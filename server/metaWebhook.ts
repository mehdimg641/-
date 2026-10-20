import { createHmac, timingSafeEqual } from "crypto";
import express, { type Express, type Request, type Response } from "express";
import { ingestEvents, sendReply } from "./inboxService";
import { getInboxStore } from "./inboxStore";
import { metaSetting, refreshMetaSettings } from "./metaSettings";

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
  message?: { mid?: string; text?: string; is_echo?: boolean; is_deleted?: boolean };
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
  const expected = metaSetting("META_WEBHOOK_VERIFY_TOKEN");
  if (!expected || mode !== "subscribe" || typeof token !== "string" || !challenge) return null;
  return constantTimeEqual(token, expected) ? String(challenge) : null;
}

/** Validates X-Hub-Signature-256. Fails closed when META_APP_SECRET is missing. */
export function verifyMetaSignature(rawBody: Buffer | undefined, header: unknown) {
  const secret = metaSetting("META_APP_SECRET");
  if (!secret || !rawBody) return false;
  if (typeof header !== "string" || !/^sha256=[a-f0-9]{64}$/i.test(header)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return constantTimeEqual(header.slice("sha256=".length).toLowerCase(), expected);
}

/** INSTAGRAM_ACCOUNT_IDS (comma separated) or META_INSTAGRAM_ACCOUNT_ID. Empty = accept every account. */
export function allowedAccountIds() {
  const raw = metaSetting("INSTAGRAM_ACCOUNT_IDS") || process.env.META_INSTAGRAM_ACCOUNT_ID || "";
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Turns a verified webhook payload into inbox events. Skips our own comments and echoed DMs
 * (replying to them would loop), deleted messages, read/delivery receipts and other fields.
 */
export function extractEvents(body: WebhookBody): IncomingEvent[] {
  const allowed = allowedAccountIds();
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
      });
    }
  }
  return events;
}

export function registerMetaWebhook(app: Express) {
  app.get(WEBHOOK_PATH, async (req: Request, res: Response) => {
    await refreshMetaSettings();
    const challenge = getMetaWebhookChallenge(req.query["hub.mode"], req.query["hub.verify_token"], req.query["hub.challenge"]);
    if (challenge) return res.status(200).type("text/plain").send(challenge);
    return res.status(403).json({ error: "Invalid webhook verification token" });
  });

  // Raw body parser: the signature is computed over the exact bytes Meta sent.
  // Must be registered before the global express.json() middleware.
  app.post(WEBHOOK_PATH, express.raw({ type: "*/*", limit: MAX_BODY }), async (req: Request, res: Response) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : undefined;
    await refreshMetaSettings();
    if (!verifyMetaSignature(rawBody, req.get("x-hub-signature-256"))) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    let body: WebhookBody;
    try {
      body = JSON.parse(rawBody!.toString("utf8")) as WebhookBody;
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }
    if (body?.object !== "instagram") return res.status(404).json({ error: "Unsupported Meta object" });

    // Store before acknowledging: on a storage error Meta gets a 5xx and retries later.
    let toSend: number[];
    try {
      const store = await getInboxStore();
      ({ toSend } = await ingestEvents(store, extractEvents(body)));
    } catch (error) {
      console.error("[Meta Webhook] Failed to store events:", error);
      return res.status(503).set("Retry-After", "60").json({ error: "Temporarily unavailable" });
    }

    res.status(200).json({ received: true });

    const store = await getInboxStore();
    for (const replyId of toSend) {
      await sendReply(store, replyId, null).catch((error) => console.error("[Meta Webhook] Auto-reply failed:", error));
    }
  });
}
