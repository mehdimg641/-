import { createHmac, timingSafeEqual } from "crypto";
import express, { type Express, type Request, type Response } from "express";
import { enabledAccounts } from "./accounts";
import { applyCustomerReactions, ingestEvents, sendReply, type CustomerReaction } from "./inboxService";
import { getInboxStore } from "./inboxStore";
import { metaSetting, refreshMetaSettings } from "./metaSettings";
import { recordWebhook } from "./webhookLog";

const WEBHOOK_PATH = "/api/meta/webhook";
const MAX_BODY = "1mb";
const MAX_EVENTS_PER_REQUEST = 1000;

/** Comment webhook: entry[].changes[] = { field: "comments", value: {...} } */
type ChangeEvent = {
  field?: string;
  value?: {
    id?: string;
    text?: string;
    from?: { id?: string; username?: string };
    media?: { id?: string };
  };
};

/** DM webhook: entry[].messaging[] = { sender, recipient, message } */
type MessagingEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  message?: { mid?: string; text?: string; is_echo?: boolean; is_deleted?: boolean; quick_reply?: { payload?: string } };
  /** message_reactions: someone reacted to (or un-reacted from) a message. */
  reaction?: { mid?: string; action?: "react" | "unreact"; reaction?: string; emoji?: string };
};

export type WebhookBody = {
  object?: string;
  entry?: Array<{ id?: string; changes?: ChangeEvent[]; messaging?: MessagingEvent[] }>;
};

export type IncomingEvent = {
  accountId: string;
  kind: "comment" | "dm";
  externalId: string;
  senderId: string;
  username: string | null;
  text: string;
  mediaId: string | null;
  /** When it was written; set for imported history, webhooks use the arrival time. */
  at?: Date | null;
  /** The quick-reply button the customer tapped, if any. */
  payload?: string | null;
};

function constantTimeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isMetaWebhookConfigured() {
  return Boolean(metaSetting("META_WEBHOOK_VERIFY_TOKEN") && metaSetting("META_ACCESS_TOKEN") && metaSetting("META_APP_SECRET"));
}

export function getMetaWebhookChallenge(mode: unknown, token: unknown, challenge: unknown) {
  // Copying from a web page easily picks up a space or newline; neither side may contain one on purpose.
  const expected = metaSetting("META_WEBHOOK_VERIFY_TOKEN").trim();
  if (!expected || mode !== "subscribe" || typeof token !== "string" || !challenge) return null;
  return constantTimeEqual(token.trim(), expected) ? String(challenge) : null;
}

/** "ab…yz (24)": enough to tell two verify tokens apart in the log without writing either one down. */
export function tokenHint(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "(empty)";
  const chars = Array.from(text);
  return `${chars.length <= 6 ? "•".repeat(chars.length) : `${chars.slice(0, 2).join("")}…${chars.slice(-2).join("")}`} (${chars.length})`;
}

/** Validates X-Hub-Signature-256. Fails closed when META_APP_SECRET is missing. */
export function verifyMetaSignature(rawBody: Buffer | undefined, header: unknown) {
  const secret = metaSetting("META_APP_SECRET");
  if (!secret || !rawBody) return false;
  if (typeof header !== "string" || !/^sha256=[a-f0-9]{64}$/i.test(header)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return constantTimeEqual(header.slice("sha256=".length).toLowerCase(), expected);
}

/**
 * INSTAGRAM_ACCOUNT_IDS (comma separated) or META_INSTAGRAM_ACCOUNT_ID, plus the connected pages.
 * Empty = accept every account.
 */
export function allowedAccountIds(pages: string[] = []) {
  const raw = metaSetting("INSTAGRAM_ACCOUNT_IDS") || process.env.META_INSTAGRAM_ACCOUNT_ID || "";
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return Array.from(new Set([...ids, ...pages]));
}

const REACTION_EMOJI: Record<string, string> = { love: "❤️", like: "👍", laugh: "😂", wow: "😮", sad: "😢", angry: "😡", smile: "😊" };

/** Customers' reactions to our DMs (message_reactions); our own reactions echo back and are skipped. */
export function extractReactions(body: WebhookBody, pages: string[] = []): CustomerReaction[] {
  const allowed = allowedAccountIds(pages);
  const ownIds = new Set(allowed);
  const reactions: CustomerReaction[] = [];
  for (const entry of body.entry ?? []) {
    const accountId = entry.id;
    if (!accountId || (allowed.length > 0 && !ownIds.has(accountId))) continue;
    for (const m of entry.messaging ?? []) {
      const r = m.reaction;
      const senderId = m.sender?.id;
      if (!r?.mid || !senderId || senderId === accountId || ownIds.has(senderId)) continue;
      const emoji = r.action === "unreact" ? null : r.emoji || REACTION_EMOJI[r.reaction ?? ""] || "❤️";
      reactions.push({ mid: r.mid, emoji });
      if (reactions.length >= MAX_EVENTS_PER_REQUEST) return reactions;
    }
  }
  return reactions;
}

/**
 * Turns a verified webhook payload into inbox events. Skips our own comments and echoed DMs
 * (replying to them would loop), deleted messages, read/delivery receipts and other fields.
 */
export function extractEvents(body: WebhookBody, pages: string[] = []): IncomingEvent[] {
  const allowed = allowedAccountIds(pages);
  const ownIds = new Set(allowed);
  const events: IncomingEvent[] = [];
  let seen = 0;

  for (const entry of body.entry ?? []) {
    const accountId = entry.id;
    if (!accountId || (allowed.length > 0 && !ownIds.has(accountId))) continue;
    const isOwn = (id: string | undefined) => id === accountId || (id !== undefined && ownIds.has(id));

    for (const change of entry.changes ?? []) {
      if (++seen > MAX_EVENTS_PER_REQUEST) return events;
      const v = change.value;
      if (change.field !== "comments" || !v?.id || !v.text || !v.from?.id || isOwn(v.from.id)) continue;
      events.push({
        accountId,
        kind: "comment",
        externalId: v.id,
        senderId: v.from.id,
        username: v.from.username ?? null,
        text: v.text,
        mediaId: v.media?.id ?? null,
      });
    }

    for (const m of entry.messaging ?? []) {
      if (++seen > MAX_EVENTS_PER_REQUEST) return events;
      const message = m.message;
      const senderId = m.sender?.id;
      if (!message?.mid || !message.text || message.is_echo || message.is_deleted) continue;
      if (!senderId || isOwn(senderId)) continue;
      events.push({
        accountId,
        kind: "dm",
        externalId: message.mid,
        senderId,
        username: null,
        text: message.text,
        mediaId: null,
        payload: message.quick_reply?.payload ?? null,
      });
    }
  }
  return events;
}

/** Which accounts and fields a payload carried, for the webhook log. */
export function describePayload(body: WebhookBody) {
  const accounts = new Set<string>();
  const fields = new Set<string>();
  let items = 0;
  for (const entry of body.entry ?? []) {
    if (entry.id) accounts.add(entry.id);
    for (const change of entry.changes ?? []) {
      fields.add(change.field ?? "?");
      items++;
    }
    if (entry.messaging?.length) {
      fields.add("messaging");
      items += entry.messaging.length;
    }
  }
  return { accounts: Array.from(accounts), fields: Array.from(fields), items };
}

function describeResult(payload: ReturnType<typeof describePayload>, kept: number, result: { stored: number; duplicates: number }) {
  return `accounts: ${payload.accounts.join(",") || "-"} | fields: ${payload.fields.join(",") || "-"} | stored ${result.stored}, duplicate ${result.duplicates}, ignored ${payload.items - kept}`;
}

const WEBHOOK_HELLO =
  "✓ وبهوک Sepand Inbox فعال است.\nاین آدرس را در داشبورد Meta به‌عنوان Callback URL وارد کنید؛ Meta با Verify Token تأییدش می‌کند (باز کردن در مرورگر لازم نیست).\nنتیجهٔ درخواست‌های Meta: تنظیمات ← عیب‌یابی دریافت پیام.\n\n✓ Sepand Inbox webhook is up. Use this URL as the Callback URL in the Meta dashboard; Meta verifies it with the Verify Token.\n";

export function registerMetaWebhook(app: Express) {
  app.get(WEBHOOK_PATH, async (req: Request, res: Response) => {
    // Someone opened the URL in a browser; Meta always sends hub.mode. Say it works instead of "invalid".
    if (req.query["hub.mode"] === undefined) return res.status(200).type("text/plain; charset=utf-8").send(WEBHOOK_HELLO);
    await refreshMetaSettings();
    const challenge = getMetaWebhookChallenge(req.query["hub.mode"], req.query["hub.verify_token"], req.query["hub.challenge"]);
    if (challenge) {
      recordWebhook({ method: "GET", status: 200, outcome: "challenge_ok", detail: "" });
      return res.status(200).type("text/plain").send(challenge);
    }
    recordWebhook({
      method: "GET",
      status: 403,
      outcome: "challenge_bad_token",
      detail: `Meta sent ${tokenHint(req.query["hub.verify_token"])}, saved here ${tokenHint(metaSetting("META_WEBHOOK_VERIFY_TOKEN"))}`,
    });
    return res.status(403).json({ error: "Invalid webhook verification token" });
  });

  // Raw body parser: the signature is computed over the exact bytes Meta sent.
  // Must be registered before the global express.json() middleware.
  app.post(WEBHOOK_PATH, express.raw({ type: "*/*", limit: MAX_BODY }), async (req: Request, res: Response) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : undefined;
    await refreshMetaSettings();
    if (!verifyMetaSignature(rawBody, req.get("x-hub-signature-256"))) {
      recordWebhook({ method: "POST", status: 401, outcome: "bad_signature", detail: "" });
      return res.status(401).json({ error: "Invalid signature" });
    }

    let body: WebhookBody;
    try {
      body = JSON.parse(rawBody!.toString("utf8")) as WebhookBody;
    } catch {
      recordWebhook({ method: "POST", status: 400, outcome: "bad_json", detail: "" });
      return res.status(400).json({ error: "Invalid JSON" });
    }
    if (body?.object !== "instagram") {
      recordWebhook({ method: "POST", status: 404, outcome: "other_object", detail: String(body?.object ?? "") });
      return res.status(404).json({ error: "Unsupported Meta object" });
    }

    // Store before acknowledging: on a storage error Meta gets a 5xx and retries later.
    let toSend: number[];
    const payload = describePayload(body);
    try {
      const store = await getInboxStore();
      const pages = (await enabledAccounts(store)).map((a) => a.id);
      const events = extractEvents(body, pages);
      const result = await ingestEvents(store, events);
      await applyCustomerReactions(store, extractReactions(body, pages));
      toSend = result.toSend;
      recordWebhook({ method: "POST", status: 200, outcome: "received", detail: describeResult(payload, events.length, result), accounts: payload.accounts });
    } catch (error) {
      console.error("[Meta Webhook] Failed to store events:", error);
      recordWebhook({ method: "POST", status: 503, outcome: "error", detail: error instanceof Error ? error.message : String(error) });
      return res.status(503).set("Retry-After", "60").json({ error: "Temporarily unavailable" });
    }

    res.status(200).json({ received: true });

    const store = await getInboxStore();
    for (const replyId of toSend) {
      await sendReply(store, replyId, null).catch((error) => console.error("[Meta Webhook] Auto-reply failed:", error));
    }
  });
}
