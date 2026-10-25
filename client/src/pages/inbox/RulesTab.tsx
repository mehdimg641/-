import { useMemo, useState } from "react";
import { AlertCircle, Check, FlaskConical, ImageIcon, Mail, MessageSquareText, Pencil, Plus, Search, Send, ShieldCheck, Sparkles, Trash2, Workflow, X } from "lucide-react";
import { joinMessages, MAX_BUTTON_TITLE, MAX_BUTTONS, splitMessages, type DmButton } from "@shared/inbox";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { trpc } from "@/lib/trpc";
import { MultiMessageEditor } from "./MultiMessageEditor";
import { pageName } from "./PageSwitcher";
import type { RouterOutputs } from "./types";
import { errorMessage, faNum, StatusPill, Switch } from "./ui";

export type Rule = RouterOutputs["rules"]["list"][number];
type Template = RouterOutputs["templates"]["list"][number];
type Post = RouterOutputs["posts"]["list"][number];
type Channels = Rule["channels"];

const channelLabel = (channels: Channels) =>
  channels.length === 2 ? "کامنت و دایرکت" : channels[0] === "dm" ? "فقط دایرکت" : "فقط کامنت";

export const postLabel = (post: Pick<Post, "id" | "caption">) => {
  const caption = post.caption?.replace(/\s+/g, " ").trim();
  return caption ? (caption.length > 40 ? `${caption.slice(0, 40)}…` : caption) : `پست ${post.id.slice(-6)}`;
};

function textSummary(templates: Template[], id: number | null, inline: string | null) {
  if (id != null) return `قالب «${templates.find((t) => t.id === id)?.title ?? "حذف‌شده"}»`;
  return inline || "";
}

function RuleCard({ rule, editing, templates, posts, onEdit }: { rule: Rule; editing: boolean; templates: Template[]; posts: Post[]; onEdit: () => void }) {
  const utils = trpc.useUtils();
  const changed = () => {
    utils.rules.list.invalidate();
    utils.approvals.list.invalidate();
    utils.inbox.invalidate();
  };
  const update = trpc.rules.update.useMutation({ onSuccess: changed });
  const remove = trpc.rules.delete.useMutation({ onSuccess: changed });
  const tone = rule.action === "approval" ? "gold" : "blue";
  const reply = textSummary(templates, rule.templateId, rule.template);
  const dm = textSummary(templates, rule.dmTemplateId, rule.dmTemplate);
  const scope = rule.mediaIds?.length
    ? rule.mediaIds.map((id) => postLabel(posts.find((p) => p.id === id) ?? { id, caption: null })).join("، ")
    : null;
  return (
    <div className={editing ? "rule-card editing" : "rule-card"}>
      <div className="rule-top">
        <div className={`rule-icon ${tone}`}>{rule.action === "approval" ? <ShieldCheck size={18} /> : <Send size={18} />}</div>
        <div className="rule-title"><b>{rule.name}</b><span>{rule.enabled ? "فعال" : "غیرفعال"} · اولویت {faNum(rule.priority)}</span></div>
        <Switch small on={rule.enabled} label="فعال/غیرفعال" onToggle={() => update.mutate({ id: rule.id, patch: { enabled: !rule.enabled } })} />
      </div>
      {scope && <div className="rule-line"><span>پست</span><p><ImageIcon size={12} /> {scope}</p></div>}
      <div className="rule-line"><span>اگر</span><p>{rule.keywords.length ? `متن شامل «${rule.keywords.join("، ")}» باشد` : "هیچ قانون دیگری منطبق نشود"} ({channelLabel(rule.channels)})</p></div>
      {reply && <div className="rule-line"><span>پاسخ</span><p>{reply}</p></div>}
      {dm && <div className="rule-line"><span>دایرکت</span><p>{dm}</p></div>}
      {rule.dmButtons?.length ? <div className="rule-line"><span>دکمه</span><p>{rule.dmButtons.map((b) => `«${b.title}»`).join("، ")}</p></div> : null}
      <div className="rule-footer">
        <StatusPill tone={tone}>{rule.action === "approval" ? "نیازمند تأیید" : "ارسال مستقیم"}</StatusPill>
        <span className="rule-actions">
          <button className="text-button" onClick={onEdit}><Pencil size={13} /> {editing ? "در حال ویرایش…" : "ویرایش"}</button>
          <button className="text-button danger" onClick={() => window.confirm(`قانون «${rule.name}» حذف شود؟`) && remove.mutate({ id: rule.id })}><Trash2 size={13} /> حذف</button>
        </span>
      </div>
    </div>
  );
}

const splitKeywords = (value: string) => value.split(/[,،\n]/).map((k) => k.trim()).filter(Boolean);

/** Text written here, or a saved template from the library. */
function TextSource({ label, hint, value, templateId, templates, allowNone, single, onChange }: {
  label: string;
  hint?: string;
  value: string;
  templateId: number | null;
  templates: Template[];
  allowNone?: boolean;
  /** Instagram allows one message here; extra boxes become paragraphs of it. */
  single?: boolean;
  onChange: (next: { value: string; templateId: number | null }) => void;
}) {
  const mode = templateId != null ? "template" : allowNone && !value ? "none" : "text";
  const [forcedText, setForcedText] = useState(false);
  const shown = forcedText && mode === "none" ? "text" : mode;
  const source = (shown === "template" ? templates.find((t) => t.id === templateId)?.text : value)?.replaceAll("{{username}}", "hossein.rz") ?? "";
  const previewParts = single ? [joinMessages(source)].filter(Boolean) : splitMessages(source);
  return (
    <div className="text-source">
      <div className="text-source-head">
        <b>{label}</b>
        <div className="segmented">
          {allowNone && <button type="button" className={shown === "none" ? "active" : ""} onClick={() => { setForcedText(false); onChange({ value: "", templateId: null }); }}>ندارد</button>}
          <button type="button" className={shown === "text" ? "active" : ""} onClick={() => { setForcedText(true); onChange({ value, templateId: null }); }}>متن جدید</button>
          <button type="button" className={shown === "template" ? "active" : ""} disabled={!templates.length} onClick={() => onChange({ value, templateId: templateId ?? templates[0]?.id ?? null })}>از قالب‌ها</button>
        </div>
      </div>
      {shown === "text" && (
        <MultiMessageEditor
          value={value}
          single={single}
          addLabel={single ? "افزودن بند" : "افزودن پیام بعدی"}
          onChange={(next) => onChange({ value: next, templateId: null })}
          placeholder="سلام {{username}}، ..."
        />
      )}
      {shown === "template" && (
        <select value={templateId ?? ""} onChange={(e) => onChange({ value, templateId: Number(e.target.value) })}>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.title}{t.category ? ` (${t.category})` : ""}</option>)}
        </select>
      )}
      {hint && <span className="field-tip">{hint}</span>}
      {shown !== "none" && previewParts.length > 0 && (
        <div className="builder-preview">
          <Sparkles size={14} />
          <div className="preview-parts">
            {previewParts.map((part, i) => <span key={i}>{previewParts.length > 1 ? `پیام ${faNum(i + 1)}: ` : "پیش‌نمایش: "}{part}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}

export function RuleBuilder({ rule, templates, posts, presetMediaIds, onDone, embedded }: {
  rule: Rule | null;
  templates: Template[];
  posts: Post[];
  presetMediaIds?: string[];
  onDone: () => void;
  /** Inside the side panel: the panel shows the title, and «انصراف» closes it. */
  embedded?: boolean;
}) {
  const utils = trpc.useUtils();
  const [name, setName] = useState(rule?.name ?? "");
  const [keywords, setKeywords] = useState(rule?.keywords.join("، ") ?? "");
  const [channels, setChannels] = useState<Channels>(rule?.channels ?? (presetMediaIds ? ["comment"] : ["comment", "dm"]));
  const [action, setAction] = useState<Rule["action"]>(rule?.action ?? "approval");
  const [priority, setPriority] = useState(rule?.priority ?? 50);
  const [reply, setReply] = useState({ value: rule?.template ?? "سلام {{username}}، ", templateId: rule?.templateId ?? null });
  const [dm, setDm] = useState({ value: rule?.dmTemplate ?? "", templateId: rule?.dmTemplateId ?? null });
  const [mediaIds, setMediaIds] = useState<string[]>(rule?.mediaIds ?? presetMediaIds ?? []);
  const [buttons, setButtons] = useState<DmButton[]>(rule?.dmButtons ?? []);
  const [error, setError] = useState("");

  const onSuccess = () => {
    utils.rules.list.invalidate();
    utils.posts.list.invalidate();
    // Pending drafts were rebuilt for the changed rule.
    utils.approvals.list.invalidate();
    utils.inbox.invalidate();
    onDone();
  };
  const onError = (e: unknown) => setError(errorMessage(e));
  const create = trpc.rules.create.useMutation({ onSuccess, onError });
  const update = trpc.rules.update.useMutation({ onSuccess, onError });

  const forComments = channels.includes("comment");
  const scoped = mediaIds.length > 0;
  // Post-specific rules only make sense for comments.
  const effectiveChannels: Channels = scoped ? ["comment"] : channels;

  const save = () => {
    setError("");
    const input = {
      name,
      keywords: splitKeywords(keywords),
      channels: effectiveChannels,
      action,
      template: reply.templateId != null ? "" : reply.value,
      templateId: reply.templateId,
      dmTemplate: forComments && dm.templateId == null && dm.value.trim() ? dm.value : null,
      dmTemplateId: forComments ? dm.templateId : null,
      mediaIds: scoped ? mediaIds : null,
      dmButtons: buttons.length ? buttons.map((b) => ({ title: b.title.trim(), reply: b.reply })) : null,
      priority,
      enabled: rule?.enabled ?? true,
    };
    if (rule) update.mutate({ id: rule.id, patch: input });
    else create.mutate(input);
  };

  const channelValue = scoped ? "comment" : channels.length === 2 ? "both" : channels[0];
  const togglePost = (id: string) => setMediaIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  const syncedPosts = posts.filter((p) => p.synced || mediaIds.includes(p.id));

  return (
    <div className={embedded ? "builder-card embedded" : "builder-card"}>
      {!embedded && <div className="builder-header"><div><b>{rule ? `ویرایش «${rule.name}»` : "ساخت قانون جدید"}</b><span>پاسخ زیر کامنت، دایرکت به نویسندهٔ کامنت، یا پاسخ دایرکت</span></div><Workflow size={18} /></div>}
      <div className="builder-fields">
        <label>نام قانون<input value={name} onChange={(event) => setName(event.target.value)} placeholder="مثلاً: قیمت تیرآهن" /></label>
        <label>کلمات محرک (با ، جدا کنید؛ خالی = همه پیام‌ها)<input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="قیمت، نرخ، استعلام" /></label>
        <label>کانال
          <select value={channelValue} disabled={scoped} onChange={(event) => setChannels(event.target.value === "both" ? ["comment", "dm"] : [event.target.value as "comment" | "dm"])}>
            <option value="both">کامنت و دایرکت</option>
            <option value="comment">فقط کامنت</option>
            <option value="dm">فقط دایرکت</option>
          </select>
        </label>
        <label>اقدام
          <select value={action} onChange={(event) => setAction(event.target.value as Rule["action"])}>
            <option value="approval">ارسال برای تأیید اپراتور</option>
            <option value="send">ارسال مستقیم (فقط اگر ارسال خودکار روشن باشد)</option>
          </select>
        </label>
        <label>اولویت (عدد کمتر = زودتر)<input type="number" min={0} max={10000} value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></label>
      </div>

      {forComments && (
        <div className="post-scope">
          <b>پست‌ها</b>
          <div className="segmented">
            <button type="button" className={!scoped ? "active" : ""} onClick={() => setMediaIds([])}>همهٔ پست‌ها</button>
            <button type="button" className={scoped ? "active" : ""} disabled={!syncedPosts.length} onClick={() => !scoped && syncedPosts[0] && setMediaIds([syncedPosts[0].id])}>پست‌های انتخابی</button>
          </div>
          {scoped && (
            <div className="post-pick">
              {syncedPosts.map((p) => (
                <label key={p.id} className={mediaIds.includes(p.id) ? "picked" : ""}>
                  <input type="checkbox" checked={mediaIds.includes(p.id)} onChange={() => togglePost(p.id)} />
                  {p.imageUrl ? <img src={p.imageUrl} alt="" loading="lazy" /> : <span className="post-thumb-empty"><ImageIcon size={14} /></span>}
                  <span>{postLabel(p)}</span>
                </label>
              ))}
            </div>
          )}
          {!syncedPosts.length && <span className="field-tip">برای انتخاب پست، ابتدا در صفحهٔ «پست‌ها» همگام‌سازی کنید.</span>}
        </div>
      )}

      <TextSource
        label={forComments ? (channels.length === 2 && !scoped ? "پاسخ (زیر کامنت / در دایرکت)" : "پاسخ زیر کامنت") : "پاسخ دایرکت"}
        hint={'هر کادر یک پیام جداست و به ترتیب ارسال می‌شود · {{username}} = نام اکانت مخاطب (در دایرکت‌ها خالی می‌ماند)'}
        value={reply.value}
        templateId={reply.templateId}
        templates={templates}
        allowNone={forComments}
        onChange={setReply}
      />
      {forComments && (
        <TextSource
          label="دایرکت به نویسندهٔ کامنت"
          single
          hint="اینستاگرام برای هر کامنت فقط یک دایرکت (تا ۷ روز بعد) اجازه می‌دهد؛ بندها در همان یک پیام می‌روند."
          value={dm.value}
          templateId={dm.templateId}
          templates={templates}
          allowNone
          onChange={setDm}
        />
      )}
      <ButtonsEditor buttons={buttons} onChange={setButtons} forComments={forComments} />
      {error && <div className="settings-warning"><AlertCircle size={16} /><span>{error}</span></div>}
      <div className="builder-buttons">
        <button className="primary-button" onClick={save} disabled={create.isPending || update.isPending || !name.trim()}><Check size={15} /> {rule ? "ذخیره تغییرات" : "ذخیره قانون"}</button>
        {(rule || presetMediaIds || embedded) && <button className="secondary-button" onClick={onDone}>انصراف</button>}
      </div>
    </div>
  );
}

/** Quick-reply buttons under the rule's DM; each option has its own reply. */
function ButtonsEditor({ buttons, onChange, forComments }: { buttons: DmButton[]; onChange: (next: DmButton[]) => void; forComments: boolean }) {
  const set = (i: number, patch: Partial<DmButton>) => onChange(buttons.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  return (
    <div className="buttons-editor">
      <div className="text-source-head">
        <b>دکمه‌ها زیر دایرکت</b>
        <span className="field-tip">{forComments ? "زیر «دایرکت به نویسندهٔ کامنت»" : "زیر آخرین پیام پاسخ دایرکت"}</span>
      </div>
      <span className="field-tip">
        مشتری با زدن یک دکمه، پاسخ همان گزینه را خودکار دریافت می‌کند (تأیید دایرکت اول، کل گزینه‌ها را تأیید می‌کند). یک دکمه مثل «ارسال ادامه» برای پیام بعدی، یا چند گزینه مثل یک منو. حداکثر {MAX_BUTTONS} دکمه، هر کدام تا {MAX_BUTTON_TITLE} حرف.
      </span>
      {buttons.map((button, i) => (
        <div className="button-row" key={i}>
          <div className="button-row-head">
            <input value={button.title} maxLength={MAX_BUTTON_TITLE} onChange={(e) => set(i, { title: e.target.value })} placeholder={i === 0 ? "مثلاً: لیست قیمت" : "متن دکمه"} />
            <small>{button.title.length}/{MAX_BUTTON_TITLE}</small>
            <button type="button" className="icon-button" aria-label="حذف دکمه" onClick={() => onChange(buttons.filter((_, j) => j !== i))}><X size={13} /></button>
          </div>
          <MultiMessageEditor value={button.reply} onChange={(reply) => set(i, { reply })} placeholder="پاسخی که با زدن این دکمه فرستاده می‌شود" />
        </div>
      ))}
      {buttons.length < MAX_BUTTONS && (
        <button type="button" className="secondary-button compact-button" onClick={() => onChange([...buttons, { title: buttons.length ? "" : "ارسال ادامه", reply: "" }])}>
          <Plus size={13} /> افزودن دکمه
        </button>
      )}
    </div>
  );
}

/** Answers "why did (or didn't) this comment get a draft?" before a real customer writes it. */
export function RuleTester({ posts }: { posts: Post[] }) {
  const [text, setText] = useState("");
  const [channel, setChannel] = useState<"comment" | "dm">("comment");
  const [mediaId, setMediaId] = useState<string>("");
  const [submitted, setSubmitted] = useState<{ text: string; channel: "comment" | "dm"; mediaId: string | null } | null>(null);
  const result = trpc.rules.test.useQuery(submitted ?? { text: "-", channel: "comment", mediaId: null }, { enabled: submitted !== null });
  const data = submitted ? result.data : undefined;
  const winner = data?.matches[0];
  return (
    <div className="builder-card rule-tester">
      <div className="builder-header"><div><b><FlaskConical size={15} /> آزمایش قانون‌ها</b><span>یک کامنت یا دایرکت نمونه بنویسید تا ببینید کدام قانون پاسخ می‌دهد و چه متنی می‌سازد</span></div></div>
      <div className="builder-fields">
        <label>کانال
          <select value={channel} onChange={(e) => setChannel(e.target.value as "comment" | "dm")}>
            <option value="comment">کامنت</option>
            <option value="dm">دایرکت</option>
          </select>
        </label>
        {channel === "comment" && (
          <label>پست
            <select value={mediaId} onChange={(e) => setMediaId(e.target.value)}>
              <option value="">هر پستی (فقط قوانین عمومی)</option>
              {posts.map((p) => <option key={p.id} value={p.id}>{postLabel(p)}</option>)}
            </select>
          </label>
        )}
      </div>
      <label>متن نمونه<textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="مثلاً: لیست قیمت تیرآهن رو بفرستید" /></label>
      <div className="builder-buttons">
        <button className="primary-button" disabled={!text.trim()} onClick={() => setSubmitted({ text: text.trim(), channel, mediaId: channel === "comment" && mediaId ? mediaId : null })}><FlaskConical size={15} /> آزمایش</button>
      </div>
      {result.error && submitted && <div className="settings-warning"><AlertCircle size={16} /><span>{errorMessage(result.error)}</span></div>}
      {data && !winner && (
        <div className="settings-warning"><AlertCircle size={16} /><span>هیچ قانون فعالی با این متن جور نمی‌شود، پس پیش‌نویسی ساخته نمی‌شود. یک قانون بسازید که یکی از کلمه‌های این متن (مثلاً «لیست») را داشته باشد و کانالش «{channel === "dm" ? "دایرکت" : "کامنت"}» باشد. قالب‌ها به‌تنهایی پاسخی نمی‌سازند؛ باید در یک قانون انتخاب شوند.</span></div>
      )}
      {data && winner && (
        <div className="tester-result">
          <ol>
            {data.matches.map((m, i) => (
              <li key={m.id} className={i === 0 ? "winner" : "loser"}>
                <b>{m.name}</b> <small>{m.keyword ? `کلمهٔ «${m.keyword}»` : "بدون کلمهٔ محرک (همهٔ پیام‌ها)"} · اولویت {faNum(m.priority)}{m.scoped ? " · مخصوص پست" : ""}</small>
                {i === 0 ? <StatusPill tone="green">اعمال می‌شود</StatusPill> : <StatusPill tone="slate">نادیده (قانون بالاتر برنده شد)</StatusPill>}
              </li>
            ))}
          </ol>
          {data.matches.length > 1 && (
            <span className="field-tip">{faNum(data.matches.length)} قانون با این متن جور شدند ولی فقط اولی اعمال می‌شود. برای اینکه قانون دیگری برنده شود، عدد «اولویت» آن را کوچک‌تر کنید یا کلمه‌های قانون‌های دیگر را دقیق‌تر کنید.</span>
          )}
          {splitMessages(data.message).map((part, i, all) => (
            <div className="tester-reply" key={`m${i}`}><MessageSquareText size={13} /> {channel === "dm" ? "پاسخ دایرکت" : "پاسخ زیر کامنت"}{all.length > 1 ? ` ${faNum(i + 1)} از ${faNum(all.length)}` : ""}: <p>{part}</p></div>
          ))}
          {data.dmMessage ? <div className="tester-reply"><Mail size={13} /> دایرکت به نویسندهٔ کامنت: <p>{joinMessages(data.dmMessage)}</p></div> : null}
          {data.buttons.length > 0 && (
            <div className="tester-reply">
              دکمه‌های زیر دایرکت:
              <div className="quick-replies">{data.buttons.map((b) => <span key={b.title} className="quick-reply" title={b.reply}>{b.title}</span>)}</div>
            </div>
          )}
          {!data.message && !data.dmMessage && (
            <div className="settings-warning"><AlertCircle size={16} /><span>قانون «{winner.name}» برنده می‌شود ولی متن پاسخی ندارد (قالبش خالی است یا برای این کانال متنی تعریف نشده)، پس پیش‌نویسی ساخته نمی‌شود. قانون را ویرایش کنید.</span></div>
          )}
        </div>
      )}
    </div>
  );
}
type RuleScope = "all" | "comment" | "dm" | "post" | "off";

/** A page without rules can start from another page's rules and templates. */
function CopyRules() {
  const utils = trpc.useUtils();
  const status = trpc.inbox.status.useQuery();
  const pages = trpc.accounts.list.useQuery();
  const others = (pages.data ?? []).filter((p) => p.id !== status.data?.accountId);
  const [from, setFrom] = useState("");
  const source = from || others[0]?.id || "";
  const copy = trpc.rules.copyFrom.useMutation({
    onSuccess: () => {
      utils.rules.list.invalidate();
      utils.templates.list.invalidate();
      utils.approvals.list.invalidate();
    },
  });
  if (!others.length) return null;
  return (
    <>
      <div className="copy-rules">
        <span>یا شروع با قوانین و قالب‌های</span>
        {others.length > 1 ? (
          <select value={source} onChange={(e) => setFrom(e.target.value)} aria-label="پیج مبدأ" dir="ltr">
            {others.map((p) => <option key={p.id} value={p.id}>{pageName(p)}</option>)}
          </select>
        ) : (
          <b dir="ltr">{pageName(others[0])}</b>
        )}
        <button type="button" className="secondary-button" disabled={copy.isPending || !source} onClick={() => copy.mutate({ fromAccountId: source })}>
          {copy.isPending ? "در حال کپی…" : "کپی به این پیج"}
        </button>
      </div>
      {copy.data?.skipped ? <span>{faNum(copy.data.skipped)} قانون مخصوص پست‌های آن پیج کپی نشد.</span> : null}
      {copy.error && <span className="error-text">{errorMessage(copy.error)}</span>}
    </>
  );
}

/** The rules as cards; creating and editing happen in a side panel. */
export function RulesTab({ rules, templates, posts, error }: { rules: Rule[]; templates: Template[]; posts: Post[]; error?: string }) {
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<RuleScope>("all");
  // null: closed; "new": a new rule; otherwise the rule being edited.
  const [editing, setEditing] = useState<Rule | "new" | null>(null);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rules.filter((r) => {
      const inScope = scope === "all" || (scope === "off" ? !r.enabled : scope === "post" ? Boolean(r.mediaIds?.length) : r.channels.includes(scope));
      return inScope && (!q || `${r.name} ${r.keywords.join(" ")}`.toLowerCase().includes(q));
    });
  }, [rules, search, scope]);
  const counts: Record<RuleScope, number> = {
    all: rules.length,
    comment: rules.filter((r) => r.channels.includes("comment")).length,
    dm: rules.filter((r) => r.channels.includes("dm")).length,
    post: rules.filter((r) => r.mediaIds?.length).length,
    off: rules.filter((r) => !r.enabled).length,
  };
  const scopes: [RuleScope, string][] = [["all", "همه"], ["comment", "کامنت"], ["dm", "دایرکت"], ["post", "مخصوص پست"], ["off", "غیرفعال"]];

  return (
    <div className="rules-tab">
      <div className="tab-toolbar">
        <div className="search-box"><Search size={16} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجو در نام یا کلمهٔ محرک..." /></div>
        <div className="chip-group">
          {scopes.map(([id, label]) => (
            <button key={id} className={scope === id ? "active" : ""} onClick={() => setScope(id)}>{label} <span>{faNum(counts[id])}</span></button>
          ))}
        </div>
        <button className="primary-button" onClick={() => setEditing("new")}><Plus size={15} /> قانون جدید</button>
      </div>
      <p className="tab-hint">قوانین مخصوص یک پست اول بررسی می‌شوند، بعد بقیه به ترتیب اولویت (عدد کمتر زودتر). فقط اولین قانون منطبق پیش‌نویس می‌سازد؛ برای امتحان از زبانهٔ «آزمایش قانون» استفاده کنید.</p>
      {error && <div className="settings-warning"><AlertCircle size={16} /><span>{error}</span></div>}
      <div className="rule-grid">
        {shown.map((rule) => (
          <RuleCard key={rule.id} rule={rule} editing={editing !== "new" && editing?.id === rule.id} templates={templates} posts={posts} onEdit={() => setEditing(rule)} />
        ))}
      </div>
      {!shown.length && (
        <div className="approval-empty">
          <Workflow size={22} />
          <b>{rules.length ? "قانونی با این فیلتر نیست" : "این پیج هنوز قانونی ندارد"}</b>
          <span>{rules.length ? "جستجو یا فیلتر را تغییر دهید." : "با «قانون جدید» اولین قانون را بسازید."}</span>
          {!rules.length && !error && <CopyRules />}
        </div>
      )}
      <Sheet open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <SheetContent side="left" dir="rtl" className="rule-sheet w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{editing && editing !== "new" ? `ویرایش «${editing.name}»` : "قانون جدید"}</SheetTitle>
            <SheetDescription>پاسخ زیر کامنت، دایرکت به نویسندهٔ کامنت، یا پاسخ دایرکت</SheetDescription>
          </SheetHeader>
          {editing !== null && (
            <RuleBuilder
              key={editing === "new" ? "new" : editing.id}
              rule={editing === "new" ? null : editing}
              templates={templates}
              posts={posts}
              onDone={() => setEditing(null)}
              embedded
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
