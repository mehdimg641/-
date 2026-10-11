import { createHmac, timingSafeEqual } from "crypto";
import type { Express, Request, Response } from "express";

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

function buildPersonalizedMessage(username: string, sourceText: string) {
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
    const message = buildPersonalizedMessage(stringValue(from.username), stringValue(value.text));
    return graphRequest(`/${encodeURIComponent(commentId)}/replies`, { message });
  }

  // DM webhook: { sender: { id }, recipient: { id }, message: { mid, text } }
  if (event.sender?.id && event.message?.text) {
    const mid = event.message.mid ?? "";
    if (event.message.is_echo || (ownId && event.sender.id === ownId) || alreadyHandled(mid)) {
      return { ignored: true };
    }
    if (!ownId) return { skipped: true, reason: "META_INSTAGRAM_ACCOUNT_ID is not configured" };
    return graphRequest(`/${encodeURIComponent(ownId)}/messages`, {
      recipient: JSON.stringify({ id: event.sender.id }),
      message: JSON.stringify({ text: buildPersonalizedMessage("", event.message.text) }),
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
