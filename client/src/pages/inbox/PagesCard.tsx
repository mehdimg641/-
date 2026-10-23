import { useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, Eye, Instagram, KeyRound, Plus, RefreshCw, Unplug } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { daysLeft, pageName, pageNameInText, useSwitchPage, type PageSummary } from "./PageSwitcher";
import { errorMessage, faNum, StatusPill } from "./ui";

function expiryText(page: PageSummary) {
  const days = daysLeft(page.tokenExpiresAt);
  if (days === null) return "تاریخ انقضای توکن هنوز معلوم نیست؛ با اولین تمدید معلوم می‌شود";
  if (days < 0) return "توکن منقضی شده؛ توکن جدید بگذارید";
  return `${faNum(days)} روز تا انقضای توکن (خودکار تمدید می‌شود)`;
}

/** Paste a token: it is sent once and never shown again. */
function TokenForm({ submitLabel, pending, onSubmit, onCancel }: { submitLabel: string; pending: boolean; onSubmit: (token: string) => void; onCancel?: () => void }) {
  const [token, setToken] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim()) onSubmit(token.trim());
  };
  return (
    <form className="page-token-form" onSubmit={submit}>
      <input
        type="password"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        placeholder="توکن دسترسی پیج (IGAA…)"
        autoComplete="off"
        spellCheck={false}
        dir="ltr"
        aria-label="توکن دسترسی پیج"
      />
      <button className="primary-button" type="submit" disabled={pending || !token.trim()}>{pending ? "در حال بررسی…" : submitLabel}</button>
      {onCancel && <button className="secondary-button" type="button" onClick={onCancel}>انصراف</button>}
    </form>
  );
}

function PageRow({ page, active }: { page: PageSummary; active: boolean }) {
  const utils = trpc.useUtils();
  const switchPage = useSwitchPage();
  const [replacing, setReplacing] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const done = (text: string) => {
    setNotice({ ok: true, text });
    utils.accounts.list.invalidate();
  };
  const fail = (error: unknown) => setNotice({ ok: false, text: errorMessage(error) });
  const update = trpc.accounts.updateToken.useMutation({ onSuccess: () => { setReplacing(false); done("توکن جدید ذخیره شد"); }, onError: fail });
  const refresh = trpc.accounts.refresh.useMutation({ onSuccess: () => done("توکن تمدید شد"), onError: fail });
  const remove = trpc.accounts.remove.useMutation({
    onSuccess: () => {
      utils.accounts.list.invalidate();
      utils.inbox.status.invalidate();
    },
    onError: fail,
  });
  const disconnect = () => {
    if (!window.confirm(`اتصال ${pageNameInText(page)} قطع شود؟ پیام‌ها، قوانین و قالب‌هایش می‌مانند و با افزودن دوبارهٔ همین پیج برمی‌گردند.`)) return;
    remove.mutate({ id: page.id });
  };
  const days = daysLeft(page.tokenExpiresAt);
  const tone = page.lastError || (days !== null && days < 7) ? "orange" : "green";

  return (
    <div className={`page-row ${active ? "active" : ""}`}>
      <div className="connected-account">
        <div className="account-avatar large account-tone-gold"><Instagram size={20} /></div>
        <div><b dir="ltr">{pageName(page)}</b><span dir="ltr">{page.id} · {page.tokenPreview || "بدون توکن"}</span></div>
        {active ? <StatusPill tone="blue">در حال نمایش</StatusPill> : <StatusPill tone={tone}>{tone === "green" ? "متصل" : "نیاز به توجه"}</StatusPill>}
      </div>
      <div className="page-row-detail">{expiryText(page)}</div>
      {page.lastError && <div className="settings-warning"><AlertCircle size={16} /><span>{page.lastError}</span></div>}
      {replacing ? (
        <TokenForm submitLabel="ذخیرهٔ توکن" pending={update.isPending} onSubmit={(token) => update.mutate({ id: page.id, token })} onCancel={() => setReplacing(false)} />
      ) : (
        <div className="page-row-actions">
          {!active && <button type="button" className="secondary-button compact-button" onClick={() => switchPage(page.id)}><Eye size={14} /> نمایش این پیج</button>}
          <button type="button" className="secondary-button compact-button" onClick={() => { setNotice(null); setReplacing(true); }}><KeyRound size={14} /> توکن جدید</button>
          <button type="button" className="secondary-button compact-button" disabled={refresh.isPending} onClick={() => refresh.mutate({ id: page.id })}><RefreshCw size={14} /> {refresh.isPending ? "در حال تمدید…" : "تمدید توکن"}</button>
          <button type="button" className="secondary-button compact-button danger-text" disabled={remove.isPending} onClick={disconnect}><Unplug size={14} /> قطع اتصال</button>
        </div>
      )}
      {notice && <div className={notice.ok ? "settings-success" : "settings-warning"}>{notice.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}<span>{notice.text}</span></div>}
    </div>
  );
}

/** The Instagram pages this dashboard manages; each has its own token, rules and templates. */
export function PagesCard({ activeId }: { activeId: string | null }) {
  const utils = trpc.useUtils();
  const pages = trpc.accounts.list.useQuery();
  const switchPage = useSwitchPage();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const add = trpc.accounts.add.useMutation({
    onSuccess: ({ account, subscribeError }) => {
      setAdding(false);
      utils.accounts.list.invalidate();
      utils.inbox.status.invalidate();
      setNotice(
        subscribeError
          ? { ok: false, text: `${pageNameInText(account)} وصل شد، ولی فعال‌سازی وب‌هوک آن ناموفق بود: ${subscribeError}` }
          : { ok: true, text: `${pageNameInText(account)} وصل شد و وب‌هوک‌هایش فعال شد.` },
      );
    },
    onError: (error) => setNotice({ ok: false, text: errorMessage(error) }),
  });
  const list = pages.data ?? [];
  const added = add.data?.account;

  return (
    <div className="settings-card account-manager-card" id="pages-card">
      <div className="settings-card-head">
        <div className="settings-symbol instagram"><Instagram size={20} /></div>
        <div><h3>پیج‌های متصل</h3><span>هر پیج توکن، قوانین و قالب‌های خودش را دارد؛ در هر لحظه یکی از آن‌ها نمایش داده می‌شود</span></div>
        <StatusPill tone={list.length ? "green" : "orange"}>{list.length ? `${faNum(list.length)} پیج` : "بدون پیج"}</StatusPill>
      </div>
      <div className="account-list">
        {pages.error && <div className="settings-warning"><AlertCircle size={16} /><span>{errorMessage(pages.error)}</span></div>}
        {list.map((page) => <PageRow key={page.id} page={page} active={page.id === (activeId ?? list[0]?.id)} />)}
        {!list.length && !pages.isLoading && <div className="settings-warning"><AlertCircle size={16} /><span>هنوز پیجی وصل نشده. توکن پیج را در «افزودن پیج» بگذارید (یا در کارت «اتصال اینستاگرام» پایین).</span></div>}
      </div>
      {adding ? (
        <div className="page-add">
          <p>پیج باید حساب حرفه‌ای (Business یا Creator) باشد. در Meta for Developers → برنامهٔ شما → Instagram → API setup، با همان پیج وارد شوید، «Generate token» را بزنید و توکن را این‌جا بگذارید. توکن فقط یک بار فرستاده می‌شود و دیگر نمایش داده نمی‌شود.</p>
          <TokenForm submitLabel="افزودن پیج" pending={add.isPending} onSubmit={(token) => { setNotice(null); add.mutate({ token }); }} onCancel={() => setAdding(false)} />
        </div>
      ) : (
        <button type="button" className="secondary-button page-add-button" onClick={() => { setNotice(null); setAdding(true); }}><Plus size={15} /> افزودن پیج</button>
      )}
      {notice && (
        <div className={notice.ok ? "settings-success" : "settings-warning"}>
          {notice.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          <span>{notice.text}</span>
          {added && added.id !== activeId && <button type="button" className="secondary-button compact-button" onClick={() => switchPage(added.id)}>نمایش این پیج</button>}
        </div>
      )}
    </div>
  );
}
