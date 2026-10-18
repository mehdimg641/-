import { createHmac, timingSafeEqual } from "crypto";
import type { Express, Request, Response } from "express";

// Instagram API with Instagram Login (graph.instagram.com).
// Tokens generated under "API setup with Instagram login" only work on this host.
const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v23.0";
const GRAPH_BASE = `https://graph.instagram.com/${GRAPH_VERSION}`;

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
  timestamp?: number;
  message?: { mid?: string; text?: string; is_echo?: boolean };
};

type WebhookBody = {
  object?: string;
  entry?: Array<{ id?: string; changes?: ChangeEvent[]; messaging?: MessagingEvent[] }>;
};

export type DraftReply =
  | { kind: "comment"; commentId: string; username: string; incoming: string; reply: string }
  | { kind: "dm"; recipientId: string; incoming: string; reply: string };

export function isMetaWebhookConfigured() {
  return Boolean(process.env.META_WEBHOOK_VERIFY_TOKEN && process.env.META_ACCESS_TOKEN);
}

/** Replies are only sent when explicitly enabled; otherwise they are logged as drafts for review. */
export function isAutoReplyEnabled() {
  return process.env.META_AUTO_REPLY === "true";
}

export function getMetaWebhookChallenge(mode: unknown, token: unknown, challenge: unknown) {
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!expected || mode !== "subscribe" || token !== expected || !challenge) return null;
  return String(challenge);
}

/** Validates X-Hub-Signature-256 when META_APP_SECRET is set. */
export function isValidSignature(rawBody: Buffer | undefined, header: unknown) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true;
  if (!rawBody || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"));
  const received = Buffer.from(header.slice("sha256=".length));
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function buildPersonalizedMessage(username: string, sourceText: string) {
  const greeting = username ? `سلام ${username}، ` : "سلام، ";
  const normalized = sourceText.toLowerCase();
  if (normalized.includes("قیمت") || normalized.includes("نرخ") || normalized.includes("استعلام")) {
    return `${greeting}برای اعلام قیمت دقیق لطفاً سایز، تناژ و شهر مقصد را دایرکت کنید.`;
  }
  if (normalized.includes("آنالیز") || normalized.includes("کیفیت") || normalized.includes("3sp") || normalized.includes("4sp") || normalized.includes("5sp")) {
    return `${greeting}نوع شمش و سایز موردنظر را بفرمایید تا آنالیز و مشخصات فنی مناسب ارسال شود.`;
  }
  return `${greeting}درخواست شما ثبت شد. لطفاً مشخصات کامل را بفرستید تا همکار فروش راهنمایی کند.`;
}

/** Turns a webhook payload into reply drafts, skipping our own comments and echoed DMs. */
export function extractDrafts(body: WebhookBody): DraftReply[] {
  const ownId = process.env.META_INSTAGRAM_ACCOUNT_ID;
  const drafts: DraftReply[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (change.field !== "comments" || !v?.id || !v.text) continue;
      if (v.from?.id && (v.from.id === ownId || v.from.id === entry.id)) continue;
      const username = v.from?.username ?? "";
      drafts.push({ kind: "comment", commentId: v.id, username, incoming: v.text, reply: buildPersonalizedMessage(username, v.text) });
    }
    for (const m of entry.messaging ?? []) {
      const text = m.message?.text;
      const senderId = m.sender?.id;
      if (!text || !senderId || m.message?.is_echo) continue;
      if (senderId === ownId || senderId === entry.id) continue;
      drafts.push({ kind: "dm", recipientId: senderId, incoming: text, reply: buildPersonalizedMessage("", text) });
    }
  }
  return drafts;
}

async function graphPost(path: string, body: Record<string, unknown>) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return { skipped: true, reason: "META_ACCESS_TOKEN is not configured" };
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Instagram Graph API ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function sendDraft(draft: DraftReply) {
  if (draft.kind === "comment") {
    return graphPost(`/${encodeURIComponent(draft.commentId)}/replies`, { message: draft.reply });
  }
  return graphPost(`/me/messages`, { recipient: { id: draft.recipientId }, message: { text: draft.reply } });
}

export function registerMetaWebhook(app: Express) {
  app.get("/api/meta/webhook", (req: Request, res: Response) => {
    const challenge = getMetaWebhookChallenge(req.query["hub.mode"], req.query["hub.verify_token"], req.query["hub.challenge"]);
    if (challenge) return res.status(200).type("text/plain").send(challenge);
    return res.status(403).json({ error: "Invalid webhook verification token" });
  });

  app.post("/api/meta/webhook", async (req: Request, res: Response) => {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!isValidSignature(rawBody, req.headers["x-hub-signature-256"])) {
      return res.status(401).json({ error: "Invalid signature" });
    }
    const body = req.body as WebhookBody;
    if (body?.object !== "instagram") return res.status(404).json({ error: "Unsupported Meta object" });

    res.status(200).json({ received: true });
    for (const draft of extractDrafts(body)) {
      if (!isAutoReplyEnabled()) {
        console.log("[Meta Webhook] Draft (auto-reply off):", JSON.stringify(draft));
        continue;
      }
      try {
        await sendDraft(draft);
      } catch (error) {
        console.error("[Meta Webhook] Failed to send reply:", error);
      }
    }
  });
}
