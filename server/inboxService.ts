import type { IgEvent, Reply, ReplyRule } from "../drizzle/schema";
import {
  DM_WINDOW_CLOSED,
  PRIVATE_WINDOW_CLOSED,
  buttonPayload,
  channelOf,
  joinMessages,
  optionsAsText,
  parseButtonPayload,
  replyDeadline,
  splitMessages,
  type ApprovalItem,
  type InboxThread,
  type QuickReply,
} from "@shared/inbox";
import type { InboxStore } from "./inboxStore";
import {
  getWebhookSubscription,
  listMediaComments,
  listRecentMedia,
  listRecentMessages,
  ownUsername,
  replyToComment,
  sendDirectMessage,
  sendPrivateReply,
  subscribeWebhooks,
} from "./metaGraph";
import type { IncomingEvent } from "./metaWebhook";
import { decideReply, normalizeText, renderTemplate } from "./replyRules";
import { metaSetting } from "./metaSettings";

const TONES = ["orange", "gold", "blue", "green", "violet"];
const THREAD_EVENT_LIMIT = 2000;

/** Auto-sending is opt-in; by default every draft waits for an operator. */
export function isAutoReplyEnabled() {
  return metaSetting("META_AUTO_REPLY") === "true";
}

type Decision = NonNullable<ReturnType<typeof decideReply>>;
type DraftPart = { channel: "reply" | "private"; text: string; quickReplies: QuickReply[] | null };

/** The drafts a decision calls for, in send order. */
function draftParts(event: Pick<IgEvent, "id" | "kind">, decision: Decision): DraftPart[] {
  // Each "---" part is its own reply, drafted (and later sent) in order.
  const parts: DraftPart[] = splitMessages(decision.message).map((text) => ({ channel: "reply", text, quickReplies: null }));
  // Instagram allows one private reply per comment, so its parts go out as one message.
  const dm = event.kind === "comment" ? joinMessages(decision.dmMessage) : "";
  if (dm) parts.push({ channel: "private", text: dm, quickReplies: null });
  // The rule's buttons ride on its direct message: the private reply for a comment, the last
  // message for a DM. A public comment reply can't carry buttons.
  const buttons = decision.rule.dmButtons ?? [];
  const carrier = event.kind === "comment" ? parts.find((p) => p.channel === "private") : parts[parts.length - 1];
  if (buttons.length && carrier) carrier.quickReplies = buttons.map((b, i) => ({ title: b.title, payload: buttonPayload(decision.rule.id, i, event.id) }));
  return parts;
}

/** Channels Instagram no longer accepts for this message (drafting them would only fail). */
function closedChannels(event: Pick<IgEvent, "kind" | "createdAt">, now = new Date()) {
  return new Set(
    (["reply", "private"] as const).filter((channel) => {
      const deadline = replyDeadline(event.kind, channel, event.createdAt);
      return deadline !== null && deadline <= now;
    }),
  );
}

/** Each sender's latest DM: a DM stays answerable for 24 hours after it. */
async function latestDms(store: InboxStore) {
  const latest = new Map<string, Date>();
  for (const event of await store.listEvents(THREAD_EVENT_LIMIT)) {
    if (event.kind !== "dm") continue;
    const seen = latest.get(event.senderId);
    if (!seen || event.createdAt > seen) latest.set(event.senderId, event.createdAt);
  }
  return latest;
}

function deadlineOf(event: IgEvent, channel: Reply["channel"], dms: Map<string, Date>) {
  const dm = dms.get(event.senderId);
  const receivedAt = event.kind === "dm" && dm && dm > event.createdAt ? dm : event.createdAt;
  return replyDeadline(event.kind, channel, receivedAt);
}

async function createDrafts(store: InboxStore, event: IgEvent, decision: Decision) {
  const ids: number[] = [];
  const closed = closedChannels(event);
  for (const part of draftParts(event, decision).filter((p) => !closed.has(p.channel))) {
    ids.push(
      (await store.createReply({ eventId: event.id, ruleId: decision.rule.id, source: "rule", channel: part.channel, text: part.text, quickReplies: part.quickReplies, status: "pending" })).id,
    );
  }
  return ids;
}

/** How long after a DM with buttons a typed option still counts as a tap (Instagram's reply window). */
const TAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A DM that answers one of our buttons: the tapped quick reply, or the same title typed by the
 * person we sent the buttons to. Returns the rule option to send, or null for an ordinary DM.
 */
async function resolveTap(store: InboxStore, event: IncomingEvent, rules: ReplyRule[]) {
  if (event.kind !== "dm") return null;
  let tap = parseButtonPayload(event.payload);
  if (!tap) {
    const typed = normalizeText(event.text).trim();
    const now = Date.now();
    const sources = (await store.listEvents(THREAD_EVENT_LIMIT)).filter((e) => e.senderId === event.senderId);
    const offered = (await store.listReplies({ status: "sent", eventIds: sources.map((e) => e.id) }))
      .filter((r) => r.quickReplies?.length && r.sentAt && now - r.sentAt.getTime() <= TAP_WINDOW_MS)
      .sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0));
    for (const reply of offered) {
      const hit = reply.quickReplies!.find((q) => normalizeText(q.title).trim() === typed);
      if (hit) {
        tap = parseButtonPayload(hit.payload);
        break;
      }
    }
  }
  if (!tap) return null;
  const rule = rules.find((r) => r.id === tap!.ruleId);
  const button = rule?.dmButtons?.[tap.index];
  if (!rule || !button) return null;
  const source = await store.getEvent(tap.eventId);
  return { rule, parts: splitMessages(renderTemplate(button.reply, source?.username ?? "")) };
}

/**
 * Stores events and drafts the replies their rules call for. Returns the reply ids to send right
 * away: auto-reply on and rule action "send", or the answer to a tapped button (approving the
 * first DM approved its options). `allowAutoSend: false` keeps rule drafts in the approval queue;
 * imported history passes `draft: false` (old messages shouldn't flood the queue) and `read: true`.
 */
export async function ingestEvents(store: InboxStore, events: IncomingEvent[], options: { allowAutoSend?: boolean; draft?: boolean; read?: boolean } = {}) {
  const [rules, templates] = events.length ? await Promise.all([store.listRules(), store.listTemplates()]) : [[], []];
  const autoSend = (options.allowAutoSend ?? true) && isAutoReplyEnabled();
  const toSend: number[] = [];
  let stored = 0;
  let duplicates = 0;

  for (const event of events) {
    const tap = options.draft === false ? null : await resolveTap(store, event, rules);
    const decision = tap ? null : decideReply(rules, templates, event.kind, event.username ?? "", event.text, event.mediaId);
    const { at, payload: _payload, ...fields } = event;
    const ruleId = tap?.rule.id ?? decision?.rule.id ?? null;
    const saved = await store.insertEvent({ ...fields, ruleId, ...(at ? { createdAt: at } : {}), ...(options.read ? { isRead: true } : {}) });
    if (!saved) {
      duplicates++;
      continue;
    }
    stored++;
    if (tap) {
      for (const text of tap.parts) {
        toSend.push((await store.createReply({ eventId: saved.id, ruleId: tap.rule.id, source: "rule", channel: "reply", text, status: "pending" })).id);
      }
      continue;
    }
    if (!decision || options.draft === false) continue;
    const ids = await createDrafts(store, saved, decision);
    if (autoSend && decision.rule.action === "send") toSend.push(...ids);
  }
  return { stored, duplicates, toSend };
}

/** Messages this recent are re-checked when rules change; older ones need "apply to unanswered". */
const REDRAFT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Brings the approval queue in line with the current rules and templates. Looks at every message
 * that still has a pending rule draft (however old: "apply to unanswered" drafts old comments
 * too) and at recent messages without any reply. Each channel (reply in place, private DM) is
 * judged on its own: one with a sent, failed, rejected or manual reply is settled and left alone;
 * the pending drafts of the others are drafted again. Never sends anything.
 */
export async function redraftPending(store: InboxStore, now = new Date()) {
  const [events, rules, templates, pending] = await Promise.all([
    store.listEvents(THREAD_EVENT_LIMIT),
    store.listRules(),
    store.listTemplates(),
    store.listReplies({ status: "pending" }),
  ]);
  const withDrafts = new Set(pending.filter((r) => r.source === "rule").map((r) => r.eventId));
  const byId = new Map(events.map((e) => [e.id, e] as const));
  for (const id of Array.from(withDrafts)) {
    if (!byId.has(id)) {
      const event = await store.getEvent(id);
      if (event) byId.set(id, event);
    }
  }
  const candidates = Array.from(byId.values()).filter((e) => withDrafts.has(e.id) || now.getTime() - e.createdAt.getTime() <= REDRAFT_WINDOW_MS);
  const replies = await store.listReplies({ eventIds: candidates.map((e) => e.id) });
  let updated = 0;
  for (const event of candidates) {
    // In creation order, like draftParts (the database store lists newest first).
    const own = replies.filter((r) => r.eventId === event.id).sort((a, b) => a.id - b.id);
    if (own.some((r) => r.status === "sending")) continue;
    const sent = new Set(own.filter((r) => r.status !== "pending" || r.source !== "rule").map((r) => r.channel));
    // A channel past Instagram's deadline is left as it is: its drafts can only be rejected.
    const closed = closedChannels(event, now);
    const open = (channel: Reply["channel"]) => !sent.has(channel) && !closed.has(channel);
    const drafts = own.filter((r) => r.status === "pending" && r.source === "rule" && open(r.channel));
    const decision = decideReply(rules, templates, event.kind, event.username ?? "", event.text, event.mediaId);
    const ruleId = decision?.rule.id ?? null;
    const wanted = decision ? draftParts(event, decision).filter((p) => open(p.channel)) : [];
    const same =
      drafts.length === wanted.length &&
      drafts.every(
        (r, i) =>
          r.channel === wanted[i].channel &&
          r.text === wanted[i].text &&
          JSON.stringify(r.quickReplies ?? null) === JSON.stringify(wanted[i].quickReplies) &&
          r.ruleId === ruleId,
      );
    if (same && (sent.size > 0 || event.ruleId === ruleId)) continue;
    await store.deletePendingReplies(drafts.map((r) => r.id));
    // Keep the tag of the rule that answered, if part of the answer already went out.
    if (!sent.size) await store.setEventRule(event.id, ruleId);
    for (const part of wanted) {
      await store.createReply({ eventId: event.id, ruleId, source: "rule", channel: part.channel, text: part.text, quickReplies: part.quickReplies, status: "pending" });
    }
    updated++;
  }
  return { updated };
}

/**
 * Runs the current rules over events that never got any reply or draft (e.g. they arrived before
 * the rule existed). Drafts always wait for approval; nothing is sent automatically.
 */
export async function applyRulesToUnanswered(store: InboxStore) {
  // First bring drafts already in the queue up to date with the current rules.
  const { updated } = await redraftPending(store);
  const [events, rules, templates] = await Promise.all([store.listEvents(THREAD_EVENT_LIMIT), store.listRules(), store.listTemplates()]);
  const answered = new Set((await store.listReplies({ eventIds: events.map((e) => e.id) })).map((r) => r.eventId));
  let drafted = 0;
  for (const event of events) {
    if (answered.has(event.id)) continue;
    const decision = decideReply(rules, templates, event.kind, event.username ?? "", event.text, event.mediaId);
    if (!decision) continue;
    if ((await createDrafts(store, event, decision)).length) drafted++;
  }
  return { drafted, updated };
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
    // Past Instagram's deadline the API only answers with an error; say why without calling it.
    const deadline = deadlineOf(event, reply.channel, event.kind === "dm" ? await latestDms(store) : new Map());
    if (deadline && deadline <= new Date()) throw new Error(reply.channel === "private" ? PRIVATE_WINDOW_CLOSED : DM_WINDOW_CLOSED);
    const buttons = reply.quickReplies?.length ? reply.quickReplies : null;
    const send = (body: string, quickReplies: QuickReply[] | null) =>
      reply.channel === "private"
        ? sendPrivateReply(event.externalId, body, quickReplies)
        : event.kind === "comment"
          ? replyToComment(event.externalId, body)
          : sendDirectMessage(event.senderId, body, quickReplies);
    let sentText = text;
    try {
      await send(text, buttons);
    } catch (error) {
      // If Instagram refuses the buttons, send the options as text; typing one still counts as a tap.
      if (!buttons) throw error;
      sentText = optionsAsText(text, buttons);
      await send(sentText, null);
    }
    await store.updateReply(replyId, { text: sentText, status: "sent", error: null, decidedBy: operatorId, sentAt: new Date() });
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
  // "---" lines split the text into several messages (several replies under a comment, or
  // several DMs), sent in order; a failure stops the rest so they never arrive out of order.
  let result: Awaited<ReturnType<typeof sendReply>> = { ok: false, error: "متن پاسخ خالی است" };
  for (const part of splitMessages(text)) {
    const reply = await store.createReply({ eventId, source: "manual", text: part, status: "pending", decidedBy: operatorId });
    result = await sendReply(store, reply.id, operatorId);
    if (!result.ok) break;
  }
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
  const open = [...pending, ...failed];
  const sent = await store.listReplies({ status: "sent", eventIds: Array.from(new Set(open.map((r) => r.eventId))) });
  const answered = new Set(sent.map((r) => r.eventId));
  const dms = await latestDms(store);
  const items: ApprovalItem[] = [];
  for (const reply of open) {
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
      buttons: reply.quickReplies?.map((q) => q.title) ?? [],
      receivedAt: event.createdAt,
      answered: answered.has(reply.eventId),
      expiresAt: deadlineOf(event, reply.channel, dms),
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
  /** Comment count Instagram reported at the last sync. */
  igComments: number | null;
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
  const blank = (id: string): PostSummary => ({ id, caption: null, mediaType: null, imageUrl: null, permalink: null, postedAt: null, comments: 0, igComments: null, pending: 0, repliesSent: 0, dmsSent: 0, rules: 0, synced: false });
  for (const m of media) {
    posts.set(m.id, { ...blank(m.id), caption: m.caption, mediaType: m.mediaType, imageUrl: m.thumbnailUrl ?? m.mediaUrl, permalink: m.permalink, postedAt: m.postedAt, igComments: m.commentsCount ?? null, synced: true });
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
export async function importPostComments(store: InboxStore, mediaId: string, accountId: string, options: { draft?: boolean; read?: boolean } = {}) {
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
    events.push({ accountId, kind: "comment", externalId: c.id, senderId, username: c.username, text: c.text, mediaId, at: c.at });
  }
  const result = await ingestEvents(store, events, { allowAutoSend: false, ...options });
  return { fetched: comments.length, imported: result.stored, alreadyThere: result.duplicates, own: skippedOwn };
}

/** Posts whose comments the history import reads; each one is a Graph call. */
const HISTORY_POSTS = 12;

/**
 * Fills the inbox with what happened before the webhook worked: comments on recent posts and recent
 * DMs. Nothing is drafted or sent; "apply rules to unanswered" does that on request.
 * `hiddenComments` counts comments Instagram reports but won't return, which is what Meta does
 * for people without a role on the app while it is in Development mode.
 */
export async function importHistory(store: InboxStore, accountId: string) {
  // Without this subscription Meta sends no new events either.
  const subscription = await getWebhookSubscription().catch(() => null);
  if (subscription?.missing.length) await subscribeWebhooks().catch(() => undefined);

  await syncPosts(store);
  const posts = (await store.listMedia())
    .filter((m) => (m.commentsCount ?? 0) > 0)
    .sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0))
    .slice(0, HISTORY_POSTS);
  const comments = { posts: posts.length, reported: 0, fetched: 0, imported: 0, hidden: 0 };
  for (const post of posts) {
    const result = await importPostComments(store, post.id, accountId, { draft: false, read: true });
    comments.reported += post.commentsCount ?? 0;
    comments.fetched += result.fetched;
    comments.imported += result.imported;
    if (!result.fetched) comments.hidden += post.commentsCount ?? 0;
  }

  const dms = { fetched: 0, imported: 0, error: null as string | null };
  try {
    const own = await ownUsername();
    const messages = (await listRecentMessages()).filter((m) => m.fromId !== accountId && (!own || m.username !== own));
    const result = await ingestEvents(
      store,
      messages.map((m) => ({ accountId, kind: "dm" as const, externalId: m.id, senderId: m.fromId, username: m.username, text: m.text, mediaId: null, at: m.at })),
      { allowAutoSend: false, draft: false, read: true },
    );
    dms.fetched = messages.length;
    dms.imported = result.stored;
  } catch (error) {
    dms.error = error instanceof Error ? error.message : String(error);
  }
  return { comments, dms };
}
