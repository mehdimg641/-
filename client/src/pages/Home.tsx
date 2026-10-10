import { useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  AtSign,
  ArrowUpLeft,
  BarChart3,
  Bell,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Clock3,
  FileText,
  Filter,
  Globe2,
  HelpCircle,
  Inbox,
  Instagram,
  Library,
  MessageCircle,
  MessageSquareText,
  MoreHorizontal,
  PanelRight,
  Plus,
  Reply,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tag,
  UserRound,
  Users,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { filterInboxThreads, type InboxChannel, type InboxThread } from "@shared/inbox";

type Tab = "inbox" | "automation" | "templates" | "analytics" | "settings";
type Channel = InboxChannel;
type Thread = InboxThread;

const initialThreads: Thread[] = [
  {
    id: 1,
    name: "حسین رضایی",
    handle: "hossein.rz",
    channel: "DM",
    message: "برای شمش ۱۲۵، آنالیز و قیمت روز رو می‌فرمایید؟",
    time: "۱۰ دقیقه پیش",
    tag: "قیمت‌گیری",
    tagTone: "gold",
    unread: true,
    priority: true,
    avatar: "ح",
    messages: [
      { from: "contact", text: "سلام وقت بخیر. برای شمش ۱۲۵، آنالیز و قیمت روز رو می‌فرمایید؟", time: "۱۰:۳۴" },
    ],
  },
  {
    id: 2,
    name: "میلاد نادری",
    handle: "milad.n",
    channel: "DM",
    message: "سلام، ارسال به اصفهان دارید؟",
    time: "۲۵ دقیقه پیش",
    tag: "ارسال",
    tagTone: "blue",
    unread: true,
    avatar: "م",
    messages: [
      { from: "contact", text: "سلام، ارسال به اصفهان دارید؟ زمان تحویل معمولاً چقدره؟", time: "۱۰:۱۹" },
    ],
  },
  {
    id: 3,
    name: "شرکت فولاد آریا",
    handle: "aria.steel",
    channel: "DM",
    message: "3SP موجود دارید؟ ماهانه حدود ۵۰۰ تن نیاز داریم.",
    time: "۱ ساعت پیش",
    tag: "تأمین عمده",
    tagTone: "violet",
    unread: true,
    priority: true,
    avatar: "ف",
    messages: [
      { from: "contact", text: "سلام. 3SP موجود دارید؟ ماهانه حدود ۵۰۰ تن نیاز داریم.", time: "۰۹:۴۵" },
      { from: "agent", text: "درود، درخواست شما ثبت شد و همکار فروش برای اعلام ظرفیت و شرایط تماس می‌گیرد.", time: "۰۹:۵۰" },
    ],
  },
  {
    id: 4,
    name: "نیما احمدی",
    handle: "nima.a",
    channel: "کامنت",
    message: "قراضه آهن هم از کارگاه خرید دارید؟",
    time: "۲ ساعت پیش",
    tag: "قراضه",
    tagTone: "green",
    unread: true,
    avatar: "ن",
    messages: [
      { from: "contact", text: "قراضه آهن هم از کارگاه خرید دارید؟", time: "۰۸:۵۵" },
    ],
  },
  {
    id: 5,
    name: "مهدی حسینی",
    handle: "mehdi.h",
    channel: "کامنت",
    message: "آنالیز 5SP رو از کجا می‌تونم دریافت کنم؟",
    time: "دیروز",
    tag: "آنالیز",
    tagTone: "orange",
    unread: false,
    avatar: "م",
    messages: [
      { from: "contact", text: "آنالیز 5SP رو از کجا می‌تونم دریافت کنم؟", time: "دیروز" },
      { from: "agent", text: "سلام، در دایرکت پیام دادیم تا فایل آنالیز را برایتان ارسال کنیم.", time: "دیروز" },
    ],
  },
  {
    id: 6,
    name: "سارا توکلی",
    handle: "sara.t",
    channel: "DM",
    message: "برای استعلام قیمت باید چه اطلاعاتی بفرستم؟",
    time: "۲ روز پیش",
    tag: "راهنمایی",
    tagTone: "slate",
    unread: false,
    avatar: "س",
    messages: [
      { from: "contact", text: "برای استعلام قیمت باید چه اطلاعاتی بفرستم؟", time: "شنبه" },
      { from: "agent", text: "سلام، لطفاً نوع شمش، سایز، تناژ ماهانه و شهر مقصد را بفرستید.", time: "شنبه" },
    ],
  },
];

const commentsSummary = [
  { label: "پاسخ‌داده‌نشده", value: "۴", color: "orange", note: "از کامنت‌های اخیر" },
  { label: "در انتظار قیمت", value: "۱۲", color: "gold", note: "سرنخ‌های گرم" },
  { label: "نیازمند پیگیری", value: "۷", color: "violet", note: "بدون پاسخ کامل" },
];

const navItems: { id: Tab; label: string; icon: typeof Inbox; badge?: string }[] = [
  { id: "inbox", label: "صندوق ورودی", icon: Inbox, badge: "۲۱" },
  { id: "automation", label: "اتوماسیون", icon: Workflow },
  { id: "templates", label: "قالب پاسخ‌ها", icon: Library },
  { id: "analytics", label: "تحلیل عملکرد", icon: BarChart3 },
  { id: "settings", label: "تنظیمات", icon: Settings2 },
];

function StatusPill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

function IconButton({ label, children, onClick }: { label: string; children: React.ReactNode; onClick?: () => void }) {
  return (
    <button className="icon-button" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("inbox");
  const [threads, setThreads] = useState(initialThreads);
  const [selectedId, setSelectedId] = useState(1);
  const [filter, setFilter] = useState<"all" | "unread" | "priority">("all");
  const [channelFilter, setChannelFilter] = useState<"all" | Channel>("all");
  const [search, setSearch] = useState("");
  const [composer, setComposer] = useState("");
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [smartDrafts, setSmartDrafts] = useState(true);
  const [sentNotice, setSentNotice] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const selectedThread = threads.find((thread) => thread.id === selectedId) ?? threads[0];
  const visibleThreads = useMemo(() => filterInboxThreads(threads, search, filter, channelFilter), [threads, search, filter, channelFilter]);

  const openThread = (id: number) => {
    setSelectedId(id);
    setThreads((current) => current.map((thread) => (thread.id === id ? { ...thread, unread: false } : thread)));
    setSentNotice("");
  };

  const sendReply = () => {
    const trimmed = composer.trim();
    if (!trimmed) return;
    setThreads((current) => current.map((thread) => thread.id === selectedThread.id ? {
      ...thread,
      unread: false,
      messages: [...thread.messages, { from: "agent", text: trimmed, time: "اکنون" }],
    } : thread));
    setComposer("");
    setSentNotice("پاسخ در پیش‌نویس مکالمه ثبت شد");
    window.setTimeout(() => setSentNotice(""), 2600);
  };

  const suggestReply = () => {
    setComposer(selectedThread.tag === "قیمت‌گیری"
      ? "سلام، وقت بخیر. برای اعلام قیمت دقیق لطفاً سایز شمش، تناژ و شهر مقصد را بفرمایید تا همکار فروش راهنمایی کند."
      : selectedThread.tag === "ارسال"
        ? "سلام، بله ارسال به اصفهان انجام می‌شود. لطفاً تناژ و زمان موردنظر را بفرمایید تا زمان تحویل دقیق اعلام شود."
        : "سلام، درخواست شما ثبت شد. لطفاً مشخصات کامل را بفرمایید تا همکار فروش دقیق‌تر راهنمایی کند.");
  };

  return (
    <div className="app-shell" dir="rtl">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><span>س</span></div>
          <div>
            <strong>سپند</strong>
            <span>INBOX STUDIO</span>
          </div>
        </div>
        <div className="account-card">
          <div className="account-avatar"><Instagram size={18} /></div>
          <div className="account-meta">
            <b>@sepandsteel</b>
            <span>Sepand Steel · متصل</span>
          </div>
          <span className="online-dot" />
        </div>
        <div className="workspace-label">میز کار</div>
        <nav className="side-nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={`nav-item ${tab === item.id ? "active" : ""}`} onClick={() => setTab(item.id)}>
                <Icon size={18} strokeWidth={1.9} />
                <span>{item.label}</span>
                {item.badge && <small>{item.badge}</small>}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="sync-card">
            <div className="sync-icon"><ShieldCheck size={17} /></div>
            <div><b>اتصال امن است</b><span>همگام‌سازی ۸ دقیقه پیش</span></div>
          </div>
          <button className="help-link"><HelpCircle size={17} /> راهنمای استفاده</button>
          <div className="operator">
            <div className="operator-avatar">م</div>
            <div><b>مدیر سپند</b><span>دسترسی کامل</span></div>
            <MoreHorizontal size={18} className="muted-icon" />
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>سپند</span><ChevronLeft size={15} /><b>{navItems.find((item) => item.id === tab)?.label}</b></div>
          <div className="top-actions">
            <div className="connection-status"><span className="pulse" /> اتصال Instagram فعال</div>
            <IconButton label="اعلان‌ها"><Bell size={18} /></IconButton>
            <div className="top-avatar">م</div>
          </div>
        </header>

        {tab === "inbox" && (
          <div className="content-wrap inbox-page">
            <section className="page-heading">
              <div>
                <div className="eyebrow"><span className="eyebrow-line" /> OPERATIONS / SOCIAL</div>
                <h1>صندوق ورودی سپند</h1>
                <p>تمام گفتگوهای مهم اینستاگرام، در یک نمای عملیاتی برای تیم فروش.</p>
              </div>
              <div className="heading-actions">
                <button className="secondary-button" onClick={() => setShowFilters((value) => !value)}><SlidersHorizontal size={16} /> فیلترها</button>
                <button className="primary-button" onClick={() => setTab("automation")}><Sparkles size={16} /> ساخت پاسخ هوشمند</button>
              </div>
            </section>

            <section className="metric-grid">
              <div className="metric-card accent-gold"><div className="metric-icon"><Inbox size={18} /></div><span>کل گفتگوهای باز</span><strong>۲۱</strong><em><ArrowUpLeft size={14} /> ۱۸٪ این هفته</em></div>
              <div className="metric-card accent-orange"><div className="metric-icon"><Clock3 size={18} /></div><span>بی‌پاسخ مانده</span><strong>۸</strong><em className="warning-text"><AlertCircle size={14} /> نیاز به اقدام</em></div>
              <div className="metric-card accent-blue"><div className="metric-icon"><Zap size={18} /></div><span>پاسخ خودکار</span><strong>۰٪</strong><em className="muted-text">در حالت پیش‌نمایش</em></div>
              <div className="metric-card accent-green"><div className="metric-icon"><Users size={18} /></div><span>سرنخ‌های گرم</span><strong>۱۲</strong><em><ArrowUpLeft size={14} /> ۳ سرنخ جدید</em></div>
            </section>

            {showFilters && <div className="filter-drawer"><div className="filter-title"><b>فیلتر مکالمات</b><IconButton label="بستن فیلترها" onClick={() => setShowFilters(false)}><X size={16} /></IconButton></div><div className="filter-options"><button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>همه</button><button className={filter === "unread" ? "selected" : ""} onClick={() => setFilter("unread")}>خوانده‌نشده</button><button className={filter === "priority" ? "selected" : ""} onClick={() => setFilter("priority")}>اولویت‌دار</button><button className={channelFilter === "DM" ? "selected" : ""} onClick={() => setChannelFilter(channelFilter === "DM" ? "all" : "DM")}>دایرکت</button><button className={channelFilter === "کامنت" ? "selected" : ""} onClick={() => setChannelFilter(channelFilter === "کامنت" ? "all" : "کامنت")}>کامنت</button></div></div>}

            <div className="inbox-layout">
              <section className="conversation-list panel">
                <div className="list-header"><div><b>مکالمات اخیر</b><span>{visibleThreads.length} مورد نمایش داده می‌شود</span></div><IconButton label="تنظیمات لیست"><MoreHorizontal size={18} /></IconButton></div>
                <div className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="جست‌وجو در نام، متن یا برچسب..." /><kbd>⌘ K</kbd></div>
                <div className="list-tabs"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>همه <span>۲۱</span></button><button className={filter === "unread" ? "active" : ""} onClick={() => setFilter("unread")}>بی‌پاسخ <span>۸</span></button><button className={filter === "priority" ? "active" : ""} onClick={() => setFilter("priority")}>اولویت‌دار</button></div>
                <div className="thread-scroll">
                  {visibleThreads.map((thread) => <button key={thread.id} className={`thread-row ${thread.id === selectedThread.id ? "selected" : ""}`} onClick={() => openThread(thread.id)}><div className={`thread-avatar ${thread.tagTone}`}>{thread.avatar}<span className={`channel-mini ${thread.channel === "DM" ? "dm" : "comment"}`}>{thread.channel === "DM" ? <MessageCircle size={10} /> : <MessageSquareText size={10} />}</span></div><div className="thread-content"><div className="thread-name-line"><b>{thread.name}</b><span>{thread.time}</span></div><div className="thread-handle">@{thread.handle}</div><p>{thread.message}</p><div className="thread-footer"><StatusPill tone={thread.tagTone}>{thread.tag}</StatusPill>{thread.unread && <span className="unread-mark" />} {thread.priority && <span className="priority-mark">اولویت</span>}</div></div></button>)}
                  {visibleThreads.length === 0 && <div className="empty-state"><Search size={24} /><b>موردی پیدا نشد</b><span>فیلتر یا عبارت جست‌وجو را تغییر دهید.</span></div>}
                </div>
              </section>

              <section className="conversation-detail panel">
                <div className="detail-header"><div className="detail-person"><div className={`detail-avatar ${selectedThread.tagTone}`}>{selectedThread.avatar}</div><div><h2>{selectedThread.name}</h2><span>@{selectedThread.handle} · {selectedThread.channel}</span></div><StatusPill tone="green">سرنخ گرم</StatusPill></div><div className="detail-actions"><IconButton label="افزودن برچسب"><Tag size={17} /></IconButton><IconButton label="بستن مکالمه"><CheckCircle2 size={17} /></IconButton><IconButton label="بیشتر"><MoreHorizontal size={17} /></IconButton></div></div>
                <div className="context-strip"><div><AtSign size={15} /><span>از طریق {selectedThread.channel === "DM" ? "دایرکت" : "کامنت پست"}</span></div><div><Clock3 size={15} /><span>پاسخ پیشنهادی در کمتر از ۲ دقیقه</span></div><StatusPill tone={selectedThread.tagTone}>{selectedThread.tag}</StatusPill></div>
                <div className="message-stream">
                  <div className="day-divider"><span>امروز</span></div>
                  {selectedThread.messages.map((message, index) => <div key={`${message.time}-${index}`} className={`bubble-row ${message.from === "agent" ? "agent" : "contact"}`}><div className={`bubble-avatar ${message.from === "agent" ? "agent-avatar" : "contact-avatar"}`}>{message.from === "agent" ? "س" : selectedThread.avatar}</div><div className="bubble-wrap"><div className={`message-bubble ${message.from === "agent" ? "agent-bubble" : "contact-bubble"}`}>{message.text}</div><span className="message-time">{message.from === "agent" ? "پاسخ سپند" : selectedThread.name} · {message.time}</span></div></div>)}
                  <div className="ai-note"><Sparkles size={15} /><span>این گفتگو با برچسب «{selectedThread.tag}» شناسایی شده و آماده پاسخ‌گویی است.</span></div>
                </div>
                <div className="composer-area"><div className="composer-toolbar"><span className="composer-label"><Reply size={15} /> پاسخ به {selectedThread.channel === "DM" ? "دایرکت" : "کامنت"}</span><button className="suggest-button" onClick={suggestReply}><Sparkles size={14} /> پیشنهاد پاسخ هوشمند</button></div><textarea value={composer} onChange={(event) => setComposer(event.target.value)} placeholder="پاسخ خود را بنویسید..." /><div className="composer-bottom"><span className="composer-hint">Enter برای ارسال · Shift + Enter برای خط جدید</span><button className="send-button" onClick={sendReply} disabled={!composer.trim()}><Send size={15} /> ارسال پاسخ</button></div>{sentNotice && <div className="sent-notice"><Check size={14} /> {sentNotice}</div>}</div>
              </section>

              <aside className="right-rail">
                <div className="rail-card profile-card"><div className="rail-card-header"><span>پروفایل مخاطب</span><MoreHorizontal size={17} /></div><div className="profile-main"><div className={`profile-avatar ${selectedThread.tagTone}`}>{selectedThread.avatar}</div><div><b>{selectedThread.name}</b><span>@{selectedThread.handle}</span></div></div><div className="profile-stats"><div><b>۳</b><span>تعامل</span></div><div><b>۲</b><span>خرید قبلی</span></div><div><b>۱</b><span>ماه</span></div></div><button className="profile-link">مشاهده پروفایل اینستاگرام <ArrowUpLeft size={14} /></button></div>
                <div className="rail-card"><div className="rail-card-header"><span>برچسب‌ها</span><button className="text-button"><Plus size={14} /> افزودن</button></div><div className="tag-cloud"><StatusPill tone={selectedThread.tagTone}>{selectedThread.tag}</StatusPill><StatusPill tone="slate">سرنخ جدید</StatusPill><StatusPill tone="blue">B2B</StatusPill></div></div>
                <div className="rail-card automation-mini"><div className="rail-card-header"><span>وضعیت اتوماسیون</span><Bot size={17} /></div><div className="automation-state"><div className={`switch ${autoReplyEnabled ? "on" : ""}`} onClick={() => setAutoReplyEnabled(!autoReplyEnabled)}><span /></div><div><b>{autoReplyEnabled ? "پاسخ خودکار روشن" : "پاسخ خودکار خاموش"}</b><span>{autoReplyEnabled ? "در حالت تست و تأیید" : "پیش از اتصال API"}</span></div></div><div className="automation-note"><ShieldCheck size={14} /> پاسخ‌های حساس ابتدا برای تأیید شما می‌آیند.</div></div>
              </aside>
            </div>
          </div>
        )}

        {tab === "automation" && <AutomationView enabled={autoReplyEnabled} setEnabled={setAutoReplyEnabled} smartDrafts={smartDrafts} setSmartDrafts={setSmartDrafts} onBack={() => setTab("inbox")} />}
        {tab === "templates" && <TemplatesView onUse={(text) => { setTab("inbox"); setComposer(text); }} />}
        {tab === "analytics" && <AnalyticsView />}
        {tab === "settings" && <SettingsView enabled={autoReplyEnabled} setEnabled={setAutoReplyEnabled} />}
      </main>
    </div>
  );
}

function AutomationView({ enabled, setEnabled, smartDrafts, setSmartDrafts, onBack }: { enabled: boolean; setEnabled: (value: boolean) => void; smartDrafts: boolean; setSmartDrafts: (value: boolean) => void; onBack: () => void }) {
  const [ruleSaved, setRuleSaved] = useState(false);
  return <div className="content-wrap subpage"><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> AUTOMATION / CONTROL</div><h1>اتوماسیون پاسخ‌گویی</h1><p>قواعد روشن و قابل کنترل برای پاسخ سریع‌تر، بدون از دست دادن لحن سپند.</p></div><button className="secondary-button" onClick={onBack}><ChevronLeft size={16} /> بازگشت به Inbox</button></section><div className="automation-hero"><div className="hero-orbit"><div className="orbit-core"><Bot size={31} /></div><span className="orbit-dot one" /><span className="orbit-dot two" /><span className="orbit-dot three" /></div><div><span className="mini-kicker">CONTROLLED AUTOMATION</span><h2>پاسخ‌گویی هوشمند، با تأیید شما</h2><p>بعد از اتصال Meta API، قواعد فعال می‌توانند کامنت و دایرکت‌های کم‌ریسک را پاسخ دهند و موارد قیمت/قرارداد را برای تأیید نگه دارند.</p><div className="hero-actions"><button className={`primary-button ${enabled ? "active-button" : ""}`} onClick={() => setEnabled(!enabled)}>{enabled ? <CheckCircle2 size={16} /> : <Zap size={16} />} {enabled ? "اتوماسیون فعال است" : "فعال‌سازی حالت تست"}</button><button className="ghost-button"><FileText size={16} /> مشاهده لاگ پاسخ‌ها</button></div></div></div><div className="section-title-row"><div><h2>قواعد فعال</h2><span>برای دایرکت و کامنت، به تفکیک هر پیج قابل تنظیم است</span></div><button className="secondary-button"><Plus size={16} /> قانون جدید</button></div><div className="rule-grid"><RuleCard icon={<Tag size={18} />} tone="gold" title="درخواست قیمت" trigger="کامنت یا پیام شامل «قیمت»، «نرخ» یا «استعلام» باشد" action="صدا زدن نام مخاطب + ارسال قالب قیمت و درخواست مشخصات" enabled={enabled} /><RuleCard icon={<MessageCircle size={18} />} tone="blue" title="کامنت → دایرکت" trigger="کامنت شامل سؤال محصول یا کلمه «آنالیز» باشد" action="پاسخ کوتاه زیر کامنت + دعوت به دایرکت با قالب اختصاصی" enabled={enabled} /><RuleCard icon={<ShieldCheck size={18} />} tone="green" title="سوالات عمومی" trigger="سوالات پرتکرار درباره سایز و آنالیز" action="ارسال پاسخ تأییدشده از کتابخانه" enabled={smartDrafts} /></div><div className="builder-grid"><CommentRuleBuilder onSaved={() => setRuleSaved(true)} /><ApprovalQueue /></div>{ruleSaved && <div className="saved-banner"><Check size={14} /> قانون جدید در پیش‌نمایش ذخیره شد و برای هر پیج قابل اختصاص است.</div>}<div className="safety-panel"><div className="safety-icon"><ShieldCheck size={19} /></div><div><b>گاردریل‌های پاسخ سپند</b><p>هیچ قیمت، تخفیف، زمان تحویل یا تعهد تجاری بدون تأیید اپراتور ارسال نمی‌شود.</p></div><button className={`switch ${smartDrafts ? "on" : ""}`} onClick={() => setSmartDrafts(!smartDrafts)}><span /></button></div></div>;
}

function CommentRuleBuilder({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState("پاسخ کامنت استعلام قیمت");
  const [keyword, setKeyword] = useState("قیمت، نرخ، استعلام");
  const [reply, setReply] = useState("سلام {{username}}، برای اعلام قیمت دقیق لطفاً سایز، تناژ و شهر مقصد را دایرکت کنید.");
  return <div className="builder-card"><div className="builder-header"><div><b>ساخت قانون جدید</b><span>برای پاسخ به کامنت و انتقال به دایرکت</span></div><Workflow size={18} /></div><div className="builder-fields"><label>نام قانون<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>کلمات محرک<input value={keyword} onChange={(event) => setKeyword(event.target.value)} /></label><label>پیج‌های هدف<select defaultValue="all"><option value="all">همه پیج‌های متصل</option><option value="sepandsteel">@sepandsteel</option><option value="sepand.trade">@sepand.trade</option></select></label><label>اقدام پس از پاسخ<select defaultValue="dm"><option value="dm">ارسال دایرکت اختصاصی</option><option value="comment">فقط پاسخ زیر کامنت</option><option value="approval">ارسال برای تأیید اپراتور</option></select></label></div><label>متن پاسخ <span className="field-tip">{"{{username}}"} = نام اکانت · {"{{profile_signal}}"} = ویژگی تشخیص‌داده‌شده</span><textarea value={reply} onChange={(event) => setReply(event.target.value)} /></label><div className="builder-preview"><Sparkles size={14} /><span>پیش‌نمایش: سلام <b>hossein.rz</b>، برای اعلام قیمت دقیق لطفاً سایز، تناژ و شهر مقصد را دایرکت کنید.</span></div><button className="primary-button" onClick={onSaved}><Check size={15} /> ذخیره قانون «{name || "بدون نام"}»</button></div>;
}

function ApprovalQueue() {
  const [items, setItems] = useState([
    { id: 1, name: "حسین رضایی", handle: "hossein.rz", text: "برای شمش ۱۲۵ قیمت روز رو می‌فرمایید؟", reason: "قیمت حساس", tone: "gold" },
    { id: 2, name: "شرکت فولاد آریا", handle: "aria.steel", text: "ماهانه ۵۰۰ تن نیاز داریم.", reason: "سرنخ عمده", tone: "violet" },
  ]);
  const approve = (id: number) => setItems((current) => current.filter((item) => item.id !== id));
  return <div className="approval-card"><div className="builder-header"><div><b>صف تأیید اپراتور</b><span>پاسخ‌های حساس قبل از ارسال اینجا می‌آیند</span></div><StatusPill tone={items.length ? "orange" : "green"}>{items.length ? `${items.length} در انتظار` : "پاک است"}</StatusPill></div>{items.length ? items.map((item) => <div className="approval-item" key={item.id}><div className={`approval-avatar ${item.tone}`}>{item.name[0]}</div><div className="approval-copy"><b>{item.name} <small>@{item.handle}</small></b><p>{item.text}</p><StatusPill tone={item.tone}>{item.reason}</StatusPill></div><div className="approval-actions"><button className="approve-button" onClick={() => approve(item.id)}><Check size={14} /> تأیید</button><button className="reject-button" onClick={() => approve(item.id)}><X size={14} /></button></div></div>) : <div className="approval-empty"><CheckCircle2 size={22} /><b>موردی برای بررسی نیست</b><span>پاسخ‌های کم‌ریسک طبق قوانین ارسال می‌شوند.</span></div>}<div className="approval-footer"><ShieldCheck size={14} /> قیمت و تعهد تجاری همیشه نیازمند تأیید است.</div></div>;
}

function RuleCard({ icon, tone, title, trigger, action, enabled }: { icon: React.ReactNode; tone: string; title: string; trigger: string; action: string; enabled: boolean }) {
  return <div className="rule-card"><div className="rule-top"><div className={`rule-icon ${tone}`}>{icon}</div><div className="rule-title"><b>{title}</b><span>{enabled ? "فعال" : "در انتظار اتصال"}</span></div><div className={`switch small ${enabled ? "on" : ""}`}><span /></div></div><div className="rule-line"><span>اگر</span><p>{trigger}</p></div><div className="rule-line"><span>آنگاه</span><p>{action}</p></div><div className="rule-footer"><span><Activity size={13} /> پیش‌نمایش ایمن</span><MoreHorizontal size={16} /></div></div>;
}

function TemplatesView({ onUse }: { onUse: (text: string) => void }) {
  const templates = [{ title: "استعلام قیمت اولیه", category: "قیمت‌گیری", tone: "gold", text: "سلام، وقت بخیر. برای اعلام قیمت دقیق لطفاً نوع شمش، سایز، تناژ و شهر مقصد را بفرمایید تا همکار فروش راهنمایی کند." }, { title: "آنالیز و کیفیت", category: "آنالیز", tone: "blue", text: "سلام، مشخصات فنی و آنالیز محصول موردنظر شما را بررسی می‌کنیم. لطفاً سایز و گرید موردنظر را بفرمایید." }, { title: "ارسال به شهر مقصد", category: "ارسال", tone: "green", text: "سلام، ارسال به شهر شما قابل بررسی است. لطفاً تناژ و زمان موردنظر را بفرمایید تا زمان تحویل و هزینه حمل اعلام شود." }, { title: "دریافت قراضه", category: "قراضه", tone: "violet", text: "سلام، برای بررسی خرید قراضه لطفاً نوع بار، وزن تقریبی، محل بارگیری و تصاویر را ارسال کنید." }];
  return <div className="content-wrap subpage"><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> LIBRARY / APPROVED REPLIES</div><h1>کتابخانه پاسخ‌ها</h1><p>قالب‌های تأییدشده برای اینکه تیم با یک لحن واحد پاسخ دهد.</p></div><button className="primary-button"><Plus size={16} /> قالب جدید</button></section><div className="template-toolbar"><div className="search-box compact"><Search size={17} /><input placeholder="جست‌وجو در قالب‌ها..." /></div><div className="template-filters"><button className="selected">همه</button><button>فروش</button><button>پشتیبانی</button><button>قراضه</button></div></div><div className="template-grid">{templates.map((template) => <div className="template-card" key={template.title}><div className="template-card-top"><StatusPill tone={template.tone}>{template.category}</StatusPill><MoreHorizontal size={17} /></div><h3>{template.title}</h3><p>{template.text}</p><div className="template-card-bottom"><span><CheckCircle2 size={14} /> تأییدشده</span><button className="text-button" onClick={() => onUse(template.text)}>استفاده در پاسخ <ArrowUpLeft size={14} /></button></div></div>)}</div></div>;
}

function AnalyticsView() {
  return <div className="content-wrap subpage"><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> ANALYTICS / SIGNALS</div><h1>تحلیل عملکرد</h1><p>تصویری سریع از فشار Inbox، سرعت پاسخ و فرصت‌های فروش.</p></div><button className="secondary-button"><Clock3 size={16} /> ۷ روز اخیر <ChevronDown size={15} /></button></section><div className="analytics-grid"><div className="big-chart panel"><div className="chart-heading"><div><b>ورودی گفتگوها</b><span>ترکیب کامنت و دایرکت</span></div><StatusPill tone="gold">+۱۸٪</StatusPill></div><div className="chart-area"><div className="y-labels"><span>۴۰</span><span>۳۰</span><span>۲۰</span><span>۱۰</span><span>۰</span></div><div className="chart"><div className="grid-line one" /><div className="grid-line two" /><div className="grid-line three" /><div className="grid-line four" /><svg viewBox="0 0 600 220" preserveAspectRatio="none"><defs><linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#e5b960" stopOpacity=".32" /><stop offset="100%" stopColor="#e5b960" stopOpacity="0" /></linearGradient></defs><path d="M0,178 C55,168 70,150 120,158 C170,166 190,122 245,132 C300,144 314,80 365,101 C420,123 447,72 490,82 C530,92 555,46 600,55 L600,220 L0,220 Z" fill="url(#chartFill)" /><path d="M0,178 C55,168 70,150 120,158 C170,166 190,122 245,132 C300,144 314,80 365,101 C420,123 447,72 490,82 C530,92 555,46 600,55" fill="none" stroke="#e5b960" strokeWidth="3" strokeLinecap="round" /></svg><div className="x-labels"><span>شنبه</span><span>یکشنبه</span><span>دوشنبه</span><span>سه‌شنبه</span><span>چهارشنبه</span><span>پنجشنبه</span><span>جمعه</span></div></div></div></div><div className="response-card panel"><div className="chart-heading"><div><b>سرعت پاسخ‌گویی</b><span>میانگین تیم</span></div><Clock3 size={18} className="muted-icon" /></div><div className="response-number">۱ ساعت <small>و ۲۴ دقیقه</small></div><div className="progress-track"><span style={{ width: "72%" }} /></div><div className="response-foot"><span>هدف: زیر ۲ ساعت</span><b>عالی</b></div><div className="mini-stat-row"><div><span>کامنت</span><b>۳۸٪</b></div><div><span>دایرکت</span><b>۶۲٪</b></div></div></div></div><div className="insight-grid"><div className="insight-card"><div className="insight-icon gold"><Sparkles size={17} /></div><div><b>فرصت این هفته</b><p>۱۲ گفت‌وگو درباره قیمت و تناژ؛ بهترین نقطه برای فعال‌سازی پاسخ پیشنهادی.</p></div><ArrowUpLeft size={17} /></div><div className="insight-card"><div className="insight-icon blue"><MessageSquareText size={17} /></div><div><b>پست برتر</b><p>پست «آهن قراضه» بیشترین کامنت را گرفته؛ برای پاسخ خودکار اولویت دارد.</p></div><ArrowUpLeft size={17} /></div></div></div>;
}

function SettingsView({ enabled, setEnabled }: { enabled: boolean; setEnabled: (value: boolean) => void }) {
  const [personalize, setPersonalize] = useState(true);
  const [detectProfile, setDetectProfile] = useState(true);
  const [commentReplies, setCommentReplies] = useState(true);
  const [accounts, setAccounts] = useState([
    { handle: "@sepandsteel", name: "Sepand Steel", followers: "۶٬۰۵۶", status: "فعال", tone: "gold" },
    { handle: "@sepand.trade", name: "Sepand Trade", followers: "—", status: "آماده اتصال", tone: "blue" },
  ]);

  const addAccount = () => setAccounts((current) => [...current, { handle: `@page-${current.length + 1}`, name: "پیج جدید", followers: "—", status: "آماده اتصال", tone: "violet" }]);

  return <div className="content-wrap subpage"><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> SETTINGS / WORKSPACE</div><h1>تنظیمات سپند</h1><p>اتصال‌ها، لحن برند، شخصی‌سازی و سطح دسترسی پاسخ‌گویی را مدیریت کنید.</p></div><button className="primary-button"><Check size={16} /> ذخیره تغییرات</button></section><div className="settings-grid"><div className="settings-column"><div className="settings-card account-manager-card"><div className="settings-card-head"><div className="settings-symbol instagram"><Instagram size={20} /></div><div><h3>مدیریت پیج‌ها</h3><span>اتصال هر تعداد پیج، با تنظیمات مستقل</span></div><StatusPill tone="green">بدون سقف</StatusPill></div><div className="account-list">{accounts.map((account, index) => <div className="connected-account" key={`${account.handle}-${index}`}><div className={`account-avatar large account-tone-${account.tone}`}><Instagram size={20} /></div><div><b>{account.handle}</b><span>{account.name} · {account.followers === "—" ? "آمار پس از اتصال" : `${account.followers} دنبال‌کننده`}</span></div><StatusPill tone={account.status === "فعال" ? "green" : "slate"}>{account.status}</StatusPill><button className="secondary-button compact-button">تنظیمات</button></div>)}</div><button className="add-account-button" onClick={addAccount}><Plus size={16} /> افزودن پیج جدید <span>تعداد اتصال محدود نیست</span></button><div className="settings-warning"><AlertCircle size={16} /><span>برای پاسخ خودکار واقعی، دسترسی پیام‌رسانی و کامنت Meta API برای هر پیج باید جداگانه تکمیل شود. این نسخه در حالت پیش‌نمایش است.</span></div></div><div className="settings-card"><div className="settings-card-head"><div className="settings-symbol gold"><Sparkles size={19} /></div><div><h3>شخصی‌سازی پاسخ</h3><span>پاسخ‌ها بر اساس مخاطب، نه فقط متن خام</span></div></div><div className="setting-row"><div><b>صدا زدن مخاطب با نام اکانت</b><span>مثلاً «سلام حسین، ...» بر اساس username عمومی</span></div><div className={`switch ${personalize ? "on" : ""}`} onClick={() => setPersonalize(!personalize)}><span /></div></div><div className="setting-row"><div><b>تشخیص ویژگی پروفایل</b><span>مثل فروشنده، کارخانه‌دار یا خریدار عمده</span></div><div className={`switch ${detectProfile ? "on" : ""}`} onClick={() => setDetectProfile(!detectProfile)}><span /></div></div><div className="setting-row"><div><b>پاسخ اختصاصی به کامنت</b><span>قالب جدا برای هر نوع کامنت و پست</span></div><div className={`switch ${commentReplies ? "on" : ""}`} onClick={() => setCommentReplies(!commentReplies)}><span /></div></div><label>دستورالعمل تشخیص مخاطب<textarea defaultValue="اگر مخاطب درباره قیمت یا تناژ پرسید، او را سرنخ فروش در نظر بگیر. اگر نشانه‌ای از کارخانه یا خرید عمده بود، پاسخ B2B بده. از ادعای قطعی درباره هویت شخص خودداری کن." /></label></div></div><div className="settings-column"><div className="settings-card"><div className="settings-card-head"><div className="settings-symbol violet"><ShieldCheck size={19} /></div><div><h3>کنترل‌های ایمنی</h3><span>قبل از ارسال پاسخ‌های حساس</span></div></div><div className="setting-row"><div><b>حالت تأیید اپراتور</b><span>قیمت، تخفیف و قرارداد نیازمند تأیید باشد</span></div><div className="switch on"><span /></div></div><div className="setting-row"><div><b>پاسخ خودکار</b><span>{enabled ? "در حالت تست روشن است" : "خاموش"}</span></div><div className={`switch ${enabled ? "on" : ""}`} onClick={() => setEnabled(!enabled)}><span /></div></div><div className="setting-row"><div><b>ثبت لاگ پاسخ‌ها</b><span>نگهداری تاریخچه برای بررسی تیم</span></div><div className="switch on"><span /></div></div></div><div className="settings-card"><div className="settings-card-head"><div className="settings-symbol blue"><MessageSquareText size={19} /></div><div><h3>قواعد کامنت</h3><span>پاسخ به کامنت زیر پست‌ها</span></div></div><div className="rule-preview"><div className="rule-preview-head"><StatusPill tone="gold">قیمت</StatusPill><b>پاسخ کامنت استعلام</b></div><p>سلام {personalize ? "{{نام مخاطب}}" : "دوست عزیز"}، برای اعلام قیمت دقیق لطفاً سایز، تناژ و شهر مقصد را دایرکت کنید.</p><div className="rule-preview-foot"><span><CheckCircle2 size={13} /> {commentReplies ? "فعال برای همه پیج‌های منتخب" : "غیرفعال"}</span><MoreHorizontal size={16} /></div></div><button className="secondary-button full-button"><Plus size={15} /> افزودن قانون پاسخ به کامنت</button></div><div className="settings-card compact-info"><div className="settings-card-head"><div className="settings-symbol blue"><Globe2 size={19} /></div><div><h3>منطقه زمانی</h3><span>برای زمان‌بندی و گزارش‌ها</span></div></div><div className="timezone-line"><span>Asia / Tehran</span><span>تهران · UTC+۳:۳۰</span></div></div></div></div></div>;
}
