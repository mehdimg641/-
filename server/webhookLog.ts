/** Recent webhook requests, so the dashboard can show whether Meta calls in and why a call was dropped. */
export type WebhookOutcome = "challenge_ok" | "challenge_bad_token" | "bad_signature" | "bad_json" | "other_object" | "received" | "error";
export type WebhookLogEntry = {
  at: Date;
  method: "GET" | "POST";
  status: number;
  outcome: WebhookOutcome;
  detail: string;
  /** Instagram account ids the payload was for, to spot an allowlist that doesn't match. */
  accounts: string[];
};

const MAX_ENTRIES = 50;
const entries: WebhookLogEntry[] = [];

export function recordWebhook(entry: Omit<WebhookLogEntry, "at" | "accounts"> & { accounts?: string[] }) {
  entries.unshift({ at: new Date(), accounts: [], ...entry, detail: entry.detail.slice(0, 255) });
  entries.length = Math.min(entries.length, MAX_ENTRIES);
}

/** Newest first. Kept in memory: a restart clears it. */
export function listWebhookLog(limit = 20) {
  return entries.slice(0, limit);
}
