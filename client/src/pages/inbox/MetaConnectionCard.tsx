import { useState } from "react";
import { AlertCircle, CheckCircle2, Copy, KeyRound, RefreshCw, Save, Wand2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { errorMessage, StatusPill } from "./ui";

type Source = "panel" | "env" | "unset";

const sourceLabel = (source: Source) => (source === "panel" ? "ذخیره‌شده در پنل" : source === "env" ? "از تنظیمات سرور" : "تنظیم نشده");
const sourceTone = (source: Source) => (source === "unset" ? "orange" : "green");

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

/** Enter the Instagram token and webhook secrets from the dashboard; no server env vars needed. */
export function MetaConnectionCard() {
  const utils = trpc.useUtils();
  const settings = trpc.settings.meta.useQuery();
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [verifyToken, setVerifyToken] = useState<string | null>(null);
  const [accountIds, setAccountIds] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = () => {
    utils.settings.meta.invalidate();
    utils.inbox.status.invalidate();
  };
  const save = trpc.settings.saveMeta.useMutation({
    onSuccess: () => {
      setAccessToken("");
      setAppSecret("");
      setVerifyToken(null);
      setAccountIds(null);
      setNotice({ ok: true, text: "ذخیره شد. برای اطمینان «تست اتصال» را بزنید." });
      refresh();
    },
    onError: (error) => setNotice({ ok: false, text: errorMessage(error) }),
  });
  const test = trpc.settings.testMeta.useMutation({
    onSuccess: (result) => {
      if (!result.ok) return setNotice({ ok: false, text: `اتصال ناموفق: ${result.error}` });
      const names = result.accounts.map((a) => (a.username ? `@${a.username}` : a.id)).join("، ");
      setNotice({ ok: true, text: `اتصال برقرار است: ${names}` });
      // Fill in the account id the token belongs to, so webhooks for it are accepted.
      if (!settings.data?.accountIds.value) setAccountIds(result.accounts.map((a) => a.id).join(","));
    },
    onError: (error) => setNotice({ ok: false, text: errorMessage(error) }),
  });

  const data = settings.data;
  if (!data) {
    return <div className="settings-card"><div className="settings-card-head"><div className="settings-symbol blue"><KeyRound size={19} /></div><div><h3>اتصال اینستاگرام</h3><span>{settings.error ? errorMessage(settings.error) : "در حال بارگذاری..."}</span></div></div></div>;
  }

  const webhookUrl = `${window.location.origin}/api/meta/webhook`;
  const verifyValue = verifyToken ?? data.verifyToken.value;
  const accountValue = accountIds ?? data.accountIds.value;
  const dirty = Boolean(accessToken || appSecret || verifyToken !== null || accountIds !== null);

  const submit = () => {
    setNotice(null);
    save.mutate({
      accessToken: accessToken || undefined,
      appSecret: appSecret || undefined,
      verifyToken: verifyToken === null ? undefined : verifyToken,
      accountIds: accountIds === null ? undefined : accountIds,
    });
  };

  return (
    <div className="settings-card meta-connection">
      <div className="settings-card-head">
        <div className="settings-symbol blue"><KeyRound size={19} /></div>
        <div><h3>اتصال اینستاگرام</h3><span>توکن و کلیدها اینجا ذخیره می‌شوند (رمزنگاری‌شده)؛ نیازی به تغییر تنظیمات هاست نیست</span></div>
        <StatusPill tone={data.configured ? "green" : "orange"}>{data.configured ? "متصل" : "پیکربندی ناقص"}</StatusPill>
      </div>

      <label className="meta-field">
        <span className="meta-field-head">Access Token اینستاگرام <StatusPill tone={sourceTone(data.accessToken.source)}>{sourceLabel(data.accessToken.source)}</StatusPill></span>
        <input type="password" dir="auto" autoComplete="off" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder={data.accessToken.preview ? `توکن فعلی ${data.accessToken.preview} است؛ برای تغییر، توکن جدید را بچسبانید` : "IGAA… یا EAA…"} />
        <small>توکن Instagram Login با IGAA و توکن صفحهٔ فیسبوک با EAA شروع می‌شود. API فعلی: <b dir="ltr">{data.apiHost === "facebook" ? "graph.facebook.com" : "graph.instagram.com"}</b></small>
      </label>

      <label className="meta-field">
        <span className="meta-field-head">App Secret <StatusPill tone={sourceTone(data.appSecret.source)}>{sourceLabel(data.appSecret.source)}</StatusPill></span>
        <input type="password" dir="auto" autoComplete="off" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder={data.appSecret.preview ? `مقدار فعلی ${data.appSecret.preview} است` : "developers.facebook.com → App settings → Basic"} />
        <small>برای بررسی امضای پیام‌های Meta لازم است؛ بدون آن هیچ رویدادی پذیرفته نمی‌شود.</small>
      </label>

      <label className="meta-field">
        <span className="meta-field-head">Verify Token وب‌هوک <StatusPill tone={sourceTone(data.verifyToken.source)}>{sourceLabel(data.verifyToken.source)}</StatusPill></span>
        <div className="meta-inline">
          <input dir="auto" autoComplete="off" value={verifyValue} onChange={(e) => setVerifyToken(e.target.value)} placeholder="یک رشتهٔ تصادفی" />
          <button type="button" className="secondary-button compact-button" onClick={() => setVerifyToken(randomToken())}><Wand2 size={14} /> ساخت</button>
          <button type="button" className="secondary-button compact-button" disabled={!verifyValue} onClick={() => copy(verifyValue)}><Copy size={14} /></button>
        </div>
        <small>همین مقدار را در Meta → Webhooks در فیلد Verify token وارد کنید.</small>
      </label>

      <label className="meta-field">
        <span className="meta-field-head">شناسهٔ عددی حساب اینستاگرام <StatusPill tone={sourceTone(data.accountIds.source)}>{sourceLabel(data.accountIds.source)}</StatusPill></span>
        <input dir="auto" value={accountValue} onChange={(e) => setAccountIds(e.target.value)} placeholder="با «تست اتصال» خودکار پر می‌شود" />
        <small>فقط رویدادهای این حساب(ها) پذیرفته می‌شوند. چند شناسه را با ویرگول جدا کنید.</small>
      </label>

      <div className="meta-webhook">
        <span>Callback URL برای Meta:</span>
        <code dir="ltr">{webhookUrl}</code>
        <button type="button" className="text-button" onClick={() => copy(webhookUrl)}><Copy size={13} /> کپی</button>
      </div>

      {notice && <div className={notice.ok ? "settings-success" : "settings-warning"}>{notice.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}<span>{notice.text}</span></div>}

      <div className="builder-buttons">
        <button type="button" className="primary-button" disabled={!dirty || save.isPending} onClick={submit}><Save size={15} /> {save.isPending ? "در حال ذخیره..." : "ذخیره"}</button>
        <button type="button" className="secondary-button" disabled={test.isPending || dirty || data.accessToken.source === "unset"} onClick={() => { setNotice(null); test.mutate(); }}><RefreshCw size={15} /> {test.isPending ? "در حال بررسی..." : "تست اتصال"}</button>
      </div>
      {dirty && <small className="meta-hint">ابتدا ذخیره کنید، سپس تست اتصال بزنید.</small>}

      <div className="meta-steps">
        <b>مراحل در developers.facebook.com:</b>
        <ol>
          <li>Instagram → API setup with Instagram login → «Generate token» و چسباندن آن در بالا</li>
          <li>App settings → Basic → App secret و چسباندن آن در بالا</li>
          <li>Instagram → Webhooks: همین Callback URL و Verify token را وارد و Verify and save کنید</li>
          <li>فیلدهای <span dir="ltr">comments</span> و <span dir="ltr">messages</span> را Subscribe کنید</li>
        </ol>
      </div>
    </div>
  );
}
