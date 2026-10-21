import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Bot, Check, CheckCheck, CheckCircle2, ChevronLeft, FlaskConical, ImageIcon, Mail, MessageSquareText, Pencil, Plus, RefreshCw, Search, Send, ShieldCheck, Sparkles, Trash2, Workflow, X } from "lucide-react";
import type { ApprovalItem } from "@shared/inbox";
import { joinMessages, MAX_BUTTON_TITLE, MAX_BUTTONS, splitMessages, type DmButton } from "@shared/inbox";
import { trpc } from "@/lib/trpc";
import { MultiMessageEditor } from "./MultiMessageEditor";
import type { RouterOutputs } from "./types";
import { errorMessage, faNum, relativeTime, StatusPill, Switch } from "./ui";

type Rule = RouterOutputs["rules"]["list"][number];
type Template = RouterOutputs["templates"]["list"][number];
type Post = RouterOutputs["posts"]["list"][number];
type Channels = Rule["channels"];

const channelLabel = (channels: Channels) =>
  channels.length === 2 ? "کامنت و دایرکت" : channels[0] === "dm" ? "فقط دایرکت" : "فقط کامنت";

export const postLabel = (post: Pick<Post, "id" | "caption">) => {
  const caption = post.caption?.replace(/\s+/g, " ").trim();
  return caption ? (caption.length > 40 ? `${caption.slice(0, 40)}…` : caption) : `پست ${post.id.slice(-6)}`;
};

export function AutomationView({ approvals, autoReply, onBack }: { approvals: ApprovalItem[]; autoReply: boolean; onBack: () => void }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState<Rule | null>(null);
  const [builderKey, setBuilderKey] = useState(0);
  const [applyNotice, setApplyNotice] = useState("");
  const rules = trpc.rules.list.useQuery();
  const templates = trpc.templates.list.useQuery();
  const posts = trpc.posts.list.useQuery();
  const apply = trpc.rules.applyToUnanswered.useMutation({
    onSuccess: (result) => {
      const parts = [
        result.updated ? `${faNum(result.updated)} پیش‌نویس با قوانین فعلی به‌روز شد` : "",
        result.drafted ? `برای ${faNum(result.drafted)} پیام بی‌پاسخ پیش‌نویس تازه ساخته شد` : "",
      ].filter(Boolean);
      setApplyNotice(parts.length ? `${parts.join("؛ ")}.` : "صف تأیید با قوانین فعلی هماهنگ است و پیام بی‌پاسخ منطبقی پیدا نشد.");
      utils.approvals.list.invalidate();
      utils.inbox.invalidate();
    },
    onError: (error) => setApplyNotice(errorMessage(error)),
  });

  const builderRef = useRef<HTMLDivElement>(null);
  const startNew = () => {
    setEditing(null);
    setBuilderKey((key) => key + 1);
  };
  const edit = (rule: Rule) => {
    setEditing(rule);
    setBuilderKey((key) => key + 1);
  };
  // The form sits below the rules and the tester; bring it into view, or "edit" seems to do nothing.
  useEffect(() => {
    if (!editing) return;
    builderRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    builderRef.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
  }, [editing, builderKey]);

  return (
    <div className="content-wrap subpage">
      <section className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> AUTOMATION / CONTROL</div>
          <h1>اتوماسیون پاسخ‌گویی</h1>
          <p>قواعد روشن و قابل کنترل برای پاسخ سریع‌تر، بدون از دست دادن لحن سپند.</p>
        </div>
        <button className="secondary-button" onClick={onBack}><ChevronLeft size={16} /> بازگشت به Inbox</button>
      </section>

      <div className="automation-hero">
        <div className="hero-orbit"><div className="orbit-core"><Bot size={31} /></div><span className="orbit-dot one" /><span className="orbit-dot two" /><span className="orbit-dot three" /></div>
        <div>
          <span className="mini-kicker">CONTROLLED AUTOMATION</span>
          <h2>پاسخ‌گویی هوشمند، با تأیید شما</h2>
          <p>
            هر کامنت یا دایرکت ورودی با اولین قانون منطبق پیش‌نویس می‌سازد: پاسخ زیر کامنت و در صورت تنظیم، یک دایرکت به نویسندهٔ کامنت. قوانینِ مخصوص یک پست قبل از قوانین عمومی بررسی می‌شوند.
            {autoReply
              ? " ارسال خودکار روشن است: قوانین «ارسال مستقیم» بدون تأیید ارسال می‌شوند."
              : " ارسال خودکار خاموش است؛ هیچ پاسخی بدون تأیید ارسال نمی‌شود (تنظیمات → کنترل‌های ایمنی)."}
          </p>
          <div className="hero-actions">
            <button className="secondary-button" disabled={apply.isPending} onClick={() => { setApplyNotice(""); apply.mutate(); }}>
              <RefreshCw size={15} /> {apply.isPending ? "در حال بررسی..." : "اعمال قوانین فعلی (به‌روزرسانی صف و پیام‌های بی‌پاسخ)"}
            </button>
          </div>
          {applyNotice && <p className="hero-notice">{applyNotice}</p>}
        </div>
      </div>

      <div className="section-title-row">
        <div><h2>قواعد</h2><span>قوانین مخصوص پست اول، سپس به ترتیب اولویت؛ اولین قانون منطبق اعمال می‌شود</span></div>
        <button className="secondary-button" onClick={startNew}><Plus size={16} /> قانون جدید</button>
      </div>
      {rules.error && <div className="settings-warning"><AlertCircle size={16} /><span>{errorMessage(rules.error)}</span></div>}
      <div className="rule-grid">
        {rules.data?.map((rule) => (
          <RuleCard key={rule.id} rule={rule} editing={editing?.id === rule.id} templates={templates.data ?? []} posts={posts.data ?? []} onEdit={() => edit(rule)} />
        ))}
      </div>

      <RuleTester posts={posts.data ?? []} />

      <div className="builder-grid">
        <div ref={builderRef} className={editing ? "builder-slot editing" : "builder-slot"}>
          <RuleBuilder key={builderKey} rule={editing} templates={templates.data ?? []} posts={posts.data ?? []} onDone={startNew} />
        </div>
        <ApprovalQueue items={approvals} />
      </div>

      <div className="safety-panel">
        <div className="safety-icon"><ShieldCheck size={19} /></div>
        <div><b>گاردریل‌های پاسخ سپند</b><p>قوانین «نیازمند تأیید» (قیمت، تخفیف، قرارداد، تحویل) هرگز خودکار ارسال نمی‌شوند، حتی وقتی ارسال خودکار روشن است.</p></div>
      </div>
    </div>
  );
}

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

export function RuleBuilder({ rule, templates, posts, presetMediaIds, onDone }: {
  rule: Rule | null;
  templates: Template[];
  posts: Post[];
  presetMediaIds?: string[];
  onDone: () => void;
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
    <div className="builder-card">
      <div className="builder-header"><div><b>{rule ? `ویرایش «${rule.name}»` : "ساخت قانون جدید"}</b><span>پاسخ زیر کامنت، دایرکت به نویسندهٔ کامنت، یا پاسخ دایرکت</span></div><Workflow size={18} /></div>
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
        {(rule || presetMediaIds) && <button className="secondary-button" onClick={onDone}>انصراف</button>}
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
function RuleTester({ posts }: { posts: Post[] }) {
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

type QueueSort = "newest" | "oldest";
type QueueKind = "all" | "comment" | "private" | "dm";
const PAGE = 30;
const isNew = (item: ApprovalItem) => Date.now() - new Date(item.receivedAt).getTime() < 3_600_000;

function ApprovalQueue({ items }: { items: ApprovalItem[] }) {
  const utils = trpc.useUtils();
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkNotice, setBulkNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [bulkBusy, setBulkBusy] = useState("");
  const [search, setSearch] = useState("");
  const [rule, setRule] = useState("all");
  const [kind, setKind] = useState<QueueKind>("all");
  const [status, setStatus] = useState<"all" | "pending" | "failed">("all");
  const [sort, setSort] = useState<QueueSort>("newest");
  const [todayOnly, setTodayOnly] = useState(false);
  const [answer, setAnswer] = useState<"all" | "unanswered" | "answered">("all");
  const [grouped, setGrouped] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const refresh = () => {
    utils.approvals.list.invalidate();
    utils.inbox.invalidate();
    utils.posts.invalidate();
  };
  const approve = trpc.approvals.approve.useMutation({
    onSuccess: (result, input) => {
      setErrors((current) => ({ ...current, [input.id]: result.ok ? "" : result.error }));
      refresh();
    },
    onError: (error, input) => setErrors((current) => ({ ...current, [input.id]: errorMessage(error) })),
  });
  const reject = trpc.approvals.reject.useMutation({ onSuccess: refresh, onError: (error, input) => setErrors((current) => ({ ...current, [input.id]: errorMessage(error) })) });
  const approveMany = trpc.approvals.approveMany.useMutation();
  const rejectMany = trpc.approvals.rejectMany.useMutation();
  const busy = (id: number) => Boolean(bulkBusy) || (approve.isPending && approve.variables?.id === id) || (reject.isPending && reject.variables?.id === id);

  const rules = useMemo(() => Array.from(new Set(items.map((i) => i.reason))), [items]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const list = items.filter(
      (i) =>
        (rule === "all" || i.reason === rule) &&
        (status === "all" || i.status === status) &&
        (answer === "all" || (answer === "unanswered" ? !i.answered : i.answered)) &&
        (kind === "all" || (kind === "private" ? i.replyChannel === "private" : kind === "dm" ? i.channel === "DM" : i.channel !== "DM" && i.replyChannel === "reply")) &&
        (!todayOnly || new Date(i.receivedAt) >= startOfDay) &&
        (!q || `${i.name} ${i.handle} ${i.incoming} ${drafts[i.id] ?? i.draft}`.toLowerCase().includes(q)),
    );
    const time = (i: ApprovalItem) => new Date(i.receivedAt).getTime() || new Date(i.createdAt).getTime();
    return list.sort((a, b) => (sort === "newest" ? time(b) - time(a) || b.id - a.id : time(a) - time(b) || a.id - b.id));
  }, [items, search, rule, kind, status, answer, sort, todayOnly, drafts]);
  const visible = filtered.slice(0, shown);
  // Grouped by the rule that drafted them, in the chosen order.
  const groups = useMemo(() => {
    if (!grouped) return [["", visible] as const];
    const map = new Map<string, ApprovalItem[]>();
    for (const item of visible) map.set(item.reason, [...(map.get(item.reason) ?? []), item]);
    return Array.from(map.entries());
  }, [visible, grouped]);

  // Several batches of at most 100: the server sends each reply to Instagram one by one.
  const sendAll = async (list: ApprovalItem[], label: string) => {
    if (!list.length || !window.confirm(`${faNum(list.length)} پاسخ ${label} با همین متن‌ها ارسال شود؟`)) return;
    setBulkNotice(null);
    let sent = 0;
    const failed: Array<{ id: number; error: string }> = [];
    try {
      for (let i = 0; i < list.length; i += 100) {
        setBulkBusy(`در حال ارسال… ${faNum(Math.min(i + 100, list.length))} از ${faNum(list.length)}`);
        const result = await approveMany.mutateAsync({ items: list.slice(i, i + 100).map((item) => ({ id: item.id, text: drafts[item.id] })) });
        sent += result.sent;
        failed.push(...result.failed);
      }
      setBulkNotice({ ok: failed.length === 0, text: `${faNum(sent)} پاسخ ارسال شد${failed.length ? `؛ ${faNum(failed.length)} مورد ناموفق بود (خطا زیر هر مورد)` : ""}.` });
    } catch (error) {
      setBulkNotice({ ok: false, text: errorMessage(error) });
    } finally {
      setErrors((current) => ({ ...current, ...Object.fromEntries(failed.map((f) => [f.id, f.error])) }));
      setSelected(new Set());
      setBulkBusy("");
      refresh();
    }
  };
  const rejectAll = async (list: ApprovalItem[], label: string) => {
    if (!list.length || !window.confirm(`${faNum(list.length)} پیش‌نویس ${label} رد شود؟ (ارسال نمی‌شوند و از صف حذف می‌شوند)`)) return;
    setBulkNotice(null);
    setBulkBusy("در حال رد کردن…");
    try {
      let rejected = 0;
      for (let i = 0; i < list.length; i += 1000) rejected += (await rejectMany.mutateAsync({ ids: list.slice(i, i + 1000).map((item) => item.id) })).rejected;
      setBulkNotice({ ok: true, text: `${faNum(rejected)} پیش‌نویس رد شد.` });
    } catch (error) {
      setBulkNotice({ ok: false, text: errorMessage(error) });
    } finally {
      setSelected(new Set());
      setBulkBusy("");
      refresh();
    }
  };
  const toggle = (id: number) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const selectedItems = filtered.filter((item) => selected.has(item.id));
  const filtering = filtered.length !== items.length;

  return (
    <div className="approval-card">
      <div className="builder-header"><div><b>صف تأیید اپراتور</b><span>پیش‌نویس‌ها قبل از ارسال اینجا می‌آیند</span></div><StatusPill tone={items.length ? "orange" : "green"}>{items.length ? `${faNum(items.length)} در انتظار` : "پاک است"}</StatusPill></div>
      {items.length > 0 && (
        <div className="queue-filters">
          <div className="search-box compact"><Search size={15} /><input value={search} onChange={(e) => { setSearch(e.target.value); setShown(PAGE); }} placeholder="جستجو در نام، کامنت یا متن پاسخ..." /></div>
          <select value={sort} onChange={(e) => setSort(e.target.value as QueueSort)}>
            <option value="newest">جدیدترین اول</option>
            <option value="oldest">قدیمی‌ترین اول</option>
          </select>
          <select value={rule} onChange={(e) => { setRule(e.target.value); setShown(PAGE); }}>
            <option value="all">همهٔ قانون‌ها</option>
            {rules.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <select value={kind} onChange={(e) => { setKind(e.target.value as QueueKind); setShown(PAGE); }}>
            <option value="all">همهٔ انواع</option>
            <option value="comment">پاسخ زیر کامنت</option>
            <option value="private">دایرکت به نویسندهٔ کامنت</option>
            <option value="dm">پاسخ دایرکت</option>
          </select>
          <select value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setShown(PAGE); }}>
            <option value="all">همهٔ وضعیت‌ها</option>
            <option value="pending">در انتظار تأیید</option>
            <option value="failed">ارسال ناموفق</option>
          </select>
          <select value={answer} onChange={(e) => { setAnswer(e.target.value as typeof answer); setShown(PAGE); }}>
            <option value="all">جواب‌داده‌شده و نشده</option>
            <option value="unanswered">جواب داده نشده</option>
            <option value="answered">جواب گرفته (کانال دیگر مانده)</option>
          </select>
          <label className="bulk-check"><input type="checkbox" checked={todayOnly} onChange={(e) => { setTodayOnly(e.target.checked); setShown(PAGE); }} /> فقط امروز</label>
          <label className="bulk-check"><input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> گروه‌بندی بر اساس قانون</label>
        </div>
      )}
      {items.length > 0 && (
        <div className="bulk-bar">
          <label className="bulk-check"><input type="checkbox" checked={filtered.length > 0 && selectedItems.length === filtered.length} onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((i) => i.id)) : new Set())} /> انتخاب همه{filtering ? " (فیلترشده)" : ""}</label>
          <button className="approve-button" disabled={!selectedItems.length || Boolean(bulkBusy)} onClick={() => sendAll(selectedItems, "انتخاب‌شده")}><CheckCheck size={14} /> تأیید انتخاب‌شده‌ها{selectedItems.length ? ` (${faNum(selectedItems.length)})` : ""}</button>
          <button className="reject-button wide" disabled={!selectedItems.length || Boolean(bulkBusy)} onClick={() => rejectAll(selectedItems, "انتخاب‌شده")}><X size={13} /> رد انتخاب‌شده‌ها</button>
          <button className="secondary-button compact-button" disabled={!filtered.length || Boolean(bulkBusy)} onClick={() => sendAll(filtered, filtering ? "فیلترشده" : "در صف")}>تأیید همه{filtering ? "ٔ فیلترشده‌ها" : ""} ({faNum(filtered.length)})</button>
        </div>
      )}
      {bulkBusy && <span className="field-tip">{bulkBusy} (هر پاسخ جدا به اینستاگرام فرستاده می‌شود)</span>}
      {bulkNotice && <div className={bulkNotice.ok ? "settings-success" : "settings-warning"}>{bulkNotice.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}<span>{bulkNotice.text}</span></div>}
      {items.length > 0 && filtering && <span className="field-tip">{faNum(filtered.length)} مورد از {faNum(items.length)} با فیلترها جور است.</span>}
      {filtered.length ? (
        groups.map(([reason, list]) => (
          <div className="approval-group" key={reason || "all"}>
            {grouped && (
              <div className="approval-group-head">
                <b>{reason}</b> <small>{faNum(filtered.filter((i) => i.reason === reason).length)} مورد</small>
                <button className="text-button" disabled={Boolean(bulkBusy)} onClick={() => sendAll(filtered.filter((i) => i.reason === reason), `قانون «${reason}»`)}><CheckCheck size={13} /> تأیید همهٔ این دسته</button>
              </div>
            )}
            {list.map((item) => (
              <div className={isNew(item) ? "approval-item fresh" : "approval-item"} key={item.id}>
                <input className="approval-select" type="checkbox" aria-label="انتخاب" checked={selected.has(item.id)} onChange={() => toggle(item.id)} />
                <div className={`approval-avatar ${item.tone}`}>{item.name[0]}</div>
                <div className="approval-copy">
                  <b>{item.name} {isNew(item) && <StatusPill tone="green">جدید</StatusPill>} <small>@{item.handle} · {item.channel === "DM" ? "دایرکت" : "کامنت"} {relativeTime(item.receivedAt)}{Math.abs(new Date(item.createdAt).getTime() - new Date(item.receivedAt).getTime()) > 3_600_000 ? ` · پیش‌نویس ${relativeTime(item.createdAt)}` : ""}</small></b>
                  <p>{item.incoming}</p>
                  <span className={`reply-kind ${item.replyChannel}`}>
                    {item.replyChannel === "private" ? <><Mail size={11} /> دایرکت به نویسندهٔ کامنت</> : item.channel === "DM" ? <><Send size={11} /> پاسخ دایرکت</> : <><MessageSquareText size={11} /> پاسخ زیر کامنت</>}
                  </span>
                  <textarea className="approval-draft" value={drafts[item.id] ?? item.draft} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))} />
                  {item.buttons.length > 0 && <div className="quick-replies">{item.buttons.map((b) => <span key={b} className="quick-reply">{b}</span>)}</div>}
                  <StatusPill tone={item.status === "failed" ? "orange" : item.tone}>{item.status === "failed" ? "ارسال ناموفق" : item.reason}</StatusPill>
                  {item.answered && <StatusPill tone="green">جواب گرفته</StatusPill>}
                  {(errors[item.id] || item.error) && <span className="error-text">{errors[item.id] || item.error}</span>}
                </div>
                <div className="approval-actions">
                  <button className="approve-button" disabled={busy(item.id)} onClick={() => approve.mutate({ id: item.id, text: drafts[item.id] })}><Check size={14} /> {item.status === "failed" ? "تلاش مجدد" : "تأیید و ارسال"}</button>
                  <button className="reject-button" aria-label="رد" title="رد" disabled={busy(item.id)} onClick={() => reject.mutate({ id: item.id })}><X size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        ))
      ) : items.length ? (
        <div className="approval-empty"><Search size={22} /><b>موردی با این فیلترها نیست</b><span>جستجو یا فیلترها را تغییر دهید.</span></div>
      ) : (
        <div className="approval-empty"><CheckCircle2 size={22} /><b>موردی برای بررسی نیست</b><span>پیش‌نویس‌های جدید با رسیدن پیام‌ها اینجا ظاهر می‌شوند.</span></div>
      )}
      {filtered.length > shown && (
        <button className="secondary-button queue-more" onClick={() => setShown((n) => n + PAGE)}>نمایش {faNum(Math.min(PAGE, filtered.length - shown))} مورد دیگر ({faNum(filtered.length - shown)} باقی‌مانده)</button>
      )}
      <div className="approval-footer"><ShieldCheck size={14} /> قیمت و تعهد تجاری همیشه نیازمند تأیید است.</div>
    </div>
  );
}
