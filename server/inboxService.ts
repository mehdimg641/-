import type { IgEvent, Reply, ReplyRule } from "../drizzle/schema";
import { channelOf, type ApprovalItem, type InboxThread } from "@shared/inbox";
import type { InboxStore } from "./inboxStore";
import { listMediaComments, listRecentMedia, ownUsername, replyToComment, sendDirectMessage, sendPrivateReply } from "./metaGraph";
import type { IncomingEvent } from "./metaWebhook";
import { decideReply } from "./replyRules";
import { metaSetting } from "./metaSettings";

const TONES = ["orange", "gold", "blue", "green", "violet"];
const THREAD_EVENT_LIMIT = 2000;

/** Auto-sending is opt-in; by default every draft waits for an operator. */
export function isAutoReplyEnabled() {
  return metaSetting("META_AUTO_REPLY") === "true";
}

/** Creates the drafts a rule decision calls for: a reply in place and, for comments, a private DM. */
async function createDrafts(store: InboxStore, event: IgEvent, decision: NonNullable<ReturnType<typeof decideReply>>) {
  const ids: number[] = [];
  if (decision.message) {
    ids.push((await store.createReply({ eventId: event.id, ruleId: decision.rule.id, source: "rule", channel: "reply", text: decision.message, status: "pending" })).id);
  }
  if (event.kind === "comment" && decision.dmMessage) {
    ids.push((await store.createReply({ eventId: event.id, ruleId: decision.rule.id, source: "rule", channel: "private", text: decision.dmMessage, status: "pending" })).id);
  }
  return ids;
}

/**
 * Stores new events and drafts replies for each one that matches a rule. Returns the reply ids to
 * send right away (auto-reply on and rule action "send"); `allowAutoSend: false` keeps everything
 * in the approval queue (used for imported old comments).
 */
export async function ingestEvents(store: InboxStore, events: IncomingEvent[], options: { allowAutoSend?: boolean } = {}) {
  const [rules, templates] = events.length ? await Promise.all([store.listRules(), store.listTemplates()]) : [[], []];
  const autoSend = (options.allowAutoSend ?? true) && isAutoReplyEnabled();
  const toSend: number[] = [];
  let stored = 0;
  let duplicates = 0;

  for (const event of events) {
    const decision = decideReply(rules, templates, event.kind, event.username ?? "", event.text, event.mediaId);
    const saved = await store.insertEvent({ ...event, ruleId: decision?.rule.id ?? null });
    if (!saved) {
      duplicates++;
      continue;
    }
    stored++;
    if (!decision) continue;
    const ids = await createDrafts(store, saved, decision);
    if (autoSend && decision.rule.action === "send") toSend.push(...ids);
  }
  return { stored, duplicates, toSend };
}

/**
 * Runs the current rules over events that never got any reply or draft (e.g. they arrived before
 * the rule existed). Drafts always wait for approval; nothing is sent automatically.
 */
export async function applyRulesToUnanswered(store: InboxStore) {
  const [events, rules, templates] = await Promise.all([store.listEvents(THREAD_EVENT_LIMIT), store.listRules(), store.listTemplates()]);
  const answered = new Set((await store.listReplies({ eventIds: events.map((e) => e.id) })).map((r) => r.eventId));
  let drafted = 0;
  for (const event of events) {
    if (answered.has(event.id)) continue;
    const decision = decideReply(rules, templates, event.kind, event.username ?? "", event.text, event.mediaId);
    if (!decision) continue;
    if ((await createDrafts(store, event, decision)).length) drafted++;
  }
  return { drafted };
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
    if (reply.channel === "private") await sendPrivateReply(event.externalId, text);
    else if (event.kind === "comment") await replyToComment(event.externalId, text);
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
    // The operator answered this conversation directly; its in-place rule drafts are now stale.
    // Private-DM drafts for comments are a separate action and stay in the queue.
    for (const draft of await store.listReplies({ status: "pending" })) {
      if (draft.channel !== "reply") continue;
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
      thread.messages.push({ id: `r${reply.id}`, from: "agent", text: reply.text, at: reply.sentAt ?? reply.createdAt, status: reply.status, error: reply.error, via: reply.channel === "private" ? "dm" : undefined });
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
      replyChannel: reply.channel,
      mediaId: event.mediaId,
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

// --- Posts ----------------------------------------------------------------------------------------

export type PostSummary = {
  id: string;
  caption: string | null;
  mediaType: string | null;
  imageUrl: string | null;
  permalink: string | null;
  postedAt: Date | null;
  /** Comments stored in the inbox for this post. */
  comments: number;
  pending: number;
  repliesSent: number;
  dmsSent: number;
  /** Rules that apply only to this post. */
  rules: number;
  synced: boolean;
};

/** Pulls recent posts from Instagram into the media table. */
export async function syncPosts(store: InboxStore) {
  const media = await listRecentMedia();
  await store.upsertMedia(media);
  return { synced: media.length };
}

export async function listPosts(store: InboxStore): Promise<PostSummary[]> {
  const [media, events, rules] = await Promise.all([store.listMedia(), store.listEvents(THREAD_EVENT_LIMIT), store.listRules()]);
  const comments = events.filter((e) => e.kind === "comment" && e.mediaId);
  const replies = await store.listReplies({ eventIds: comments.map((e) => e.id) });
  const posts = new Map<string, PostSummary>();
  const blank = (id: string): PostSummary => ({ id, caption: null, mediaType: null, imageUrl: null, permalink: null, postedAt: null, comments: 0, pending: 0, repliesSent: 0, dmsSent: 0, rules: 0, synced: false });
  for (const m of media) {
    posts.set(m.id, { ...blank(m.id), caption: m.caption, mediaType: m.mediaType, imageUrl: m.thumbnailUrl ?? m.mediaUrl, permalink: m.permalink, postedAt: m.postedAt, synced: true });
  }
  const postOf = new Map<number, string>();
  for (const e of comments) {
    // Comments can arrive for posts that were never synced; list them anyway.
    if (!posts.has(e.mediaId!)) posts.set(e.mediaId!, blank(e.mediaId!));
    posts.get(e.mediaId!)!.comments++;
    postOf.set(e.id, e.mediaId!);
  }
  for (const r of replies) {
    const post = posts.get(postOf.get(r.eventId) ?? "");
    if (!post) continue;
    if (r.status === "pending") post.pending++;
    if (r.status === "sent") r.channel === "private" ? post.dmsSent++ : post.repliesSent++;
  }
  for (const rule of rules) for (const id of rule.mediaIds ?? []) if (posts.has(id)) posts.get(id)!.rules++;
  return Array.from(posts.values()).sort(
    (a, b) => (b.postedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (a.postedAt?.getTime() ?? Number.MAX_SAFE_INTEGER),
  );
}

export type PostComment = {
  eventId: number;
  threadId: string;
  username: string;
  text: string;
  at: Date;
  rule: string;
  tone: string;
  replies: Array<{ id: number; channel: "reply" | "private"; text: string; status: Reply["status"]; error: string | null; source: Reply["source"] }>;
};

/** Every comment on a post with its public reply and private DM, newest first. */
export async function postComments(store: InboxStore, mediaId: string): Promise<PostComment[]> {
  const [events, rules] = await Promise.all([store.listEvents(THREAD_EVENT_LIMIT), store.listRules()]);
  const comments = events.filter((e) => e.kind === "comment" && e.mediaId === mediaId);
  const replies = await store.listReplies({ eventIds: comments.map((e) => e.id) });
  const style = ruleStyle(rules);
  return comments.map((e) => {
    const { tag, tone } = style(e.ruleId);
    return {
      eventId: e.id,
      threadId: `comment:${e.senderId}`,
      username: displayName(e),
      text: e.text,
      at: e.createdAt,
      rule: tag,
      tone,
      replies: replies
        .filter((r) => r.eventId === e.id && r.status !== "rejected")
        .sort((a, b) => a.id - b.id)
        .map((r) => ({ id: r.id, channel: r.channel, text: r.text, status: r.status, error: r.error, source: r.source })),
    };
  });
}

/**
 * Imports a post's existing comments (from before the webhook was connected). Rules draft
 * replies for them, but nothing is sent automatically: old comments always wait for approval.
 */
export async function importPostComments(store: InboxStore, mediaId: string, accountId: string) {
  const comments = await listMediaComments(mediaId);
  // Meta can leave out a comment's author; then the account's own comments are recognised by username.
  const own = comments.some((c) => !c.fromId) ? await ownUsername() : null;
  let skippedOwn = 0;
  const events: IncomingEvent[] = [];
  for (const c of comments) {
    if ((c.fromId && c.fromId === accountId) || (own && c.username === own)) {
      skippedOwn++;
      continue;
    }
    // Replies and private DMs only need the comment id, so an unknown author is no reason to skip.
    const senderId = c.fromId ?? (c.username ? `u:${c.username}` : `c:${c.id}`);
    events.push({ accountId, kind: "comment", externalId: c.id, senderId, username: c.username, text: c.text, mediaId });
  }
  const result = await ingestEvents(store, events, { allowAutoSend: false });
  return { fetched: comments.length, imported: result.stored, alreadyThere: result.duplicates, own: skippedOwn };
}
