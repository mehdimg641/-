import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCustomerReactions, buildThreads, ingestEvents, moderateComment, reactToEvent, sendReply } from "./inboxService";
import { MemoryInboxStore } from "./inboxStore";
import { extractReactions } from "./metaWebhook";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv("META_ACCESS_TOKEN", "IGAA-test");
  vi.stubEnv("INSTAGRAM_ACCOUNT_IDS", "acc");
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ message_id: "out-mid-1", recipient_id: "555" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function storeWith() {
  const store = new MemoryInboxStore();
  for (const r of await store.listRules()) await store.deleteRule(r.id);
  await store.createRule({ name: "قیمت", keywords: ["قیمت"], channels: ["comment", "dm"], action: "approval", template: "سلام", templateId: null, dmTemplate: null, dmTemplateId: null, mediaIds: null, priority: 1, enabled: true, dmButtons: null });
  await ingestEvents(store, [
    { accountId: "acc", kind: "dm", externalId: "mid.1", senderId: "555", username: null, text: "قیمت؟", mediaId: null },
    { accountId: "acc", kind: "comment", externalId: "c1", senderId: "999", username: "ali", text: "قیمت؟", mediaId: "m1" },
  ]);
  const events = await store.listEvents(10);
  return { store, dm: events.find((e) => e.kind === "dm")!, comment: events.find((e) => e.kind === "comment")! };
}

describe("reactions and comment moderation", () => {
  it("puts a heart on a DM and takes it off", async () => {
    const { store, dm } = await storeWith();
    await reactToEvent(store, dm.id, true);
    expect(fetchMock.mock.calls[0][0]).toBe("https://graph.instagram.com/v23.0/me/messages");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ recipient: { id: "555" }, sender_action: "react", payload: { message_id: "mid.1", reaction: "love" } });
    expect((await store.getEvent(dm.id))?.reaction).toBe("love");
    await reactToEvent(store, dm.id, false);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ recipient: { id: "555" }, sender_action: "unreact", payload: { message_id: "mid.1" } });
    expect((await store.getEvent(dm.id))?.reaction).toBeNull();
  });

  it("hides, shows and deletes a comment; deleting drops its drafts", async () => {
    const { store, comment, dm } = await storeWith();
    await expect(moderateComment(store, dm.id, "hide", 1)).rejects.toThrow("فقط کامنت");
    await moderateComment(store, comment.id, "hide", 1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://graph.instagram.com/v23.0/c1");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ hide: true });
    expect((await store.getEvent(comment.id))?.hidden).toBe(true);
    await moderateComment(store, comment.id, "delete", 1);
    expect(fetchMock.mock.calls[1][1].method).toBe("DELETE");
    expect((await store.getEvent(comment.id))?.deleted).toBe(true);
    expect((await store.listReplies({ eventIds: [comment.id] })).map((r) => r.status)).toEqual(["rejected"]);
    const thread = (await buildThreads(store)).find((t) => t.kind === "comment")!;
    expect(thread.messages[0]).toMatchObject({ eventId: comment.id, hidden: true, deleted: true });
  });

  it("shows the customer's reaction on our sent DM", async () => {
    const { store, dm } = await storeWith();
    const [draft] = await store.listReplies({ eventIds: [dm.id] });
    await sendReply(store, draft.id, 1);
    expect((await store.getReply(draft.id))?.externalId).toBe("out-mid-1");
    const body = {
      object: "instagram",
      entry: [{ id: "acc", messaging: [
        { sender: { id: "555" }, recipient: { id: "acc" }, reaction: { mid: "out-mid-1", action: "react" as const, reaction: "love", emoji: "❤️" } },
        { sender: { id: "acc" }, recipient: { id: "555" }, reaction: { mid: "mid.1", action: "react" as const, reaction: "love" } },
      ] }],
    };
    expect(extractReactions(body)).toEqual([{ mid: "out-mid-1", emoji: "❤️" }]);
    expect(await applyCustomerReactions(store, extractReactions(body))).toBe(1);
    const thread = (await buildThreads(store)).find((t) => t.kind === "dm")!;
    expect(thread.messages.find((m) => m.from === "agent")?.customerReaction).toBe("❤️");
    await applyCustomerReactions(store, [{ mid: "out-mid-1", emoji: null }]);
    expect((await store.getReply(draft.id))?.customerReaction).toBeNull();
  });
});
