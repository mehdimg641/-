import type { InsertReplyRule, InsertReplyTemplate, ReplyRule, ReplyTemplate } from "../drizzle/schema";

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

/** Seeded into an empty templates table (the former built-in library). */
export const DEFAULT_TEMPLATES: InsertReplyTemplate[] = [
  { title: "استعلام قیمت اولیه", category: "فروش", text: "سلام {{username}}، وقت بخیر. برای اعلام قیمت دقیق لطفاً نوع شمش، سایز، تناژ و شهر مقصد را بفرمایید تا همکار فروش راهنمایی کند." },
  { title: "آنالیز و کیفیت", category: "پشتیبانی", text: "سلام {{username}}، مشخصات فنی و آنالیز محصول موردنظر شما را بررسی می‌کنیم. لطفاً سایز و گرید موردنظر را بفرمایید." },
  { title: "ارسال به شهر مقصد", category: "فروش", text: "سلام {{username}}، ارسال به شهر شما قابل بررسی است. لطفاً تناژ و زمان موردنظر را بفرمایید تا زمان تحویل و هزینه حمل اعلام شود." },
  { title: "دریافت قراضه", category: "قراضه", text: "سلام {{username}}، برای بررسی خرید قراضه لطفاً نوع بار، وزن تقریبی، محل بارگیری و تصاویر را ارسال کنید." },
  { title: "دعوت به دایرکت", category: "کامنت", text: "سلام {{username}}، جزئیات را در دایرکت برایتان فرستادیم 🌹" },
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
  // Only spaces and tabs: line breaks carry paragraphs and the "---" message separators.
  return username ? rendered : rendered.replace(/[ \t]+،/g, "،").replace(/[ \t]{2,}/g, " ").trim();
}

export type ReplyDecision = {
  rule: ReplyRule;
  /** Public comment reply, or the DM reply for DM events. Empty = no reply in place. */
  message: string;
  /** Comments only: private DM to the commenter. Empty = none. */
  dmMessage: string;
};

type TemplateLookup = Pick<ReplyTemplate, "id" | "text">[];

function templateText(templates: TemplateLookup, id: number | null, inline: string | null) {
  if (id != null) return templates.find((t) => t.id === id)?.text ?? "";
  return inline ?? "";
}

const isScoped = (rule: ReplyRule) => Boolean(rule.mediaIds && rule.mediaIds.length);

/**
 * First matching rule wins. Rules limited to specific posts are checked before rules for every
 * post, so "keyword X on this post" beats a general rule; within each group, lower priority first.
 */
/**
 * Every rule that would answer this text, in the order they are tried; only the first one is
 * applied. `keyword` is the keyword that matched, or null for a rule without keywords.
 */
export function matchingRules(rules: ReplyRule[], channel: ReplyChannel, text: string, mediaId: string | null = null) {
  const normalized = normalizeText(text);
  const matches: Array<{ rule: ReplyRule; keyword: string | null }> = [];
  const ordered = [...rules]
    .filter((r) => r.enabled && r.channels.includes(channel))
    .filter((r) => !isScoped(r) || (channel === "comment" && mediaId !== null && r.mediaIds!.includes(mediaId)))
    .sort((a, b) => Number(isScoped(b)) - Number(isScoped(a)) || a.priority - b.priority || a.id - b.id);
  for (const rule of ordered) {
    if (rule.keywords.length === 0) {
      matches.push({ rule, keyword: null });
      continue;
    }
    const keyword = rule.keywords.find((k) => k.trim() && normalized.includes(normalizeText(k.trim())));
    if (keyword) matches.push({ rule, keyword: keyword.trim() });
  }
  return matches;
}

export function decideReply(
  rules: ReplyRule[],
  templates: TemplateLookup,
  channel: ReplyChannel,
  username: string,
  text: string,
  mediaId: string | null = null,
): ReplyDecision | null {
  const rule = matchingRules(rules, channel, text, mediaId)[0]?.rule;
  if (!rule) return null;
  const message = renderTemplate(templateText(templates, rule.templateId, rule.template), username);
  const dmMessage = channel === "comment" ? renderTemplate(templateText(templates, rule.dmTemplateId, rule.dmTemplate), username) : "";
  return { rule, message, dmMessage };
}
