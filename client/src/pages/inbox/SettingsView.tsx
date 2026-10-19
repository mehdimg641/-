import { AlertCircle, CheckCircle2, Database, Globe2, Instagram, KeyRound, ShieldCheck } from "lucide-react";
import type { InboxStatus } from "./types";
import { StatusPill, Switch } from "./ui";

function Row({ title, detail, ok }: { title: string; detail: string; ok: boolean }) {
  return (
    <div className="setting-row">
      <div><b>{title}</b><span>{detail}</span></div>
      <Switch on={ok} label={title} />
    </div>
  );
}

export function SettingsView({ status }: { status: InboxStatus | undefined }) {
  return (
    <div className="content-wrap subpage">
      <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> SETTINGS / WORKSPACE</div><h1>تنظیمات سپند</h1><p>وضعیت اتصال Meta، ذخیره‌سازی و کنترل‌های ارسال. این مقادیر از متغیرهای محیطی سرور خوانده می‌شوند.</p></div></section>
      <div className="settings-grid">
        <div className="settings-column">
          <div className="settings-card account-manager-card">
            <div className="settings-card-head"><div className="settings-symbol instagram"><Instagram size={20} /></div><div><h3>حساب‌های اینستاگرام</h3><span>شناسه‌های عددی مجاز در INSTAGRAM_ACCOUNT_IDS</span></div><StatusPill tone={status?.metaConfigured ? "green" : "orange"}>{status?.metaConfigured ? "متصل" : "پیکربندی ناقص"}</StatusPill></div>
            <div className="account-list">
              {status?.accountIds.length ? status.accountIds.map((id) => (
                <div className="connected-account" key={id}><div className="account-avatar large account-tone-gold"><Instagram size={20} /></div><div><b dir="ltr">{id}</b><span>@sepandsteel</span></div><StatusPill tone="green">مجاز</StatusPill></div>
              )) : <div className="settings-warning"><AlertCircle size={16} /><span>هیچ شناسه‌ای تنظیم نشده؛ رویداد همه حساب‌های این برنامه Meta پذیرفته می‌شود. برای امنیت بیشتر INSTAGRAM_ACCOUNT_IDS را تنظیم کنید.</span></div>}
            </div>
            {!status?.metaConfigured && <div className="settings-warning"><AlertCircle size={16} /><span>برای دریافت و ارسال واقعی، META_APP_SECRET، META_WEBHOOK_VERIFY_TOKEN و META_ACCESS_TOKEN باید روی سرور تنظیم شوند. آدرس وب‌هوک: <span dir="ltr">/api/meta/webhook</span></span></div>}
          </div>
          <div className="settings-card">
            <div className="settings-card-head"><div className="settings-symbol blue"><KeyRound size={19} /></div><div><h3>اتصال Meta</h3><span>نوع API از روی توکن تشخیص داده می‌شود</span></div></div>
            <Row title="وب‌هوک و امضا" detail="بررسی X-Hub-Signature-256 با META_APP_SECRET" ok={Boolean(status?.metaConfigured)} />
            <div className="timezone-line"><span>API</span><span dir="ltr">{status?.apiHost === "facebook" ? "graph.facebook.com (Facebook Login)" : "graph.instagram.com (Instagram Login)"}</span></div>
          </div>
        </div>
        <div className="settings-column">
          <div className="settings-card">
            <div className="settings-card-head"><div className="settings-symbol violet"><ShieldCheck size={19} /></div><div><h3>کنترل‌های ایمنی</h3><span>قبل از ارسال پاسخ‌ها</span></div></div>
            <Row title="حالت تأیید اپراتور" detail="قوانین «نیازمند تأیید» هرگز خودکار ارسال نمی‌شوند" ok />
            <Row title="ارسال خودکار" detail={status?.autoReply ? "روشن: قوانین «ارسال مستقیم» بدون تأیید ارسال می‌شوند" : "خاموش: همه پاسخ‌ها منتظر تأیید می‌مانند (META_AUTO_REPLY=true برای روشن‌کردن)"} ok={Boolean(status?.autoReply)} />
          </div>
          <div className="settings-card">
            <div className="settings-card-head"><div className="settings-symbol gold"><Database size={19} /></div><div><h3>ذخیره‌سازی</h3><span>پیام‌ها، قوانین و تاریخچه پاسخ‌ها</span></div></div>
            <Row title="پایگاه داده" detail={status?.persistent ? "MySQL متصل است" : "DATABASE_URL تنظیم نشده؛ داده‌ها فقط در حافظه هستند و با ری‌استارت پاک می‌شوند"} ok={Boolean(status?.persistent)} />
          </div>
          <div className="settings-card compact-info"><div className="settings-card-head"><div className="settings-symbol blue"><Globe2 size={19} /></div><div><h3>منطقه زمانی</h3><span>زمان‌ها بر اساس مرورگر نمایش داده می‌شوند</span></div></div><div className="timezone-line"><span>Asia / Tehran</span><span><CheckCircle2 size={13} /> تهران · UTC+۳:۳۰</span></div></div>
        </div>
      </div>
    </div>
  );
}
