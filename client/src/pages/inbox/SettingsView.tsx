import { AlertCircle, CheckCircle2, Database, Globe2, Instagram, PackageCheck, ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { APP_BUILD, CHANGELOG } from "@/version";
import { DiagnosticsCard } from "./DiagnosticsCard";
import { MetaConnectionCard } from "./MetaConnectionCard";
import type { InboxStatus } from "./types";
import { errorMessage, relativeTime, StatusPill, Switch } from "./ui";

function Row({ title, detail, ok, onToggle }: { title: string; detail: string; ok: boolean; onToggle?: () => void }) {
  return (
    <div className="setting-row">
      <div><b>{title}</b><span>{detail}</span></div>
      <Switch on={ok} label={title} onToggle={onToggle} />
    </div>
  );
}

function AutoReplyRow({ enabled }: { enabled: boolean }) {
  const utils = trpc.useUtils();
  const save = trpc.settings.saveMeta.useMutation({
    onSuccess: () => {
      utils.inbox.status.invalidate();
      utils.settings.meta.invalidate();
    },
  });
  const toggle = () => {
    if (!enabled && !window.confirm("با روشن‌کردن ارسال خودکار، پاسخ قوانین «ارسال مستقیم» بدون تأیید شما برای مشتری فرستاده می‌شود. ادامه می‌دهید؟")) return;
    save.mutate({ autoReply: !enabled });
  };
  return (
    <>
      <Row
        title="ارسال خودکار"
        detail={enabled ? "روشن: قوانین «ارسال مستقیم» بدون تأیید ارسال می‌شوند" : "خاموش: همه پاسخ‌ها منتظر تأیید شما می‌مانند"}
        ok={enabled}
        onToggle={save.isPending ? undefined : toggle}
      />
      {save.error && <div className="settings-warning"><AlertCircle size={16} /><span>{errorMessage(save.error)}</span></div>}
    </>
  );
}

export function SettingsView({ status }: { status: InboxStatus | undefined }) {
  return (
    <div className="content-wrap subpage">
      <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> SETTINGS / WORKSPACE</div><h1>تنظیمات سپند</h1><p>اتصال اینستاگرام، ذخیره‌سازی و کنترل‌های ارسال را از همین‌جا مدیریت کنید.</p></div></section>
      <div className="settings-grid">
        <div className="settings-column">
          <div className="settings-card account-manager-card">
            <div className="settings-card-head"><div className="settings-symbol instagram"><Instagram size={20} /></div><div><h3>حساب‌های اینستاگرام</h3><span>حساب‌هایی که پیام‌هایشان پذیرفته می‌شود</span></div><StatusPill tone={status?.metaConfigured ? "green" : "orange"}>{status?.metaConfigured ? "متصل" : "پیکربندی ناقص"}</StatusPill></div>
            <div className="account-list">
              {status?.accountIds.length ? status.accountIds.map((id) => (
                <div className="connected-account" key={id}><div className="account-avatar large account-tone-gold"><Instagram size={20} /></div><div><b dir="ltr">{id}</b><span>@sepandsteel</span></div><StatusPill tone="green">مجاز</StatusPill></div>
              )) : <div className="settings-warning"><AlertCircle size={16} /><span>هیچ شناسه‌ای تنظیم نشده؛ رویداد همه حساب‌های این برنامه Meta پذیرفته می‌شود. برای امنیت بیشتر شناسهٔ حساب را در «اتصال اینستاگرام» وارد کنید.</span></div>}
            </div>
            {!status?.metaConfigured && <div className="settings-warning"><AlertCircle size={16} /><span>برای دریافت و ارسال واقعی، توکن دسترسی، App Secret و Verify Token را در کارت «اتصال اینستاگرام» وارد کنید.</span></div>}
          </div>
          <MetaConnectionCard />
          <div className="settings-card compact-info">
            <div className="settings-card-head"><div className="settings-symbol gold"><Instagram size={19} /></div><div><h3>آخرین پیام دریافت‌شده از Meta</h3><span>اگر کامنت یا دایرکت تازه‌ای گذاشتید و این زمان تغییر نکرد، Meta رویداد را نفرستاده است</span></div></div>
            <div className="timezone-line"><span>{status?.lastEventAt ? relativeTime(status.lastEventAt) : "هنوز هیچ پیامی نرسیده"}</span><span dir="ltr">{status?.lastEventAt ? status.lastEventAt.toLocaleString("fa-IR") : "—"}</span></div>
            {!status?.lastEventAt && <div className="settings-warning"><AlertCircle size={16} /><span>اگر برنامهٔ Meta در حالت Development است، فقط رویداد حساب‌هایی که در App roles (Admin/Tester) هستند ارسال می‌شود. برای کامنت‌های همهٔ کاربران، برنامه باید Live باشد و دسترسی instagram_business_manage_comments و instagram_business_manage_messages تأیید شده باشد.</span></div>}
          </div>
          <DiagnosticsCard status={status} />
        </div>
        <div className="settings-column">
          <div className="settings-card">
            <div className="settings-card-head"><div className="settings-symbol violet"><ShieldCheck size={19} /></div><div><h3>کنترل‌های ایمنی</h3><span>قبل از ارسال پاسخ‌ها</span></div></div>
            <Row title="حالت تأیید اپراتور" detail="قوانین «نیازمند تأیید» هرگز خودکار ارسال نمی‌شوند" ok />
            <AutoReplyRow enabled={Boolean(status?.autoReply)} />
          </div>
          <div className="settings-card">
            <div className="settings-card-head"><div className="settings-symbol gold"><Database size={19} /></div><div><h3>ذخیره‌سازی</h3><span>پیام‌ها، قوانین و تاریخچه پاسخ‌ها</span></div></div>
            <Row title="پایگاه داده" detail={status?.persistent ? "MySQL متصل است" : "DATABASE_URL تنظیم نشده؛ داده‌ها فقط در حافظه هستند و با ری‌استارت پاک می‌شوند"} ok={Boolean(status?.persistent)} />
          </div>
          <div className="settings-card compact-info"><div className="settings-card-head"><div className="settings-symbol blue"><Globe2 size={19} /></div><div><h3>منطقه زمانی</h3><span>زمان‌ها بر اساس مرورگر نمایش داده می‌شوند</span></div></div><div className="timezone-line"><span>Asia / Tehran</span><span><CheckCircle2 size={13} /> تهران · UTC+۳:۳۰</span></div></div>
          <VersionCard serverBuild={status?.serverVersion ?? null} />
        </div>
      </div>
    </div>
  );
}

function VersionCard({ serverBuild }: { serverBuild: { version: string; commit: string; builtAt: string } | null }) {
  const stale = Boolean(serverBuild && serverBuild.commit !== APP_BUILD.commit);
  return (
    <div className="settings-card">
      <div className="settings-card-head"><div className="settings-symbol green"><PackageCheck size={19} /></div><div><h3>نسخهٔ برنامه</h3><span>برای اطمینان از اینکه به‌روزرسانی نصب شده</span></div></div>
      <div className="timezone-line"><span>این صفحه</span><span dir="ltr">v{APP_BUILD.version} · {APP_BUILD.commit} · {new Date(APP_BUILD.builtAt).toLocaleString("fa-IR")}</span></div>
      <div className="timezone-line"><span>نصب‌شده روی سرور</span><span dir="ltr">{serverBuild ? `v${serverBuild.version} · ${serverBuild.commit}` : "—"}</span></div>
      {stale && <div className="settings-warning"><AlertCircle size={16} /><span>نسخهٔ سرور جدیدتر است؛ صفحه را دوباره بارگذاری کنید.</span></div>}
      <div className="version-list">
        {CHANGELOG.slice(0, 3).map((entry) => (
          <div key={entry.version}>
            <b dir="ltr">v{entry.version}</b>
            <ul>{entry.items.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
        ))}
      </div>
    </div>
  );
}
