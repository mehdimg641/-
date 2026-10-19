import { useState } from "react";
import { BarChart3, ChevronLeft, Inbox, Instagram, Library, LogIn, LogOut, Settings2, ShieldCheck, Workflow } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { AnalyticsView } from "./inbox/AnalyticsView";
import { AutomationView } from "./inbox/AutomationView";
import { InboxView } from "./inbox/InboxView";
import { SettingsView } from "./inbox/SettingsView";
import { TemplatesView } from "./inbox/TemplatesView";
import { faNum, IconButton, relativeTime } from "./inbox/ui";

type Tab = "inbox" | "automation" | "templates" | "analytics" | "settings";

const POLL_MS = 15_000;

const navItems: { id: Tab; label: string; icon: typeof Inbox }[] = [
  { id: "inbox", label: "صندوق ورودی", icon: Inbox },
  { id: "automation", label: "اتوماسیون", icon: Workflow },
  { id: "templates", label: "قالب پاسخ‌ها", icon: Library },
  { id: "analytics", label: "تحلیل عملکرد", icon: BarChart3 },
  { id: "settings", label: "تنظیمات", icon: Settings2 },
];

function Gate({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="gate-page" dir="rtl">
      <div className="gate-card">
        <div className="brand-mark"><span>س</span></div>
        <h1>{title}</h1>
        <p>{body}</p>
        {action}
      </div>
    </div>
  );
}

export default function Home() {
  const { user, loading, logout } = useAuth();
  if (loading) return <Gate title="سپند Inbox" body="در حال بارگذاری..." />;
  if (!user) {
    return <Gate title="ورود به سپند Inbox" body="برای مشاهده پیام‌ها و پاسخ‌گویی وارد شوید." action={<button className="primary-button" onClick={() => startLogin()}><LogIn size={16} /> ورود</button>} />;
  }
  if (user.role !== "admin") {
    return <Gate title="دسترسی محدود است" body="حساب شما دسترسی مدیر ندارد. از مالک برنامه بخواهید نقش admin را برای شما فعال کند." action={<button className="secondary-button" onClick={() => logout()}><LogOut size={16} /> خروج</button>} />;
  }
  return <Dashboard userName={user.name ?? "مدیر سپند"} onLogout={logout} />;
}

function Dashboard({ userName, onLogout }: { userName: string; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>("inbox");
  const [composer, setComposer] = useState("");

  const status = trpc.inbox.status.useQuery();
  const threads = trpc.inbox.threads.useQuery(undefined, { refetchInterval: POLL_MS });
  const approvals = trpc.approvals.list.useQuery(undefined, { refetchInterval: POLL_MS });
  const stats = trpc.inbox.stats.useQuery(undefined, { enabled: tab === "analytics" });

  const unread = threads.data?.filter((thread) => thread.unread).length ?? 0;
  const pending = approvals.data?.length ?? 0;
  const connected = Boolean(status.data?.metaConfigured);
  const badge = (id: Tab) => (id === "inbox" && unread ? faNum(unread) : id === "automation" && pending ? faNum(pending) : null);

  return (
    <div className="app-shell" dir="rtl">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><span>س</span></div>
          <div><strong>سپند</strong><span>INBOX STUDIO</span></div>
        </div>
        <div className="account-card">
          <div className="account-avatar"><Instagram size={18} /></div>
          <div className="account-meta"><b>@sepandsteel</b><span>Sepand Steel · {connected ? "متصل" : "پیکربندی نشده"}</span></div>
          {connected && <span className="online-dot" />}
        </div>
        <div className="workspace-label">میز کار</div>
        <nav className="side-nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            const count = badge(item.id);
            return (
              <button key={item.id} className={`nav-item ${tab === item.id ? "active" : ""}`} onClick={() => setTab(item.id)}>
                <Icon size={18} strokeWidth={1.9} />
                <span>{item.label}</span>
                {count && <small>{count}</small>}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="sync-card">
            <div className="sync-icon"><ShieldCheck size={17} /></div>
            <div><b>{status.data?.persistent ? "ذخیره‌سازی پایدار" : "ذخیره موقت (بدون DB)"}</b><span>{threads.dataUpdatedAt ? `به‌روزرسانی ${relativeTime(new Date(threads.dataUpdatedAt))}` : "در انتظار داده"}</span></div>
          </div>
          <div className="operator">
            <div className="operator-avatar">{userName.charAt(0)}</div>
            <div><b>{userName}</b><span>دسترسی کامل</span></div>
            <IconButton label="خروج" onClick={onLogout}><LogOut size={16} /></IconButton>
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>سپند</span><ChevronLeft size={15} /><b>{navItems.find((item) => item.id === tab)?.label}</b></div>
          <div className="top-actions">
            <div className={`connection-status ${connected ? "" : "offline"}`}><span className="pulse" /> {connected ? "اتصال Instagram فعال" : "اتصال Meta پیکربندی نشده"}</div>
            <div className="top-avatar">{userName.charAt(0)}</div>
          </div>
        </header>

        {tab === "inbox" && (
          <InboxView
            threads={threads.data ?? []}
            approvals={approvals.data ?? []}
            loading={threads.isLoading}
            autoReply={Boolean(status.data?.autoReply)}
            composer={composer}
            setComposer={setComposer}
            onOpenAutomation={() => setTab("automation")}
          />
        )}
        {tab === "automation" && <AutomationView approvals={approvals.data ?? []} autoReply={Boolean(status.data?.autoReply)} onBack={() => setTab("inbox")} />}
        {tab === "templates" && <TemplatesView onUse={(text) => { setTab("inbox"); setComposer(text); }} />}
        {tab === "analytics" && <AnalyticsView stats={stats.data} />}
        {tab === "settings" && <SettingsView status={status.data} />}
      </main>
    </div>
  );
}
