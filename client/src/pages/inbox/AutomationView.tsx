import { useState } from "react";
import { AlertCircle, Bot, Check, CheckCircle2, ChevronLeft, Pencil, Plus, Send, ShieldCheck, Sparkles, Trash2, Workflow, X } from "lucide-react";
import type { ApprovalItem } from "@shared/inbox";
import { trpc } from "@/lib/trpc";
import type { RouterOutputs } from "./types";
import { errorMessage, faNum, relativeTime, StatusPill, Switch } from "./ui";

type Rule = RouterOutputs["rules"]["list"][number];
type Channels = Rule["channels"];

const channelLabel = (channels: Channels) =>
  channels.length === 2 ? "کامنت و دایرکت" : channels[0] === "dm" ? "فقط دایرکت" : "فقط کامنت";

export function AutomationView({ approvals, autoReply, onBack }: { approvals: ApprovalItem[]; autoReply: boolean; onBack: () => void }) {
  const [editing, setEditing] = useState<Rule | null>(null);
  const [builderKey, setBuilderKey] = useState(0);
  const rules = trpc.rules.list.useQuery();

  const startNew = () => {
    setEditing(null);
    setBuilderKey((key) => key + 1);
  };

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
            هر کامنت یا دایرکت ورودی با اولین قانون منطبق، یک پیش‌نویس پاسخ می‌سازد. پیش‌نویس‌ها در صف تأیید می‌مانند تا شما ارسالشان کنید.
            {autoReply
              ? " ارسال خودکار روشن است: قوانین «ارسال مستقیم» بدون تأیید ارسال می‌شوند."
              : " ارسال خودکار خاموش است (META_AUTO_REPLY)؛ هیچ پاسخی بدون تأیید ارسال نمی‌شود."}
          </p>
        </div>
      </div>

      <div className="section-title-row">
        <div><h2>قواعد</h2><span>به ترتیب اولویت؛ اولین قانون منطبق اعمال می‌شود</span></div>
        <button className="secondary-button" onClick={startNew}><Plus size={16} /> قانون جدید</button>
      </div>
      {rules.error && <div className="settings-warning"><AlertCircle size={16} /><span>{errorMessage(rules.error)}</span></div>}
      <div className="rule-grid">
        {rules.data?.map((rule) => (
          <RuleCard key={rule.id} rule={rule} onEdit={() => { setEditing(rule); setBuilderKey((key) => key + 1); }} />
        ))}
      </div>

      <div className="builder-grid">
        <RuleBuilder key={builderKey} rule={editing} onDone={startNew} />
        <ApprovalQueue items={approvals} />
      </div>

      <div className="safety-panel">
        <div className="safety-icon"><ShieldCheck size={19} /></div>
        <div><b>گاردریل‌های پاسخ سپند</b><p>قوانین «نیازمند تأیید» (قیمت، تخفیف، قرارداد، تحویل) هرگز خودکار ارسال نمی‌شوند، حتی وقتی ارسال خودکار روشن است.</p></div>
      </div>
    </div>
  );
}

function RuleCard({ rule, onEdit }: { rule: Rule; onEdit: () => void }) {
  const utils = trpc.useUtils();
  const update = trpc.rules.update.useMutation({ onSuccess: () => utils.rules.list.invalidate() });
  const remove = trpc.rules.delete.useMutation({ onSuccess: () => utils.rules.list.invalidate() });
  const tone = rule.action === "approval" ? "gold" : "blue";
  return (
    <div className="rule-card">
      <div className="rule-top">
        <div className={`rule-icon ${tone}`}>{rule.action === "approval" ? <ShieldCheck size={18} /> : <Send size={18} />}</div>
        <div className="rule-title"><b>{rule.name}</b><span>{rule.enabled ? "فعال" : "غیرفعال"} · اولویت {faNum(rule.priority)}</span></div>
        <Switch small on={rule.enabled} label="فعال/غیرفعال" onToggle={() => update.mutate({ id: rule.id, patch: { enabled: !rule.enabled } })} />
      </div>
      <div className="rule-line"><span>اگر</span><p>{rule.keywords.length ? `متن شامل «${rule.keywords.join("، ")}» باشد` : "هیچ قانون دیگری منطبق نشود"} ({channelLabel(rule.channels)})</p></div>
      <div className="rule-line"><span>آنگاه</span><p>{rule.template}</p></div>
      <div className="rule-footer">
        <StatusPill tone={tone}>{rule.action === "approval" ? "نیازمند تأیید" : "ارسال مستقیم"}</StatusPill>
        <span className="rule-actions">
          <button className="text-button" onClick={onEdit}><Pencil size={13} /> ویرایش</button>
          <button className="text-button danger" onClick={() => window.confirm(`قانون «${rule.name}» حذف شود؟`) && remove.mutate({ id: rule.id })}><Trash2 size={13} /> حذف</button>
        </span>
      </div>
    </div>
  );
}

const splitKeywords = (value: string) => value.split(/[,،\n]/).map((k) => k.trim()).filter(Boolean);

function RuleBuilder({ rule, onDone }: { rule: Rule | null; onDone: () => void }) {
  const utils = trpc.useUtils();
  const [name, setName] = useState(rule?.name ?? "");
  const [keywords, setKeywords] = useState(rule?.keywords.join("، ") ?? "");
  const [channels, setChannels] = useState<Channels>(rule?.channels ?? ["comment", "dm"]);
  const [action, setAction] = useState<Rule["action"]>(rule?.action ?? "approval");
  const [priority, setPriority] = useState(rule?.priority ?? 50);
  const [template, setTemplate] = useState(rule?.template ?? "سلام {{username}}، ");
  const [error, setError] = useState("");

  const onSuccess = () => {
    utils.rules.list.invalidate();
    onDone();
  };
  const onError = (e: unknown) => setError(errorMessage(e));
  const create = trpc.rules.create.useMutation({ onSuccess, onError });
  const update = trpc.rules.update.useMutation({ onSuccess, onError });

  const save = () => {
    setError("");
    const input = { name, keywords: splitKeywords(keywords), channels, action, template, priority, enabled: rule?.enabled ?? true };
    if (rule) update.mutate({ id: rule.id, patch: input });
    else create.mutate(input);
  };

  const channelValue = channels.length === 2 ? "both" : channels[0];
  const preview = template.replaceAll("{{username}}", "hossein.rz");

  return (
    <div className="builder-card">
      <div className="builder-header"><div><b>{rule ? `ویرایش «${rule.name}»` : "ساخت قانون جدید"}</b><span>برای پاسخ به کامنت و دایرکت</span></div><Workflow size={18} /></div>
      <div className="builder-fields">
        <label>نام قانون<input value={name} onChange={(event) => setName(event.target.value)} placeholder="مثلاً: درخواست قیمت" /></label>
        <label>کلمات محرک (با ، جدا کنید؛ خالی = همه پیام‌ها)<input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="قیمت، نرخ، استعلام" /></label>
        <label>کانال
          <select value={channelValue} onChange={(event) => setChannels(event.target.value === "both" ? ["comment", "dm"] : [event.target.value as "comment" | "dm"])}>
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
      <label>متن پاسخ <span className="field-tip">{"{{username}}"} = نام اکانت مخاطب (در دایرکت‌ها خالی می‌ماند)</span><textarea value={template} onChange={(event) => setTemplate(event.target.value)} /></label>
      <div className="builder-preview"><Sparkles size={14} /><span>پیش‌نمایش: {preview}</span></div>
      {error && <div className="settings-warning"><AlertCircle size={16} /><span>{error}</span></div>}
      <div className="builder-buttons">
        <button className="primary-button" onClick={save} disabled={create.isPending || update.isPending || !name.trim() || !template.trim()}><Check size={15} /> {rule ? "ذخیره تغییرات" : "ذخیره قانون"}</button>
        {rule && <button className="secondary-button" onClick={onDone}>انصراف</button>}
      </div>
    </div>
  );
}

function ApprovalQueue({ items }: { items: ApprovalItem[] }) {
  const utils = trpc.useUtils();
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const refresh = () => {
    utils.approvals.list.invalidate();
    utils.inbox.invalidate();
  };
  const approve = trpc.approvals.approve.useMutation({
    onSuccess: (result, input) => {
      setErrors((current) => ({ ...current, [input.id]: result.ok ? "" : result.error }));
      refresh();
    },
    onError: (error, input) => setErrors((current) => ({ ...current, [input.id]: errorMessage(error) })),
  });
  const reject = trpc.approvals.reject.useMutation({ onSuccess: refresh, onError: (error, input) => setErrors((current) => ({ ...current, [input.id]: errorMessage(error) })) });
  const busy = (id: number) => (approve.isPending && approve.variables?.id === id) || (reject.isPending && reject.variables?.id === id);

  return (
    <div className="approval-card">
      <div className="builder-header"><div><b>صف تأیید اپراتور</b><span>پیش‌نویس‌ها قبل از ارسال اینجا می‌آیند</span></div><StatusPill tone={items.length ? "orange" : "green"}>{items.length ? `${faNum(items.length)} در انتظار` : "پاک است"}</StatusPill></div>
      {items.length ? (
        items.map((item) => (
          <div className="approval-item" key={item.id}>
            <div className={`approval-avatar ${item.tone}`}>{item.name[0]}</div>
            <div className="approval-copy">
              <b>{item.name} <small>@{item.handle} · {item.channel === "DM" ? "دایرکت" : "کامنت"} · {relativeTime(item.createdAt)}</small></b>
              <p>{item.incoming}</p>
              <textarea className="approval-draft" value={drafts[item.id] ?? item.draft} onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))} />
              <StatusPill tone={item.status === "failed" ? "orange" : item.tone}>{item.status === "failed" ? "ارسال ناموفق" : item.reason}</StatusPill>
              {(errors[item.id] || item.error) && <span className="error-text">{errors[item.id] || item.error}</span>}
            </div>
            <div className="approval-actions">
              <button className="approve-button" disabled={busy(item.id)} onClick={() => approve.mutate({ id: item.id, text: drafts[item.id] })}><Check size={14} /> {item.status === "failed" ? "تلاش مجدد" : "تأیید و ارسال"}</button>
              <button className="reject-button" aria-label="رد" title="رد" disabled={busy(item.id)} onClick={() => reject.mutate({ id: item.id })}><X size={14} /></button>
            </div>
          </div>
        ))
      ) : (
        <div className="approval-empty"><CheckCircle2 size={22} /><b>موردی برای بررسی نیست</b><span>پیش‌نویس‌های جدید با رسیدن پیام‌ها اینجا ظاهر می‌شوند.</span></div>
      )}
      <div className="approval-footer"><ShieldCheck size={14} /> قیمت و تعهد تجاری همیشه نیازمند تأیید است.</div>
    </div>
  );
}
