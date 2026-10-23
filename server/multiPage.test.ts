import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAccount, ensureAccounts, refreshDueToken } from "./accounts";
import { buildThreads, copyRulesFrom, ingestEvents, listApprovals, sendReply } from "./inboxService";
import { MemoryInboxStore } from "./inboxStore";
import { encryptSetting } from "./metaSettings";
import { extractEvents } from "./metaWebhook";
import type { IncomingEvent } from "./metaWebhook";

const dm = (accountId: string, mid: string, text: string): IncomingEvent => ({
  accountId, kind: "dm", externalId: mid, senderId: "555", username: null, text, mediaId: null,
});

let fetchMock: ReturnType<typeof vi.fn>;

/** Two pages: A (from the old settings) and B; rules of B are made by each test. */
async function twoPages() {
  const store = new MemoryInboxStore();
  await ensureAccounts(store);
  await store.saveAccount({ id: "B", username: "pageb", token: encryptSetting("IGAAtokenB"), enabled: true });
  return store;
}

beforeEach(() => {
  vi.stubEnv("JWT_SECRET", "test-secret");
  vi.stubEnv("META_ACCESS_TOKEN", "IGAAtokenA");
  vi.stubEnv("INSTAGRAM_ACCOUNT_IDS", "A");
  vi.stubEnv("META_AUTO_REPLY", "");
  vi.stubEnv("META_API_HOST", "");
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "out1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("pages", () => {
  it("turns the single page in Settings into the first page and gives it the starter rules", async () => {
    const store = new MemoryInboxStore();
    await ensureAccounts(store);
    expect((await store.listAccounts()).map((a) => a.id)).toEqual(["A"]);
    const rules = await store.listRules("A");
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => r.accountId === "A")).toBe(true);
    expect(await store.listRules("B")).toEqual([]);
  });

  it("matches an event only against its own page's rules", async () => {
    const store = await twoPages();
    await ingestEvents(store, [dm("A", "m1", "قیمت؟"), dm("B", "m2", "قیمت؟")]);
    const a = await listApprovals(store, "A");
    expect(a.length).toBeGreaterThan(0);
    expect(await listApprovals(store, "B")).toEqual([]);
  });

  it("keeps the same customer's conversations with two pages apart", async () => {
    const store = await twoPages();
    await ingestEvents(store, [dm("A", "m1", "سلام"), dm("B", "m2", "درود")]);
    const a = await buildThreads(store, "A");
    const b = await buildThreads(store, "B");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(b[0].messages.map((m) => m.text)).toEqual(["درود"]);
  });

  it("sends as the page the message came to", async () => {
    const store = await twoPages();
    const rule = await store.createRule({ accountId: "B", name: "B", keywords: ["قیمت"], channels: ["dm"], action: "approval", template: "پاسخ B", priority: 1, enabled: true });
    expect(rule.accountId).toBe("B");
    await ingestEvents(store, [dm("B", "m2", "قیمت؟")]);
    const [item] = await listApprovals(store, "B");
    expect(item.draft).toBe("پاسخ B");
    await sendReply(store, item.id, 1);
    const send = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/me/messages"))!;
    expect(send[1].headers.Authorization).toBe("Bearer IGAAtokenB");
  });

  it("copies rules and templates to another page, pointing at the copied templates", async () => {
    const store = await twoPages();
    const template = await store.createTemplate({ accountId: "A", title: "قیمت", category: "", text: "متن قالب" });
    await store.createRule({ accountId: "A", name: "با قالب", keywords: ["x"], channels: ["dm"], template: "", templateId: template.id, priority: 1, enabled: true });
    await store.createRule({ accountId: "A", name: "یک پست", keywords: ["y"], channels: ["comment"], template: "z", mediaIds: ["m1"], priority: 2, enabled: true });
    const result = await copyRulesFrom(store, "A", "B");
    expect(result.skipped).toBe(1);
    const rules = await store.listRules("B");
    const templates = await store.listTemplates("B");
    const copied = rules.find((r) => r.name === "با قالب")!;
    expect(copied.accountId).toBe("B");
    expect(copied.templateId).not.toBe(template.id);
    expect(templates.find((t) => t.id === copied.templateId)?.text).toBe("متن قالب");
    expect(rules.some((r) => r.name === "یک پست")).toBe(false);
    // Page A keeps its own.
    expect((await store.listRules("A")).some((r) => r.name === "با قالب")).toBe(true);
  });

  it("connects a page from its token and subscribes its webhooks", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      new Response(JSON.stringify(String(url).includes("/me?") ? { user_id: 1784, username: "newpage" } : { success: true }), { status: 200 }),
    );
    const store = new MemoryInboxStore();
    const { account, subscribeError } = await addAccount(store, "IGAAnewtoken");
    expect(account).toMatchObject({ id: "1784", username: "newpage", enabled: true });
    expect(account.tokenPreview).not.toContain("newtoken");
    expect(subscribeError).toBeNull();
    const calls = fetchMock.mock.calls.map(([url, init]) => [String(url), init?.headers?.Authorization]);
    expect(calls.some(([url, auth]) => url.includes("subscribed_apps") && auth === "Bearer IGAAnewtoken")).toBe(true);
  });

  it("refuses a token of another page when replacing one", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ user_id: 99, username: "other" }), { status: 200 }));
    const store = await twoPages();
    await expect(addAccount(store, "IGAAother", "B")).rejects.toThrow("@other");
    expect((await store.getAccount("B"))?.username).toBe("pageb");
  });

  it("refreshes a week-old Instagram token and records the new expiry", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ access_token: "IGAAfresh", expires_in: 5184000 }), { status: 200 }));
    const store = await twoPages();
    fetchMock.mockClear();
    const now = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const refreshed = await refreshDueToken(store, now);
    expect(refreshed).toBe("A");
    expect(String(fetchMock.mock.calls[0][0])).toContain("refresh_access_token");
    expect((await store.getAccount("A"))?.tokenExpiresAt).toBeInstanceOf(Date);
    // Not again right away: the next call takes the other page or nothing.
    expect(await refreshDueToken(store, new Date())).toBeNull();
  });

  it("accepts webhooks for connected pages besides the allowlist", () => {
    const body = { object: "instagram", entry: [{ id: "B", messaging: [{ sender: { id: "555" }, recipient: { id: "B" }, message: { mid: "x", text: "سلام" } }] }] };
    expect(extractEvents(body)).toHaveLength(0);
    expect(extractEvents(body, ["B"])).toHaveLength(1);
  });
});
