import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOKIE_NAME } from "../shared/const";
import type { TrpcContext } from "./_core/context";
import { ENV } from "./_core/env";
import { authenticateLocal, resetLoginFailures } from "./_core/localAuth";
import { appRouter } from "./routers";

function context(ip = "1.2.3.4") {
  const cookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
  const ctx = {
    user: null,
    req: { ip, protocol: "https", headers: {} } as TrpcContext["req"],
    res: { cookie: (name: string, value: string, options: Record<string, unknown>) => cookies.push({ name, value, options }) } as unknown as TrpcContext["res"],
  } satisfies TrpcContext;
  return { ctx, cookies };
}

beforeEach(() => {
  vi.stubEnv("AUTH_MODE", "local");
  vi.stubEnv("ADMIN_USERNAME", "admin");
  vi.stubEnv("ADMIN_PASSWORD", "correct-horse-battery");
  vi.stubEnv("DATABASE_URL", "");
  // ENV is read once at import, so set the signing secret directly.
  ENV.cookieSecret = "test-jwt-secret-test-jwt-secret-1234";
  resetLoginFailures();
});
afterEach(() => vi.unstubAllEnvs());

describe("auth.login (AUTH_MODE=local)", () => {
  it("rejects a wrong password without setting a cookie", async () => {
    const { ctx, cookies } = context();
    await expect(appRouter.createCaller(ctx).auth.login({ username: "admin", password: "wrong-password" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(cookies).toHaveLength(0);
  });

  it("sets a lax, httpOnly session cookie that resolves to the admin", async () => {
    const { ctx, cookies } = context();
    await expect(appRouter.createCaller(ctx).auth.login({ username: "admin", password: "correct-horse-battery" })).resolves.toEqual({ success: true });
    expect(cookies[0]).toMatchObject({ name: COOKIE_NAME, options: { httpOnly: true, sameSite: "lax", secure: true } });
    expect(await authenticateLocal(cookies[0].value)).toMatchObject({ role: "admin", openId: "local:admin" });
  });

  it("does not accept the session after the admin username changes", async () => {
    const { ctx, cookies } = context();
    await appRouter.createCaller(ctx).auth.login({ username: "admin", password: "correct-horse-battery" });
    vi.stubEnv("ADMIN_USERNAME", "someone-else");
    expect(await authenticateLocal(cookies[0].value)).toBeNull();
    expect(await authenticateLocal("not-a-jwt")).toBeNull();
  });

  it("locks an IP out after 5 failures, even for the right password", async () => {
    const { ctx } = context("9.9.9.9");
    const caller = appRouter.createCaller(ctx);
    for (let i = 0; i < 5; i++) await expect(caller.auth.login({ username: "admin", password: "nope" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.auth.login({ username: "admin", password: "correct-horse-battery" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // Other clients are unaffected.
    await expect(appRouter.createCaller(context("5.5.5.5").ctx).auth.login({ username: "admin", password: "correct-horse-battery" })).resolves.toEqual({ success: true });
  });

  it("refuses to log in until a strong password is configured", async () => {
    vi.stubEnv("ADMIN_PASSWORD", "short");
    await expect(appRouter.createCaller(context().ctx).auth.login({ username: "admin", password: "short" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("is disabled outside local mode", async () => {
    vi.stubEnv("AUTH_MODE", "");
    await expect(appRouter.createCaller(context().ctx).auth.login({ username: "admin", password: "correct-horse-battery" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
