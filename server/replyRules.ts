import type { InsertReplyRule, ReplyRule } from "../drizzle/schema";

export type ReplyChannel = "comment" | "dm";

/**
 * Seeded into an empty rules table. Order is priority: sensitive topics come first so
 * "قیمت با تخفیف؟" is held for approval instead of matching the plain price rule.
 */
export const DEFAULT_RULES: InsertReplyRule[] = [
  {
    name: "تخفیف / قرارداد / تحویل",
    keywords: ["تخفیف", "قرارداد", "تحویل", "پیش پرداخت", "عمده"],
    channels: ["comment", "dm"],
    action: "approval",
    template: "سلام {{username}}، درخواست شما ثبت شد و همکار فروش به‌زودی پاسخ می‌دهد.",
    priority: 10,
  },
  {
    name: "درخواست قیمت",
    keywords: ["قیمت", "نرخ", "استعلام"],
    channels: ["comment", "dm"],
    action: "approval",
    template: "سلام {{username}}، برای اعلام قیمت دقیق لطفاً سایز، تناژ و شهر مقصد را دایرکت کنید.",
    priority: 20,
  },
  {
    name: "آنالیز و کیفیت",
    keywords: ["آنالیز", "کیفیت", "3sp", "4sp", "5sp"],
    channels: ["comment", "dm"],
    action: "send",
    template: "سلام {{username}}، نوع شمش و سایز موردنظر را بفرمایید تا آنالیز و مشخصات فنی مناسب ارسال شود.",
    priority: 30,
  },
  {
    name: "پاسخ پیش‌فرض",
    keywords: [],
    channels: ["comment", "dm"],
    action: "approval",
    template: "سلام {{username}}، درخواست شما ثبت شد. لطفاً مشخصات کامل را بفرستید تا همکار فروش راهنمایی کند.",
    priority: 1000,
  },
];

/** Persian/Arabic digits and letter variants are folded so "۳SP" and "ي" match "3sp" and "ی". */
export function normalizeText(text: string) {
  return text
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/‌/g, " ")
    .toLowerCase();
}

export function renderTemplate(template: string, username: string) {
  const rendered = template.replaceAll("{{username}}", username);
  // Without a username, "سلام ، ..." would read oddly; collapse the empty slot.
  return username ? rendered : rendered.replace(/\s+،/g, "،").replace(/\s{2,}/g, " ").trim();
}

export type ReplyDecision = { rule: ReplyRule; message: string };

export function decideReply(rules: ReplyRule[], channel: ReplyChannel, username: string, text: string): ReplyDecision | null {
  const normalized = normalizeText(text);
  const rule = [...rules]
    .filter((r) => r.enabled && r.channels.includes(channel))
    .sort((a, b) => a.priority - b.priority || a.id - b.id)
    .find((r) => r.keywords.length === 0 || r.keywords.some((k) => k.trim() && normalized.includes(normalizeText(k.trim()))));
  if (!rule) return null;
  return { rule, message: renderTemplate(rule.template, username) };
}
