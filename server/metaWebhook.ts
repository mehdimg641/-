import type { Express, Request, Response } from "express";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

type MetaEvent = {
  field?: string;
  value?: Record<string, unknown>;
};

export function isMetaWebhookConfigured() {
  return Boolean(process.env.META_WEBHOOK_VERIFY_TOKEN && process.env.META_ACCESS_TOKEN);
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
  const value = event.value ?? {};
  const field = stringValue(event.field);
  const username = stringValue(value.from_username) || stringValue(value.username) || "";
  const text = stringValue(value.message) || stringValue(value.text);
  const responseMessage = buildPersonalizedMessage(username, text);

  if (field === "comments" && value.comment_id) {
    return graphRequest(`/${encodeURIComponent(String(value.comment_id))}/replies`, { message: responseMessage });
  }

  if ((field === "messages" || field === "messaging") && value.sender_id && process.env.META_INSTAGRAM_ACCOUNT_ID) {
    return graphRequest(`/${encodeURIComponent(process.env.META_INSTAGRAM_ACCOUNT_ID)}/messages`, {
      recipient: JSON.stringify({ id: String(value.sender_id) }),
      message: JSON.stringify({ text: responseMessage }),
    });
  }

  return { ignored: true, field };
}

export function registerMetaWebhook(app: Express) {
  app.get("/api/meta/webhook", (req: Request, res: Response) => {
    const challenge = getMetaWebhookChallenge(req.query["hub.mode"], req.query["hub.verify_token"], req.query["hub.challenge"]);
    if (challenge) return res.status(200).type("text/plain").send(challenge);
    return res.status(403).json({ error: "Invalid webhook verification token" });
  });

  app.post("/api/meta/webhook", async (req: Request, res: Response) => {
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
