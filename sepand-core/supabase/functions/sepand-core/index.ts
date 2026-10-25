// Sepand Core: stateless AI layer (Gemini) and the Telegram relay for Sepand Inbox.
//
// Routes (all under /functions/v1/sepand-core):
//   GET  /health          → which secrets are set (names only, never values)
//   POST /analyze         → {text, channel?, company_info?} → Analysis   (header x-core-secret)
//   POST /telegram        → Telegram webhook (header X-Telegram-Bot-Api-Secret-Token)
//   GET  /telegram/setup  → points the bot's webhook here (idempotent, no auth needed)
//   GET  /outbox          → delivers replies approved in the inbox (idempotent; run every minute)
//
// Telegram is blocked from the inbox's Iranian host, so the Core is the only side that talks to
// Telegram: customer message → Gemini → inbox (telegram-bridge.php) as a message + pending draft;
// the operator approves in the inbox; /outbox fetches approved replies and sends them.

import {
  type Analysis, buildPrompt, DEFAULT_COMPANY_INFO, maskPersonalData, normalizeAnalysis,
  RESPONSE_SCHEMA, safeEqual, signBridge, webhookSecret,
} from "./logic.ts";

const env = (name: string) => (Deno.env.get(name) ?? "").trim();
const GEMINI_MODEL = env("SEPAND_GEMINI_MODEL") || "gemini-flash-latest";
// Used when the main model is busy (503) or rate-limited (429), which happens often on the free tier.
const GEMINI_FALLBACK_MODEL = env("SEPAND_GEMINI_FALLBACK_MODEL") || "gemini-flash-lite-latest";
const GEMINI_TIMEOUT_MS = 15_000;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

class CoreError extends Error {}

// --- Gemini ------------------------------------------------------------------------------------

async function analyze(text: string, channel: string, companyInfo: string): Promise<Analysis> {
  // "Gemini API Key" is the name the key was first saved under in the dashboard.
  const key = env("SEPAND_GEMINI_API_KEY") || env("Gemini API Key");
  if (!key) throw new CoreError("SEPAND_GEMINI_API_KEY is not set");
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: buildPrompt(maskPersonalData(text), channel, companyInfo) }] }],
    generationConfig: { temperature: 0.3, responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA },
  });
  let resp: Response | null = null;
  for (const model of [GEMINI_MODEL, GEMINI_FALLBACK_MODEL]) {
    resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      body,
    });
    if (resp.ok) break;
    // Google's error text never contains the key; it is logged, not returned.
    console.error("gemini error", model, resp.status, (await resp.text().catch(() => "")).slice(0, 200));
    if (resp.status !== 503 && resp.status !== 429) break;
  }
  if (!resp?.ok) throw new CoreError(`Gemini HTTP ${resp?.status}`);
  const data = await resp.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  try {
    return normalizeAnalysis(JSON.parse(raw));
  } catch {
    return normalizeAnalysis({ reason: "پاسخ مدل قابل خواندن نبود" });
  }
}

// --- Telegram ----------------------------------------------------------------------------------

async function tg(method: string, payload: Record<string, unknown>): Promise<Record<string, any>> {
  const resp = await fetch(`https://api.telegram.org/bot${env("SEPAND_TG_BOT_TOKEN")}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await resp.json().catch(() => ({}));
  if (!body.ok) console.error("telegram", method, resp.status, body.description ?? "");
  return body;
}

// --- Inbox bridge ------------------------------------------------------------------------------

async function bridge(action: "ingest" | "outbox" | "ack", payload: unknown): Promise<Record<string, any>> {
  const base = env("SEPAND_INBOX_URL").replace(/\/+$/, "");
  const secret = env("SEPAND_BRIDGE_SECRET");
  if (!base || secret.length < 24) throw new CoreError("SEPAND_INBOX_URL / SEPAND_BRIDGE_SECRET are not set");
  const body = JSON.stringify(payload);
  const time = String(Math.floor(Date.now() / 1000));
  const resp = await fetch(`${base}/telegram-bridge.php?action=${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Sepand-Time": time, "X-Sepand-Signature": await signBridge(secret, time, body) },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new CoreError(`inbox ${action} HTTP ${resp.status}: ${data.error ?? ""}`);
  return data;
}

function senderName(from: Record<string, any> | undefined): string {
  if (!from) return "";
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  return from.username ? `${name} @${from.username}`.trim() : name;
}

async function onCustomerMessage(msg: Record<string, any>) {
  const text: string = (msg.text ?? msg.caption ?? "").trim();
  if (text.startsWith("/")) return; // /start and other commands are not customer questions
  let draft = "";
  if (text) {
    try {
      draft = (await analyze(text, "telegram", env("SEPAND_COMPANY_INFO") || DEFAULT_COMPANY_INFO)).draft;
    } catch (e) {
      // The message still reaches the inbox, just without a draft.
      console.error("analyze failed", (e as Error).message);
    }
  }
  await bridge("ingest", { chat_id: msg.chat.id, message_id: msg.message_id, name: senderName(msg.from), text, draft });
}

async function onTelegram(req: Request): Promise<Response> {
  const token = env("SEPAND_TG_BOT_TOKEN");
  if (!token) return json(503, { error: "bot not configured" });
  if (!safeEqual(req.headers.get("x-telegram-bot-api-secret-token") ?? "", await webhookSecret(token))) {
    return json(401, { error: "unauthorized" });
  }
  const update = await req.json().catch(() => null);
  const msg = update?.message;
  if (!msg || msg.chat?.type !== "private") return json(200, { ok: true });
  try {
    await onCustomerMessage(msg);
  } catch (e) {
    // Non-200 makes Telegram retry, which is what we want when the inbox was unreachable;
    // the bridge ignores duplicates, so a retry never creates a second message.
    console.error("ingest failed", (e as Error).message);
    return json(502, { error: "inbox unreachable" });
  }
  return json(200, { ok: true });
}

/** Sends replies the operator approved in the inbox and reports each result back. */
async function flushOutbox(): Promise<{ sent: number; failed: number }> {
  const { items = [] } = await bridge("outbox", {});
  const results = [];
  for (const it of items as Array<{ replyId: number; chatId: string; replyTo: string; text: string }>) {
    const sent = await tg("sendMessage", {
      chat_id: it.chatId, text: it.text,
      reply_parameters: it.replyTo ? { message_id: Number(it.replyTo), allow_sending_without_reply: true } : undefined,
    });
    results.push(sent.ok
      ? { replyId: it.replyId, ok: true, messageId: sent.result?.message_id }
      : { replyId: it.replyId, ok: false, error: String(sent.description ?? "Telegram error").slice(0, 200) });
  }
  if (results.length) await bridge("ack", { results });
  return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

// --- HTTP --------------------------------------------------------------------------------------

function hasCoreSecret(req: Request): boolean {
  const expected = env("SEPAND_CORE_SECRET");
  return expected.length >= 24 && safeEqual(req.headers.get("x-core-secret") ?? "", expected);
}

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/^.*\/sepand-core/, "") || "/";

  if (req.method === "GET" && path === "/health") {
    const names = ["SEPAND_GEMINI_API_KEY", "SEPAND_TG_BOT_TOKEN", "SEPAND_INBOX_URL", "SEPAND_BRIDGE_SECRET", "SEPAND_CORE_SECRET", "SEPAND_COMPANY_INFO"];
    const secrets: Record<string, boolean> = Object.fromEntries(names.map((n) => [n, env(n) !== ""]));
    secrets.SEPAND_GEMINI_API_KEY ||= env("Gemini API Key") !== "";
    return json(200, { ok: true, model: GEMINI_MODEL, secrets });
  }

  if (req.method === "POST" && path === "/telegram") return onTelegram(req);

  // No auth needed: it only points the bot at this same function, with a secret derived from the token.
  if (path === "/telegram/setup") {
    const token = env("SEPAND_TG_BOT_TOKEN");
    if (!token) return json(503, { error: "SEPAND_TG_BOT_TOKEN is not set" });
    const result = await tg("setWebhook", {
      url: `${env("SUPABASE_URL")}/functions/v1/sepand-core/telegram`,
      secret_token: await webhookSecret(token), allowed_updates: ["message"],
    });
    return json(result.ok ? 200 : 502, { ok: !!result.ok, description: result.description ?? "" });
  }

  // No auth needed: it only delivers replies an operator already approved, each claimed once by the inbox.
  if (path === "/outbox") {
    try {
      return json(200, await flushOutbox());
    } catch (e) {
      return json(502, { error: (e as Error).message });
    }
  }

  if (req.method === "POST" && path === "/analyze") {
    if (!hasCoreSecret(req)) return json(401, { error: "unauthorized" });
    const body = await req.json().catch(() => null);
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 4000) return json(400, { error: "text must be 1-4000 characters" });
    const channel = typeof body.channel === "string" ? body.channel.slice(0, 20) : "instagram";
    const company = typeof body.company_info === "string" && body.company_info.trim()
      ? body.company_info.slice(0, 6000)
      : env("SEPAND_COMPANY_INFO") || DEFAULT_COMPANY_INFO;
    try {
      return json(200, await analyze(text, channel, company));
    } catch (e) {
      return json(502, { error: (e as Error).message });
    }
  }

  return json(404, { error: "not found" });
});
