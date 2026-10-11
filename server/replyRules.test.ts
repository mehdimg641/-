import { describe, expect, it } from "vitest";
import { decideReply } from "./replyRules";

describe("decideReply", () => {
  it("personalizes price requests", () => {
    const d = decideReply("comment", "ali", "قیمت شمش چنده؟");
    expect(d?.rule.id).toBe("price");
    expect(d?.message.startsWith("سلام ali،")).toBe(true);
  });
  it("holds discount and contract questions for approval, even when price is mentioned", () => {
    expect(decideReply("dm", "", "قیمت با تخفیف؟")?.rule.action).toBe("approval");
  });
  it("matches analysis keywords case-insensitively", () => {
    expect(decideReply("dm", "", "آنالیز 3SP")?.rule.id).toBe("analysis");
  });
  it("falls back to the default reply", () => {
    expect(decideReply("dm", "", "سلام")?.rule.id).toBe("fallback");
  });
});
