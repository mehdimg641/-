import { describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import { getMetaWebhookChallenge, isMetaWebhookConfigured, verifyMetaSignature } from "./metaWebhook";

describe("Meta webhook adapter", () => {
  it("accepts the configured verification token", () => {
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "sepand-secret");
    expect(getMetaWebhookChallenge("subscribe", "sepand-secret", "challenge-123")).toBe("challenge-123");
  });

  it("rejects an invalid verification token", () => {
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "sepand-secret");
    expect(getMetaWebhookChallenge("subscribe", "wrong", "challenge-123")).toBeNull();
  });

  it("reports configuration status without exposing secrets", () => {
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "sepand-secret");
    vi.stubEnv("META_ACCESS_TOKEN", "token");
    vi.stubEnv("META_APP_SECRET", "app-secret");
    expect(isMetaWebhookConfigured()).toBe(true);
  });

  it("verifies the X-Hub-Signature-256 header", () => {
    vi.stubEnv("META_APP_SECRET", "app-secret");
    const body = Buffer.from('{"object":"instagram"}');
    const sig = "sha256=" + createHmac("sha256", "app-secret").update(body).digest("hex");
    expect(verifyMetaSignature(body, sig)).toBe(true);
    expect(verifyMetaSignature(body, "sha256=" + "0".repeat(64))).toBe(false);
    expect(verifyMetaSignature(body, undefined)).toBe(false);
  });
});
