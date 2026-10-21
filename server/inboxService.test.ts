import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyRulesToUnanswered, buildThreads, importHistory, importPostComments, ingestEvents, listApprovals, listPosts, postComments, redraftPending, rejectReply, sendManualReply, sendReply } from "./inboxService";
import { MemoryInboxStore } from "./inboxStore";
import type { IncomingEvent } from "./metaWebhook";

const comment = (id: string, text: string): IncomingEvent => ({
  accountId: "acc", kind: "comment", externalId: id, senderId: "999", username: "hossein.rz", text, mediaId: "m1",
});
const dm = (mid: string, text: string): IncomingEvent => ({
  accountId: "acc", kind: "dm", externalId: mid, senderId: "555", username: null, text, mediaId: null,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("META_ACCESS_TOKEN", "IGAAtest");
  vi.stubEnv("META_AUTO_REPLY", "");
  vi.stubEnv("META_API_HOST", "");
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "out1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("ingestEvents", () => {
  it("drafts every match for approval by default", async () => {
    const store = new MemoryInboxStore();
    const result = await ingestEvents(store, [comment("c1", "آنالیز 5SP؟"), dm("m1", "قیمت؟")]);
    expect(result).toEqual({ stored: 2, duplicates: 0, toSend: [] });
    expect(await listApprovals(store)).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("auto-sends only 'send' rules when META_AUTO_REPLY=true", async () => {
    vi.stubEnv("META_AUTO_REPLY", "true");
    const store = new MemoryInboxStore();
    const result = await ingestEvents(store, [comment("c1", "آنالیز 5SP؟"), dm("m1", "قیمت با تخفیف؟")]);
    expect(result.toSend).toHaveLength(1);
    const reply = await store.getReply(result.toSend[0]);
    expect((await store.getEvent(reply!.eventId))?.externalId).toBe("c1");
  });

  it("counts duplicates without drafting again", async () => {
    const store = new MemoryInboxStore();
    await ingestEvents(store, [dm("m1", "سلام")]);
    expect(await ingestEvents(store, [dm("m1", "سلام")])).toMatchObject({ stored: 0, duplicates: 1 });
    expect(await store.listReplies({})).toHaveLength(1);
  });
});

describe("sendReply", () => {
  it("replies to comments on graph.instagram.com with a bearer token", async () => {
    const store = new MemoryInboxStore();
    await ingestEvents(store, [comment("c1", "قیمت؟")]);
    const [item] = await listApprovals(store);
    expect(await sendReply(store, item.id, 7, "متن ویرایش‌شده")).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.instagram.com/v23.0/c1/replies");
    expect(init.headers.Authorization).toBe("Bearer IGAAtest");
    expect(JSON.parse(init.body)).toEqual({ message: "متن ویرایش‌شده" });
    expect(await store.getReply(item.id)).toMatchObject({ status: "sent", text: "متن ویرایش‌شده", decidedBy: 7 });
  });

  it("uses graph.facebook.com for Facebook Login tokens and /me/messages for DMs", async () => {
    vi.stubEnv("META_ACCESS_TOKEN", "EAAtest");
    const store = new MemoryInboxStore();
    await ingestEvents(store, [dm("m1", "سلام")]);
    const [item] = await listApprovals(store);
    await sendReply(store, item.id, 1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v21.0/me/messages");
    expect(JSON.parse(init.body).recipient).toEqual({ id: "555" });
  });

  it("refuses to send the same reply twice", async () => {
    const store = new MemoryInboxStore();
    await ingestEvents(store, [dm("m1", "سلام")]);
    const [item] = await listApprovals(store);
    await sendReply(store, item.id, 1);
    await expect(sendReply(store, item.id, 1)).rejects.toThrow();
    await expect(rejectReply(store, item.id, 1)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records Meta errors and allows a retry", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "outside 24h window" } }), { status: 400 }));
    const store = new MemoryInboxStore();
    await ingestEvents(store, [dm("m1", "سلام")]);
    const [item] = await listApprovals(store);
    expect(await sendReply(store, item.id, 1)).toMatchObject({ ok: false });
    expect(await store.getReply(item.id)).toMatchObject({ status: "failed", error: "Meta API 400: outside 24h window" });
    expect(await sendReply(store, item.id, 1)).toEqual({ ok: true });
  });
});

describe("threads", () => {
  it("groups by sender, hides drafts and clears them after a manual reply", async () => {
    const store = new MemoryInboxStore();
    await ingestEvents(store, [dm("m1", "سلام"), dm("m2", "قیمت؟"), comment("c1", "قیمت؟")]);
    let threads = await buildThreads(store);
    expect(threads).toHaveLength(2);
    const dmThread = threads.find((t) => t.kind === "dm")!;
    expect(dmThread.messages.map((m) => m.from)).toEqual(["contact", "contact"]);
    expect(dmThread.priority).toBe(true);
    expect(dmThread.unread).toBe(true);

    await sendManualReply(store, dmThread.lastEventId, "سلام، بله", 1);
    threads = await buildThreads(store);
    const updated = threads.find((t) => t.kind === "dm")!;
    expect(updated.messages.at(-1)).toMatchObject({ from: "agent", text: "سلام، بله", status: "sent" });
    expect(updated.priority).toBe(false);
    // The comment thread's draft is untouched.
    expect((await listApprovals(store)).map((a) => a.channel)).toEqual(["کامنت"]);
  });
});

describe("comment → reply + DM per post", () => {
  async function storeWithPostRule() {
    const store = new MemoryInboxStore();
    const dmTemplate = await store.createTemplate({ title: "لیست قیمت", category: "", text: "سلام {{username}}، لیست قیمت را فرستادیم." });
    await store.createRule({ name: "تیرآهن", keywords: ["قیمت"], channels: ["comment"], action: "send", template: "سلام {{username}}، دایرکت را ببینید 🌹", templateId: null, dmTemplate: null, dmTemplateId: dmTemplate.id, mediaIds: ["m1"], priority: 500, enabled: true });
    return store;
  }

  it("drafts a public reply and a private DM, and sends both when auto-reply is on", async () => {
    vi.stubEnv("META_AUTO_REPLY", "true");
    const store = await storeWithPostRule();
    const result = await ingestEvents(store, [comment("c1", "قیمت؟")]);
    expect(result.toSend).toHaveLength(2);
    for (const id of result.toSend) await sendReply(store, id, null);
    const [publicCall, dmCall] = fetchMock.mock.calls;
    expect(publicCall[0]).toBe("https://graph.instagram.com/v23.0/c1/replies");
    expect(JSON.parse(publicCall[1].body)).toEqual({ message: "سلام hossein.rz، دایرکت را ببینید 🌹" });
    expect(dmCall[0]).toBe("https://graph.instagram.com/v23.0/me/messages");
    expect(JSON.parse(dmCall[1].body)).toEqual({ recipient: { comment_id: "c1" }, message: { text: "سلام hossein.rz، لیست قیمت را فرستادیم." } });
  });

  it("shows post comments with both replies and counts them per post", async () => {
    const store = await storeWithPostRule();
    await ingestEvents(store, [comment("c1", "قیمت؟")]);
    const [item] = await postComments(store, "m1");
    expect(item.replies.map((r) => r.channel)).toEqual(["reply", "private"]);
    expect((await listApprovals(store)).map((a) => a.replyChannel)).toEqual(["reply", "private"]);
    const [post] = await listPosts(store);
    expect(post).toMatchObject({ id: "m1", comments: 1, pending: 2, rules: 1, synced: false });
  });

  it("drafts replies for messages that arrived before the rule existed, without sending", async () => {
    vi.stubEnv("META_AUTO_REPLY", "true");
    const store = new MemoryInboxStore([]);
    await ingestEvents(store, [comment("c1", "قیمت؟")]);
    expect(await listApprovals(store)).toHaveLength(0);
    await store.createRule({ name: "قیمت", keywords: ["قیمت"], channels: ["comment"], action: "send", template: "سلام", templateId: null, dmTemplate: null, dmTemplateId: null, mediaIds: null, priority: 10, enabled: true });
    expect(await applyRulesToUnanswered(store)).toEqual({ drafted: 1 });
    expect(await applyRulesToUnanswered(store)).toEqual({ drafted: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("importPostComments", () => {
  it("keeps comments Meta returns without an author and skips the account's own", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/comments")) {
        return new Response(JSON.stringify({ data: [
          { id: "c1", text: "قیمت تیرآهن؟", username: "buyer1" },
          { id: "c2", text: "عالی", from: { id: "77", username: "fan" } },
          { id: "c3", text: "ممنون از شما", username: "sepandsteel" },
          { id: "c4", text: "ارسال دارید؟" },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({ username: "sepandsteel" }), { status: 200 });
    });
    const store = new MemoryInboxStore();
    const result = await importPostComments(store, "m1", "acc");
    expect(result).toEqual({ fetched: 4, imported: 3, alreadyThere: 0, own: 1 });
    const comments = await postComments(store, "m1");
    expect(comments.map((c) => c.threadId).sort()).toEqual(["comment:77", "comment:c:c4", "comment:u:buyer1"]);
    expect((await importPostComments(store, "m1", "acc")).alreadyThere).toBe(3);
  });
});

describe("importHistory", () => {
  it("imports comments and DMs with their original time, drafts nothing and reports hidden comments", async () => {
    const calls: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.includes("/subscribed_apps")) return json(init?.method === "POST" ? { success: true } : { data: [] });
      if (url.includes("/me/media")) {
        return json({ data: [
          { id: "p1", caption: "تیرآهن", timestamp: "2026-10-18T08:00:00+0000", comments_count: 2 },
          { id: "p2", caption: "ورق", timestamp: "2026-10-17T08:00:00+0000", comments_count: 5 },
          { id: "p3", caption: "بدون کامنت", timestamp: "2026-10-16T08:00:00+0000", comments_count: 0 },
        ] });
      }
      if (url.includes("/p1/comments")) return json({ data: [{ id: "c1", text: "قیمت؟", timestamp: "2026-10-18T09:00:00+0000", from: { id: "77", username: "buyer" } }] });
      if (url.includes("/p2/comments")) return json({ data: [] });
      if (url.includes("/me/conversations")) {
        return json({ data: [{ id: "t1", messages: { data: [
          { id: "mid1", created_time: "2026-10-19T10:00:00+0000", message: "سلام، قیمت ورق؟", from: { id: "55", username: "customer" } },
          { id: "mid2", created_time: "2026-10-19T10:05:00+0000", message: "سلام، در خدمتیم", from: { id: "acc", username: "sepandsteel" } },
        ] } }] });
      }
      return json({ username: "sepandsteel" });
    });
    const store = new MemoryInboxStore();
    const result = await importHistory(store, "acc");
    expect(result.comments).toEqual({ posts: 2, reported: 7, fetched: 1, imported: 1, hidden: 5 });
    expect(result.dms).toEqual({ fetched: 1, imported: 1, error: null });
    expect(calls).toContain("POST https://graph.instagram.com/v23.0/me/subscribed_apps?subscribed_fields=comments,messages");
    const events = await store.listEvents(10);
    expect(events.map((e) => [e.kind, e.externalId, e.createdAt.toISOString(), e.isRead])).toEqual(
      expect.arrayContaining([
        ["comment", "c1", "2026-10-18T09:00:00.000Z", true],
        ["dm", "mid1", "2026-10-19T10:00:00.000Z", true],
      ]),
    );
    expect(await store.listReplies({})).toEqual([]);
  });
});

describe("several messages per reply", () => {
  const rule = (template: string, dmTemplate: string | null = null) => ({
    name: "لیست", keywords: ["لیست"], channels: ["comment", "dm"] as ("comment" | "dm")[], action: "approval" as const,
    template, templateId: null, dmTemplate, dmTemplateId: null, mediaIds: null, priority: 1, enabled: true,
  });

  it("drafts one reply per --- part and keeps the private DM as one message", async () => {
    const store = new MemoryInboxStore();
    await store.createRule(rule("سلام {{username}}\n---\nلیست قیمت امروز\n---\n", "بخش اول\n---\nبخش دوم"));
    await ingestEvents(store, [comment("c1", "لیست؟")]);
    const drafts = await store.listReplies({ status: "pending" });
    expect(drafts.map((d) => [d.channel, d.text])).toEqual([
      ["reply", "سلام hossein.rz"],
      ["reply", "لیست قیمت امروز"],
      ["private", "بخش اول\n\nبخش دوم"],
    ]);
  });

  it("keeps the separators when a DM has no username", async () => {
    const store = new MemoryInboxStore();
    await store.createRule(rule("سلام {{username}}، خوش آمدید\n---\nلیست پیوست است"));
    await ingestEvents(store, [dm("m1", "لیست")]);
    expect((await store.listReplies({ status: "pending" })).map((d) => d.text)).toEqual(["سلام، خوش آمدید", "لیست پیوست است"]);
  });

  it("sends a manual reply as several messages in order and stops at the first failure", async () => {
    const store = new MemoryInboxStore();
    await ingestEvents(store, [dm("m1", "سلام")]);
    const [event] = await store.listEvents(1);
    expect((await sendManualReply(store, event.id, "اول\n---\nدوم", 1)).ok).toBe(true);
    expect(fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).message.text)).toEqual(["اول", "دوم"]);

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "outside window" } }), { status: 400 }));
    expect((await sendManualReply(store, event.id, "الف\n---\nب", 1)).ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("redraftPending", () => {
  // Only the rules a test creates; the store seeds the defaults otherwise.
  async function emptyStore() {
    const store = new MemoryInboxStore();
    for (const r of await store.listRules()) await store.deleteRule(r.id);
    return store;
  }
  const base = { name: "لیست", keywords: ["لیست"], channels: ["comment"] as ("comment" | "dm")[], action: "approval" as const, templateId: null, dmTemplate: null, dmTemplateId: null, mediaIds: null, priority: 1, enabled: true };

  it("rebuilds pending drafts after a rule change and leaves answered messages alone", async () => {
    const store = await emptyStore();
    const rule = await store.createRule({ ...base, template: "نسخهٔ اول" });
    await ingestEvents(store, [comment("c1", "لیست؟"), { ...comment("c2", "لیست لطفا"), senderId: "888" }]);
    const [first] = await store.listReplies({ status: "pending" });
    await sendReply(store, first.id, 1);

    await store.updateRule(rule.id, { template: "نسخهٔ دوم\n---\nبخش دوم" });
    expect((await redraftPending(store)).updated).toBe(1);
    expect((await store.listReplies({ status: "pending" })).map((r) => r.text)).toEqual(["نسخهٔ دوم", "بخش دوم"]);
    expect((await store.listReplies({ status: "sent" })).map((r) => r.text)).toEqual(["نسخهٔ اول"]);
    // Nothing changed since: no churn.
    expect((await redraftPending(store)).updated).toBe(0);

    await store.updateRule(rule.id, { enabled: false });
    await redraftPending(store);
    expect(await store.listReplies({ status: "pending" })).toEqual([]);
  });

  it("drafts recent messages a new rule now matches, but not old ones", async () => {
    const store = await emptyStore();
    await ingestEvents(store, [comment("c1", "سلام لیست"), { ...comment("c2", "لیست قدیمی"), senderId: "777", at: new Date(Date.now() - 10 * 24 * 3600 * 1000) }]);
    await store.createRule({ ...base, template: "لیست قیمت" });
    expect((await redraftPending(store)).updated).toBe(1);
    expect((await store.listReplies({ status: "pending" })).map((r) => r.text)).toEqual(["لیست قیمت"]);
  });
});

describe("buttons under a DM", () => {
  async function storeWithMenu() {
    const store = new MemoryInboxStore();
    for (const r of await store.listRules()) await store.deleteRule(r.id);
    const rule = await store.createRule({
      name: "منو", keywords: ["لیست"], channels: ["comment"], action: "approval", template: "", templateId: null,
      dmTemplate: "سلام {{username}}، کدام را می‌خواهید؟", dmTemplateId: null, mediaIds: null, priority: 1, enabled: true,
      dmButtons: [{ title: "لیست قیمت", reply: "قیمت امروز: ...\n---\nبرای سفارش پیام بدهید" }, { title: "آدرس انبار", reply: "انبار: ..." }],
    });
    return { store, rule };
  }

  it("sends the private reply with quick replies and answers a tapped button", async () => {
    const { store, rule } = await storeWithMenu();
    await ingestEvents(store, [comment("c1", "لیست؟")]);
    const [draft] = await store.listReplies({ status: "pending" });
    const [event] = await store.listEvents(1);
    expect(draft.channel).toBe("private");
    expect(draft.quickReplies).toEqual([
      { title: "لیست قیمت", payload: `SEPAND:${rule.id}:0:${event.id}` },
      { title: "آدرس انبار", payload: `SEPAND:${rule.id}:1:${event.id}` },
    ]);
    await sendReply(store, draft.id, 1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).message.quick_replies[1]).toEqual({ content_type: "text", title: "آدرس انبار", payload: `SEPAND:${rule.id}:1:${event.id}` });

    fetchMock.mockClear();
    const tap = { ...dm("mid.tap", "لیست قیمت"), senderId: "999", payload: `SEPAND:${rule.id}:0:${event.id}` };
    const result = await ingestEvents(store, [tap]);
    expect(result.toSend).toHaveLength(2);
    for (const id of result.toSend) await sendReply(store, id, null);
    expect(fetchMock.mock.calls.map((c) => JSON.parse(c[1].body))).toEqual([
      { recipient: { id: "999" }, message: { text: "قیمت امروز: ..." } },
      { recipient: { id: "999" }, message: { text: "برای سفارش پیام بدهید" } },
    ]);
  });

  it("treats a typed option as a tap and falls back to text options when buttons are refused", async () => {
    const { store } = await storeWithMenu();
    await ingestEvents(store, [comment("c1", "لیست؟")]);
    const [draft] = await store.listReplies({ status: "pending" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "quick replies not supported" } }), { status: 400 }));
    expect((await sendReply(store, draft.id, 1)).ok).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).message.text).toContain("«آدرس انبار»");

    const result = await ingestEvents(store, [{ ...dm("mid.typed", " آدرس انبار "), senderId: "999" }]);
    expect(result.toSend).toHaveLength(1);
    expect((await store.getReply(result.toSend[0]))?.text).toBe("انبار: ...");
  });
});
