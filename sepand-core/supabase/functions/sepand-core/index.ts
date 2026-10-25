// Sepand Core: stateless AI layer (Gemini) and the Telegram / Bale relay for Sepand Inbox.
//
// Routes (all under /functions/v1/sepand-core):
//   GET  /health          → which secrets are set (names only, never values)
//   POST /analyze         → {text, channel?, company_info?} → Analysis   (header x-core-secret)
//   POST /telegram        → Telegram webhook (header X-Telegram-Bot-Api-Secret-Token)
//   GET  /telegram/setup  → points the bot's webhook here (idempotent, no auth needed)
//   POST /bale/<secret>   → Bale webhook (Bale sends no secret header, so the secret is in the path)
//   GET  /bale/setup      → points the Bale bot's webhook here (idempotent, no auth needed)
//   GET  /outbox          → delivers replies approved in the inbox (idempotent; run every minute)
//
// Telegram is blocked from the inbox's Iranian host, so the Core is the only side that talks to
// the messengers: customer message → Gemini → inbox (telegram-bridge.php / bale-bridge.php) as a
// message + pending draft; the operator approves in the inbox; /outbox fetches approved replies and
// sends them. Bale works the same way, so both share one code path.

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

// --- Messengers --------------------------------------------------------------------------------

/** Telegram and Bale speak the same Bot API; they differ only in host, token and inbox bridge. */
interface Messenger {
  name: "telegram" | "bale";
  api: string;
  tokenEnv: string;
  bridgeFile: string;
  webhookLabel: string;
}

const TELEGRAM: Messenger = {
  name: "telegram", api: "https://api.telegram.org", tokenEnv: "SEPAND_TG_BOT_TOKEN",
  bridgeFile: "telegram-bridge.php", webhookLabel: "sepand-telegram-webhook",
};
const BALE: Messenger = {
  name: "bale", api: "https://tapi.bale.ai", tokenEnv: "SEPAND_BALE_BOT_TOKEN",
  bridgeFile: "bale-bridge.php", webhookLabel: "sepand-bale-webhook",
};
const MESSENGERS = [TELEGRAM, BALE];

const token = (m: Messenger) => env(m.tokenEnv);
const hookSecret = (m: Messenger) => webhookSecret(token(m), m.webhookLabel);

async function botApi(m: Messenger, method: string, payload: Record<string, unknown>): Promise<Record<string, any>> {
  const resp = await fetch(`${m.api}/bot${token(m)}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await resp.json().catch(() => ({}));
  if (!body.ok) console.error(m.name, method, resp.status, body.description ?? "");
  return body;
}

// --- Inbox bridge ------------------------------------------------------------------------------

async function bridge(m: Messenger, action: "ingest" | "outbox" | "ack", payload: unknown): Promise<Record<string, any>> {
  const base = env("SEPAND_INBOX_URL").replace(/\/+$/, "");
  const secret = env("SEPAND_BRIDGE_SECRET");
  if (!base || secret.length < 24) throw new CoreError("SEPAND_INBOX_URL / SEPAND_BRIDGE_SECRET are not set");
  const body = JSON.stringify(payload);
  const time = String(Math.floor(Date.now() / 1000));
  const resp = await fetch(`${base}/${m.bridgeFile}?action=${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Sepand-Time": time, "X-Sepand-Signature": await signBridge(secret, time, body) },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new CoreError(`inbox ${m.name} ${action} HTTP ${resp.status}: ${data.error ?? ""}`);
  return data;
}

function senderName(from: Record<string, any> | undefined): string {
  if (!from) return "";
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  return from.username ? `${name} @${from.username}`.trim() : name;
}

async function onCustomerMessage(m: Messenger, msg: Record<string, any>) {
  const text: string = (msg.text ?? msg.caption ?? "").trim();
  if (text.startsWith("/")) return; // /start and other commands are not customer questions
  let draft = "";
  if (text) {
    try {
      draft = (await analyze(text, m.name, env("SEPAND_COMPANY_INFO") || DEFAULT_COMPANY_INFO)).draft;
    } catch (e) {
      // The message still reaches the inbox, just without a draft.
      console.error("analyze failed", (e as Error).message);
    }
  }
  await bridge(m, "ingest", { chat_id: msg.chat.id, message_id: msg.message_id, name: senderName(msg.from), text, draft });
}

/** A webhook call whose secret was already checked. */
async function onUpdate(m: Messenger, req: Request): Promise<Response> {
  const update = await req.json().catch(() => null);
  const msg = update?.message;
  if (!msg || msg.chat?.type !== "private") return json(200, { ok: true });
  try {
    await onCustomerMessage(m, msg);
  } catch (e) {
    // Non-200 makes the messenger retry, which is what we want when the inbox was unreachable;
    // the bridge ignores duplicates, so a retry never creates a second message.
    console.error(`${m.name} ingest failed`, (e as Error).message);
    return json(502, { error: "inbox unreachable" });
  }
  return json(200, { ok: true });
}

async function setupWebhook(m: Messenger): Promise<Response> {
  if (!token(m)) return json(503, { error: `${m.tokenEnv} is not set` });
  const base = `${env("SUPABASE_URL")}/functions/v1/sepand-core`;
  const result = await botApi(m, "setWebhook", m === TELEGRAM
    ? { url: `${base}/telegram`, secret_token: await hookSecret(m), allowed_updates: ["message"] }
    : { url: `${base}/bale/${await hookSecret(m)}` });
  return json(result.ok ? 200 : 502, { ok: !!result.ok, description: result.description ?? "" });
}

/** Sends replies the operator approved in the inbox and reports each result back. */
async function flushOutbox(m: Messenger): Promise<{ sent: number; failed: number }> {
  const { items = [] } = await bridge(m, "outbox", {});
  const results = [];
  for (const it of items as Array<{ replyId: number; chatId: string; replyTo: string; text: string }>) {
    const replyTo = it.replyTo ? Number(it.replyTo) : undefined;
    const sent = await botApi(m, "sendMessage", m === TELEGRAM
      ? { chat_id: it.chatId, text: it.text, reply_parameters: replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined }
      : { chat_id: it.chatId, text: it.text, reply_to_message_id: replyTo });
    results.push(sent.ok
      ? { replyId: it.replyId, ok: true, messageId: sent.result?.message_id }
      : { replyId: it.replyId, ok: false, error: String(sent.description ?? `${m.name} error`).slice(0, 200) });
  }
  if (results.length) await bridge(m, "ack", { results });
  return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

/** Each messenger is flushed on its own, so one being down never holds up the other. */
async function flushAll() {
  const total = { sent: 0, failed: 0, errors: [] as string[] };
  for (const m of MESSENGERS) {
    if (!token(m)) continue;
    try {
      const r = await flushOutbox(m);
      total.sent += r.sent;
      total.failed += r.failed;
    } catch (e) {
      total.errors.push((e as Error).message);
    }
  }
  return total;
}

// --- HTTP --------------------------------------------------------------------------------------

function hasCoreSecret(req: Request): boolean {
  const expected = env("SEPAND_CORE_SECRET");
  return expected.length >= 24 && safeEqual(req.headers.get("x-core-secret") ?? "", expected);
}

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/^.*\/sepand-core/, "") || "/";

  if (req.method === "GET" && path === "/health") {
    const names = ["SEPAND_GEMINI_API_KEY", "SEPAND_TG_BOT_TOKEN", "SEPAND_BALE_BOT_TOKEN", "SEPAND_INBOX_URL", "SEPAND_BRIDGE_SECRET", "SEPAND_CORE_SECRET", "SEPAND_COMPANY_INFO"];
    const secrets: Record<string, boolean> = Object.fromEntries(names.map((n) => [n, env(n) !== ""]));
    secrets.SEPAND_GEMINI_API_KEY ||= env("Gemini API Key") !== "";
    return json(200, { ok: true, model: GEMINI_MODEL, secrets });
  }

  if (req.method === "POST" && path === "/telegram") {
    if (!token(TELEGRAM)) return json(503, { error: "bot not configured" });
    if (!safeEqual(req.headers.get("x-telegram-bot-api-secret-token") ?? "", await hookSecret(TELEGRAM))) {
      return json(401, { error: "unauthorized" });
    }
    return onUpdate(TELEGRAM, req);
  }

  // No auth needed: it only points the bot at this same function, with a secret derived from the token.
  if (path === "/telegram/setup") return setupWebhook(TELEGRAM);
  if (path === "/bale/setup") return setupWebhook(BALE);

  if (req.method === "POST" && path.startsWith("/bale/")) {
    if (!token(BALE)) return json(503, { error: "bot not configured" });
    if (!safeEqual(path.slice("/bale/".length), await hookSecret(BALE))) return json(401, { error: "unauthorized" });
    return onUpdate(BALE, req);
  }

  // No auth needed: it only delivers replies an operator already approved, each claimed once by the inbox.
  if (path === "/outbox") {
    const result = await flushAll();
    return json(result.errors.length && !result.sent && !result.failed ? 502 : 200, result);
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
