import { COOKIE_NAME } from "@shared/const";
import { joinMessages, MAX_BUTTON_TITLE, MAX_BUTTONS, MAX_MESSAGE_LENGTH, messagesFit, MESSAGES_TOO_LONG, normalizeAccountIds } from "@shared/inbox";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
import { clientKey, isLocalAuth, LOCAL_SESSION_MS, LocalAuthError, localLogin } from "./_core/localAuth";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, publicProcedure, router } from "./_core/trpc";
import {
  applyRulesToUnanswered,
  buildThreads,
  importHistory,
  redraftPending,
  importPostComments,
  listPosts,
  postComments,
  syncPosts,
  inboxStats,
  isAutoReplyEnabled,
  listApprovals,
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
    throw error;
  }
}

// Everything that reads customer messages or sends replies is admin-only:
// any Manus account can sign in, but only the owner (OWNER_OPEN_ID) is admin by default.
const inboxRouter = router({
  status: adminProcedure.query(async () => {
    await refreshMetaSettings();
    const store = await getInboxStore();
    return {
      metaConfigured: isMetaWebhookConfigured(),
      autoReply: isAutoReplyEnabled(),
      apiHost: getMetaApiHost(),
      accountIds: allowedAccountIds(),
      persistent: store.persistent,
      lastEventAt: (await store.listEvents(1))[0]?.createdAt ?? null,
      /** The installed build (from version.json); the Node.js package doesn't write one. */
      serverVersion: null as { version: string; commit: string; builtAt: string } | null,
    };
  }),
  threads: adminProcedure.query(async () => buildThreads(await getInboxStore())),
  /** Pulls recent comments and DMs that arrived before the webhook worked. */
  importHistory: adminProcedure.mutation(async () => {
    await refreshMetaSettings();
    const accountId = allowedAccountIds()[0] ?? "";
    if (!accountId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "ابتدا شناسهٔ حساب اینستاگرام را در تنظیمات وارد کنید" });
    return meta(async () => importHistory(await getInboxStore(), accountId));
  }),
  stats: adminProcedure.query(async () => inboxStats(await getInboxStore())),
  markRead: adminProcedure
    .input(z.object({ kind: z.enum(["comment", "dm"]), senderId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await (await getInboxStore()).markRead(input.kind, input.senderId);
      return { success: true } as const;
    }),
  reply: adminProcedure
    .input(z.object({ eventId: z.number().int(), text: z.string().trim().min(1).max(4000).refine(messagesFit, MESSAGES_TOO_LONG) }))
    .mutation(async ({ input, ctx }) => guard(async () => sendManualReply(await getInboxStore(), input.eventId, input.text, ctx.user.id))),
});

const approvalsRouter = router({
  list: adminProcedure.query(async () => listApprovals(await getInboxStore())),
  approve: adminProcedure
    .input(z.object({ id: z.number().int(), text: z.string().trim().min(1).max(1000).optional() }))
    .mutation(async ({ input, ctx }) => guard(async () => sendReply(await getInboxStore(), input.id, ctx.user.id, input.text))),
  /** Sends several drafts one after another; a failure doesn't stop the rest. */
  approveMany: adminProcedure
    .input(z.object({ items: z.array(z.object({ id: z.number().int(), text: z.string().trim().min(1).max(1000).optional() })).min(1).max(100) }))
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
  reject: adminProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ input, ctx }) =>
    guard(async () => {
      await rejectReply(await getInboxStore(), input.id, ctx.user.id);
      return { success: true } as const;
    }),
  ),
});

const rulesRouter = router({
  list: adminProcedure.query(async () => {
    const rules = await (await getInboxStore()).listRules();
    return rules.sort((a, b) => a.priority - b.priority || a.id - b.id);
  }),
  create: adminProcedure.input(ruleInput).mutation(async ({ input }) => {
    assertRuleReplies(input);
    const store = await getInboxStore();
    const rule = await store.createRule(input);
    return { ...rule, redrafted: (await redraftPending(store)).updated };
  }),
  update: adminProcedure
    .input(z.object({ id: z.number().int(), patch: ruleInput.partial() }))
    .mutation(async ({ input }) => {
      const store = await getInboxStore();
      const current = (await store.listRules()).find((r) => r.id === input.id);
      if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "قانون پیدا نشد" });
      assertRuleReplies({ ...current, ...input.patch });
      const rule = (await store.updateRule(input.id, input.patch))!;
      // Pending drafts follow the rule as it is now.
      return { ...rule, redrafted: (await redraftPending(store)).updated };
    }),
  /** Which rules a sample message would trigger, in order, and the reply the first one drafts. */
  test: adminProcedure
    .input(z.object({ channel: z.enum(["comment", "dm"]), text: z.string().trim().min(1).max(1000), mediaId: z.string().trim().min(1).max(64).nullable() }))
    .query(async ({ input }) => {
      const store = await getInboxStore();
      const [rules, templates] = await Promise.all([store.listRules(), store.listTemplates()]);
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
  applyToUnanswered: adminProcedure.mutation(async () => applyRulesToUnanswered(await getInboxStore())),
  delete: adminProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ input }) => {
    const store = await getInboxStore();
    await store.deleteRule(input.id);
    return { success: true as const, redrafted: (await redraftPending(store)).updated };
  }),
});

const templatesRouter = router({
  list: adminProcedure.query(async () => (await getInboxStore()).listTemplates()),
  create: adminProcedure.input(templateInput).mutation(async ({ input }) => (await getInboxStore()).createTemplate(input)),
  update: adminProcedure.input(z.object({ id: z.number().int(), patch: templateInput.partial() })).mutation(async ({ input }) => {
    const store = await getInboxStore();
    const template = await store.updateTemplate(input.id, input.patch);
    if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "قالب پیدا نشد" });
    // Rules that use this template now draft the new text.
    return { ...template, redrafted: (await redraftPending(store)).updated };
  }),
  delete: adminProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ input }) => {
    const store = await getInboxStore();
    const used = (await store.listRules()).filter((r) => r.templateId === input.id || r.dmTemplateId === input.id);
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
  list: adminProcedure.query(async () => listPosts(await getInboxStore())),
  sync: adminProcedure.mutation(async () => meta(async () => syncPosts(await getInboxStore()))),
  comments: adminProcedure.input(mediaIdInput).query(async ({ input }) => postComments(await getInboxStore(), input.mediaId)),
  importComments: adminProcedure.input(mediaIdInput).mutation(async ({ input }) => {
    await refreshMetaSettings();
    const accountId = allowedAccountIds()[0] ?? "";
    if (!accountId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "ابتدا شناسهٔ حساب اینستاگرام را در تنظیمات وارد کنید" });
    return meta(async () => importPostComments(await getInboxStore(), input.mediaId, accountId));
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
      return { success: true } as const;
    }),
  testMeta: adminProcedure.mutation(async () => testMetaConnection()),
  /** Why the inbox may be empty: does Meta call in, and is the account subscribed to the webhook fields? */
  diagnostics: adminProcedure.query(async () => {
    const store = await getInboxStore();
    const [events, media] = await Promise.all([store.listEvents(5000), store.listMedia()]);
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
  subscribeWebhooks: adminProcedure.mutation(async () => meta(subscribeWebhooks)),
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
  settings: settingsRouter,
});

export type AppRouter = typeof appRouter;
