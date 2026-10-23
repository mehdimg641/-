import type { IgAccount } from "../drizzle/schema";
import type { InboxStore } from "./inboxStore";
import { MetaApiError, ownUsername, refreshInstagramToken, subscribeWebhooks, testMetaConnection, withGraphAccount } from "./metaGraph";
import { decryptSetting, encryptSetting, maskSecret, metaSetting, refreshMetaSettings } from "./metaSettings";

/** What the dashboard sees of a page; the token itself never leaves the server. */
export type AccountSummary = {
  id: string;
  username: string | null;
  name: string | null;
  tokenPreview: string;
  tokenExpiresAt: Date | null;
  lastError: string | null;
  enabled: boolean;
};

export function summarize(account: IgAccount): AccountSummary {
  return {
    id: account.id,
    username: account.username,
    name: account.name,
    tokenPreview: maskSecret(decryptSetting(account.token) ?? ""),
    tokenExpiresAt: account.tokenExpiresAt,
    lastError: account.lastError,
    enabled: account.enabled,
  };
}

const migrated = new WeakSet<InboxStore>();

/**
 * Pages came after the single-page settings. The first time, the page in Settings (token +
 * account id) becomes the first page, and rules, templates and posts without a page join it.
 */
export async function ensureAccounts(store: InboxStore) {
  if (migrated.has(store)) return;
  await refreshMetaSettings();
  let accounts = await store.listAccounts();
  const legacyToken = metaSetting("META_ACCESS_TOKEN");
  const legacyId = metaSetting("INSTAGRAM_ACCOUNT_IDS").split(",")[0]?.trim();
  if (!accounts.length && legacyToken && legacyId) {
    try {
      // The username is only for the page switcher; without it the page shows by id.
      const username = await withGraphAccount({ id: legacyId, token: legacyToken }, () => ownUsername()).catch(() => null);
      await store.saveAccount({ id: legacyId, username, token: encryptSetting(legacyToken), enabled: true });
      accounts = await store.listAccounts();
    } catch (error) {
      // Without a key to encrypt it the page keeps working from Settings, as before pages existed.
      console.warn("[Accounts] Could not move the Settings page into pages:", error instanceof Error ? error.message : error);
      return;
    }
  }
  if (accounts[0]) await store.assignOrphans(accounts[0].id);
  migrated.add(store);
}

export async function enabledAccounts(store: InboxStore) {
  await ensureAccounts(store);
  return (await store.listAccounts()).filter((a) => a.enabled);
}

/** The page a request asked for (X-Sepand-Account), or the first connected page. */
export async function resolveAccount(store: InboxStore, requested: string | null | undefined) {
  const accounts = await enabledAccounts(store);
  return accounts.find((a) => a.id === requested) ?? accounts[0] ?? null;
}

/** Runs `fn` with Graph calls using this page's token (the Settings token if it has none). */
export async function asAccount<T>(store: InboxStore, accountId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  if (!accountId) return fn();
  const account = await store.getAccount(accountId);
  const token = account ? decryptSetting(account.token) : null;
  if (!token) return fn();
  return withGraphAccount({ id: accountId, token }, fn);
}

/**
 * Connects a page from its access token: Meta says which professional account it belongs to,
 * the page is saved (or its token replaced) and its webhooks are subscribed.
 */
export async function addAccount(store: InboxStore, token: string, expectedId?: string) {
  await ensureAccounts(store);
  const test = await withGraphAccount({ id: "", token }, () => testMetaConnection());
  if (!test.ok) throw new MetaApiError(test.error);
  // A Facebook Login token can reach several professional accounts.
  const me = test.accounts.find((a) => a.id === expectedId) ?? test.accounts[0];
  if (!me) throw new MetaApiError("این توکن به هیچ حساب حرفه‌ای اینستاگرام وصل نیست");
  if (expectedId && me.id !== expectedId) throw new MetaApiError(`این توکن مال ${me.username ? `@${me.username}` : me.id} است، نه این پیج`);
  const first = !(await store.listAccounts()).length;
  const account = await store.saveAccount({
    id: me.id,
    username: me.username || null,
    token: encryptSetting(token),
    tokenRefreshedAt: new Date(),
    tokenExpiresAt: null,
    lastError: null,
    enabled: true,
  });
  if (first) await store.assignOrphans(account.id);
  let subscribeError: string | null = null;
  if (test.host === "instagram") {
    await withGraphAccount({ id: account.id, token }, () => subscribeWebhooks()).catch((error) => {
      subscribeError = error instanceof Error ? error.message : String(error);
    });
  }
  if (subscribeError) await store.updateAccount(account.id, { lastError: `فعال‌سازی وب‌هوک: ${subscribeError}` });
  return { account: summarize((await store.getAccount(account.id))!), subscribeError };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Refreshes one page's Instagram Login token and records the new expiry (or the error). */
export async function refreshAccount(store: InboxStore, account: IgAccount) {
  const token = decryptSetting(account.token);
  if (!token) throw new MetaApiError("توکن این پیج خوانده نشد؛ توکن جدید بگذارید");
  try {
    const fresh = await refreshInstagramToken(token);
    await store.updateAccount(account.id, { token: encryptSetting(fresh.token), tokenExpiresAt: fresh.expiresAt, tokenRefreshedAt: new Date(), lastError: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.updateAccount(account.id, { lastError: `تمدید توکن: ${message}`, tokenRefreshedAt: new Date() });
    throw error;
  }
}

/**
 * Keeps tokens alive without a cron: called from the dashboard's status poll, it refreshes at most
 * one Instagram Login token a week old (Meta needs it to be at least a day old). Failures are kept
 * on the page and shown in Settings; they never break the poll.
 */
export async function refreshDueToken(store: InboxStore, now = new Date()) {
  for (const account of await enabledAccounts(store)) {
    const token = decryptSetting(account.token) ?? "";
    if (!token.startsWith("IG")) continue;
    const last = account.tokenRefreshedAt ?? account.createdAt;
    const expiringSoon = account.tokenExpiresAt && account.tokenExpiresAt.getTime() - now.getTime() < 10 * DAY_MS;
    if (now.getTime() - last.getTime() < (expiringSoon ? DAY_MS : 7 * DAY_MS)) continue;
    await refreshAccount(store, account).catch(() => undefined);
    return account.id;
  }
  return null;
}
