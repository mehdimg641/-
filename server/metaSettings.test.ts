import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import { testMetaConnection } from "./metaGraph";
import { decryptSetting, encryptSetting, maskSecret, metaSetting, metaSettingSource, resetMetaSettingsCache, saveMetaSettings } from "./metaSettings";
import { verifyMetaSignature } from "./metaWebhook";
import { appRouter } from "./routers";

const admin = {
  user: { id: 1, openId: "local:admin", name: "admin", email: null, loginMethod: "local", role: "admin", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { headers: {} } as TrpcContext["req"],
  res: {} as TrpcContext["res"],
} satisfies TrpcContext;

beforeEach(() => {
  vi.stubEnv("JWT_SECRET", "test-jwt-secret-test-jwt-secret-1234");
  vi.stubEnv("DATABASE_URL", "");
  for (const key of ["META_ACCESS_TOKEN", "META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN", "INSTAGRAM_ACCOUNT_IDS", "META_AUTO_REPLY", "META_API_HOST"]) vi.stubEnv(key, "");
  resetMetaSettingsCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetMetaSettingsCache();
});

describe("setting encryption", () => {
  it("round-trips and does not store plaintext", () => {
    const stored = encryptSetting("IGAA-secret-token");
    expect(stored).not.toContain("IGAA");
    expect(decryptSetting(stored)).toBe("IGAA-secret-token");
  });

  it("refuses to decrypt after JWT_SECRET changes", () => {
    const stored = encryptSetting("IGAA-secret-token");
    vi.stubEnv("JWT_SECRET", "another-secret-another-secret-0000");
    expect(decryptSetting(stored)).toBeNull();
  });

  it("masks secrets", () => {
    expect(maskSecret("IGAAabcdefghijklmnop")).toBe("IGAA…mnop");
    expect(maskSecret("short")).toBe("••••");
    expect(maskSecret("")).toBe("");
  });
});

describe("dashboard settings", () => {
  it("override the environment and clear back to it", async () => {
    vi.stubEnv("META_APP_SECRET", "from-env");
    expect(metaSettingSource("META_APP_SECRET")).toBe("env");
    await saveMetaSettings({ META_APP_SECRET: "from-panel" });
    expect(metaSetting("META_APP_SECRET")).toBe("from-panel");
    expect(metaSettingSource("META_APP_SECRET")).toBe("panel");
    await saveMetaSettings({ META_APP_SECRET: null });
    expect(metaSetting("META_APP_SECRET")).toBe("from-env");
  });

  it("are what the webhook uses to verify signatures", async () => {
    const { createHmac } = await import("crypto");
    const body = Buffer.from('{"object":"instagram"}');
    const sig = "sha256=" + createHmac("sha256", "panel-secret").update(body).digest("hex");
    expect(verifyMetaSignature(body, sig)).toBe(false);
    await saveMetaSettings({ META_APP_SECRET: "panel-secret" });
    expect(verifyMetaSignature(body, sig)).toBe(true);
  });

  it("never return the token to the client, only a preview", async () => {
    const caller = appRouter.createCaller(admin);
    await caller.settings.saveMeta({ accessToken: "IGAAverysecrettoken1234", appSecret: "app-secret-value-xyz", verifyToken: "verify-me", accountIds: "1784, 999" });
    const result = await caller.settings.meta();
    expect(JSON.stringify(result)).not.toContain("verysecret");
    expect(JSON.stringify(result)).not.toContain("app-secret-value");
    expect(result.accessToken).toEqual({ source: "panel", preview: "IGAA…1234" });
    expect(result.verifyToken.value).toBe("verify-me");
    expect(result.accountIds.value).toBe("1784,999");
    expect(result.configured).toBe(true);
  });

  it("rejects non-numeric account ids and non-admins", async () => {
    await expect(appRouter.createCaller(admin).settings.saveMeta({ accountIds: "sepandsteel" })).rejects.toThrow();
    const user = { ...admin, user: { ...admin.user, role: "user" as const } };
    await expect(appRouter.createCaller(user).settings.meta()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("turns auto-reply on and off from the dashboard", async () => {
    const caller = appRouter.createCaller(admin);
    vi.stubEnv("META_AUTO_REPLY", "false");
    await caller.settings.saveMeta({ autoReply: true });
    expect((await caller.settings.meta()).autoReply).toEqual({ source: "panel", value: true });
    await caller.settings.saveMeta({ autoReply: false });
    expect((await caller.settings.meta()).autoReply.value).toBe(false);
  });
});

describe("testMetaConnection", () => {
  it("keeps 17-digit ids exact", async () => {
    const { parseGraphJson } = await import("./metaGraph");
    expect(parseGraphJson('{"user_id": 17841400000000001, "n": 5, "s": "x 12345678901234567"}')).toEqual({ user_id: "17841400000000001", n: 5, s: "x 12345678901234567" });
  });

  it("reads the professional account id with an Instagram Login token", async () => {
    await saveMetaSettings({ META_ACCESS_TOKEN: "IGAAtoken" });
    const fetchMock = vi.fn(async () => new Response('{"user_id": 17841400000000001, "username": "sepandsteel"}'));
    vi.stubGlobal("fetch", fetchMock);
    expect(await testMetaConnection()).toEqual({ ok: true, host: "instagram", accounts: [{ id: "17841400000000001", username: "sepandsteel" }] });
    expect(fetchMock.mock.calls[0][0]).toBe("https://graph.instagram.com/v23.0/me?fields=user_id,username");
  });

  it("lists linked Instagram accounts with a Facebook page token", async () => {
    await saveMetaSettings({ META_ACCESS_TOKEN: "EAAtoken" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ name: "Sepand", instagram_business_account: { id: "1784", username: "sepandsteel" } }, { name: "Other" }] }))));
    expect(await testMetaConnection()).toEqual({ ok: true, host: "facebook", accounts: [{ id: "1784", username: "sepandsteel" }] });
  });

  it("reports Meta errors", async () => {
    await saveMetaSettings({ META_ACCESS_TOKEN: "IGAAexpired" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Error validating access token" } }), { status: 400 })));
    expect(await testMetaConnection()).toEqual({ ok: false, host: "instagram", error: "Meta API 400: Error validating access token" });
  });
});
