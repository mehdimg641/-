import { useState } from "react";
import { AlertCircle, ArrowUpLeft, Check, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { MultiMessageEditor } from "./MultiMessageEditor";
import type { RouterOutputs } from "./types";
import { errorMessage, StatusPill } from "./ui";

type Template = RouterOutputs["templates"]["list"][number];

const TONES = ["gold", "blue", "green", "violet", "orange"];
const toneFor = (category: string, categories: string[]) => TONES[Math.max(0, categories.indexOf(category)) % TONES.length];

/** Saved reply texts: used by rules ("از قالب‌ها") or dropped into the composer. */
export function TemplatesView({ onUse }: { onUse: (text: string) => void }) {
  const templates = trpc.templates.list.useQuery();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("همه");
  const [editing, setEditing] = useState<Template | "new" | null>(null);

  const all = templates.data ?? [];
  const categories = Array.from(new Set(all.map((t) => t.category).filter(Boolean)));
  const shown = all.filter((t) => (category === "همه" || t.category === category) && `${t.title} ${t.text}`.includes(search));

  return (
    <div className="content-wrap subpage">
      <section className="page-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> LIBRARY / APPROVED REPLIES</div><h1>کتابخانه پاسخ‌ها</h1><p>قالب‌ها را یک بار بنویسید و در قوانین (پاسخ کامنت یا دایرکت) یا کادر پاسخ استفاده کنید.</p></div>
        <button className="primary-button" onClick={() => setEditing("new")}><Plus size={16} /> قالب جدید</button>
      </section>
      {editing && <TemplateEditor template={editing === "new" ? null : editing} categories={categories} onDone={() => setEditing(null)} />}
      {templates.error && <div className="settings-warning"><AlertCircle size={16} /><span>{errorMessage(templates.error)}</span></div>}
      <div className="template-toolbar">
        <div className="search-box compact"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="جست‌وجو در قالب‌ها..." /></div>
        <div className="template-filters">{["همه", ...categories].map((c) => <button key={c} className={category === c ? "selected" : ""} onClick={() => setCategory(c)}>{c}</button>)}</div>
      </div>
      <div className="template-grid">
        {shown.map((template) => <TemplateCard key={template.id} template={template} tone={toneFor(template.category, categories)} onEdit={() => setEditing(template)} onUse={onUse} />)}
        {templates.data && !shown.length && <div className="empty-state"><Search size={24} /><b>قالبی پیدا نشد</b></div>}
      </div>
    </div>
  );
}

function TemplateCard({ template, tone, onEdit, onUse }: { template: Template; tone: string; onEdit: () => void; onUse: (text: string) => void }) {
  const utils = trpc.useUtils();
  const [error, setError] = useState("");
  const remove = trpc.templates.delete.useMutation({ onSuccess: () => utils.templates.list.invalidate(), onError: (e) => setError(errorMessage(e)) });
  return (
    <div className="template-card">
      <div className="template-card-top">
        {template.category ? <StatusPill tone={tone}>{template.category}</StatusPill> : <span />}
        <span className="rule-actions">
          <button className="text-button" onClick={onEdit}><Pencil size={13} /> ویرایش</button>
          <button className="text-button danger" onClick={() => window.confirm(`قالب «${template.title}» حذف شود؟`) && remove.mutate({ id: template.id })}><Trash2 size={13} /></button>
        </span>
      </div>
      <h3>{template.title}</h3>
      <p>{template.text.split(/\n[ \t]*-{3,}[ \t]*\n/).join("  ·  ")}</p>
      {error && <span className="error-text">{error}</span>}
      <div className="template-card-bottom">
        <span className="field-tip">{"{{username}}"} با نام مخاطب جایگزین می‌شود</span>
        <button className="text-button" onClick={() => onUse(template.text.replaceAll("{{username}}", "").replace(/\s+،/g, "،"))}>استفاده در پاسخ <ArrowUpLeft size={14} /></button>
      </div>
    </div>
  );
}

function TemplateEditor({ template, categories, onDone }: { template: Template | null; categories: string[]; onDone: () => void }) {
  const utils = trpc.useUtils();
  const [title, setTitle] = useState(template?.title ?? "");
  const [category, setCategory] = useState(template?.category ?? "");
  const [text, setText] = useState(template?.text ?? "سلام {{username}}، ");
  const [error, setError] = useState("");
  const onSuccess = () => {
    utils.templates.list.invalidate();
    // Drafts of rules that use this template now carry the new text.
    utils.approvals.list.invalidate();
    onDone();
  };
  const onError = (e: unknown) => setError(errorMessage(e));
  const create = trpc.templates.create.useMutation({ onSuccess, onError });
  const update = trpc.templates.update.useMutation({ onSuccess, onError });
  const save = () => {
    setError("");
    const input = { title, category, text };
    if (template) update.mutate({ id: template.id, patch: input });
    else create.mutate(input);
  };
  return (
    <div className="builder-card template-editor">
      <div className="builder-header"><div><b>{template ? `ویرایش «${template.title}»` : "قالب جدید"}</b><span>در قوانین با «از قالب‌ها» انتخاب می‌شود</span></div><button className="icon-button" aria-label="بستن" onClick={onDone}><X size={16} /></button></div>
      <div className="builder-fields">
        <label>عنوان<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثلاً: لیست قیمت تیرآهن" /></label>
        <label>دسته (اختیاری)<input value={category} list="template-categories" onChange={(e) => setCategory(e.target.value)} placeholder="فروش، کامنت، ..." /></label>
        <datalist id="template-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
      </div>
      <div className="template-text-field">
        <b>متن</b> <span className="field-tip">هر کادر یک پیام جداست و به ترتیب ارسال می‌شود · {"{{username}}"} = نام اکانت مخاطب</span>
        <MultiMessageEditor value={text} onChange={setText} />
      </div>
      {error && <div className="settings-warning"><AlertCircle size={16} /><span>{error}</span></div>}
      <div className="builder-buttons">
        <button className="primary-button" disabled={!title.trim() || !text.trim() || create.isPending || update.isPending} onClick={save}><Check size={15} /> ذخیره قالب</button>
        <button className="secondary-button" onClick={onDone}>انصراف</button>
      </div>
    </div>
  );
}
