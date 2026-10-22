import { describe, expect, it } from "vitest";
import { withReadableHtmlErrors } from "../client/src/lib/trpcFetch";

describe("withReadableHtmlErrors", () => {
  it("turns a gateway-timeout page into one tRPC error per batched call", async () => {
    const page = new Response("<html><head><title>504 Gateway Time-out</title></head><body></body></html>", { status: 504, headers: { "content-type": "text/html" } });
    const response = await withReadableHtmlErrors(page, "/api/trpc/approvals.approveMany,inbox.threads?batch=1");
    const body = await response.json();
    expect(body).toHaveLength(2);
    expect(body[0].error.json.message).toContain("HTTP 504 · 504 Gateway Time-out");
    expect(body[0].error.json.message).toContain("بیش از حد طول کشید");
    expect(body[0].error.json.data.httpStatus).toBe(504);
  });

  it("leaves JSON answers alone", async () => {
    const ok = new Response('[{"result":{"data":{"json":1}}}]', { headers: { "content-type": "application/json" } });
    expect(await withReadableHtmlErrors(ok, "/api/trpc/x")).toBe(ok);
  });
});
