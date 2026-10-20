/**
 * Outgoing calls to Meta. The token type decides the host:
 * - Instagram Login tokens ("IGAA…") only work on graph.instagram.com.
 * - Facebook Login page tokens ("EAA…") use graph.facebook.com.
 * META_API_HOST=instagram|facebook overrides the guess.
 */
import { metaSetting, refreshMetaSettings } from "./metaSettings";

export type MetaApiHost = "instagram" | "facebook";

export function getMetaApiHost(): MetaApiHost {
  const override = process.env.META_API_HOST;
  if (override === "instagram" || override === "facebook") return override;
  return metaSetting("META_ACCESS_TOKEN").startsWith("EAA") ? "facebook" : "instagram";
}

function graphBase() {
  const host = getMetaApiHost();
  const version = process.env.META_GRAPH_VERSION ?? (host === "instagram" ? "v23.0" : "v21.0");
  return `https://graph.${host}.com/${version}`;
}

export class MetaApiError extends Error {}

async function graphRequest(method: "GET" | "POST", path: string, body?: Record<string, unknown>) {
  await refreshMetaSettings();
  const token = metaSetting("META_ACCESS_TOKEN");
  if (!token) throw new MetaApiError("توکن دسترسی اینستاگرام تنظیم نشده است (تنظیمات → اتصال اینستاگرام)");
  let response: Response;
  try {
    response = await fetch(`${graphBase()}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    // DNS, firewall or timeout: the host could not reach Meta at all.
    const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    throw new MetaApiError(`ارتباط سرور با ${new URL(graphBase()).host} برقرار نشد (${reason})`);
  }
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {}
    throw new MetaApiError(`Meta API ${response.status}: ${message}`);
  }
  return text ? parseGraphJson(text) : {};
}

/** Meta ids can exceed Number.MAX_SAFE_INTEGER; keep long integers as strings so no digit is lost. */
export function parseGraphJson(text: string) {
  return JSON.parse(text.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"')) as Record<string, unknown>;
}

/** Public reply under a comment. */
export function replyToComment(commentId: string, message: string) {
  return graphRequest("POST", `/${encodeURIComponent(commentId)}/replies`, { message });
}

/** DM reply. Meta only allows this within the 24-hour window after the user's last message. */
export function sendDirectMessage(recipientId: string, text: string) {
  return graphRequest("POST", `/me/messages`, { recipient: { id: recipientId }, message: { text } });
}

export type MetaConnectionTest =
  | { ok: true; host: MetaApiHost; accounts: Array<{ id: string; username: string }> }
  | { ok: false; host: MetaApiHost; error: string };

/** Checks the saved token against Meta and returns the Instagram professional account(s) it can manage. */
export async function testMetaConnection(): Promise<MetaConnectionTest> {
  const host = getMetaApiHost();
  try {
    if (host === "instagram") {
      // user_id is the professional account id that webhooks report as entry.id.
      const me = (await graphRequest("GET", "/me?fields=user_id,username")) as { user_id?: string | number; username?: string };
      if (!me.user_id) return { ok: false, host, error: "Meta شناسهٔ حساب را برنگرداند" };
      return { ok: true, host, accounts: [{ id: String(me.user_id), username: me.username ?? "" }] };
    }
    const pages = (await graphRequest("GET", "/me/accounts?fields=name,instagram_business_account{id,username}")) as {
      data?: Array<{ instagram_business_account?: { id?: string; username?: string } }>;
    };
    const accounts = (pages.data ?? [])
      .map((page) => page.instagram_business_account)
      .filter((account): account is { id: string; username?: string } => Boolean(account?.id))
      .map((account) => ({ id: account.id, username: account.username ?? "" }));
    if (!accounts.length) return { ok: false, host, error: "هیچ حساب اینستاگرام حرفه‌ای به صفحه‌های این توکن وصل نیست" };
    return { ok: true, host, accounts };
  } catch (error) {
    return { ok: false, host, error: error instanceof Error ? error.message : String(error) };
  }
}

/** DM to the author of a comment (Instagram "private reply"); allowed once per comment, within 7 days. */
export function sendPrivateReply(commentId: string, text: string) {
  return graphRequest("POST", `/me/messages`, { recipient: { comment_id: commentId }, message: { text } });
}

/** The account whose media to list: "me" with an Instagram Login token, else the configured IG account id. */
function mediaOwner() {
  if (getMetaApiHost() === "instagram") return "me";
  const id = metaSetting("INSTAGRAM_ACCOUNT_IDS").split(",")[0]?.trim();
  if (!id) throw new MetaApiError("ابتدا شناسهٔ حساب اینستاگرام را در تنظیمات وارد کنید (تست اتصال آن را پر می‌کند)");
  return encodeURIComponent(id);
}

type GraphPage<T> = { data?: T[]; paging?: { next?: string; cursors?: { after?: string } } };

/** Follows cursor pagination up to `maxPages`. */
async function graphList<T>(path: string, maxPages: number) {
  const items: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const result = (await graphRequest("GET", after ? `${path}${sep}after=${encodeURIComponent(after)}` : path)) as GraphPage<T>;
    items.push(...(result.data ?? []));
    after = result.paging?.next ? result.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return items;
}

/** Recent posts of the connected account, newest first. */
export async function listRecentMedia() {
  type Media = { id: string; caption?: string; media_type?: string; media_url?: string; thumbnail_url?: string; permalink?: string; timestamp?: string; comments_count?: number };
  const media = await graphList<Media>(`/${mediaOwner()}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count&limit=50`, 2);
  return media.map((m) => ({
    id: String(m.id),
    caption: m.caption ?? null,
    mediaType: m.media_type ?? null,
    mediaUrl: m.media_url ?? null,
    thumbnailUrl: m.thumbnail_url ?? null,
    permalink: m.permalink ?? null,
    postedAt: m.timestamp ? new Date(m.timestamp) : null,
    commentsCount: m.comments_count ?? null,
  }));
}

/** Top-level comments of a post (up to 200). */
export async function listMediaComments(mediaId: string) {
  type Comment = { id: string; text?: string; timestamp?: string; username?: string; from?: { id?: string; username?: string } };
  const comments = await graphList<Comment>(`/${encodeURIComponent(mediaId)}/comments?fields=id,text,timestamp,username,from&limit=50`, 4);
  return comments
    .filter((c) => c.text)
    .map((c) => ({ id: String(c.id), text: c.text!, username: c.from?.username ?? c.username ?? null, fromId: c.from?.id ? String(c.from.id) : null }));
}
