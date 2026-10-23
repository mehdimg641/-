import type { ReactNode } from "react";

export function StatusPill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

export function IconButton({ label, children, onClick }: { label: string; children: ReactNode; onClick?: () => void }) {
  return (
    <button className="icon-button" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

export function Switch({ on, onToggle, small, label }: { on: boolean; onToggle?: () => void; small?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch ${small ? "small" : ""} ${on ? "on" : ""} ${onToggle ? "" : "readonly"}`}
      onClick={onToggle}
      disabled={!onToggle}
    >
      <span />
    </button>
  );
}

const numberFormat = new Intl.NumberFormat("fa-IR");
export const faNum = (value: number) => numberFormat.format(value);

export function relativeTime(date: Date) {
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "اکنون";
  if (minutes < 60) return `${faNum(minutes)} دقیقه پیش`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${faNum(hours)} ساعت پیش`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "دیروز" : `${faNum(days)} روز پیش`;
}

export const clock = (date: Date) => date.toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" });

export const weekday = (date: Date) => date.toLocaleDateString("fa-IR", { weekday: "long" });

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "خطای ناشناخته";
}

/** Has a real username (not just Instagram's numeric sender id). */
export const hasUsername = (handle: string) => !/^\d+$/.test(handle);

/**
 * Past the API's deadline a person can still send the text from the Instagram app: copies it and
 * opens that customer's DM. Returns a note for the operator.
 */
export async function copyAndOpenDm(handle: string, text: string) {
  // Open the tab first: browsers block popups that come after an await.
  if (hasUsername(handle)) window.open(`https://ig.me/m/${encodeURIComponent(handle)}`, "_blank", "noopener");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return "کپی خودکار نشد؛ متن را از کادر بالا کپی کنید.";
  }
  return hasUsername(handle)
    ? "متن کپی شد؛ در اینستاگرام بچسبانید و بفرستید، بعد «ارسال دستی شد» را بزنید."
    : "متن کپی شد؛ نام کاربری معلوم نیست، دایرکت را خودتان در اینستاگرام پیدا کنید.";
}

/** "۵ ساعت" / "۲۰ دقیقه" until `end`, or "" once it has passed. */
export function timeUntil(end: Date) {
  const ms = end.getTime() - Date.now();
  if (ms <= 0) return "";
  return ms < 3_600_000 ? `${faNum(Math.max(1, Math.round(ms / 60_000)))} دقیقه` : `${faNum(Math.round(ms / 3_600_000))} ساعت`;
}
