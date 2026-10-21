export type InboxChannel = "DM" | "کامنت";
export type InboxKind = "comment" | "dm";
export type ReplyStatus = "pending" | "sending" | "sent" | "rejected" | "failed";

export type InboxMessage = {
  id: string;
  from: "contact" | "agent";
  text: string;
  at: Date;
  /** Only for agent messages. */
  status?: ReplyStatus;
  error?: string | null;
  /** "dm": a private reply sent to a commenter's inbox. */
  via?: "dm";
};

export type InboxThread = {
  /** `${kind}:${senderId}` */
  id: string;
  kind: InboxKind;
  channel: InboxChannel;
  senderId: string;
  name: string;
  handle: string;
  message: string;
  updatedAt: Date;
  tag: string;
  tagTone: string;
  unread: boolean;
  /** Has a reply waiting for operator approval. */
  priority: boolean;
  avatar: string;
  /** Latest incoming event; manual replies answer this one. */
  lastEventId: number;
  messages: InboxMessage[];
};

export type ApprovalItem = {
  id: number;
  threadId: string;
  channel: InboxChannel;
  name: string;
  handle: string;
  incoming: string;
  draft: string;
  reason: string;
  /** "reply": answer in place (comment reply / DM); "private": DM to the commenter. */
  replyChannel: "reply" | "private";
  /** Titles of the quick-reply buttons sent with this message. */
  buttons: string[];
  /** When the comment or DM itself arrived; createdAt is when the draft was made. */
  receivedAt: Date;
  /** The comment or DM already has a sent reply on some channel. */
  answered: boolean;
  /** When Instagram stops accepting this reply; null when it has no deadline. */
  expiresAt: Date | null;
  mediaId: string | null;
  tone: string;
  status: ReplyStatus;
  error: string | null;
  createdAt: Date;
};

const HOUR_MS = 60 * 60 * 1000;
/** Instagram accepts the one private reply to a comment for 7 days after the comment. */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * HOUR_MS;
/** A DM can be answered for 24 hours after the customer's latest message. */
export const DM_WINDOW_MS = 24 * HOUR_MS;

/**
 * When Instagram stops accepting a reply: `receivedAt` is the comment's time for a private reply
 * and the customer's latest DM for a DM. Replies under a comment have no deadline.
 */
export function replyDeadline(kind: InboxKind, channel: "reply" | "private", receivedAt: Date): Date | null {
  if (kind === "comment" && channel === "reply") return null;
  return new Date(receivedAt.getTime() + (kind === "comment" ? PRIVATE_REPLY_WINDOW_MS : DM_WINDOW_MS));
}

export const PRIVATE_WINDOW_CLOSED = "مهلت اینستاگرام گذشته: دایرکت به نویسندهٔ کامنت فقط تا ۷ روز بعد از کامنت ممکن است. پاسخ زیر کامنت هنوز ممکن است.";
export const DM_WINDOW_CLOSED = "مهلت اینستاگرام گذشته: به دایرکت فقط تا ۲۴ ساعت بعد از آخرین پیام مشتری می‌شود جواب داد. اگر دوباره پیام بدهد، مهلت دوباره باز می‌شود.";
/** Instagram's own refusal (code 10 / 2534022) when the window has closed. */
export const WINDOW_CLOSED = "مهلت ارسال اینستاگرام گذشته (دایرکت: ۲۴ ساعت بعد از آخرین پیام مشتری؛ دایرکت به نویسندهٔ کامنت: ۷ روز بعد از کامنت).";

/** Public reply that replaces a private DM Instagram no longer allows: the customer's DM reopens the window. */
export const DM_INVITE_TEXT = "سلام {{username}}، لطفاً به دایرکت پیج پیام بدهید تا جواب‌تان را همان‌جا بفرستیم 🌹";

export const channelOf = (kind: InboxKind): InboxChannel => (kind === "dm" ? "DM" : "کامنت");

export type InboxFilter = "all" | "unread" | "priority" | "unanswered";

/** The contact's latest message has no sent reply after it. */
export function isUnanswered(thread: InboxThread) {
  let lastContact = -1;
  thread.messages.forEach((m, i) => {
    if (m.from === "contact") lastContact = i;
  });
  if (lastContact < 0) return false;
  return !thread.messages.slice(lastContact + 1).some((m) => m.from === "agent" && m.status === "sent");
}

export function filterInboxThreads(
  threads: InboxThread[],
  search: string,
  filter: InboxFilter,
  channelFilter: "all" | InboxChannel,
) {
  return threads.filter((thread) => {
    const matchesSearch = `${thread.name} ${thread.handle} ${thread.message} ${thread.tag}`.toLowerCase().includes(search.toLowerCase());
    const matchesFilter =
      filter === "all" || (filter === "unread" ? thread.unread : filter === "unanswered" ? isUnanswered(thread) : thread.priority);
    const matchesChannel = channelFilter === "all" || thread.channel === channelFilter;
    return matchesSearch && matchesFilter && matchesChannel;
  });
}

/**
 * Account ids as typed on a Persian keyboard: Persian/Arabic digits, the Persian comma «،» and
 * spaces become "17841457283303858,…".
 */
export function normalizeAccountIds(value: string) {
  return toLatinDigits(value)
    .replace(/[،؛;\s]+/g, ",")
    .replace(/,{2,}/g, ",")
    .replace(/^,|,$/g, "");
}

export function toLatinDigits(value: string) {
  return value.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** Instagram's limit for one comment reply or DM. */
export const MAX_MESSAGE_LENGTH = 1000;

/** A line holding only "---" splits a reply into separate messages, sent in order. */
export function splitMessages(text: string) {
  return text
    .split(/^[ \t]*-{3,}[ \t]*$/m)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** A private reply to a comment can only be one message, so its parts become paragraphs. */
export const joinMessages = (text: string) => splitMessages(text).join("\n\n");

export const messagesFit = (text: string) => splitMessages(text).every((part) => part.length <= MAX_MESSAGE_LENGTH);

export const MESSAGES_TOO_LONG = "هر پیام حداکثر ۱۰۰۰ کاراکتر است؛ متن طولانی را با یک خط --- به چند پیام تقسیم کنید";

/** A button under a rule's DM and the reply it sends when tapped. */
export type DmButton = { title: string; reply: string };
/** An Instagram quick reply as sent: the payload says which rule option it was. */
export type QuickReply = { title: string; payload: string };

export const MAX_BUTTONS = 13;
export const MAX_BUTTON_TITLE = 20;

export const buttonPayload = (ruleId: number, index: number, eventId: number) => `SEPAND:${ruleId}:${index}:${eventId}`;

export function parseButtonPayload(payload: string | null | undefined) {
  const m = /^SEPAND:(\d+):(\d+):(\d+)$/.exec(payload ?? "");
  return m ? { ruleId: Number(m[1]), index: Number(m[2]), eventId: Number(m[3]) } : null;
}

/** When Instagram refuses the buttons, the options go into the text; typing one counts as a tap. */
export const optionsAsText = (text: string, buttons: QuickReply[]) =>
  `${text}\n\nبرای ادامه یکی از این‌ها را بنویسید: ${buttons.map((b) => `«${b.title}»`).join("، ")}`;
