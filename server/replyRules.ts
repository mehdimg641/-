export type ReplyChannel = "comment" | "dm";

export type ReplyRule = {
  id: string;
  name: string;
  keywords: string[];
  channels: ReplyChannel[];
  /** "send" replies immediately; "approval" holds the reply for an operator. */
  action: "send" | "approval";
  /** Supports {{username}}. */
  template: string;
};

/** Order matters: the first matching rule wins, so sensitive rules come first. */
export const DEFAULT_RULES: ReplyRule[] = [
  {
    id: "sensitive",
    name: "تخفیف / قرارداد / تحویل",
    keywords: ["تخفیف", "قرارداد", "زمان تحویل", "تحویل", "پیش پرداخت", "چک"],
    channels: ["comment", "dm"],
    action: "approval",
    template: "{{username}}درخواست شما ثبت شد و همکار فروش به‌زودی پاسخ می‌دهد.",
  },
  {
    id: "price",
    name: "درخواست قیمت",
    keywords: ["قیمت", "نرخ", "استعلام"],
    channels: ["comment", "dm"],
    action: "send",
    template: "{{username}}برای اعلام قیمت دقیق لطفاً سایز، تناژ و شهر مقصد را دایرکت کنید.",
  },
  {
    id: "analysis",
    name: "آنالیز و کیفیت",
    keywords: ["آنالیز", "کیفیت", "3sp", "4sp", "5sp"],
    channels: ["comment", "dm"],
    action: "send",
    template: "{{username}}نوع شمش و سایز موردنظر را بفرمایید تا آنالیز و مشخصات فنی مناسب ارسال شود.",
  },
  {
    id: "fallback",
    name: "پاسخ پیش‌فرض",
    keywords: [],
    channels: ["comment", "dm"],
    action: "send",
    template: "{{username}}درخواست شما ثبت شد. لطفاً مشخصات کامل را بفرستید تا همکار فروش راهنمایی کند.",
  },
];

export type ReplyDecision = { rule: ReplyRule; message: string };

export function decideReply(
  channel: ReplyChannel,
  username: string,
  text: string,
  rules: ReplyRule[] = DEFAULT_RULES,
): ReplyDecision | null {
  const normalized = text.toLowerCase();
  const rule = rules.find(
    (r) =>
      r.channels.includes(channel) &&
      (r.keywords.length === 0 || r.keywords.some((k) => normalized.includes(k.toLowerCase()))),
  );
  if (!rule) return null;
  const greeting = username ? `سلام ${username}، ` : "سلام، ";
  return { rule, message: rule.template.replace("{{username}}", greeting) };
}

export type PendingReply = {
  id: string;
  channel: ReplyChannel;
  recipient: string;
  username: string;
  text: string;
  reason: string;
  createdAt: number;
};

// In-memory only: pending items are lost on restart until this is moved to the database.
const pending: PendingReply[] = [];

export function holdForApproval(item: Omit<PendingReply, "id" | "createdAt">) {
  pending.push({ ...item, id: `${Date.now()}-${pending.length}`, createdAt: Date.now() });
  if (pending.length > 500) pending.shift();
}

export function listPendingReplies() {
  return [...pending];
}
