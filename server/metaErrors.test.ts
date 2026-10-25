import { describe, expect, it } from "vitest";
import { WINDOW_CLOSED } from "@shared/inbox";
import { describeMetaError } from "./metaGraph";

describe("describeMetaError", () => {
  it("explains the cases an operator can act on and keeps Meta's details", () => {
    expect(describeMetaError(400, { message: "(#10) This message is sent outside of allowed window.", code: 10, error_subcode: 2534022 })).toBe(WINDOW_CLOSED);
    const gone = describeMetaError(400, { message: "Unsupported post request. Object with ID '1' does not exist", code: 100, error_subcode: 33, fbtrace_id: "AbC" });
    expect(gone).toMatch(/^این کامنت یا پیام دیگر وجود ندارد/);
    expect(gone).toContain("Meta API 400: Unsupported post request");
    expect(gone).toContain("(کد 100/33 · trace AbC)");
    expect(describeMetaError(500, { message: "An unknown error has occurred.", code: 1, fbtrace_id: "Xy" })).toBe(
      "خطای موقت سرور اینستاگرام؛ چند دقیقه بعد دوباره امتحان کنید. — Meta API 500: An unknown error has occurred. (کد 1 · trace Xy)",
    );
    expect(describeMetaError(400, { message: "x", code: 551, error_subcode: 1545041 })).toMatch(/^این کاربر در دسترس نیست/);
    expect(describeMetaError(400, { message: "Error validating access token" })).toBe("Meta API 400: Error validating access token");
  });
});
