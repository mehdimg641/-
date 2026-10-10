import { describe, expect, it, vi } from "vitest";
import { getMetaWebhookChallenge, isMetaWebhookConfigured } from "./metaWebhook";

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
    expect(isMetaWebhookConfigured()).toBe(true);
  });
});
