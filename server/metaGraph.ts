/**
 * Outgoing calls to Meta. The token type decides the host:
 * - Instagram Login tokens ("IGAA…") only work on graph.instagram.com.
 * - Facebook Login page tokens ("EAA…") use graph.facebook.com.
 * META_API_HOST=instagram|facebook overrides the guess.
 */
export type MetaApiHost = "instagram" | "facebook";

export function getMetaApiHost(): MetaApiHost {
  const override = process.env.META_API_HOST;
  if (override === "instagram" || override === "facebook") return override;
  return (process.env.META_ACCESS_TOKEN ?? "").startsWith("EAA") ? "facebook" : "instagram";
}

function graphBase() {
  const host = getMetaApiHost();
  const version = process.env.META_GRAPH_VERSION ?? (host === "instagram" ? "v23.0" : "v21.0");
  return `https://graph.${host}.com/${version}`;
}

export class MetaApiError extends Error {}

async function graphPost(path: string, body: Record<string, unknown>) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new MetaApiError("META_ACCESS_TOKEN تنظیم نشده است");
  const response = await fetch(`${graphBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {}
    throw new MetaApiError(`Meta API ${response.status}: ${message}`);
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** Public reply under a comment. */
export function replyToComment(commentId: string, message: string) {
  return graphPost(`/${encodeURIComponent(commentId)}/replies`, { message });
}

/** DM reply. Meta only allows this within the 24-hour window after the user's last message. */
export function sendDirectMessage(recipientId: string, text: string) {
  return graphPost(`/me/messages`, { recipient: { id: recipientId }, message: { text } });
}
