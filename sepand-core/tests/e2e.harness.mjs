// End-to-end check of the Core against a real inbox: node sepand-core/tests/e2e.harness.mjs
// Needs the PHP backend served at INBOX_URL (php -S, deploy/php + telegram-bridge.php) on a test
// database whose api/config.php sets bridge_secret = BRIDGE_SECRET. Telegram, Bale and Gemini are
// faked here; every call to them is recorded. APPROVE is a command that approves one reply id the
// way the dashboard does (send_reply). Prints ✓/✗ per check and exits 1 on any failure.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const INBOX_URL = process.env.INBOX_URL ?? "http://127.0.0.1:8765";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET ?? "bridge-secret-bridge-secret-123456";
const APPROVE = (process.env.APPROVE ?? "").split(" ").filter(Boolean);
const SQL = (q) =>
  execFileSync("mysql", ["--default-character-set=utf8mb4", "-N", "-B", process.env.DB ?? "sepand_e2e", "-e", q], { encoding: "utf8" }).replace(/\n$/, "");

const ENV = {
  SEPAND_TG_BOT_TOKEN: "111:tg-token", SEPAND_BALE_BOT_TOKEN: "222:bale-token", SEPAND_GEMINI_API_KEY: "gemini-key",
  SEPAND_INBOX_URL: INBOX_URL, SEPAND_BRIDGE_SECRET: BRIDGE_SECRET, SUPABASE_URL: "https://core.example",
  SEPAND_GEMINI_MODEL: "m1",
};
let handler;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };

const calls = [];
let messengerReply = () => ({ ok: true, result: { message_id: 900 } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith(INBOX_URL)) return realFetch(url, init);
  const body = init.body ? JSON.parse(init.body) : {};
  const m = url.match(/^https:\/\/(api\.telegram\.org|tapi\.bale\.ai)\/bot([^/]+)\/(\w+)$/);
  if (m) {
    calls.push({ host: m[1], token: m[2], method: m[3], body });
    return Response.json(m[3] === "sendMessage" ? messengerReply(body) : { ok: true, result: true });
  }
  if (url.includes("generativelanguage.googleapis.com")) {
    calls.push({ host: "gemini", body });
    const draft = { intent: "availability", confidence: 0.8, draft: "سلام، کارشناس فروش به‌زودی پاسخ می‌دهد.", needs_human: true };
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(draft) }] } }] });
  }
  throw new Error("unexpected fetch " + url);
};

await import("../supabase/functions/sepand-core/index.ts");
const call = (method, path, body, headers = {}) =>
  handler(new Request(`https://core.example/functions/v1/sepand-core${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }));

let fails = 0;
async function check(name, fn) {
  try { await fn(); console.log("✓ " + name); } catch (e) { fails++; console.log("✗ " + name + "\n    " + e.message); }
}
const update = (chatId, messageId, text) => ({
  update_id: messageId, message: { message_id: messageId, chat: { id: chatId, type: "private" }, from: { first_name: "Ali", username: "ali" }, text },
});
const lastReply = (page) => SQL(`SELECT r.id, r.status, IFNULL(r.error,'') FROM replies r JOIN igEvents e ON e.id=r.eventId WHERE e.accountId='${page}' ORDER BY r.id DESC LIMIT 1`).split("\t");

let baleUrl = "";
await check("health lists the Bale token", async () => {
  const h = await (await call("GET", "/health")).json();
  assert.equal(h.secrets.SEPAND_BALE_BOT_TOKEN, true);
});
await check("/bale/setup points Bale's webhook at a secret path", async () => {
  const r = await call("GET", "/bale/setup");
  assert.equal(r.status, 200);
  const c = calls.findLast((c) => c.host === "tapi.bale.ai" && c.method === "setWebhook");
  assert.equal(c.token, "222:bale-token");
  assert.match(c.body.url, /^https:\/\/core\.example\/functions\/v1\/sepand-core\/bale\/[0-9a-f]{48}$/);
  baleUrl = c.body.url.replace("https://core.example/functions/v1/sepand-core", "");
});
await check("a wrong Bale path secret is refused", async () => {
  assert.equal((await call("POST", "/bale/" + "0".repeat(48), update(5, 1, "سلام"))).status, 401);
});
await check("a Bale message reaches the «بله» page with a pending Gemini draft", async () => {
  const r = await call("POST", baleUrl, update(4455, 10, "میلگرد ۱۶ دارید؟"));
  assert.equal(r.status, 200);
  assert.equal(SQL("SELECT name FROM igAccounts WHERE id='bale'"), "بله");
  assert.equal(SQL("SELECT CONCAT(externalId,'|',senderId,'|',text) FROM igEvents WHERE accountId='bale'"), "4455:10|bale4455|میلگرد ۱۶ دارید؟");
  assert.deepEqual(lastReply("bale").slice(1), ["pending", ""]);
});
await check("Bale retrying the same update stores nothing new", async () => {
  await call("POST", baleUrl, update(4455, 10, "میلگرد ۱۶ دارید؟"));
  assert.equal(SQL("SELECT COUNT(*) FROM igEvents WHERE accountId='bale'"), "1");
});
await check("/start is not a customer message", async () => {
  await call("POST", baleUrl, update(4455, 11, "/start"));
  assert.equal(SQL("SELECT COUNT(*) FROM igEvents WHERE accountId='bale'"), "1");
});
await check("approving a Bale draft queues it without Instagram, then /outbox sends it through Bale", async () => {
  const [id] = lastReply("bale");
  const approved = execFileSync(APPROVE[0], [...APPROVE.slice(1), id], { encoding: "utf8" }).trim();
  assert.equal(approved, '{"ok":true}');
  assert.equal(lastReply("bale")[1], "failed"); // stored for the bridge; the dashboard shows "sending"
  const out = await (await call("GET", "/outbox")).json();
  assert.equal(out.sent, 1);
  const c = calls.findLast((c) => c.host === "tapi.bale.ai" && c.method === "sendMessage");
  assert.equal(String(c.body.chat_id), "4455");
  assert.equal(c.body.reply_to_message_id, 10);
  assert.deepEqual(lastReply("bale").slice(1), ["sent", ""]);
});
await check("a Bale delivery error is kept as a real failure", async () => {
  await call("POST", baleUrl, update(4455, 12, "سلام"));
  const [id] = lastReply("bale");
  execFileSync(APPROVE[0], [...APPROVE.slice(1), id]);
  messengerReply = () => ({ ok: false, description: "Forbidden: bot was blocked by the user" });
  const out = await (await call("GET", "/outbox")).json();
  messengerReply = () => ({ ok: true, result: { message_id: 901 } });
  assert.equal(out.failed, 1);
  assert.deepEqual(lastReply("bale").slice(1), ["failed", "بله: Forbidden: bot was blocked by the user"]);
  assert.equal((await (await call("GET", "/outbox")).json()).sent, 0); // not retried by itself
});
await check("Telegram still works end to end", async () => {
  const { webhookSecret } = await import("../supabase/functions/sepand-core/logic.ts");
  const r = await call("POST", "/telegram", update(777, 20, "قیمت تیرآهن ۱۸؟"), { "x-telegram-bot-api-secret-token": await webhookSecret("111:tg-token") });
  assert.equal(r.status, 200);
  const [id] = lastReply("telegram");
  execFileSync(APPROVE[0], [...APPROVE.slice(1), id]);
  assert.equal((await (await call("GET", "/outbox")).json()).sent, 1);
  const c = calls.findLast((c) => c.host === "api.telegram.org" && c.method === "sendMessage");
  assert.equal(String(c.body.chat_id), "777");
  assert.equal(c.body.reply_parameters.message_id, 20);
  assert.equal(lastReply("telegram")[1], "sent");
});
await check("Gemini drafted every customer message (not /start)", async () => {
  assert.ok(calls.filter((c) => c.host === "gemini").length >= 3);
});

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
