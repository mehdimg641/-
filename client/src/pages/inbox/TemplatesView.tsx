import { ArrowUpLeft, CheckCircle2, Search } from "lucide-react";
import { useState } from "react";
import { StatusPill } from "./ui";

/** Approved reply snippets the team can drop into the composer. */
const TEMPLATES = [
  { title: "استعلام قیمت اولیه", category: "فروش", tone: "gold", text: "سلام، وقت بخیر. برای اعلام قیمت دقیق لطفاً نوع شمش، سایز، تناژ و شهر مقصد را بفرمایید تا همکار فروش راهنمایی کند." },
  { title: "آنالیز و کیفیت", category: "پشتیبانی", tone: "blue", text: "سلام، مشخصات فنی و آنالیز محصول موردنظر شما را بررسی می‌کنیم. لطفاً سایز و گرید موردنظر را بفرمایید." },
  { title: "ارسال به شهر مقصد", category: "فروش", tone: "green", text: "سلام، ارسال به شهر شما قابل بررسی است. لطفاً تناژ و زمان موردنظر را بفرمایید تا زمان تحویل و هزینه حمل اعلام شود." },
  { title: "دریافت قراضه", category: "قراضه", tone: "violet", text: "سلام، برای بررسی خرید قراضه لطفاً نوع بار، وزن تقریبی، محل بارگیری و تصاویر را ارسال کنید." },
];
const CATEGORIES = ["همه", "فروش", "پشتیبانی", "قراضه"];

export function TemplatesView({ onUse }: { onUse: (text: string) => void }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("همه");
  const templates = TEMPLATES.filter((t) => (category === "همه" || t.category === category) && `${t.title} ${t.text}`.includes(search));
  return <div className="content-wrap subpage"><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> LIBRARY / APPROVED REPLIES</div><h1>کتابخانه پاسخ‌ها</h1><p>قالب‌های تأییدشده برای اینکه تیم با یک لحن واحد پاسخ دهد.</p></div></section><div className="template-toolbar"><div className="search-box compact"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="جست‌وجو در قالب‌ها..." /></div><div className="template-filters">{CATEGORIES.map((c) => <button key={c} className={category === c ? "selected" : ""} onClick={() => setCategory(c)}>{c}</button>)}</div></div><div className="template-grid">{templates.map((template) => <div className="template-card" key={template.title}><div className="template-card-top"><StatusPill tone={template.tone}>{template.category}</StatusPill></div><h3>{template.title}</h3><p>{template.text}</p><div className="template-card-bottom"><span><CheckCircle2 size={14} /> تأییدشده</span><button className="text-button" onClick={() => onUse(template.text)}>استفاده در پاسخ <ArrowUpLeft size={14} /></button></div></div>)}</div></div>;
}
