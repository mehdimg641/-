import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowUpLeft,
  Bot,
  Check,
  Clock3,
  Copy,
  Download,
  EyeOff,
  ExternalLink,
  Heart,
  ImageIcon,
  MoreHorizontal,
  Inbox,
  MessageCircle,
  MessageSquareText,
  Reply,
  Search,
  Send,
  Sparkles,
  TimerOff,
  Trash2,
} from "lucide-react";
import { dmWindowEnd, filterInboxThreads, isUnanswered, type ApprovalItem, type InboxFilter, type InboxThread } from "@shared/inbox";
import { trpc } from "@/lib/trpc";
import { MultiMessageEditor } from "./MultiMessageEditor";
import type { RouterOutputs } from "./types";
import { clock, copyAndOpenDm, errorMessage, faNum, hasUsername, relativeTime, StatusPill, timeUntil } from "./ui";

type HistoryResult = RouterOutputs["inbox"]["importHistory"];
type Post = RouterOutputs["posts"]["list"][number];
export type InboxKind = "comment" | "dm";

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

const COPY = {
  comment: {
    title: "کامنت‌ها",
    subtitle: "کامنت‌های زیر پست‌های @sepandsteel؛ پاسخ شما زیر همان کامنت می‌نشیند.",
    icon: MessageSquareText,
    empty: "هنوز کامنتی نرسیده",
    replyLabel: "پاسخ زیر آخرین کامنت",
  },
  dm: {
    title: "دایرکت‌ها",
    subtitle: "پیام‌های مستقیم مشتریان؛ تا ۲۴ ساعت بعد از آخرین پیامشان می‌شود از اینجا جواب داد.",
    icon: MessageCircle,
    empty: "هنوز دایرکتی نرسیده",
    replyLabel: "پاسخ دایرکت",
  },
} as const;

type Props = {
  kind: InboxKind;
  threads: InboxThread[];
  approvals: ApprovalItem[];
  loading: boolean;
  autoReply: boolean;
  composer: string;
  setComposer: (text: string) => void;
  onOpenAutomation: () => void;
};

function PostRef({ post, mediaId }: { post: Post | undefined; mediaId: string }) {
  const body = (
    <>
      <span className="post-ref-thumb">{post?.imageUrl ? <img src={post.imageUrl} alt="" loading="lazy" /> : <ImageIcon size={14} />}</span>
      <span className="post-ref-text">
        <small>زیر پست</small>
        <b>{post?.caption?.trim() || (post ? "پست بدون کپشن" : `پست ${mediaId}`)}</b>
      </span>
      {post?.permalink && <ExternalLink size={13} />}
    </>
  );
  return post?.permalink ? (
    <a className="post-ref" href={post.permalink} target="_blank" rel="noreferrer">{body}</a>
  ) : (
    <div className="post-ref">{body}</div>
  );
}

export function InboxView({ kind, threads: allThreads, approvals: allApprovals, loading, autoReply, composer, setComposer, onOpenAutomation }: Props) {
  const copy = COPY[kind];
  const Icon = copy.icon;
  const utils = trpc.useUtils();
  const posts = trpc.posts.list.useQuery(undefined, { enabled: kind === "comment" });
  const postById = useMemo(() => new Map((posts.data ?? []).map((p) => [p.id, p] as const)), [posts.data]);
  const threads = useMemo(() => allThreads.filter((t) => t.kind === kind), [allThreads, kind]);
  const approvals = useMemo(() => allApprovals.filter((a) => (kind === "dm" ? a.channel === "DM" : a.channel !== "DM")), [allApprovals, kind]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
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

  // Switching between comments and DMs starts fresh.
  useEffect(() => {
    setSelectedId(null);
    setFilter("all");
    setSearch("");
    setNotice(null);
  }, [kind]);

  const visibleThreads = useMemo(() => filterInboxThreads(threads, search, filter, "all"), [threads, search, filter]);
  const selectedThread = threads.find((thread) => thread.id === selectedId) ?? visibleThreads[0] ?? threads[0];
  const pendingDraft = approvals.find((item) => item.threadId === selectedThread?.id && item.status === "pending");
  const windowEnd = selectedThread && kind === "dm" ? dmWindowEnd(selectedThread) : null;
  const windowLeft = windowEnd ? timeUntil(windowEnd) : "";
  const windowClosed = kind === "dm" && Boolean(windowEnd) && !windowLeft;

  const markRead = trpc.inbox.markRead.useMutation({ onSuccess: () => utils.inbox.threads.invalidate() });
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const actionError = (error: unknown) => setNotice({ ok: false, text: errorMessage(error) });
  const react = trpc.inbox.react.useMutation({ onSuccess: () => utils.inbox.threads.invalidate(), onError: actionError });
  const moderate = trpc.inbox.moderate.useMutation({
    onSuccess: (_, input) => {
      setNotice({ ok: true, text: input.action === "delete" ? "کامنت از اینستاگرام حذف شد" : input.action === "hide" ? "کامنت در اینستاگرام مخفی شد" : "کامنت دوباره نمایش داده می‌شود" });
      utils.inbox.invalidate();
      utils.approvals.list.invalidate();
    },
    onError: actionError,
  });
  // The comment menu closes on any click outside it.
  useEffect(() => {
    if (menuFor === null) return;
    const close = (event: MouseEvent) => {
      if (!(event.target as Element | null)?.closest?.(".bubble-menu")) setMenuFor(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuFor]);
  const moderateComment = (eventId: number, action: "hide" | "unhide" | "delete") => {
    setMenuFor(null);
    if (action === "delete" && !window.confirm("این کامنت از زیر پست در اینستاگرام حذف شود؟ این کار برگشت‌پذیر نیست.")) return;
    moderate.mutate({ eventId, action });
  };
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

  const sendFromApp = async () => {
    if (!selectedThread || !composer.trim()) return;
    setNotice({ ok: true, text: await copyAndOpenDm(selectedThread.handle, composer.trim()) });
  };

  const unread = threads.filter((thread) => thread.unread).length;
  const unanswered = threads.filter(isUnanswered).length;
  const pending = approvals.filter((item) => item.status === "pending").length;
  const failed = approvals.filter((item) => item.status === "failed").length;

  const stats: { id: InboxFilter | "failed"; label: string; value: number; tone: string }[] = [
    { id: "unread", label: "خوانده‌نشده", value: unread, tone: "orange" },
    { id: "unanswered", label: "بی‌پاسخ", value: unanswered, tone: "gold" },
    { id: "priority", label: "در انتظار تأیید", value: pending, tone: "blue" },
    { id: "failed", label: "ارسال ناموفق", value: failed, tone: "red" },
  ];

  return (
    <div className="content-wrap inbox-page">
      <section className="page-bar">
        <div className="page-bar-title">
          <span className={`page-bar-icon ${kind}`}><Icon size={20} /></span>
          <div>
            <h1>{copy.title}</h1>
            <p>{copy.subtitle}</p>
          </div>
        </div>
        <div className="page-bar-actions">
          <button className="secondary-button" disabled={importHistory.isPending} onClick={runImport}><Download size={15} /> {importHistory.isPending ? "در حال دریافت..." : "دریافت پیام‌های قبلی"}</button>
          <button className="primary-button" onClick={onOpenAutomation}><Sparkles size={15} /> صف تأیید{allApprovals.length ? ` (${faNum(allApprovals.length)})` : ""}</button>
        </div>
      </section>
      {historyNotice && <div className={historyNotice.ok ? "settings-success" : "settings-warning"}>{historyNotice.ok ? <Check size={16} /> : <AlertCircle size={16} />}<span>{historyNotice.text}</span></div>}

      <section className="stat-strip">
        {stats.map((s) => (
          <button
            key={s.id}
            className={`stat-chip ${s.tone} ${filter === s.id ? "active" : ""}`}
            onClick={() => (s.id === "failed" ? onOpenAutomation() : setFilter(filter === s.id ? "all" : s.id))}
          >
            <strong>{faNum(s.value)}</strong>
            <span>{s.label}</span>
          </button>
        ))}
        <span className={`auto-chip ${autoReply ? "on" : ""}`}><Bot size={14} /> {autoReply ? "ارسال خودکار روشن" : "ارسال خودکار خاموش؛ همه پاسخ‌ها پس از تأیید"}</span>
      </section>

      <div className="inbox-grid">
        <section className="conversation-list panel">
          <div className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="جست‌وجو در نام، متن یا برچسب..." /></div>
          <div className="list-tabs">
            <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>همه <span>{faNum(threads.length)}</span></button>
            <button className={filter === "unread" ? "active" : ""} onClick={() => setFilter("unread")}>خوانده‌نشده <span>{faNum(unread)}</span></button>
            <button className={filter === "unanswered" ? "active" : ""} onClick={() => setFilter("unanswered")}>بی‌پاسخ <span>{faNum(unanswered)}</span></button>
            <button className={filter === "priority" ? "active" : ""} onClick={() => setFilter("priority")}>منتظر تأیید</button>
          </div>
          <div className="thread-scroll">
            {visibleThreads.map((thread) => (
              <button key={thread.id} className={`thread-row ${thread.id === selectedThread?.id ? "selected" : ""} ${thread.unread ? "unread" : ""}`} onClick={() => openThread(thread)}>
                <div className={`thread-avatar ${thread.tagTone}`}>{thread.avatar}</div>
                <div className="thread-content">
                  <div className="thread-name-line"><b>{thread.name}</b><span>{relativeTime(thread.updatedAt)}</span></div>
                  <p>{thread.message}</p>
                  <div className="thread-footer">
                    <StatusPill tone={thread.tagTone}>{thread.tag}</StatusPill>
                    {thread.priority && <span className="priority-mark">منتظر تأیید</span>}
                    {isUnanswered(thread) && !thread.priority && <span className="unanswered-mark">بی‌پاسخ</span>}
                    {thread.unread && <span className="unread-mark" aria-label="خوانده‌نشده" />}
                  </div>
                </div>
              </button>
            ))}
            {loading && threads.length === 0 && <div className="empty-state"><Clock3 size={24} /><b>در حال بارگذاری...</b></div>}
            {!loading && threads.length === 0 && (
              <div className="empty-state">
                <Inbox size={26} />
                <b>{copy.empty}</b>
                <span>پیام‌های تازه از وب‌هوک Meta می‌آیند. برای موارد قبلی «دریافت پیام‌های قبلی» را بزنید.</span>
                <button className="secondary-button" disabled={importHistory.isPending} onClick={runImport}><Download size={15} /> دریافت پیام‌های قبلی</button>
              </div>
            )}
            {threads.length > 0 && visibleThreads.length === 0 && <div className="empty-state"><Search size={24} /><b>موردی پیدا نشد</b><span>فیلتر یا عبارت جست‌وجو را تغییر دهید.</span></div>}
          </div>
        </section>

        {selectedThread ? (
          <section className="conversation-detail panel">
            <div className="detail-header">
              <div className="detail-person">
                <div className={`detail-avatar ${selectedThread.tagTone}`}>{selectedThread.avatar}</div>
                <div>
                  <h2>{selectedThread.name}</h2>
                  <span dir="ltr">@{selectedThread.handle}</span>
                </div>
              </div>
              <div className="detail-meta">
                <StatusPill tone={selectedThread.tagTone}>{selectedThread.tag}</StatusPill>
                {kind === "dm" && windowEnd && (
                  <span className={`window-chip ${windowClosed ? "closed" : ""}`}>
                    {windowClosed ? <TimerOff size={13} /> : <Clock3 size={13} />}
                    {windowClosed ? "پنجرهٔ پاسخ بسته است" : `پنجرهٔ پاسخ: ${windowLeft} مانده`}
                  </span>
                )}
                {hasUsername(selectedThread.handle) && (
                  <a className="text-button" href={`https://www.instagram.com/${encodeURIComponent(selectedThread.handle)}/`} target="_blank" rel="noreferrer">پروفایل <ArrowUpLeft size={13} /></a>
                )}
              </div>
            </div>

            <div className="message-stream">
              {selectedThread.messages.map((message, i) => {
                const prevPost = selectedThread.messages.slice(0, i).reverse().find((m) => m.from === "contact")?.mediaId;
                const showPost = kind === "comment" && message.from === "contact" && message.mediaId && message.mediaId !== prevPost;
                const eventId = message.eventId;
                const post = message.mediaId ? postById.get(message.mediaId) : undefined;
                return (
                  <div key={message.id}>
                    {showPost && <PostRef post={post} mediaId={message.mediaId!} />}
                    <div className={`bubble-row ${message.from === "agent" ? "agent" : "contact"}`}>
                      <div className="bubble-wrap">
                        <div className="bubble-line">
                          <div className={`message-bubble ${message.from === "agent" ? "agent-bubble" : "contact-bubble"} ${message.status === "failed" ? "failed-bubble" : ""} ${message.deleted ? "deleted-bubble" : ""} ${message.hidden && !message.deleted ? "hidden-bubble" : ""}`}>
                            {message.text}
                            {(message.reaction || message.customerReaction) && <span className="bubble-reaction" title={message.customerReaction ? "ریکشن مشتری" : "ریکشن شما"}>{message.customerReaction ?? "❤️"}</span>}
                          </div>
                          {kind === "dm" && message.from === "contact" && eventId !== undefined && (
                            <button
                              className={`bubble-action ${message.reaction ? "on" : ""}`}
                              aria-label={message.reaction ? "برداشتن قلب" : "قلب گذاشتن"}
                              title={windowClosed ? "مهلت ۲۴ ساعته بسته است؛ از اپ اینستاگرام ریکشن بگذارید" : message.reaction ? "برداشتن قلب" : "قلب گذاشتن روی این پیام"}
                              disabled={windowClosed || react.isPending}
                              onClick={() => react.mutate({ eventId, on: !message.reaction })}
                            >
                              <Heart size={15} fill={message.reaction ? "currentColor" : "none"} />
                            </button>
                          )}
                          {kind === "comment" && message.from === "contact" && eventId !== undefined && !message.deleted && (
                            <div className="bubble-menu">
                              <button className="bubble-action" aria-label="کارهای کامنت" title="مخفی کردن، حذف یا لایک در اینستاگرام" onClick={() => setMenuFor(menuFor === eventId ? null : eventId)}>
                                <MoreHorizontal size={15} />
                              </button>
                              {menuFor === eventId && (
                                <div className="bubble-menu-list" role="menu">
                                  <button role="menuitem" disabled={moderate.isPending} onClick={() => moderateComment(eventId, message.hidden ? "unhide" : "hide")}>
                                    <EyeOff size={14} /> {message.hidden ? "نمایش دوباره در اینستاگرام" : "مخفی کردن در اینستاگرام"}
                                  </button>
                                  {post?.permalink && (
                                    <a role="menuitem" href={post.permalink} target="_blank" rel="noreferrer" onClick={() => setMenuFor(null)}>
                                      <Heart size={14} /> لایک در اینستاگرام (باز کردن پست)
                                    </a>
                                  )}
                                  <button role="menuitem" className="danger" disabled={moderate.isPending} onClick={() => moderateComment(eventId, "delete")}>
                                    <Trash2 size={14} /> حذف از اینستاگرام
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        <span className="message-time">
                          {message.from === "agent" ? (message.via === "dm" ? "دایرکت سپند" : kind === "comment" ? "پاسخ زیر کامنت" : "سپند") : selectedThread.name} · {clock(message.at)}
                          {message.deleted && " · حذف شد"}
                          {message.hidden && !message.deleted && " · مخفی در اینستاگرام"}
                          {message.customerReaction && ` · مشتری ${message.customerReaction} گذاشت`}
                          {message.status === "pending" && " · منتظر تأیید"}
                          {message.status === "sending" && " · در حال ارسال"}
                          {message.status === "failed" && <b className="error-text"> · ارسال نشد{message.error ? `: ${message.error}` : ""}</b>}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
              {pendingDraft && <div className="ai-note"><Sparkles size={15} /><span>پیش‌نویس قانون «{pendingDraft.reason}» در صف تأیید است؛ می‌توانید آن را در کادر پاسخ بارگذاری و ویرایش کنید.</span></div>}
            </div>

            <div className="composer-area">
              <div className="composer-toolbar">
                <span className="composer-label"><Reply size={15} /> {copy.replyLabel}</span>
                {pendingDraft && <button className="suggest-button" onClick={() => setComposer(pendingDraft.draft)}><Sparkles size={14} /> بارگذاری پیش‌نویس</button>}
              </div>
              {windowClosed && (
                <div className="settings-warning compact"><TimerOff size={15} /><span>مشتری بیش از ۲۴ ساعت است پیام نداده و اینستاگرام اجازهٔ جواب از اینجا را نمی‌دهد. متن را بنویسید و «کپی و باز کردن در اینستاگرام» را بزنید تا از خود اپ بفرستید.</span></div>
              )}
              <MultiMessageEditor
                value={composer}
                onChange={setComposer}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    if (!windowClosed) sendReply();
                  }
                }}
                placeholder="پاسخ خود را بنویسید..."
              />
              <div className="composer-bottom">
                <span className="composer-hint">Enter ارسال · Shift+Enter خط جدید</span>
                {windowClosed ? (
                  <button className="send-button" onClick={sendFromApp} disabled={!composer.trim()}><Copy size={15} /> کپی و باز کردن در اینستاگرام</button>
                ) : (
                  <button className="send-button" onClick={sendReply} disabled={!composer.trim() || reply.isPending}><Send size={15} /> {reply.isPending ? "در حال ارسال..." : "ارسال پاسخ"}</button>
                )}
              </div>
              {notice && <div className={`sent-notice ${notice.ok ? "" : "error-notice"}`}>{notice.ok ? <Check size={14} /> : <AlertCircle size={14} />} {notice.text}</div>}
            </div>
          </section>
        ) : (
          <section className="conversation-detail panel"><div className="empty-state"><Icon size={26} /><b>گفتگویی انتخاب نشده</b><span>از فهرست کنار یک گفتگو را باز کنید.</span></div></section>
        )}
      </div>
    </div>
  );
}
