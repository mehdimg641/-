import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { appSettings } from "../drizzle/schema";
import { getDb } from "./db";

/**
 * The Meta connection can be configured from the dashboard instead of server environment
 * variables (useful on cPanel, where editing env vars means going through the hosting panel).
 * A value saved in the dashboard wins over the environment variable of the same name.
 * Values are stored AES-256-GCM encrypted with a key derived from JWT_SECRET.
 */
export const META_SETTING_KEYS = ["META_ACCESS_TOKEN", "META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN", "INSTAGRAM_ACCOUNT_IDS", "META_AUTO_REPLY"] as const;
export type MetaSettingKey = (typeof META_SETTING_KEYS)[number];

const CACHE_MS = 15_000;
let cache = new Map<MetaSettingKey, string>();
let loadedAt = 0;
let tableReady = false;

function encryptionKey() {
  const secret = process.env.JWT_SECRET ?? "";
  if (!secret) throw new Error("JWT_SECRET تنظیم نشده؛ ذخیرهٔ امن تنظیمات ممکن نیست");
  return createHash("sha256").update(`sepand-inbox:settings:${secret}`).digest();
}

export function encryptSetting(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

/** Returns null when the value can't be decrypted (e.g. JWT_SECRET changed). */
export function decryptSetting(stored: string) {
  try {
    const [version, iv, tag, data] = stored.split(":");
    if (version !== "v1") return null;
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Dashboard value if set, otherwise the environment variable. Synchronous: reads the cache. */
export function metaSetting(key: MetaSettingKey) {
  return cache.get(key) || process.env[key] || "";
}

export function metaSettingSource(key: MetaSettingKey): "panel" | "env" | "unset" {
  if (cache.get(key)) return "panel";
  return process.env[key] ? "env" : "unset";
}

async function ensureTable(db: NonNullable<Awaited<ReturnType<typeof getDb>>>) {
  if (tableReady) return;
  // Existing installs predate this table; create it so no manual SQL import is needed.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS appSettings (
    \`key\` varchar(64) NOT NULL,
    \`value\` text NOT NULL,
    \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (\`key\`)
  ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  tableReady = true;
}

/**
 * Reloads dashboard settings from the database. Cached for a few seconds; the server may run
 * several processes (Passenger), so a save in one process reaches the others on their next refresh.
 */
export async function refreshMetaSettings(force = false) {
  if (!force && Date.now() - loadedAt < CACHE_MS) return;
  const db = await getDb();
  if (!db) {
    loadedAt = Date.now(); // in-memory mode: the cache is the store
    return;
  }
  try {
    await ensureTable(db);
    const rows = await db.select().from(appSettings).where(inArray(appSettings.key, [...META_SETTING_KEYS]));
    const next = new Map<MetaSettingKey, string>();
    for (const row of rows) {
      const value = decryptSetting(row.value);
      if (value === null) console.warn(`[Settings] Could not decrypt ${row.key}; was JWT_SECRET changed? Save it again in the dashboard.`);
      else next.set(row.key as MetaSettingKey, value);
    }
    cache = next;
    loadedAt = Date.now();
  } catch (error) {
    // Keep serving the last known values rather than dropping the connection.
    console.error("[Settings] Failed to load settings:", error);
  }
}

/** string = set, null = remove the dashboard value (falls back to the env var), undefined = keep. */
export async function saveMetaSettings(patch: Partial<Record<MetaSettingKey, string | null>>) {
  const db = await getDb();
  for (const key of META_SETTING_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    const trimmed = value?.trim() ?? "";
    if (!db) {
      if (trimmed) cache.set(key, trimmed);
      else cache.delete(key);
      continue;
    }
    await ensureTable(db);
    if (trimmed) {
      const encrypted = encryptSetting(trimmed);
      await db.insert(appSettings).values({ key, value: encrypted }).onDuplicateKeyUpdate({ set: { value: encrypted } });
    } else {
      await db.delete(appSettings).where(eq(appSettings.key, key));
    }
  }
  await refreshMetaSettings(true);
}

/** Shows enough of a secret to recognise it, never the whole value. */
export function maskSecret(value: string) {
  if (!value) return "";
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : "••••";
}

/** Test hook. */
export function resetMetaSettingsCache() {
  cache = new Map();
  loadedAt = 0;
  tableReady = false;
}
