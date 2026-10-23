import { COOKIE_NAME } from "@shared/const";
import { joinMessages, MAX_BUTTON_TITLE, MAX_BUTTONS, MAX_MESSAGE_LENGTH, messagesFit, MESSAGES_TOO_LONG, normalizeAccountIds } from "@shared/inbox";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
import { clientKey, isLocalAuth, LOCAL_SESSION_MS, LocalAuthError, localLogin } from "./_core/localAuth";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, publicProcedure, router } from "./_core/trpc";
import { addAccount, asAccount, enabledAccounts, refreshAccount, refreshDueToken, resolveAccount, summarize } from "./accounts";
import {
  applyRulesToUnanswered,
  buildThreads,
  copyRulesFrom,
  importHistory,
  redraftPending,
  importPostComments,
  listPosts,
  postComments,
  syncPosts,
  inboxStats,
  isAutoReplyEnabled,
  listApprovals,
  markSentManually,
  moderateComment,
  moveToPublicReply,
  reactToEvent,
  rejectReply,
  ReplyStateError,
  sendManualReply,
  sendReply,
} from "./inboxService";
import { getInboxStore } from "./inboxStore";
import { decideReply, matchingRules } from "./replyRules";
import { getMetaApiHost, getWebhookSubscription, MetaApiError, subscribeWebhooks, testMetaConnection } from "./metaGraph";
import { maskSecret, metaSetting, metaSettingSource, refreshMetaSettings, saveMetaSettings } from "./metaSettings";
import { allowedAccountIds, isMetaWebhookConfigured } from "./metaWebhook";
import { listWebhookLog } from "./webhookLog";

const ruleInput = z.object({
  name: z.string().trim().min(1).max(120),
  keywords: z.array(z.string().trim().min(1).max(60)).max(50),
  channels: z.array(z.enum(["comment", "dm"])).min(1),
  action: z.enum(["send", "approval"]),
  template: z.string().trim().max(4000).refine(messagesFit, MESSAGES_TOO_LONG),
  templateId: z.number().int().nullable(),
  // One private reply per comment: its parts are joined into a single message, so the whole must fit.
  dmTemplate: z.string().trim().max(4000).refine((t) => joinMessages(t).length <= MAX_MESSAGE_LENGTH, "دایرکت به نویسندهٔ کامنت یک پیام است و حداکثر ۱۰۰۰ کاراکتر").nullable(),
  dmTemplateId: z.number().int().nullable(),
  mediaIds: z.array(z.string().trim().min(1).max(64)).max(200).nullable(),
  /** Quick-reply buttons under the rule's DM; each sends its own reply when tapped. */
  dmButtons: z
    .array(z.object({ title: z.string().trim().min(1).max(MAX_BUTTON_TITLE), reply: z.string().trim().min(1).max(4000).refine(messagesFit, MESSAGES_TOO_LONG) }))
    .max(MAX_BUTTONS)
    .nullable()
    .optional(),
  priority: z.number().int().min(0).max(10000),
  enabled: z.boolean(),
});

/** A rule must reply somehow: in place (text or template) or, for comments, by DM. */
function assertRuleReplies(rule: Partial<z.infer<typeof ruleInput>>) {
  const inPlace = Boolean(rule.template) || rule.templateId != null;
  const dm = Boolean(rule.dmTemplate) || rule.dmTemplateId != null;
  if (!inPlace && !dm) throw new TRPCError({ code: "BAD_REQUEST", message: "متن پاسخ یا متن دایرکت (یا یک قالب) را وارد کنید" });
  // Buttons ride on a direct message: the DM to the commenter, or the reply itself for DM-only rules.
  if (rule.dmButtons?.length) {
    const carrier = rule.channels?.includes("comment") ? dm : inPlace;
    if (!carrier) throw new TRPCError({ code: "BAD_REQUEST", message: "دکمه‌ها زیر یک دایرکت فرستاده می‌شوند؛ ابتدا متن «دایرکت به نویسندهٔ کامنت» را وارد کنید" });
    if (new Set(rule.dmButtons.map((b) => b.title)).size !== rule.dmButtons.length) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "متن دکمه‌ها باید با هم فرق داشته باشد" });
    }
  }
}

const templateInput = z.object({
  title: z.string().trim().min(1).max(120),
  category: z.string().trim().max(60),
  text: z.string().trim().min(1).max(4000).refine(messagesFit, MESSAGES_TOO_LONG),
});

/** Turns state conflicts (already sent, not found) into a 409 the UI can show. */
async function guard<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ReplyStateError) throw new TRPCError({ code: "CONFLICT", message: error.message });
    // Instagram's refusal, already explained in Persian (describeMetaError).
    if (error instanceof MetaApiError) throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
    throw error;
  }
}

/** The page the dashboard shows (X-Sepand-Account header), or the first connected page. */
function requestedAccount(req: { headers?: Record<string, string | string[] | undefined> } | undefined) {
  const header = req?.headers?.["x-sepand-account"];
  return (Array.isArray(header) ? header[0] : header)?.trim() || null;
}

/**
 * Admin procedures that work on one page: `ctx.accountId` is that page (undefined before any page
 * is connected, which shows everything) and Graph calls use its token.
 */
const pageProcedure = adminProcedure.use(async ({ ctx, next }) => {
  const store = await getInboxStore();
  await refreshMetaSettings();
  const account = await resolveAccount(store, requestedAccount(ctx.req));
  const accountId = account?.id ?? allowedAccountIds()[0];
  return asAccount(store, accountId, () => next({ ctx: { ...ctx, accountId } }));
});

function requirePage(accountId: string | undefined) {
  if (!accountId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "ابتدا یک پیج را در تنظیمات وصل کنید" });
  return accountId;
}

// Everything that reads customer messages or sends replies is admin-only:
// any Manus account can sign in, but only the owner (OWNER_OPEN_ID) is admin by default.
const inboxRouter = router({
  status: pageProcedure.query(async ({ ctx }) => {
    const store = await getInboxStore();
    // Tokens stay alive without a cron: the dashboard polls this every few minutes.
    await refreshDueToken(store).catch(() => undefined);
    return {
      metaConfigured: isMetaWebhookConfigured() || (await enabledAccounts(store)).length > 0,
      autoReply: isAutoReplyEnabled(),
      apiHost: getMetaApiHost(),
      accountIds: allowedAccountIds((await enabledAccounts(store)).map((a) => a.id)),
      accountId: ctx.accountId ?? null,
      persistent: store.persistent,
      lastEventAt: (await store.listEvents(1, ctx.accountId))[0]?.createdAt ?? null,
      /** The installed build (from version.json); the Node.js package doesn't write one. */
      serverVersion: null as { version: string; commit: string; builtAt: string } | null,
    };
  }),
  threads: pageProcedure.query(async ({ ctx }) => buildThreads(await getInboxStore(), ctx.accountId)),
  /** Pulls recent comments and DMs that arrived before the webhook worked. */
  importHistory: pageProcedure.mutation(async ({ ctx }) => {
    const accountId = requirePage(ctx.accountId);
    return meta(async () => importHistory(await getInboxStore(), accountId));
  }),
  stats: pageProcedure.query(async ({ ctx }) => inboxStats(await getInboxStore(), ctx.accountId)),
  markRead: pageProcedure
    .input(z.object({ kind: z.enum(["comment", "dm"]), senderId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      await (await getInboxStore()).markRead(requirePage(ctx.accountId), input.kind, input.senderId);
      return { success: true } as const;
    }),
  /** ❤️ on a customer's DM. */
  react: adminProcedure.input(z.object({ eventId: z.number().int(), on: z.boolean() })).mutation(async ({ input }) =>
    guard(async () => {
      await reactToEvent(await getInboxStore(), input.eventId, input.on);
      return { success: true } as const;
    }),
  ),
  /** Hide, show again or delete a customer's comment on Instagram. */
  moderate: adminProcedure
    .input(z.object({ eventId: z.number().int(), action: z.enum(["hide", "unhide", "delete"]) }))
    .mutation(async ({ input, ctx }) =>
      guard(async () => {
        await moderateComment(await getInboxStore(), input.eventId, input.action, ctx.user.id);
        return { success: true } as const;
      }),
    ),
  reply: adminProcedure
    .input(z.object({ eventId: z.number().int(), text: z.string().trim().min(1).max(4000).refine(messagesFit, MESSAGES_TOO_LONG) }))
    .mutation(async ({ input, ctx }) => guard(async () => sendManualReply(await getInboxStore(), input.eventId, input.text, ctx.user.id))),
});

const approvalsRouter = router({
  list: pageProcedure.query(async ({ ctx }) => listApprovals(await getInboxStore(), ctx.accountId)),
  approve: adminProcedure
    .input(z.object({ id: z.number().int(), text: z.string().trim().min(1).max(1000).optional() }))
    .mutation(async ({ input, ctx }) => guard(async () => sendReply(await getInboxStore(), input.id, ctx.user.id, input.text))),
  /** Sends several drafts one after another; a failure doesn't stop the rest. */
  approveMany: adminProcedure
    .input(z.object({ items: z.array(z.object({ id: z.number().int(), text: z.string().trim().min(1).max(1000).optional() })).min(1).max(25) }))
    .mutation(async ({ input, ctx }) => {
      const store = await getInboxStore();
      let sent = 0;
      const failed: Array<{ id: number; error: string }> = [];
      for (const item of input.items) {
        try {
          const result = await sendReply(store, item.id, ctx.user.id, item.text);
          if (result.ok) sent++;
          else failed.push({ id: item.id, error: result.error });
        } catch (error) {
          failed.push({ id: item.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { sent, failed };
    }),
  /** Rejects many drafts at once (e.g. a stale batch); already sent or rejected ones are skipped. */
  rejectMany: adminProcedure
    .input(z.object({ ids: z.array(z.number().int()).min(1).max(1000) }))
    .mutation(async ({ input, ctx }) => {
      const store = await getInboxStore();
      let rejected = 0;
      for (const id of input.ids) {
        try {
          await rejectReply(store, id, ctx.user.id);
          rejected++;
        } catch (error) {
          if (!(error instanceof ReplyStateError)) throw error;
        }
      }
      return { rejected };
    }),
  /** Sent by hand in the Instagram app (e.g. past the API's deadline). */
  markSent: adminProcedure
    .input(z.object({ id: z.number().int(), text: z.string().trim().min(1).max(1000).optional() }))
    .mutation(async ({ input, ctx }) =>
      guard(async () => {
        await markSentManually(await getInboxStore(), input.id, ctx.user.id, input.text);
        return { success: true } as const;
      }),
    ),
  /** A private DM to a commenter becomes a reply under the comment. */
  moveToPublic: adminProcedure
    .input(z.object({ id: z.number().int(), text: z.string().trim().min(1).max(1000).optional() }))
    .mutation(async ({ input, ctx }) =>
      guard(async () => {
        await moveToPublicReply(await getInboxStore(), input.id, ctx.user.id, input.text);
        return { success: true } as const;
      }),
    ),
  moveToPublicMany: adminProcedure
    .input(z.object({ ids: z.array(z.number().int()).min(1).max(1000) }))
    .mutation(async ({ input, ctx }) => {
      const store = await getInboxStore();
      let moved = 0;
      for (const id of input.ids) {
        try {
          await moveToPublicReply(store, id, ctx.user.id);
          moved++;
        } catch (error) {
          if (!(error instanceof ReplyStateError)) throw error;
        }
      }
      return { moved };
    }),
  reject: adminProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ input, ctx }) =>
    guard(async () => {
      await rejectReply(await getInboxStore(), input.id, ctx.user.id);
      return { success: true } as const;
    }),
  ),
});

/** Drafts of this page follow its rules and templates as they are now. */
const redraft = async (store: Awaited<ReturnType<typeof getInboxStore>>, accountId: string | undefined) => (await redraftPending(store, new Date(), accountId)).updated;

const rulesRouter = router({
  list: pageProcedure.query(async ({ ctx }) => {
    const rules = await (await getInboxStore()).listRules(ctx.accountId);
    return rules.sort((a, b) => a.priority - b.priority || a.id - b.id);
  }),
  create: pageProcedure.input(ruleInput).mutation(async ({ input, ctx }) => {
    assertRuleReplies(input);
    const store = await getInboxStore();
    const rule = await store.createRule({ ...input, accountId: ctx.accountId ?? null });
    return { ...rule, redrafted: await redraft(store, ctx.accountId) };
  }),
  update: pageProcedure
    .input(z.object({ id: z.number().int(), patch: ruleInput.partial() }))
    .mutation(async ({ input, ctx }) => {
      const store = await getInboxStore();
      const current = (await store.listRules(ctx.accountId)).find((r) => r.id === input.id);
      if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "قانون پیدا نشد" });
      assertRuleReplies({ ...current, ...input.patch });
      const rule = (await store.updateRule(input.id, input.patch))!;
      // Pending drafts follow the rule as it is now.
      return { ...rule, redrafted: await redraft(store, ctx.accountId) };
    }),
  /** Which rules a sample message would trigger, in order, and the reply the first one drafts. */
  test: pageProcedure
    .input(z.object({ channel: z.enum(["comment", "dm"]), text: z.string().trim().min(1).max(1000), mediaId: z.string().trim().min(1).max(64).nullable() }))
    .query(async ({ input, ctx }) => {
      const store = await getInboxStore();
      const [rules, templates] = await Promise.all([store.listRules(ctx.accountId), store.listTemplates(ctx.accountId)]);
      const matches = matchingRules(rules, input.channel, input.text, input.mediaId);
      const decision = decideReply(rules, templates, input.channel, "", input.text, input.mediaId);
      return {
        matches: matches.map(({ rule, keyword }) => ({ id: rule.id, name: rule.name, priority: rule.priority, scoped: Boolean(rule.mediaIds?.length), keyword })),
        message: decision?.message ?? "",
        dmMessage: decision?.dmMessage ?? "",
        buttons: decision?.rule.dmButtons ?? [],
      };
    }),
  /** Drafts replies for messages that arrived before a matching rule existed. */
  applyToUnanswered: pageProcedure.mutation(async ({ ctx }) => applyRulesToUnanswered(await getInboxStore(), ctx.accountId)),
  delete: pageProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ input, ctx }) => {
    const store = await getInboxStore();
    if (!(await store.listRules(ctx.accountId)).some((r) => r.id === input.id)) throw new TRPCError({ code: "NOT_FOUND", message: "قانون پیدا نشد" });
    await store.deleteRule(input.id);
    return { success: true as const, redrafted: await redraft(store, ctx.accountId) };
  }),
  /** A new page starts with another page's rules and templates. */
  copyFrom: pageProcedure.input(z.object({ fromAccountId: z.string().trim().min(1).max(64) })).mutation(async ({ input, ctx }) =>
    guard(async () => {
      const store = await getInboxStore();
      const result = await copyRulesFrom(store, input.fromAccountId, requirePage(ctx.accountId));
      return { ...result, redrafted: await redraft(store, ctx.accountId) };
    }),
  ),
});

const templatesRouter = router({
  list: pageProcedure.query(async ({ ctx }) => (await getInboxStore()).listTemplates(ctx.accountId)),
  create: pageProcedure.input(templateInput).mutation(async ({ input, ctx }) => (await getInboxStore()).createTemplate({ ...input, accountId: ctx.accountId ?? null })),
  update: pageProcedure.input(z.object({ id: z.number().int(), patch: templateInput.partial() })).mutation(async ({ input, ctx }) => {
    const store = await getInboxStore();
    if (!(await store.listTemplates(ctx.accountId)).some((t) => t.id === input.id)) throw new TRPCError({ code: "NOT_FOUND", message: "قالب پیدا نشد" });
    const template = await store.updateTemplate(input.id, input.patch);
    if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "قالب پیدا نشد" });
    // Rules that use this template now draft the new text.
    return { ...template, redrafted: await redraft(store, ctx.accountId) };
  }),
  delete: pageProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ input, ctx }) => {
    const store = await getInboxStore();
    if (!(await store.listTemplates(ctx.accountId)).some((t) => t.id === input.id)) throw new TRPCError({ code: "NOT_FOUND", message: "قالب پیدا نشد" });
    const used = (await store.listRules(ctx.accountId)).filter((r) => r.templateId === input.id || r.dmTemplateId === input.id);
    if (used.length) throw new TRPCError({ code: "CONFLICT", message: `این قالب در قانون «${used[0].name}» استفاده شده؛ ابتدا قانون را تغییر دهید` });
    await store.deleteTemplate(input.id);
    return { success: true } as const;
  }),
});

/** Turns Meta errors into a message the dashboard can show. */
async function meta<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MetaApiError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
    throw error;
  }
}

const mediaIdInput = z.object({ mediaId: z.string().trim().min(1).max(64) });

const postsRouter = router({
  list: pageProcedure.query(async ({ ctx }) => listPosts(await getInboxStore(), ctx.accountId)),
  sync: pageProcedure.mutation(async ({ ctx }) => meta(async () => syncPosts(await getInboxStore(), ctx.accountId))),
  comments: pageProcedure.input(mediaIdInput).query(async ({ input, ctx }) => postComments(await getInboxStore(), input.mediaId, ctx.accountId)),
  /** One slice of a post's comments; call again with `after` = the returned `next` until it is null. */
  importComments: pageProcedure.input(mediaIdInput.extend({ after: z.string().max(1000).nullable().optional() })).mutation(async ({ input, ctx }) => {
    const accountId = requirePage(ctx.accountId);
    return meta(async () => importPostComments(await getInboxStore(), input.mediaId, accountId, { after: input.after }));
  }),
});

const tokenInput = z.string().trim().min(20, "توکن کامل نیست").max(1000);

// Connected pages. Tokens are write-only: the dashboard only ever sees a masked preview.
const accountsRouter = router({
  list: adminProcedure.query(async () => (await enabledAccounts(await getInboxStore())).map(summarize)),
  /** Connects a page from its access token; Meta says which account it is. */
  add: adminProcedure.input(z.object({ token: tokenInput })).mutation(async ({ input }) => guard(async () => addAccount(await getInboxStore(), input.token))),
  updateToken: adminProcedure
    .input(z.object({ id: z.string().trim().min(1).max(64), token: tokenInput }))
    .mutation(async ({ input }) => guard(async () => addAccount(await getInboxStore(), input.token, input.id))),
  refresh: adminProcedure.input(z.object({ id: z.string().trim().min(1).max(64) })).mutation(async ({ input }) =>
    guard(async () => {
      const store = await getInboxStore();
      const account = await store.getAccount(input.id);
      if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "پیج پیدا نشد" });
      await refreshAccount(store, account);
      return summarize((await store.getAccount(input.id))!);
    }),
  ),
  /** Disconnects a page; its messages, rules and templates stay, and adding it again brings them back. */
  remove: adminProcedure.input(z.object({ id: z.string().trim().min(1).max(64) })).mutation(async ({ input }) => {
    const store = await getInboxStore();
    if (!(await store.getAccount(input.id))) throw new TRPCError({ code: "NOT_FOUND", message: "پیج پیدا نشد" });
    await store.updateAccount(input.id, { enabled: false });
    return { success: true } as const;
  }),
});

const secretField = z.string().trim().max(1000).nullable().optional();

// The Meta connection, editable from the dashboard. Secrets are write-only: the client only
// ever gets a masked preview, except the verify token, which the operator must copy into Meta.
const settingsRouter = router({
  meta: adminProcedure.query(async () => {
    await refreshMetaSettings(true);
    const secret = (key: "META_ACCESS_TOKEN" | "META_APP_SECRET") => ({ source: metaSettingSource(key), preview: maskSecret(metaSetting(key)) });
    return {
      accessToken: secret("META_ACCESS_TOKEN"),
      appSecret: secret("META_APP_SECRET"),
      verifyToken: { source: metaSettingSource("META_WEBHOOK_VERIFY_TOKEN"), value: metaSetting("META_WEBHOOK_VERIFY_TOKEN") },
      accountIds: { source: metaSettingSource("INSTAGRAM_ACCOUNT_IDS"), value: metaSetting("INSTAGRAM_ACCOUNT_IDS") },
      autoReply: { source: metaSettingSource("META_AUTO_REPLY"), value: isAutoReplyEnabled() },
      apiHost: getMetaApiHost(),
      configured: isMetaWebhookConfigured(),
    };
  }),
  saveMeta: adminProcedure
    .input(
      z.object({
        accessToken: secretField,
        appSecret: secretField,
        verifyToken: secretField,
        accountIds: z
          .string()
          .transform(normalizeAccountIds)
          .pipe(z.string().regex(/^[0-9,]*$/, "شناسهٔ حساب فقط رقم است (مثل 17841457283303858)؛ چند شناسه را با ویرگول جدا کنید"))
          .nullable()
          .optional(),
        autoReply: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        await saveMetaSettings({
          META_ACCESS_TOKEN: input.accessToken,
          META_APP_SECRET: input.appSecret,
          META_WEBHOOK_VERIFY_TOKEN: input.verifyToken,
          INSTAGRAM_ACCOUNT_IDS: input.accountIds,
          META_AUTO_REPLY: input.autoReply === undefined ? undefined : input.autoReply ? "true" : "false",
        });
      } catch (error) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: error instanceof Error ? error.message : String(error) });
      }
      // A token saved here is also that page's token (it would otherwise keep the old one).
      if (input.accessToken) await addAccount(await getInboxStore(), input.accessToken).catch(() => undefined);
      return { success: true } as const;
    }),
  testMeta: pageProcedure.mutation(async () => testMetaConnection()),
  /** Why the inbox may be empty: does Meta call in, and is the account subscribed to the webhook fields? */
  diagnostics: pageProcedure.query(async ({ ctx }) => {
    const store = await getInboxStore();
    const [events, media] = await Promise.all([store.listEvents(5000, ctx.accountId), store.listMedia(ctx.accountId)]);
    let subscription: { ok: true; fields: string[]; missing: string[] } | { ok: false; error: string };
    try {
      subscription = { ok: true, ...(await getWebhookSubscription()) };
    } catch (error) {
      subscription = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return {
      webhookLog: listWebhookLog(20),
      subscription,
      counts: {
        comments: events.filter((e) => e.kind === "comment").length,
        dms: events.filter((e) => e.kind === "dm").length,
        /** What Instagram reported for the synced posts; far more than `comments` means Meta hides them. */
        igComments: media.reduce((sum, m) => sum + (m.commentsCount ?? 0), 0),
      },
    };
  }),
  subscribeWebhooks: pageProcedure.mutation(async () => meta(subscribeWebhooks)),
});

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    login: publicProcedure
      .input(z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(200) }))
      .mutation(async ({ input, ctx }) => {
        if (!isLocalAuth()) throw new TRPCError({ code: "NOT_FOUND", message: "Local login is disabled" });
        try {
          const token = await localLogin(clientKey(ctx.req), input.username, input.password);
          ctx.res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(ctx.req), maxAge: LOCAL_SESSION_MS });
          return { success: true } as const;
        } catch (error) {
          if (error instanceof LocalAuthError) throw new TRPCError({ code: error.code, message: error.message });
          throw error;
        }
      }),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),
  inbox: inboxRouter,
  approvals: approvalsRouter,
  rules: rulesRouter,
  templates: templatesRouter,
  posts: postsRouter,
  accounts: accountsRouter,
  settings: settingsRouter,
});

export type AppRouter = typeof appRouter;
