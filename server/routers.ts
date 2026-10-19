import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
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
import { getMetaApiHost } from "./metaGraph";
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

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
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
});

export type AppRouter = typeof appRouter;
