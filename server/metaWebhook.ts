import { createHmac, timingSafeEqual } from "crypto";
import type { Express, Request, Response } from "express";
import { decideReply, holdForApproval } from "./replyRules";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

type MetaEvent = {
  field?: string;
  value?: Record<string, unknown>;
  // Instagram messaging events (entry[].messaging[]) have no field/value wrapper.
  sender?: { id?: string };
  recipient?: { id?: string };
  message?: { mid?: string; text?: string; is_echo?: boolean };
};

const handledIds = new Set<string>();

function alreadyHandled(id: string) {
  if (!id) return false;
  if (handledIds.has(id)) return true;
  handledIds.add(id);
  if (handledIds.size > 5000) handledIds.delete(handledIds.values().next().value as string);
  return false;
}

export function verifyMetaSignature(rawBody: Buffer | undefined, header: unknown) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return false;
  if (!rawBody || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const actual = Buffer.from(header.slice("sha256=".length), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isMetaWebhookConfigured() {
  return Boolean(
    process.env.META_WEBHOOK_VERIFY_TOKEN && process.env.META_ACCESS_TOKEN && process.env.META_APP_SECRET
  );
}

export function getMetaWebhookChallenge(mode: unknown, token: unknown, challenge: unknown) {
  if (mode !== "subscribe" || token !== process.env.META_WEBHOOK_VERIFY_TOKEN || !challenge) return null;
  return String(challenge);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

async function graphRequest(path: string, body: Record<string, string>) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return { skipped: true, reason: "META_ACCESS_TOKEN is not configured" };
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, access_token: token }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Meta Graph API ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function handleEvent(event: MetaEvent) {
  const ownId = process.env.META_INSTAGRAM_ACCOUNT_ID ?? "";

  // Comment webhook: value = { id, text, from: { id, username }, media }
  if (event.field === "comments" && event.value) {
    const value = event.value;
    const from = (value.from ?? {}) as { id?: string; username?: string };
    const commentId = stringValue(value.id);
    if (!commentId || (ownId && from.id === ownId) || alreadyHandled(commentId)) return { ignored: true };
    const username = stringValue(from.username);
    const text = stringValue(value.text);
    const decision = decideReply("comment", username, text);
    if (!decision) return { ignored: true };
    if (decision.rule.action === "approval") {
      holdForApproval({ channel: "comment", recipient: commentId, username, text, reason: decision.rule.name });
      return { held: true };
    }
    const message = decision.message;
    return graphRequest(`/${encodeURIComponent(commentId)}/replies`, { message });
  }

  // DM webhook: { sender: { id }, recipient: { id }, message: { mid, text } }
  if (event.sender?.id && event.message?.text) {
    const mid = event.message.mid ?? "";
    if (event.message.is_echo || (ownId && event.sender.id === ownId) || alreadyHandled(mid)) {
      return { ignored: true };
    }
    if (!ownId) return { skipped: true, reason: "META_INSTAGRAM_ACCOUNT_ID is not configured" };
    const decision = decideReply("dm", "", event.message.text);
    if (!decision) return { ignored: true };
    if (decision.rule.action === "approval") {
      holdForApproval({ channel: "dm", recipient: event.sender.id, username: "", text: event.message.text, reason: decision.rule.name });
      return { held: true };
    }
    return graphRequest(`/${encodeURIComponent(ownId)}/messages`, {
      recipient: JSON.stringify({ id: event.sender.id }),
      message: JSON.stringify({ text: decision.message }),
    });
  }

  return { ignored: true, field: event.field };
}

export function registerMetaWebhook(app: Express) {
  app.get("/api/meta/webhook", (req: Request, res: Response) => {
    const challenge = getMetaWebhookChallenge(req.query["hub.mode"], req.query["hub.verify_token"], req.query["hub.challenge"]);
    if (challenge) return res.status(200).type("text/plain").send(challenge);
    return res.status(403).json({ error: "Invalid webhook verification token" });
  });

  app.post("/api/meta/webhook", async (req: Request, res: Response) => {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!verifyMetaSignature(rawBody, req.get("x-hub-signature-256"))) {
      return res.status(401).json({ error: "Invalid signature" });
    }
    const body = req.body as { object?: string; entry?: Array<{ changes?: MetaEvent[]; messaging?: MetaEvent[] }> };
    if (body?.object !== "instagram") return res.status(404).json({ error: "Unsupported Meta object" });

    res.status(200).json({ received: true });
    const events = (body.entry ?? []).flatMap((entry) => [...(entry.changes ?? []), ...(entry.messaging ?? [])]);
    for (const event of events) {
      try {
        await handleEvent(event);
      } catch (error) {
        console.error("[Meta Webhook] Failed to process event:", error);
      }
    }
  });
}
