/**
 * When the host answers an API call with an HTML page (a gateway timeout, a firewall block, a
 * PHP crash), tRPC fails with "Unexpected token '<' … is not valid JSON". This turns such a page
 * into a normal tRPC error for each call in the batch, with a message the operator can act on.
 */
export async function withReadableHtmlErrors(response: Response, url: string): Promise<Response> {
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("json")) return response;
  const body = await response.text();
  try {
    JSON.parse(body);
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch {}
  const title = body.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() || response.statusText || "";
  const slow = [502, 503, 504, 508, 524].includes(response.status);
  const message =
    `سرور به‌جای جواب یک صفحهٔ خطا برگرداند (HTTP ${response.status}${title ? ` · ${title}` : ""}).` +
    (slow
      ? " درخواست بیش از حد طول کشید یا هاست موقتاً در دسترس نبود؛ صفحه را تازه کنید و وضعیت موارد را ببینید (ممکن است کار در پس‌زمینه انجام شده باشد)."
      : " اگر تکرار شد، این متن را برای پشتیبانی بفرستید.");
  // One result per procedure in the batch: /api/trpc/a,b,c?batch=1
  const path = new URL(url, "http://local").pathname.replace(/^.*\/api\/trpc\//, "");
  const calls = Math.max(1, decodeURIComponent(path).split(",").length);
  const error = { error: { json: { message, code: -32603, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: response.status || 500 } } } };
  return new Response(JSON.stringify(Array.from({ length: calls }, () => error)), {
    status: response.status || 500,
    headers: { "content-type": "application/json" },
  });
}
