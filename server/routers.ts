import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
import { clientKey, isLocalAuth, LOCAL_SESSION_MS, LocalAuthError, localLogin } from "./_core/localAuth";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, publicProcedure, router } from "./_core/trpc";
import {
  buildThreads,
  inboxStats,
  isAutoReplyEnabled,
  listApprovals,
  rejectReply,
  ReplyStateError,
  sendManualReply,
  sendReply,
} from "./inboxService";
import { getInboxStore } from "./inboxStore";
import { getMetaApiHost, testMetaConnection } from "./metaGraph";
import { maskSecret, metaSetting, metaSettingSource, refreshMetaSettings, saveMetaSettings } from "./metaSettings";
import { allowedAccountIds, isMetaWebhookConfigured } from "./metaWebhook";

const ruleInput = z.object({
  name: z.string().trim().min(1).max(120),
  keywords: z.array(z.string().trim().min(1).max(60)).max(50),
  channels: z.array(z.enum(["comment", "dm"])).min(1),
  action: z.enum(["send", "approval"]),
  template: z.string().trim().min(1).max(1000),
  priority: z.number().int().min(0).max(10000),
  enabled: z.boolean(),
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
    };
  }),
  threads: adminProcedure.query(async () => buildThreads(await getInboxStore())),
  stats: adminProcedure.query(async () => inboxStats(await getInboxStore())),
  markRead: adminProcedure
    .input(z.object({ kind: z.enum(["comment", "dm"]), senderId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await (await getInboxStore()).markRead(input.kind, input.senderId);
      return { success: true } as const;
    }),
  reply: adminProcedure
    .input(z.object({ eventId: z.number().int(), text: z.string().trim().min(1).max(1000) }))
    .mutation(async ({ input, ctx }) => guard(async () => sendManualReply(await getInboxStore(), input.eventId, input.text, ctx.user.id))),
});

const approvalsRouter = router({
  list: adminProcedure.query(async () => listApprovals(await getInboxStore())),
  approve: adminProcedure
    .input(z.object({ id: z.number().int(), text: z.string().trim().min(1).max(1000).optional() }))
    .mutation(async ({ input, ctx }) => guard(async () => sendReply(await getInboxStore(), input.id, ctx.user.id, input.text))),
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
  create: adminProcedure.input(ruleInput).mutation(async ({ input }) => (await getInboxStore()).createRule(input)),
  update: adminProcedure
    .input(z.object({ id: z.number().int(), patch: ruleInput.partial() }))
    .mutation(async ({ input }) => {
      const rule = await (await getInboxStore()).updateRule(input.id, input.patch);
      if (!rule) throw new TRPCError({ code: "NOT_FOUND", message: "قانون پیدا نشد" });
      return rule;
    }),
  delete: adminProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ input }) => {
    await (await getInboxStore()).deleteRule(input.id);
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
        accountIds: z.string().trim().regex(/^[0-9,\s]*$/, "فقط شناسه‌های عددی، جداشده با ویرگول").nullable().optional(),
        autoReply: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        await saveMetaSettings({
          META_ACCESS_TOKEN: input.accessToken,
          META_APP_SECRET: input.appSecret,
          META_WEBHOOK_VERIFY_TOKEN: input.verifyToken,
          INSTAGRAM_ACCOUNT_IDS: input.accountIds === undefined || input.accountIds === null ? input.accountIds : input.accountIds.replace(/\s+/g, ""),
          META_AUTO_REPLY: input.autoReply === undefined ? undefined : input.autoReply ? "true" : "false",
        });
      } catch (error) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: error instanceof Error ? error.message : String(error) });
      }
      return { success: true } as const;
    }),
  testMeta: adminProcedure.mutation(async () => testMetaConnection()),
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
  settings: settingsRouter,
});

export type AppRouter = typeof appRouter;
