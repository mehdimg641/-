import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowUpLeft,
  AtSign,
  Bot,
  Check,
  Clock3,
  Download,
  Inbox,
  MessageCircle,
  MessageSquareText,
  Reply,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Users,
  X,
  Zap,
} from "lucide-react";
import { filterInboxThreads, type ApprovalItem, type InboxChannel, type InboxThread } from "@shared/inbox";
import { trpc } from "@/lib/trpc";
import type { RouterOutputs } from "./types";
import { clock, errorMessage, faNum, IconButton, relativeTime, StatusPill } from "./ui";

type HistoryResult = RouterOutputs["inbox"]["importHistory"];

/** Says what the history import found and, when Meta hid comments, why (Development mode, not the token). */
function historyMessage(r: HistoryResult) {
  const parts: string[] = [];
  const c = r.comments;
  if (c.posts === 0) parts.push("هیچ پستی با کامنت پیدا نشد");
  else parts.push(`از ${faNum(c.posts)} پست، ${faNum(c.fetched)} کامنت خوانده شد و ${faNum(c.imported)} کامنت تازه وارد شد`);
  if (r.dms.error) {
    parts.push(`دایرکت‌ها دریافت نشد: ${r.dms.error} — در اپ اینستاگرام گزینهٔ «Allow access to messages» (تنظیمات ← Messages and story replies ← Message controls / Connected tools) را روشن کنید و مطمئن شوید دسترسی instagram_business_manage_messages در برنامهٔ Meta اضافه شده است`);
  }
  else parts.push(`${faNum(r.dms.fetched)} دایرکت خوانده شد و ${faNum(r.dms.imported)} دایرکت تازه وارد شد`);
  let text = parts.join("؛ ") + ".";
  if (c.hidden > 0) {
    text += ` اینستاگرام ${faNum(c.hidden)} کامنت را گزارش کرد ولی متنشان را نداد. توکن مشکلی ندارد (درخواست بدون خطا انجام شد)؛ برنامهٔ Meta در حالت Development است و Meta پیام کسانی را که در App roles نیستند پنهان می‌کند. بعد از Live شدن برنامه، همین دکمه را دوباره بزنید.`;
  }
  return { ok: c.hidden === 0 && !r.dms.error, text };
}

type Props = {
  threads: InboxThread[];
  approvals: ApprovalItem[];
  loading: boolean;
  autoReply: boolean;
  composer: string;
  setComposer: (text: string) => void;
  onOpenAutomation: () => void;
};

export function InboxView({ threads, approvals, loading, autoReply, composer, setComposer, onOpenAutomation }: Props) {
  const utils = trpc.useUtils();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "unread" | "priority">("all");
  const [channelFilter, setChannelFilter] = useState<"all" | InboxChannel>("all");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [historyNotice, setHistoryNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const importHistory = trpc.inbox.importHistory.useMutation({
    onSuccess: (r) => {
      setHistoryNotice(historyMessage(r));
      utils.inbox.invalidate();
      utils.posts.invalidate();
      utils.settings.diagnostics.invalidate();
    },
    onError: (e) => setHistoryNotice({ ok: false, text: errorMessage(e) }),
  });
  const runImport = () => {
    setHistoryNotice(null);
    importHistory.mutate();
  };

  const visibleThreads = useMemo(() => filterInboxThreads(threads, search, filter, channelFilter), [threads, search, filter, channelFilter]);
  const selectedThread = threads.find((thread) => thread.id === selectedId) ?? visibleThreads[0] ?? threads[0];
  const pendingDraft = approvals.find((item) => item.threadId === selectedThread?.id && item.status === "pending");

  const markRead = trpc.inbox.markRead.useMutation({ onSuccess: () => utils.inbox.threads.invalidate() });
  const reply = trpc.inbox.reply.useMutation({
    onSuccess: (result) => {
      if (result.ok) {
        setComposer("");
        setNotice({ ok: true, text: "پاسخ ارسال شد" });
      } else {
        setNotice({ ok: false, text: `ارسال ناموفق: ${result.error}` });
      }
      utils.inbox.invalidate();
      utils.approvals.list.invalidate();
    },
    onError: (error) => setNotice({ ok: false, text: errorMessage(error) }),
  });

  useEffect(() => {
    if (!notice?.ok) return;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const openThread = (thread: InboxThread) => {
    setSelectedId(thread.id);
    setNotice(null);
    if (thread.unread) markRead.mutate({ kind: thread.kind, senderId: thread.senderId });
  };

  const sendReply = () => {
    const text = composer.trim();
    if (!text || !selectedThread || reply.isPending) return;
    reply.mutate({ eventId: selectedThread.lastEventId, text });
  };

  const unread = threads.filter((thread) => thread.unread).length;
  const pending = approvals.filter((item) => item.status === "pending").length;
  const failed = approvals.filter((item) => item.status === "failed").length;

  return (
    <div className="content-wrap inbox-page">
      <section className="page-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> OPERATIONS / SOCIAL</div>
          <h1>صندوق ورودی سپند</h1>
          <p>تمام گفتگوهای مهم اینستاگرام، در یک نمای عملیاتی برای تیم فروش.</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" disabled={importHistory.isPending} onClick={runImport}><Download size={16} /> {importHistory.isPending ? "در حال دریافت..." : "دریافت پیام‌های قبلی"}</button>
          <button className="secondary-button" onClick={() => setShowFilters((value) => !value)}><SlidersHorizontal size={16} /> فیلترها</button>
          <button className="primary-button" onClick={onOpenAutomation}><Sparkles size={16} /> قوانین و صف تأیید</button>
        </div>
      </section>
      {historyNotice && <div className={historyNotice.ok ? "settings-success" : "settings-warning"}>{historyNotice.ok ? <Check size={16} /> : <AlertCircle size={16} />}<span>{historyNotice.text}</span></div>}

      <section className="metric-grid">
        <div className="metric-card accent-gold"><div className="metric-icon"><Inbox size={18} /></div><span>کل گفتگوها</span><strong>{faNum(threads.length)}</strong><em className="muted-text">کامنت و دایرکت</em></div>
        <div className="metric-card accent-orange"><div className="metric-icon"><Clock3 size={18} /></div><span>خوانده‌نشده</span><strong>{faNum(unread)}</strong>{unread > 0 ? <em className="warning-text"><AlertCircle size={14} /> نیاز به اقدام</em> : <em className="muted-text">همه بررسی شده</em>}</div>
        <div className="metric-card accent-blue"><div className="metric-icon"><Zap size={18} /></div><span>در انتظار تأیید</span><strong>{faNum(pending)}</strong><em className="muted-text">{autoReply ? "ارسال خودکار روشن" : "ارسال خودکار خاموش"}</em></div>
        <div className="metric-card accent-green"><div className="metric-icon"><Users size={18} /></div><span>ارسال ناموفق</span><strong>{faNum(failed)}</strong>{failed > 0 ? <em className="warning-text"><AlertCircle size={14} /> در صف تأیید</em> : <em className="muted-text">بدون خطا</em>}</div>
      </section>

      {showFilters && (
        <div className="filter-drawer">
          <div className="filter-title"><b>فیلتر مکالمات</b><IconButton label="بستن فیلترها" onClick={() => setShowFilters(false)}><X size={16} /></IconButton></div>
          <div className="filter-options">
            <button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>همه</button>
            <button className={filter === "unread" ? "selected" : ""} onClick={() => setFilter("unread")}>خوانده‌نشده</button>
            <button className={filter === "priority" ? "selected" : ""} onClick={() => setFilter("priority")}>در انتظار تأیید</button>
            <button className={channelFilter === "DM" ? "selected" : ""} onClick={() => setChannelFilter(channelFilter === "DM" ? "all" : "DM")}>دایرکت</button>
            <button className={channelFilter === "کامنت" ? "selected" : ""} onClick={() => setChannelFilter(channelFilter === "کامنت" ? "all" : "کامنت")}>کامنت</button>
          </div>
        </div>
      )}

      <div className="inbox-layout">
        <section className="conversation-list panel">
          <div className="list-header"><div><b>مکالمات اخیر</b><span>{faNum(visibleThreads.length)} مورد نمایش داده می‌شود</span></div></div>
          <div className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="جست‌وجو در نام، متن یا برچسب..." /></div>
          <div className="list-tabs">
            <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>همه <span>{faNum(threads.length)}</span></button>
            <button className={filter === "unread" ? "active" : ""} onClick={() => setFilter("unread")}>خوانده‌نشده <span>{faNum(unread)}</span></button>
            <button className={filter === "priority" ? "active" : ""} onClick={() => setFilter("priority")}>در انتظار تأیید</button>
          </div>
          <div className="thread-scroll">
            {visibleThreads.map((thread) => (
              <button key={thread.id} className={`thread-row ${thread.id === selectedThread?.id ? "selected" : ""}`} onClick={() => openThread(thread)}>
                <div className={`thread-avatar ${thread.tagTone}`}>{thread.avatar}<span className={`channel-mini ${thread.channel === "DM" ? "dm" : "comment"}`}>{thread.channel === "DM" ? <MessageCircle size={10} /> : <MessageSquareText size={10} />}</span></div>
                <div className="thread-content">
                  <div className="thread-name-line"><b>{thread.name}</b><span>{relativeTime(thread.updatedAt)}</span></div>
                  <div className="thread-handle">@{thread.handle}</div>
                  <p>{thread.message}</p>
                  <div className="thread-footer"><StatusPill tone={thread.tagTone}>{thread.tag}</StatusPill>{thread.unread && <span className="unread-mark" />} {thread.priority && <span className="priority-mark">در انتظار تأیید</span>}</div>
                </div>
              </button>
            ))}
            {loading && threads.length === 0 && <div className="empty-state"><Clock3 size={24} /><b>در حال بارگذاری...</b></div>}
            {!loading && threads.length === 0 && <div className="empty-state"><Inbox size={24} /><b>هنوز پیامی نرسیده</b><span>پیام‌های تازه از وبهوک Meta می‌آیند. برای کامنت‌ها و دایرکت‌های قبلی «دریافت پیام‌های قبلی» را بزنید.</span><button className="secondary-button" disabled={importHistory.isPending} onClick={runImport}><Download size={15} /> دریافت پیام‌های قبلی</button></div>}
            {threads.length > 0 && visibleThreads.length === 0 && <div className="empty-state"><Search size={24} /><b>موردی پیدا نشد</b><span>فیلتر یا عبارت جست‌وجو را تغییر دهید.</span></div>}
          </div>
        </section>

        {selectedThread ? (
          <>
            <section className="conversation-detail panel">
              <div className="detail-header"><div className="detail-person"><div className={`detail-avatar ${selectedThread.tagTone}`}>{selectedThread.avatar}</div><div><h2>{selectedThread.name}</h2><span>@{selectedThread.handle} · {selectedThread.channel}</span></div></div></div>
              <div className="context-strip"><div><AtSign size={15} /><span>از طریق {selectedThread.channel === "DM" ? "دایرکت" : "کامنت پست"}</span></div><div><Clock3 size={15} /><span>آخرین پیام {relativeTime(selectedThread.updatedAt)}</span></div><StatusPill tone={selectedThread.tagTone}>{selectedThread.tag}</StatusPill></div>
              <div className="message-stream">
                {selectedThread.messages.map((message) => (
                  <div key={message.id} className={`bubble-row ${message.from === "agent" ? "agent" : "contact"}`}>
                    <div className={`bubble-avatar ${message.from === "agent" ? "agent-avatar" : "contact-avatar"}`}>{message.from === "agent" ? "س" : selectedThread.avatar}</div>
                    <div className="bubble-wrap">
                      <div className={`message-bubble ${message.from === "agent" ? "agent-bubble" : "contact-bubble"} ${message.status === "failed" ? "failed-bubble" : ""}`}>{message.text}</div>
                      <span className="message-time">
                        {message.from === "agent" ? (message.via === "dm" ? "دایرکت سپند" : "پاسخ سپند") : selectedThread.name} · {clock(message.at)}
                        {message.status === "failed" && <b className="error-text"> · ارسال نشد{message.error ? `: ${message.error}` : ""}</b>}
                        {message.status === "sending" && " · در حال ارسال"}
                      </span>
                    </div>
                  </div>
                ))}
                {pendingDraft && <div className="ai-note"><Sparkles size={15} /><span>پیش‌نویس قانون «{pendingDraft.reason}» در صف تأیید است. می‌توانید آن را در کادر پاسخ بارگذاری و ویرایش کنید.</span></div>}
              </div>
              <div className="composer-area">
                <div className="composer-toolbar">
                  <span className="composer-label"><Reply size={15} /> پاسخ به {selectedThread.channel === "DM" ? "دایرکت" : "کامنت"}</span>
                  {pendingDraft && <button className="suggest-button" onClick={() => setComposer(pendingDraft.draft)}><Sparkles size={14} /> بارگذاری پیش‌نویس</button>}
                </div>
                <textarea
                  value={composer}
                  onChange={(event) => setComposer(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      sendReply();
                    }
                  }}
                  placeholder="پاسخ خود را بنویسید..."
                />
                <div className="composer-bottom">
                  <span className="composer-hint">Enter برای ارسال · Shift + Enter برای خط جدید{selectedThread.kind === "dm" ? " · دایرکت فقط تا ۲۴ ساعت پس از آخرین پیام مشتری" : ""}</span>
                  <button className="send-button" onClick={sendReply} disabled={!composer.trim() || reply.isPending}><Send size={15} /> {reply.isPending ? "در حال ارسال..." : "ارسال پاسخ"}</button>
                </div>
                {notice && <div className={`sent-notice ${notice.ok ? "" : "error-notice"}`}>{notice.ok ? <Check size={14} /> : <AlertCircle size={14} />} {notice.text}</div>}
              </div>
            </section>

            <aside className="right-rail">
              <div className="rail-card profile-card">
                <div className="rail-card-header"><span>پروفایل مخاطب</span></div>
                <div className="profile-main"><div className={`profile-avatar ${selectedThread.tagTone}`}>{selectedThread.avatar}</div><div><b>{selectedThread.name}</b><span>@{selectedThread.handle}</span></div></div>
                <div className="profile-stats">
                  <div><b>{faNum(selectedThread.messages.filter((m) => m.from === "contact").length)}</b><span>پیام</span></div>
                  <div><b>{faNum(selectedThread.messages.filter((m) => m.status === "sent").length)}</b><span>پاسخ</span></div>
                </div>
                {selectedThread.handle !== selectedThread.senderId && (
                  <a className="profile-link" href={`https://www.instagram.com/${encodeURIComponent(selectedThread.handle)}/`} target="_blank" rel="noreferrer">مشاهده پروفایل اینستاگرام <ArrowUpLeft size={14} /></a>
                )}
              </div>
              <div className="rail-card"><div className="rail-card-header"><span>قانون شناسایی‌شده</span></div><div className="tag-cloud"><StatusPill tone={selectedThread.tagTone}>{selectedThread.tag}</StatusPill></div></div>
              <div className="rail-card automation-mini">
                <div className="rail-card-header"><span>وضعیت اتوماسیون</span><Bot size={17} /></div>
                <div className="automation-state"><div><b>{autoReply ? "ارسال خودکار روشن" : "ارسال خودکار خاموش"}</b><span>{autoReply ? "فقط قوانین «ارسال مستقیم»" : "همه پاسخ‌ها پس از تأیید شما ارسال می‌شوند"}</span></div></div>
                <div className="automation-note"><ShieldCheck size={14} /> پاسخ‌های حساس همیشه ابتدا برای تأیید شما می‌آیند.</div>
              </div>
            </aside>
          </>
        ) : (
          <section className="conversation-detail panel"><div className="empty-state"><MessageCircle size={24} /><b>مکالمه‌ای انتخاب نشده</b></div></section>
        )}
      </div>
    </div>
  );
}
