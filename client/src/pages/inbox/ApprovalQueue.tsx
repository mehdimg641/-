import { useMemo, useState } from "react";
import { AlertCircle, Check, CheckCheck, CheckCircle2, ChevronDown, Copy, Mail, MessageSquareText, Search, Send, ShieldCheck, X } from "lucide-react";
import { optionsAsText, type ApprovalItem } from "@shared/inbox";
import { trpc } from "@/lib/trpc";
import { copyAndOpenDm, errorMessage, faNum, relativeTime, StatusPill, timeUntil } from "./ui";

type QueueSort = "newest" | "oldest";
type QueueKind = "all" | "comment" | "private" | "dm";
type QueueStatus = "all" | "pending" | "failed" | "open" | "expired";
type QueueAnswer = "all" | "unanswered" | "answered";
const PAGE = 30;
const SEND_BATCH = 10;
const isNew = (item: ApprovalItem) => Date.now() - new Date(item.receivedAt).getTime() < 3_600_000;
/** Past Instagram's deadline (7 days for a DM to a commenter, 24 hours for a DM reply). */
export const isExpired = (item: ApprovalItem) => item.expiresAt !== null && new Date(item.expiresAt).getTime() <= Date.now();
/** Time left when the deadline is under a day away, otherwise "". */
function timeLeft(item: ApprovalItem) {
  if (!item.expiresAt) return "";
  const end = new Date(item.expiresAt);
  return end.getTime() - Date.now() > 24 * 3_600_000 ? "" : timeUntil(end);
}

const replyKind = (item: ApprovalItem) =>
  item.replyChannel === "private"
    ? { icon: <Mail size={13} />, label: "دایرکت به نویسندهٔ کامنت", cls: "private" }
    : item.channel === "DM"
      ? { icon: <Send size={13} />, label: "پاسخ دایرکت", cls: "dm" }
      : { icon: <MessageSquareText size={13} />, label: "پاسخ زیر کامنت", cls: "comment" };

/** "<Persian hint> — Meta API …" becomes a headline and the technical details. */
function splitError(error: string) {
  const at = error.indexOf(" — Meta API");
  if (at > 0) return { headline: error.slice(0, at), details: error.slice(at + 3) };
  return error.startsWith("Meta API") ? { headline: "اینستاگرام پیام را نپذیرفت.", details: error } : { headline: error, details: "" };
}

function ErrorBox({ error }: { error: string }) {
  const { headline, details } = splitError(error);
  const [copied, setCopied] = useState(false);
  return (
    <div className="queue-error">
      <AlertCircle size={15} />
      <div>
        <b>{headline}</b>
        {details && (
          <details>
            <summary>جزئیات خطا <ChevronDown size={12} /></summary>
            <code dir="ltr">{details}</code>
            <button
              type="button"
              className="text-button"
              onClick={() => navigator.clipboard?.writeText(details).then(() => setCopied(true), () => setCopied(false))}
            >
              <Copy size={12} /> {copied ? "کپی شد" : "کپی جزئیات"}
            </button>
          </details>
        )}
      </div>
    </div>
  );
}

export function ApprovalQueue({ items }: { items: ApprovalItem[] }) {
  const utils = trpc.useUtils();
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [bulkBusy, setBulkBusy] = useState("");
  const [search, setSearch] = useState("");
  const [rule, setRule] = useState("all");
  const [kind, setKind] = useState<QueueKind>("all");
  const [status, setStatus] = useState<QueueStatus>("all");
  const [sort, setSort] = useState<QueueSort>("newest");
  const [todayOnly, setTodayOnly] = useState(false);
  const [answer, setAnswer] = useState<QueueAnswer>("all");
  const [grouped, setGrouped] = useState(false);
  const [shown, setShown] = useState(PAGE);
  /** Just converted to a reply under the comment: kept highlighted so it does not seem to vanish. */
  const [moved, setMoved] = useState<Set<number>>(new Set());
  /** Items whose text was copied for sending by hand; they now offer «ارسال دستی شد». */
  const [copied, setCopied] = useState<Record<number, string>>({});

  const refresh = () => {
    utils.approvals.list.invalidate();
    utils.inbox.invalidate();
    utils.posts.invalidate();
  };
  const clearError = (id: number) => setErrors(({ [id]: _, ...rest }) => rest);
  const onItemError = (error: unknown, input: { id: number }) => setErrors((current) => ({ ...current, [input.id]: errorMessage(error) }));
  const forgetDraft = (id: number) => setDrafts(({ [id]: _, ...rest }) => rest);
  const approve = trpc.approvals.approve.useMutation({
    onSuccess: (result, input) => {
      if (result.ok) clearError(input.id);
      else setErrors((current) => ({ ...current, [input.id]: result.error }));
      refresh();
    },
    onError: onItemError,
  });
  const reject = trpc.approvals.reject.useMutation({ onSuccess: refresh, onError: onItemError });
  const markSent = trpc.approvals.markSent.useMutation({ onSuccess: (_, input) => { clearError(input.id); refresh(); }, onError: onItemError });
  const moveToPublic = trpc.approvals.moveToPublic.useMutation({
    onSuccess: (_, input) => {
      forgetDraft(input.id);
      clearError(input.id);
      setMoved((current) => new Set(current).add(input.id));
      // The converted reply has no deadline, so it would leave the «مهلت گذشته» view.
      if (status === "expired") setStatus("all");
      setNotice({ ok: true, text: "تبدیل شد: حالا پاسخ زیر همان کامنت است و منتظر تأیید شما (متن را ببینید و «تأیید و ارسال» را بزنید)." });
      refresh();
    },
    onError: onItemError,
  });
  const approveMany = trpc.approvals.approveMany.useMutation();
  const rejectMany = trpc.approvals.rejectMany.useMutation();
  const moveToPublicMany = trpc.approvals.moveToPublicMany.useMutation();
  const busy = (id: number) => Boolean(bulkBusy) || [approve, reject, markSent, moveToPublic].some((m) => m.isPending && m.variables?.id === id);

  const rules = useMemo(() => Array.from(new Set(items.map((i) => i.reason))), [items]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const list = items.filter(
      (i) =>
        (rule === "all" || i.reason === rule) &&
        (status === "all" || (status === "expired" ? isExpired(i) : status === "open" ? !isExpired(i) : i.status === status)) &&
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
  const filtering = filtered.length !== items.length;
  const resetFilters = () => {
    setSearch("");
    setRule("all");
    setKind("all");
    setStatus("all");
    setAnswer("all");
    setTodayOnly(false);
    setShown(PAGE);
  };
  const page = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setShown(PAGE);
  };

  // Small batches: the server sends each reply to Instagram one by one, and a long request
  // runs into the host's gateway timeout (an HTML error page instead of an answer).
  const sendAll = async (chosen: ApprovalItem[], label: string) => {
    // Instagram refuses these anyway; leave them for the operator to reject or answer by hand.
    const expired = chosen.filter(isExpired).length;
    const list = chosen.filter((item) => !isExpired(item));
    const skipped = expired ? `${faNum(expired)} مورد که مهلت اینستاگرامشان گذشته فرستاده نمی‌شود (وضعیت «مهلت اینستاگرام گذشته»).` : "";
    if (!list.length) {
      setNotice({ ok: false, text: skipped || "موردی برای ارسال نیست." });
      return;
    }
    if (!window.confirm(`${faNum(list.length)} پاسخ ${label} با همین متن‌ها ارسال شود؟${skipped ? `\n${skipped}` : ""}`)) return;
    setNotice(null);
    let sent = 0;
    const failed: Array<{ id: number; error: string }> = [];
    try {
      for (let i = 0; i < list.length; i += SEND_BATCH) {
        setBulkBusy(`در حال ارسال… ${faNum(Math.min(i + SEND_BATCH, list.length))} از ${faNum(list.length)}`);
        const result = await approveMany.mutateAsync({ items: list.slice(i, i + SEND_BATCH).map((item) => ({ id: item.id, text: drafts[item.id] })) });
        sent += result.sent;
        failed.push(...result.failed);
      }
      setNotice({ ok: failed.length === 0, text: `${faNum(sent)} پاسخ ارسال شد${failed.length ? `؛ ${faNum(failed.length)} مورد ناموفق بود (علت زیر هر مورد)` : ""}.${skipped ? ` ${skipped}` : ""}` });
    } catch (error) {
      setNotice({ ok: false, text: errorMessage(error) });
    } finally {
      setErrors((current) => ({ ...current, ...Object.fromEntries(failed.map((f) => [f.id, f.error])) }));
      setSelected(new Set());
      setBulkBusy("");
      refresh();
    }
  };
  const rejectAll = async (list: ApprovalItem[]) => {
    if (!list.length || !window.confirm(`${faNum(list.length)} پیش‌نویس رد شود؟ (ارسال نمی‌شوند و از صف حذف می‌شوند)`)) return;
    setNotice(null);
    setBulkBusy("در حال رد کردن…");
    try {
      let rejected = 0;
      for (let i = 0; i < list.length; i += 1000) rejected += (await rejectMany.mutateAsync({ ids: list.slice(i, i + 1000).map((item) => item.id) })).rejected;
      setNotice({ ok: true, text: `${faNum(rejected)} پیش‌نویس رد شد.` });
    } catch (error) {
      setNotice({ ok: false, text: errorMessage(error) });
    } finally {
      setSelected(new Set());
      setBulkBusy("");
      refresh();
    }
  };
  const moveAll = async (list: ApprovalItem[]) => {
    if (!list.length || !window.confirm(`${faNum(list.length)} دایرکتِ مهلت‌گذشته به پاسخ زیر همان کامنت تبدیل شود؟ متن پیش‌فرض از مشتری می‌خواهد دایرکت بدهد؛ بعد از تبدیل، متن را ببینید و تأیید کنید.`)) return;
    setNotice(null);
    setBulkBusy("در حال تبدیل…");
    try {
      let count = 0;
      for (let i = 0; i < list.length; i += 1000) count += (await moveToPublicMany.mutateAsync({ ids: list.slice(i, i + 1000).map((item) => item.id) })).moved;
      list.forEach((item) => {
        forgetDraft(item.id);
        clearError(item.id);
      });
      setMoved((current) => new Set([...Array.from(current), ...list.map((item) => item.id)]));
      if (status === "expired") setStatus("all");
      setNotice({ ok: true, text: `${faNum(count)} مورد به پاسخ زیر کامنت تبدیل شد و منتظر تأیید است.` });
    } catch (error) {
      setNotice({ ok: false, text: errorMessage(error) });
    } finally {
      setSelected(new Set());
      setBulkBusy("");
      refresh();
    }
  };
  const copyAndOpen = async (item: ApprovalItem) => {
    const draft = drafts[item.id] ?? item.draft;
    const text = item.buttons.length ? optionsAsText(draft, item.buttons.map((title) => ({ title, payload: "" }))) : draft;
    const note = await copyAndOpenDm(item.handle, text);
    setCopied((current) => ({ ...current, [item.id]: note }));
  };
  const toggle = (id: number) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectedItems = filtered.filter((item) => selected.has(item.id));
  const movable = selectedItems.filter((item) => item.replyChannel === "private" && isExpired(item));
  const allSelected = filtered.length > 0 && selectedItems.length === filtered.length;

  if (!items.length) {
    return (
      <div className="queue-empty panel">
        <CheckCircle2 size={28} />
        <b>صف تأیید خالی است</b>
        <span>پیش‌نویس‌های تازه با رسیدن کامنت و دایرکت اینجا ظاهر می‌شوند.</span>
      </div>
    );
  }

  return (
    <div className="queue">
      <div className="tab-toolbar queue-toolbar">
        <div className="search-box"><Search size={16} /><input value={search} onChange={(e) => page(setSearch)(e.target.value)} placeholder="جستجو در نام، کامنت یا متن پاسخ..." /></div>
        <select aria-label="مرتب‌سازی" value={sort} onChange={(e) => setSort(e.target.value as QueueSort)}>
          <option value="newest">جدیدترین اول</option>
          <option value="oldest">قدیمی‌ترین اول</option>
        </select>
        <select aria-label="نوع پاسخ" value={kind} onChange={(e) => page(setKind)(e.target.value as QueueKind)}>
          <option value="all">همهٔ انواع</option>
          <option value="comment">پاسخ زیر کامنت</option>
          <option value="private">دایرکت به نویسندهٔ کامنت</option>
          <option value="dm">پاسخ دایرکت</option>
        </select>
        <select aria-label="وضعیت" value={status} onChange={(e) => page(setStatus)(e.target.value as QueueStatus)}>
          <option value="all">همهٔ وضعیت‌ها</option>
          <option value="pending">در انتظار تأیید</option>
          <option value="failed">ارسال ناموفق</option>
          <option value="open">قابل ارسال (در مهلت)</option>
          <option value="expired">مهلت اینستاگرام گذشته</option>
        </select>
        <select aria-label="پاسخ" value={answer} onChange={(e) => page(setAnswer)(e.target.value as QueueAnswer)}>
          <option value="all">جواب‌داده و نداده</option>
          <option value="unanswered">جواب داده نشده</option>
          <option value="answered">جواب گرفته (کانال دیگر مانده)</option>
        </select>
        <select aria-label="قانون" value={rule} onChange={(e) => page(setRule)(e.target.value)}>
          <option value="all">همهٔ قانون‌ها</option>
          {rules.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <label className="toggle-chip"><input type="checkbox" checked={todayOnly} onChange={(e) => page(setTodayOnly)(e.target.checked)} /> فقط امروز</label>
        <label className="toggle-chip"><input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> گروه‌بندی بر اساس قانون</label>
      </div>

      <div className={`queue-actions ${selectedItems.length ? "selecting" : ""}`}>
        <label className="toggle-chip">
          <input type="checkbox" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((i) => i.id)) : new Set())} />
          {selectedItems.length ? `${faNum(selectedItems.length)} انتخاب شده` : `انتخاب همه${filtering ? "ٔ فیلترشده‌ها" : ""}`}
        </label>
        {selectedItems.length ? (
          <>
            <button className="approve-button lg" disabled={Boolean(bulkBusy)} onClick={() => sendAll(selectedItems, "انتخاب‌شده")}><CheckCheck size={15} /> تأیید و ارسال</button>
            <button className="reject-button lg" disabled={Boolean(bulkBusy)} onClick={() => rejectAll(selectedItems)}><X size={15} /> رد</button>
            {movable.length > 0 && <button className="secondary-button" disabled={Boolean(bulkBusy)} onClick={() => moveAll(movable)}><MessageSquareText size={14} /> {faNum(movable.length)} دایرکت مهلت‌گذشته ← پاسخ زیر کامنت</button>}
            <button className="text-button" onClick={() => setSelected(new Set())}>لغو انتخاب</button>
          </>
        ) : (
          <>
            <span className="queue-count">{filtering ? `${faNum(filtered.length)} از ${faNum(items.length)} مورد` : `${faNum(items.length)} مورد در صف`}</span>
            {filtering && <button className="text-button" onClick={resetFilters}>حذف فیلترها</button>}
            <button className="secondary-button push" disabled={!filtered.length || Boolean(bulkBusy)} onClick={() => sendAll(filtered, filtering ? "فیلترشده" : "در صف")}><CheckCheck size={14} /> تأیید همه{filtering ? "ٔ فیلترشده‌ها" : ""} ({faNum(filtered.length)})</button>
          </>
        )}
      </div>
      {bulkBusy && <div className="queue-progress">{bulkBusy} — هر پاسخ جدا به اینستاگرام فرستاده می‌شود.</div>}
      {notice && <div className={notice.ok ? "settings-success" : "settings-warning"}>{notice.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}<span>{notice.text}</span><button className="icon-button" aria-label="بستن" onClick={() => setNotice(null)}><X size={14} /></button></div>}

      {filtered.length ? (
        groups.map(([reason, list]) => (
          <section className="queue-group" key={reason || "all"}>
            {grouped && (
              <div className="queue-group-head">
                <b>{reason}</b> <small>{faNum(filtered.filter((i) => i.reason === reason).length)} مورد</small>
                <button className="text-button" disabled={Boolean(bulkBusy)} onClick={() => sendAll(filtered.filter((i) => i.reason === reason), `قانون «${reason}»`)}><CheckCheck size={13} /> تأیید همهٔ این دسته</button>
              </div>
            )}
            {list.map((item) => {
              const expired = isExpired(item);
              const left = timeLeft(item);
              const k = replyKind(item);
              // An error stored on a draft that is pending again (e.g. converted) is stale.
              const error = errors[item.id] || (item.status === "failed" ? item.error : null);
              return (
                <article
                  key={item.id}
                  className={["queue-card", isNew(item) ? "fresh" : "", expired ? "expired" : "", moved.has(item.id) ? "moved" : "", selected.has(item.id) ? "picked" : ""].join(" ")}
                >
                  <header className="queue-card-head">
                    <input type="checkbox" aria-label="انتخاب" checked={selected.has(item.id)} onChange={() => toggle(item.id)} />
                    <div className={`approval-avatar ${item.tone}`}>{item.name[0]}</div>
                    <div className="queue-who">
                      <b>{item.name}</b>
                      <small dir="ltr">@{item.handle}</small>
                    </div>
                    <span className={`kind-chip ${k.cls}`}>{k.icon} {k.label}</span>
                    <span className="queue-time" title={new Date(item.receivedAt).toLocaleString("fa-IR")}>{relativeTime(new Date(item.receivedAt))}</span>
                  </header>
                  <div className="queue-chips">
                    {isNew(item) && <StatusPill tone="green">جدید</StatusPill>}
                    <StatusPill tone={item.tone}>{item.reason}</StatusPill>
                    {item.status === "failed" && <StatusPill tone="orange">ارسال ناموفق</StatusPill>}
                    {item.answered && <StatusPill tone="green">جواب گرفته</StatusPill>}
                    {expired ? <StatusPill tone="orange">مهلت اینستاگرام گذشته</StatusPill> : left ? <StatusPill tone="gold">{left} تا پایان مهلت</StatusPill> : null}
                    {moved.has(item.id) && <StatusPill tone="blue">تبدیل شد به پاسخ زیر کامنت</StatusPill>}
                  </div>
                  <blockquote className="queue-incoming">{item.incoming}</blockquote>
                  <textarea
                    className="queue-draft"
                    aria-label="متن پاسخ"
                    value={drafts[item.id] ?? item.draft}
                    rows={Math.min(6, Math.max(2, (drafts[item.id] ?? item.draft).split("\n").length))}
                    onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))}
                  />
                  {item.buttons.length > 0 && <div className="quick-replies">{item.buttons.map((b) => <span key={b} className="quick-reply">{b}</span>)}</div>}
                  {expired && (
                    <div className="queue-expired">
                      <span>
                        {item.replyChannel === "private"
                          ? "اینستاگرام دایرکت به نویسندهٔ کامنت را فقط تا ۷ روز بعد از کامنت می‌پذیرد. می‌توانید زیر خود کامنت جواب بدهید یا از اپ اینستاگرام بفرستید."
                          : "به دایرکت فقط تا ۲۴ ساعت بعد از آخرین پیام مشتری می‌شود از اینجا جواب داد؛ از اپ اینستاگرام بفرستید یا منتظر پیام بعدی مشتری بمانید."}
                      </span>
                      <div className="expired-actions">
                        {item.replyChannel === "private" && <button className="secondary-button" disabled={busy(item.id)} onClick={() => moveToPublic.mutate({ id: item.id })}><MessageSquareText size={14} /> به‌جایش زیر کامنت جواب بده</button>}
                        <button className="secondary-button" disabled={busy(item.id)} onClick={() => copyAndOpen(item)}><Copy size={14} /> کپی و باز کردن دایرکت در اینستاگرام</button>
                        {copied[item.id] !== undefined && <button className="approve-button lg" disabled={busy(item.id)} onClick={() => markSent.mutate({ id: item.id, text: drafts[item.id] })}><Check size={14} /> ارسال دستی شد</button>}
                      </div>
                      {copied[item.id] && <span className="field-tip">{copied[item.id]}</span>}
                    </div>
                  )}
                  {error && <ErrorBox error={error} />}
                  <footer className="queue-card-foot">
                    <button className="reject-button lg" disabled={busy(item.id)} onClick={() => reject.mutate({ id: item.id })}><X size={14} /> رد</button>
                    <button className="approve-button lg" disabled={busy(item.id) || expired} title={expired ? "مهلت اینستاگرام گذشته" : undefined} onClick={() => approve.mutate({ id: item.id, text: drafts[item.id] })}>
                      <Check size={14} /> {approve.isPending && approve.variables?.id === item.id ? "در حال ارسال..." : item.status === "failed" ? "تلاش مجدد" : "تأیید و ارسال"}
                    </button>
                  </footer>
                </article>
              );
            })}
          </section>
        ))
      ) : (
        <div className="queue-empty panel"><Search size={24} /><b>موردی با این فیلترها نیست</b><button className="secondary-button" onClick={resetFilters}>حذف فیلترها</button></div>
      )}
      {filtered.length > shown && (
        <button className="secondary-button queue-more" onClick={() => setShown((n) => n + PAGE)}>نمایش {faNum(Math.min(PAGE, filtered.length - shown))} مورد دیگر ({faNum(filtered.length - shown)} باقی‌مانده)</button>
      )}
      <div className="approval-footer"><ShieldCheck size={14} /> قیمت و تعهد تجاری همیشه نیازمند تأیید است؛ هیچ پاسخی بدون تأیید ارسال نمی‌شود مگر قانون «ارسال مستقیم» با ارسال خودکار روشن.</div>
    </div>
  );
}
