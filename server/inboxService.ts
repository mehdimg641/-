import type { IgEvent, Reply, ReplyRule } from "../drizzle/schema";
import { channelOf, type ApprovalItem, type InboxThread } from "@shared/inbox";
import type { InboxStore } from "./inboxStore";
import { replyToComment, sendDirectMessage } from "./metaGraph";
import type { IncomingEvent } from "./metaWebhook";
import { decideReply } from "./replyRules";

const TONES = ["orange", "gold", "blue", "green", "violet"];
const THREAD_EVENT_LIMIT = 2000;

/** Auto-sending is opt-in; by default every draft waits for an operator. */
export function isAutoReplyEnabled() {
  return process.env.META_AUTO_REPLY === "true";
}

/**
 * Stores new events and creates a reply draft for each one that matches a rule.
 * Returns the ids of replies that should be sent right away (auto-reply on and rule action "send").
 */
export async function ingestEvents(store: InboxStore, events: IncomingEvent[]) {
  const rules = events.length ? await store.listRules() : [];
  const toSend: number[] = [];
  let stored = 0;
  let duplicates = 0;

  for (const event of events) {
    const decision = decideReply(rules, event.kind, event.username ?? "", event.text);
    const saved = await store.insertEvent({ ...event, ruleId: decision?.rule.id ?? null });
    if (!saved) {
      duplicates++;
      continue;
    }
    stored++;
    if (!decision) continue;
    const reply = await store.createReply({ eventId: saved.id, ruleId: decision.rule.id, source: "rule", text: decision.message, status: "pending" });
    if (isAutoReplyEnabled() && decision.rule.action === "send") toSend.push(reply.id);
  }
  return { stored, duplicates, toSend };
}

export class ReplyStateError extends Error {}

/** Sends a pending (or previously failed) reply. Safe against double clicks: only one caller can claim it. */
export async function sendReply(store: InboxStore, replyId: number, operatorId: number | null, editedText?: string) {
  const reply = await store.getReply(replyId);
  if (!reply) throw new ReplyStateError("پاسخ پیدا نشد");
  const event = await store.getEvent(reply.eventId);
  if (!event) throw new ReplyStateError("پیام اصلی پیدا نشد");
  if (!(await store.claimReply(replyId, ["pending", "failed"]))) throw new ReplyStateError("این پاسخ قبلاً ارسال یا رد شده است");

  const text = (editedText ?? reply.text).trim();
  try {
    if (!text) throw new Error("متن پاسخ خالی است");
    if (event.kind === "comment") await replyToComment(event.externalId, text);
    else await sendDirectMessage(event.senderId, text);
    await store.updateReply(replyId, { text, status: "sent", error: null, decidedBy: operatorId, sentAt: new Date() });
    return { ok: true as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.updateReply(replyId, { text, status: "failed", error: message.slice(0, 1000), decidedBy: operatorId });
    return { ok: false as const, error: message };
  }
}

export async function rejectReply(store: InboxStore, replyId: number, operatorId: number) {
  if (!(await store.claimReply(replyId, ["pending", "failed"]))) throw new ReplyStateError("این پاسخ قبلاً ارسال یا رد شده است");
  await store.updateReply(replyId, { status: "rejected", decidedBy: operatorId });
}

export async function sendManualReply(store: InboxStore, eventId: number, text: string, operatorId: number) {
  const event = await store.getEvent(eventId);
  if (!event) throw new ReplyStateError("پیام اصلی پیدا نشد");
  const reply = await store.createReply({ eventId, source: "manual", text, status: "pending", decidedBy: operatorId });
  const result = await sendReply(store, reply.id, operatorId);
  if (result.ok) {
    // The operator answered this conversation directly; its rule drafts are now stale.
    for (const draft of await store.listReplies({ status: "pending" })) {
      const draftEvent = await store.getEvent(draft.eventId);
      if (draftEvent?.kind === event.kind && draftEvent.senderId === event.senderId && (await store.claimReply(draft.id, ["pending"]))) {
        await store.updateReply(draft.id, { status: "rejected", decidedBy: operatorId });
      }
    }
  }
  return result;
}

function displayName(event: Pick<IgEvent, "username" | "senderId">) {
  return event.username || `کاربر ${event.senderId.slice(-4)}`;
}

function ruleStyle(rules: ReplyRule[]) {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority || a.id - b.id);
  return (ruleId: number | null) => {
    const index = sorted.findIndex((r) => r.id === ruleId);
    if (index < 0) return { tag: "بدون قانون", tone: "slate" };
    return { tag: sorted[index].name, tone: TONES[index % TONES.length] };
  };
}

export async function buildThreads(store: InboxStore): Promise<InboxThread[]> {
  const [events, rules] = await Promise.all([store.listEvents(THREAD_EVENT_LIMIT), store.listRules()]);
  const allReplies = await store.listReplies({ eventIds: events.map((e) => e.id) });
  const style = ruleStyle(rules);
  const repliesByEvent = new Map<number, Reply[]>();
  for (const reply of allReplies) repliesByEvent.set(reply.eventId, [...(repliesByEvent.get(reply.eventId) ?? []), reply]);

  const threads = new Map<string, InboxThread>();
  // Oldest first so messages end up in chronological order and the latest event wins the header.
  for (const event of [...events].reverse()) {
    const id = `${event.kind}:${event.senderId}`;
    const previous = threads.get(id);
    const name = displayName(event);
    const { tag, tone } = style(event.ruleId);
    const thread: InboxThread = {
      id,
      kind: event.kind,
      channel: channelOf(event.kind),
      senderId: event.senderId,
      // Comment events carry the username; keep it once known.
      name: event.username ? name : previous?.name ?? name,
      handle: event.username ?? previous?.handle ?? event.senderId,
      avatar: (event.username ? name : previous?.name ?? name).charAt(0),
      message: event.text,
      updatedAt: event.createdAt,
      tag,
      tagTone: tone,
      unread: Boolean(previous?.unread) || !event.isRead,
      priority: previous?.priority ?? false,
      lastEventId: event.id,
      messages: previous?.messages ?? [],
    };
    thread.messages.push({ id: `e${event.id}`, from: "contact", text: event.text, at: event.createdAt });
    for (const reply of (repliesByEvent.get(event.id) ?? []).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
      if (reply.status === "pending") thread.priority = true;
      if (reply.status === "pending" || reply.status === "rejected") continue; // drafts live in the approval queue
      thread.messages.push({ id: `r${reply.id}`, from: "agent", text: reply.text, at: reply.sentAt ?? reply.createdAt, status: reply.status, error: reply.error });
    }
    threads.set(id, thread);
  }
  return Array.from(threads.values()).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function listApprovals(store: InboxStore): Promise<ApprovalItem[]> {
  const [pending, failed, rules] = await Promise.all([
    store.listReplies({ status: "pending" }),
    store.listReplies({ status: "failed" }),
    store.listRules(),
  ]);
  const style = ruleStyle(rules);
  const items: ApprovalItem[] = [];
  for (const reply of [...pending, ...failed]) {
    const event = await store.getEvent(reply.eventId);
    if (!event) continue;
    const { tag, tone } = style(reply.ruleId);
    items.push({
      id: reply.id,
      threadId: `${event.kind}:${event.senderId}`,
      channel: channelOf(event.kind),
      name: displayName(event),
      handle: event.username ?? event.senderId,
      incoming: event.text,
      draft: reply.text,
      reason: reply.source === "manual" ? "پاسخ دستی" : tag,
      tone,
      status: reply.status,
      error: reply.error,
      createdAt: reply.createdAt,
    });
  }
  return items.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export async function inboxStats(store: InboxStore) {
  const threads = await buildThreads(store);
  const events = await store.listEvents(THREAD_EVENT_LIMIT);
  const replies = await store.listReplies({ eventIds: events.map((e) => e.id) });
  const sent = replies.filter((r) => r.status === "sent");

  const dayMs = 24 * 60 * 60 * 1000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => ({ date: new Date(today.getTime() - (6 - i) * dayMs), dm: 0, comment: 0 }));
  for (const event of events) {
    const index = Math.floor((event.createdAt.getTime() - days[0].date.getTime()) / dayMs);
    if (index >= 0 && index < 7) days[index][event.kind]++;
  }

  const eventById = new Map(events.map((e) => [e.id, e]));
  const firstSent = new Map<number, number>();
  for (const reply of sent) {
    const at = (reply.sentAt ?? reply.createdAt).getTime();
    firstSent.set(reply.eventId, Math.min(firstSent.get(reply.eventId) ?? at, at));
  }
  const waits = Array.from(firstSent).map(([eventId, at]) => at - (eventById.get(eventId)?.createdAt.getTime() ?? at));
  const avgResponseMinutes = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length / 60000) : null;

  return {
    threads: threads.length,
    unread: threads.filter((t) => t.unread).length,
    pending: replies.filter((r) => r.status === "pending").length,
    failed: replies.filter((r) => r.status === "failed").length,
    sent: sent.length,
    autoSent: sent.filter((r) => r.source === "rule" && r.decidedBy === null).length,
    dm: events.filter((e) => e.kind === "dm").length,
    comment: events.filter((e) => e.kind === "comment").length,
    days,
    avgResponseMinutes,
  };
}
