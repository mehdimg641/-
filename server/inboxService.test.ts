import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildThreads, ingestEvents, listApprovals, rejectReply, sendManualReply, sendReply } from "./inboxService";
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
