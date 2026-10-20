import { describe, expect, it } from "vitest";
import type { ReplyRule } from "../drizzle/schema";
import { decideReply, DEFAULT_RULES, normalizeText, renderTemplate } from "./replyRules";

const rules: ReplyRule[] = DEFAULT_RULES.map((rule, i) => ({
  id: i + 1,
  name: rule.name,
  keywords: rule.keywords,
  channels: rule.channels,
  action: rule.action ?? "approval",
  template: rule.template,
  templateId: null,
  dmTemplate: null,
  dmTemplateId: null,
  mediaIds: null,
  priority: rule.priority ?? 100,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
}));

describe("decideReply", () => {
  it("personalizes price requests and holds them for approval", () => {
    const d = decideReply(rules, [], "comment", "ali", "قیمت شمش چنده؟");
    expect(d?.rule.name).toBe("درخواست قیمت");
    expect(d?.rule.action).toBe("approval");
    expect(d?.message.startsWith("سلام ali،")).toBe(true);
  });

  it("checks sensitive rules before the price rule", () => {
    expect(decideReply(rules, [], "dm", "", "قیمت با تخفیف؟")?.rule.name).toBe("تخفیف / قرارداد / تحویل");
  });

  it("matches Persian digits and mixed case", () => {
    expect(decideReply(rules, [], "dm", "", "آنالیز ۳SP")?.rule.name).toBe("آنالیز و کیفیت");
  });

  it("falls back to the default reply and skips disabled rules", () => {
    expect(decideReply(rules, [], "dm", "", "سلام")?.rule.name).toBe("پاسخ پیش‌فرض");
    const withoutFallback = rules.map((r) => (r.keywords.length === 0 ? { ...r, enabled: false } : r));
    expect(decideReply(withoutFallback, [], "dm", "", "سلام")).toBeNull();
  });

  it("respects the rule channel", () => {
    const dmOnly = rules.map((r) => ({ ...r, channels: ["dm" as const] }));
    expect(decideReply(dmOnly, [], "comment", "ali", "قیمت")).toBeNull();
  });
});

describe("per-post rules, templates and DMs", () => {
  const base = rules[0];
  const scoped: ReplyRule = { ...base, id: 50, name: "پست تیرآهن", keywords: ["قیمت"], action: "send", priority: 500, template: "", templateId: 7, dmTemplate: "سلام {{username}}، لیست قیمت تیرآهن را فرستادیم.", dmTemplateId: null, mediaIds: ["m1"] };
  const templates = [{ id: 7, text: "سلام {{username}}، جزئیات را دایرکت کردیم 🌹" }];

  it("checks rules for this post before general rules, whatever their priority", () => {
    const d = decideReply([...rules, scoped], templates, "comment", "ali", "قیمت؟", "m1");
    expect(d?.rule.id).toBe(50);
    expect(d?.message).toBe("سلام ali، جزئیات را دایرکت کردیم 🌹");
    expect(d?.dmMessage).toBe("سلام ali، لیست قیمت تیرآهن را فرستادیم.");
  });

  it("ignores post rules on other posts and on DMs", () => {
    expect(decideReply([...rules, scoped], templates, "comment", "ali", "قیمت؟", "m2")?.rule.name).toBe("درخواست قیمت");
    expect(decideReply([{ ...scoped, channels: ["comment", "dm"] }], templates, "dm", "", "قیمت؟")).toBeNull();
  });

  it("never drafts a DM for DM events", () => {
    expect(decideReply([{ ...scoped, mediaIds: null, channels: ["dm"] }], templates, "dm", "", "قیمت")?.dmMessage).toBe("");
  });

  it("gives an empty reply when the linked template was deleted", () => {
    expect(decideReply([scoped], [], "comment", "ali", "قیمت", "m1")?.message).toBe("");
  });
});

describe("templates", () => {
  it("replaces every {{username}} and tidies an empty one", () => {
    expect(renderTemplate("سلام {{username}}، {{username}} عزیز", "ali")).toBe("سلام ali، ali عزیز");
    expect(renderTemplate("سلام {{username}}، لطفاً دایرکت کنید.", "")).toBe("سلام، لطفاً دایرکت کنید.");
  });

  it("normalizes Arabic letters", () => {
    expect(normalizeText("قيمت")).toBe("قیمت");
  });
});
