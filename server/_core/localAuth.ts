import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import type { Request } from "express";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { ENV } from "./env";
import { sdk } from "./sdk";

/**
 * Self-hosted login (AUTH_MODE=local): a single admin account from ADMIN_USERNAME / ADMIN_PASSWORD
 * replaces Manus OAuth, which only works on Manus hosting.
 */
export function isLocalAuth() {
  return process.env.AUTH_MODE === "local";
}

export const LOCAL_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 10;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const salt = randomBytes(16);
const hash = (value: string) => scryptSync(value, salt, 32);

function safeEqual(a: string, b: string) {
  // Hashing first gives equal-length buffers, so the comparison leaks neither content nor length.
  return timingSafeEqual(hash(a), hash(b));
}

const failures = new Map<string, { count: number; resetAt: number }>();

export function clientKey(req: Pick<Request, "ip">) {
  return req.ip || "unknown";
}

export function isLockedOut(key: string, now = Date.now()) {
  const entry = failures.get(key);
  if (!entry || entry.resetAt <= now) return false;
  return entry.count >= MAX_FAILURES;
}

function recordFailure(key: string, now = Date.now()) {
  const entry = failures.get(key);
  if (!entry || entry.resetAt <= now) failures.set(key, { count: 1, resetAt: now + LOCKOUT_MS });
  else entry.count++;
}

export class LocalAuthError extends Error {
  constructor(
    message: string,
    readonly code: "TOO_MANY_REQUESTS" | "UNAUTHORIZED" | "PRECONDITION_FAILED",
  ) {
    super(message);
  }
}

const openIdFor = (username: string) => `local:${username}`;

/** Validates the credentials and returns a session token for the admin. */
export async function localLogin(key: string, username: string, password: string) {
  const expectedUser = process.env.ADMIN_USERNAME ?? "";
  const expectedPassword = process.env.ADMIN_PASSWORD ?? "";
  if (!expectedUser || expectedPassword.length < MIN_PASSWORD_LENGTH || !ENV.cookieSecret) {
    throw new LocalAuthError(
      `ورود پیکربندی نشده: ADMIN_USERNAME، ADMIN_PASSWORD (حداقل ${MIN_PASSWORD_LENGTH} نویسه) و JWT_SECRET را تنظیم کنید`,
      "PRECONDITION_FAILED",
    );
  }
  if (isLockedOut(key)) throw new LocalAuthError("تلاش‌های ناموفق زیاد بود؛ ۱۵ دقیقه دیگر دوباره امتحان کنید", "TOO_MANY_REQUESTS");

  // Evaluate both so a wrong username costs the same time as a wrong password.
  const userOk = safeEqual(username, expectedUser);
  const passwordOk = safeEqual(password, expectedPassword);
  if (!userOk || !passwordOk) {
    recordFailure(key);
    throw new LocalAuthError("نام کاربری یا رمز عبور اشتباه است", "UNAUTHORIZED");
  }
  failures.delete(key);

  await db.upsertUser({ openId: openIdFor(expectedUser), name: expectedUser, loginMethod: "local", role: "admin", lastSignedIn: new Date() });
  return sdk.signSession({ openId: openIdFor(expectedUser), appId: ENV.appId || "sepand-inbox", name: expectedUser }, { expiresInMs: LOCAL_SESSION_MS });
}

/** Resolves the session cookie to the admin user; null when missing, invalid or for another account. */
export async function authenticateLocal(sessionToken: string | undefined): Promise<User | null> {
  const session = await sdk.verifySession(sessionToken);
  const expectedUser = process.env.ADMIN_USERNAME ?? "";
  // A token for a since-renamed admin, or a Manus token signed with the same secret, is not accepted.
  if (!session || !expectedUser || session.openId !== openIdFor(expectedUser)) return null;

  const user = await db.getUserByOpenId(session.openId);
  if (user) return { ...user, role: "admin" };
  if (await db.getDb()) return null;
  // No database (preview mode): there is nothing to look up, so describe the admin from the session.
  const now = new Date();
  return { id: 1, openId: session.openId, name: session.name, email: null, loginMethod: "local", role: "admin", createdAt: now, updatedAt: now, lastSignedIn: now };
}

/** Test hook. */
export function resetLoginFailures() {
  failures.clear();
}
