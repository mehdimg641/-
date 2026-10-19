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
