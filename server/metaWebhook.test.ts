import { createHmac } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractDrafts, getMetaWebhookChallenge, isAutoReplyEnabled, isMetaWebhookConfigured, isValidSignature } from "./metaWebhook";

afterEach(() => vi.unstubAllEnvs());

describe("Meta webhook adapter", () => {
  it("accepts the configured verification token", () => {
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "sepand-secret");
    expect(getMetaWebhookChallenge("subscribe", "sepand-secret", "challenge-123")).toBe("challenge-123");
  });

  it("rejects an invalid verification token", () => {
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "sepand-secret");
    expect(getMetaWebhookChallenge("subscribe", "wrong", "challenge-123")).toBeNull();
  });

  it("rejects verification when no token is configured", () => {
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "");
    expect(getMetaWebhookChallenge("subscribe", "", "challenge-123")).toBeNull();
  });

  it("reports configuration status without exposing secrets", () => {
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "sepand-secret");
    vi.stubEnv("META_ACCESS_TOKEN", "token");
    expect(isMetaWebhookConfigured()).toBe(true);
  });

  it("keeps auto-reply off unless explicitly enabled", () => {
    vi.stubEnv("META_AUTO_REPLY", "");
    expect(isAutoReplyEnabled()).toBe(false);
    vi.stubEnv("META_AUTO_REPLY", "true");
    expect(isAutoReplyEnabled()).toBe(true);
  });

  it("validates X-Hub-Signature-256 when an app secret is set", () => {
    vi.stubEnv("META_APP_SECRET", "app-secret");
    const raw = Buffer.from('{"object":"instagram"}');
    const sig = "sha256=" + createHmac("sha256", "app-secret").update(raw).digest("hex");
    expect(isValidSignature(raw, sig)).toBe(true);
    expect(isValidSignature(raw, "sha256=deadbeef")).toBe(false);
  });

  it("drafts replies for customer comments and DMs, skipping own messages and echoes", () => {
    vi.stubEnv("META_INSTAGRAM_ACCOUNT_ID", "own-1");
    const drafts = extractDrafts({
      object: "instagram",
      entry: [
        {
          id: "own-1",
          changes: [
            { field: "comments", value: { id: "c1", text: "قیمت شمش 5SP؟", from: { id: "u1", username: "ali" } } },
            { field: "comments", value: { id: "c2", text: "ممنون", from: { id: "own-1", username: "sepandsteel" } } },
          ],
          messaging: [
            { sender: { id: "u2" }, recipient: { id: "own-1" }, message: { mid: "m1", text: "آنالیز 3sp دارید؟" } },
            { sender: { id: "own-1" }, recipient: { id: "u2" }, message: { mid: "m2", text: "سلام", is_echo: true } },
          ],
        },
      ],
    });
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({ kind: "comment", commentId: "c1", username: "ali" });
    expect(drafts[0].reply).toContain("سلام ali");
    expect(drafts[1]).toMatchObject({ kind: "dm", recipientId: "u2" });
    expect(drafts[1].reply).toContain("نوع شمش");
  });
});
