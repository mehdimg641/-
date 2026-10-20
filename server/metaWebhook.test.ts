import { createHmac } from "crypto";
import express from "express";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryInboxStore, setInboxStore } from "./inboxStore";
import { extractEvents, getMetaWebhookChallenge, isMetaWebhookConfigured, registerMetaWebhook, verifyMetaSignature } from "./metaWebhook";

const ACCOUNT = "17841400000000001";

const commentPayload = (id = "c1", fromId = "999", text = "قیمت شمش ۱۲۵؟") => ({
  object: "instagram",
  entry: [{ id: ACCOUNT, time: 1, changes: [{ field: "comments", value: { id, text, from: { id: fromId, username: "hossein.rz" }, media: { id: "m1" } } }] }],
});

const dmPayload = (mid = "mid.1", extra: Record<string, unknown> = {}) => ({
  object: "instagram",
  entry: [{ id: ACCOUNT, time: 1, messaging: [{ sender: { id: "555" }, recipient: { id: ACCOUNT }, timestamp: 1, message: { mid, text: "سلام، ارسال به اصفهان دارید؟", ...extra } }] }],
});

const sign = (body: string, secret = "app-secret") => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("META_APP_SECRET", "app-secret");
  vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "sepand-secret");
  vi.stubEnv("INSTAGRAM_ACCOUNT_IDS", ACCOUNT);
  vi.stubEnv("META_INSTAGRAM_ACCOUNT_ID", "");
  vi.stubEnv("META_AUTO_REPLY", "");
});

describe("verification handshake", () => {
  it("accepts the configured token and rejects others", () => {
    expect(getMetaWebhookChallenge("subscribe", "sepand-secret", "challenge-123")).toBe("challenge-123");
    expect(getMetaWebhookChallenge("subscribe", "wrong", "challenge-123")).toBeNull();
  });

  it("rejects everything when no token is configured", () => {
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "");
    expect(getMetaWebhookChallenge("subscribe", "", "challenge-123")).toBeNull();
  });

  it("requires the app secret to report configured", () => {
    vi.stubEnv("META_ACCESS_TOKEN", "token");
    expect(isMetaWebhookConfigured()).toBe(true);
    vi.stubEnv("META_APP_SECRET", "");
    expect(isMetaWebhookConfigured()).toBe(false);
  });
});

describe("verifyMetaSignature", () => {
  const body = Buffer.from('{"object":"instagram"}');
  it("accepts a valid signature and rejects tampering", () => {
    expect(verifyMetaSignature(body, sign(body.toString()))).toBe(true);
    expect(verifyMetaSignature(body, sign(body.toString()).toUpperCase().replace("SHA256", "sha256"))).toBe(true);
    expect(verifyMetaSignature(Buffer.from('{"object":"instagram "}'), sign(body.toString()))).toBe(false);
    expect(verifyMetaSignature(body, "sha256=" + "0".repeat(64))).toBe(false);
    expect(verifyMetaSignature(body, "sha256=abc")).toBe(false);
    expect(verifyMetaSignature(body, undefined)).toBe(false);
  });

  it("fails closed without an app secret", () => {
    vi.stubEnv("META_APP_SECRET", "");
    expect(verifyMetaSignature(body, sign(body.toString(), ""))).toBe(false);
  });
});

describe("extractEvents", () => {
  it("reads comments from changes[].value", () => {
    expect(extractEvents(commentPayload())).toEqual([
      { accountId: ACCOUNT, kind: "comment", externalId: "c1", senderId: "999", username: "hossein.rz", text: "قیمت شمش ۱۲۵؟", mediaId: "m1" },
    ]);
  });

  it("reads DMs from messaging[]", () => {
    expect(extractEvents(dmPayload())).toMatchObject([{ kind: "dm", externalId: "mid.1", senderId: "555", username: null }]);
  });

  it("skips our own comments, echoes, deleted messages and receipts", () => {
    expect(extractEvents(commentPayload("c1", ACCOUNT))).toEqual([]);
    expect(extractEvents(dmPayload("mid.1", { is_echo: true }))).toEqual([]);
    expect(extractEvents(dmPayload("mid.1", { is_deleted: true }))).toEqual([]);
    expect(extractEvents({ object: "instagram", entry: [{ id: ACCOUNT, messaging: [{ sender: { id: "555" }, read: { mid: "x" } } as never] }] })).toEqual([]);
    expect(extractEvents({ object: "instagram", entry: [{ id: ACCOUNT, changes: [{ field: "mentions", value: { id: "x", text: "hi" } }] }] })).toEqual([]);
  });

  it("ignores accounts outside the allowlist", () => {
    vi.stubEnv("INSTAGRAM_ACCOUNT_IDS", "123");
    expect(extractEvents(commentPayload())).toEqual([]);
  });
});

describe("POST /api/meta/webhook", () => {
  let base = "";
  let close = () => {};
  let store: MemoryInboxStore;

  beforeAll(async () => {
    const app = express();
    registerMetaWebhook(app);
    app.use(express.json()); // the real server's global parser must not break the raw-body route
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/meta/webhook`;
    close = () => server.close();
  });
  afterAll(() => close());
  beforeEach(() => {
    store = new MemoryInboxStore();
    setInboxStore(store);
  });

  const post = (payload: unknown, signature?: string) => {
    const body = JSON.stringify(payload);
    return fetch(base, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature ?? sign(body) }, body });
  };

  it("rejects unsigned or forged requests without storing anything", async () => {
    expect((await post(commentPayload(), "sha256=" + "0".repeat(64))).status).toBe(401);
    expect(await store.listEvents(10)).toHaveLength(0);
  });

  it("stores a signed comment once, even when Meta retries", async () => {
    expect((await post(commentPayload())).status).toBe(200);
    expect((await post(commentPayload())).status).toBe(200);
    const events = await store.listEvents(10);
    expect(events).toHaveLength(1);
    expect(await store.listReplies({ status: "pending" })).toHaveLength(1);
  });

  it("answers the GET challenge", async () => {
    const res = await fetch(`${base}?hub.mode=subscribe&hub.verify_token=sepand-secret&hub.challenge=42`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("42");
  });
});

describe("describePayload", () => {
  it("lists accounts, fields and item count for the webhook log", async () => {
    const { describePayload } = await import("./metaWebhook");
    expect(
      describePayload({
        object: "instagram",
        entry: [
          { id: "178", changes: [{ field: "comments", value: {} }, { field: "mentions", value: {} }] },
          { id: "179", messaging: [{ sender: { id: "1" } }] },
        ],
      }),
    ).toEqual({ accounts: ["178", "179"], fields: ["comments", "mentions", "messaging"], items: 3 });
  });
});
