import { useEffect, useRef } from "react";
import { AlertCircle, CheckCircle2, RefreshCw, Stethoscope } from "lucide-react";
import { trpc } from "@/lib/trpc";
import type { InboxStatus, RouterOutputs } from "./types";
import { errorMessage, faNum, relativeTime, StatusPill } from "./ui";

type LogEntry = RouterOutputs["settings"]["diagnostics"]["webhookLog"][number];

const OUTCOMES: Record<LogEntry["outcome"], { text: string; tone: string }> = {
  challenge_ok: { text: "تأیید آدرس وبهوک توسط Meta", tone: "green" },
  challenge_bad_token: { text: "تأیید ناموفق: Verify Token با Meta یکی نیست", tone: "orange" },
  bad_signature: { text: "رد شد: App Secret با برنامهٔ Meta یکی نیست", tone: "orange" },
  bad_json: { text: "رد شد: بدنهٔ نامعتبر", tone: "orange" },
  other_object: { text: "رویداد غیر اینستاگرامی", tone: "slate" },
  received: { text: "رویداد دریافت شد", tone: "blue" },
  error: { text: "خطا در ذخیره", tone: "orange" },
};

/** Answers "why is the inbox empty?": is the account subscribed, does Meta call in, and what happens to each call. */
export function DiagnosticsCard({ status }: { status: InboxStatus | undefined }) {
  const utils = trpc.useUtils();
  const diag = trpc.settings.diagnostics.useQuery(undefined, { refetchInterval: 30_000 });
  const subscribe = trpc.settings.subscribeWebhooks.useMutation({ onSuccess: () => utils.settings.diagnostics.invalidate() });
  // The operator picks the id Meta actually sends; the allowlist itself stays a manual choice.
  const adoptAccount = trpc.settings.saveMeta.useMutation({
    onSuccess: () => {
      utils.inbox.status.invalidate();
      utils.settings.meta.invalidate();
      utils.settings.diagnostics.invalidate();
    },
  });
  const allowed = status?.accountIds ?? [];
  const data = diag.data;
  const sub = data?.subscription;
  // A payload for an account outside the allowlist is dropped without a trace in the inbox.
  // Subscribing is harmless and nothing arrives without it, so do it once without asking.
  const autoTried = useRef(false);
  useEffect(() => {
    if (sub?.ok && sub.missing.length > 0 && !autoTried.current) {
      autoTried.current = true;
      subscribe.mutate();
    }
  }, [sub, subscribe]);
  const received = (data?.webhookLog ?? []).some((e) => e.outcome === "received");
  // Instagram reports far more comments than it hands out: Meta hides people without an app role.
  const hiddenByDevMode = Boolean(data && data.counts.igComments > data.counts.comments);
  const foreign = Array.from(new Set((data?.webhookLog ?? []).flatMap((e) => e.accounts).filter((id) => allowed.length > 0 && !allowed.includes(id))));

  return (
    <div className="settings-card diagnostics-card">
      <div className="settings-card-head">
        <div className="settings-symbol violet"><Stethoscope size={19} /></div>
        <div><h3>عیب‌یابی دریافت پیام</h3><span>چرا صندوق ورودی خالی است؟</span></div>
        <button className="icon-button" aria-label="بازخوانی" onClick={() => diag.refetch()}><RefreshCw size={15} /></button>
      </div>
      {diag.error && <div className="settings-warning"><AlertCircle size={16} /><span>{errorMessage(diag.error)}</span></div>}

      <div className="diag-section">
        <b>۱. اشتراک رویدادها برای این حساب</b>
        {!sub && <span className="field-tip">در حال بررسی...</span>}
        {sub && !sub.ok && <div className="settings-warning"><AlertCircle size={16} /><span>{sub.error}</span></div>}
        {sub?.ok && sub.missing.length === 0 && (
          <div className="settings-success"><CheckCircle2 size={16} /><span>Meta کامنت‌ها و دایرکت‌های این حساب را به برنامه می‌فرستد ({sub.fields.join("، ")}).</span></div>
        )}
        {sub?.ok && sub.missing.length > 0 && (
          <div className="settings-warning">
            <AlertCircle size={16} />
            <span>
              {sub.fields.length ? `فقط «${sub.fields.join("، ")}» فعال است` : "هیچ رویدادی برای این حساب فعال نیست"}؛ تا «{sub.missing.join("، ")}» فعال نشود Meta آن را نمی‌فرستد.
            </span>
          </div>
        )}
        {sub?.ok && sub.missing.length > 0 && (
          <button className="primary-button" disabled={subscribe.isPending} onClick={() => subscribe.mutate()}>
            {subscribe.isPending ? "در حال فعال‌سازی..." : "فعال‌سازی دریافت کامنت و دایرکت"}
          </button>
        )}
        {subscribe.error && <span className="error-text">{errorMessage(subscribe.error)}</span>}
      </div>

      <div className="diag-section">
        <b>۲. پیام‌های ذخیره‌شده</b>
        <span>{data ? `${faNum(data.counts.comments)} کامنت · ${faNum(data.counts.dms)} دایرکت · اینستاگرام برای پست‌های همگام‌شده ${faNum(data.counts.igComments)} کامنت گزارش می‌کند` : "..."}</span>
        {hiddenByDevMode && !received && (
          <div className="settings-warning">
            <AlertCircle size={16} />
            <span>
              اینستاگرام کامنت‌ها را می‌شمارد ولی متنشان را نمی‌دهد و وبهوک هم چیزی نفرستاده: برنامهٔ Meta در حالت <b>Development</b> است.
              توکن مشکلی ندارد و ساختن توکن تازه لازم نیست. تا برنامه Live نشود، فقط پیام حساب‌هایی که در App roles (مثلاً Instagram Tester) هستند می‌آید.
            </span>
          </div>
        )}
      </div>

      <div className="diag-section">
        <b>۳. درخواست‌های اخیر Meta به وبهوک</b>
        {foreign.length > 0 && (
          <div className="settings-warning">
            <AlertCircle size={16} />
            <span>رویداد برای حساب <bdi dir="ltr">{foreign.join(", ")}</bdi> آمد ولی شناسهٔ مجاز در تنظیمات <bdi dir="ltr">{allowed.join(", ")}</bdi> است، پس کنار گذاشته شد. شناسهٔ حساب را در «اتصال اینستاگرام» اصلاح کنید.</span>
          </div>
        )}
        {foreign.map((id) => (
          <button
            key={id}
            className="primary-button"
            disabled={adoptAccount.isPending}
            onClick={() => window.confirm(`شناسهٔ حساب به ${id} تغییر کند؟ از این به بعد فقط رویدادهای همین حساب پذیرفته می‌شود.`) && adoptAccount.mutate({ accountIds: id })}
          >
            استفاده از شناسهٔ <bdi dir="ltr">{id}</bdi>
          </button>
        ))}
        {adoptAccount.error && <span className="error-text">{errorMessage(adoptAccount.error)}</span>}
        {data && data.webhookLog.length === 0 && (
          <div className="settings-warning">
            <AlertCircle size={16} />
            <span>
              Meta هنوز هیچ درخواستی به وبهوک نفرستاده. در داشبورد Meta، Callback URL باید <bdi dir="ltr">{`${window.location.origin}/api/meta/webhook`}</bdi> باشد،
              فیلدهای comments و messages Subscribe شده باشند و برنامه در حالت Live باشد (در Development فقط رویداد حساب‌های App roles می‌آید).
            </span>
          </div>
        )}
        <div className="diag-log">
          {data?.webhookLog.map((e, i) => (
            <div key={i} className="diag-log-row">
              <small>{relativeTime(e.at)}</small>
              <StatusPill tone={OUTCOMES[e.outcome].tone}>{OUTCOMES[e.outcome].text}</StatusPill>
              {e.detail && <code dir="ltr">{e.detail}</code>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
