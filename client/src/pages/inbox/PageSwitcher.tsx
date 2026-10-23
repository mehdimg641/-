import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Instagram, Plus } from "lucide-react";
import { setActivePage } from "@/lib/activePage";
import { trpc } from "@/lib/trpc";
import type { RouterOutputs } from "./types";

export type PageSummary = RouterOutputs["accounts"]["list"][number];

export const pageName = (page: Pick<PageSummary, "id" | "username">) => (page.username ? `@${page.username}` : page.id);

/** The page name inside a Persian sentence, kept left-to-right ("@name", not "name@"). */
export const pageNameInText = (page: Pick<PageSummary, "id" | "username">) => `\u2068${pageName(page)}\u2069`;

/** Days until a page's token expires, or null when unknown. */
export function daysLeft(expiresAt: Date | null) {
  return expiresAt ? Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000) : null;
}

/** Shows another page: every view reloads with that page's messages, rules and templates. */
export function useSwitchPage() {
  const queryClient = useQueryClient();
  return (accountId: string) => {
    setActivePage(accountId);
    // Drops the other page's data at once, so nothing shows the wrong page while it reloads.
    void queryClient.resetQueries();
  };
}

/** The sidebar's account card: the page on screen, and a menu to switch to another one. */
export function PageSwitcher({ activeId, connected, onAddPage }: { activeId: string | null; connected: boolean; onAddPage: () => void }) {
  const pages = trpc.accounts.list.useQuery();
  const switchPage = useSwitchPage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const list = pages.data ?? [];
  const active = list.find((p) => p.id === activeId) ?? list[0];
  const warn = list.some((p) => p.lastError || (daysLeft(p.tokenExpiresAt) ?? 99) < 7);

  return (
    <div className="page-switcher" ref={ref}>
      <button type="button" className="account-card" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <div className="account-avatar"><Instagram size={18} /></div>
        <div className="account-meta">
          <b dir="ltr">{active ? pageName(active) : "پیج اینستاگرام"}</b>
          <span>{list.length > 1 ? `${list.length.toLocaleString("fa-IR")} پیج متصل` : connected ? "متصل" : "پیکربندی نشده"}</span>
        </div>
        {warn ? <span className="online-dot warn" title="یکی از پیج‌ها به توجه نیاز دارد" /> : connected && <span className="online-dot" />}
        <ChevronDown size={14} className="account-caret" />
      </button>
      {open && (
        <div className="page-menu" role="menu">
          <div className="page-menu-label">پیج‌های متصل</div>
          {list.map((page) => {
            const days = daysLeft(page.tokenExpiresAt);
            const problem = page.lastError ? "خطا" : days !== null && days < 7 ? "توکن رو به انقضا" : null;
            return (
              <button
                key={page.id}
                type="button"
                role="menuitemradio"
                aria-checked={page.id === active?.id}
                className={`page-menu-item ${page.id === active?.id ? "active" : ""}`}
                onClick={() => {
                  setOpen(false);
                  if (page.id !== active?.id) switchPage(page.id);
                }}
              >
                <div className="account-avatar"><Instagram size={15} /></div>
                <div><b dir="ltr">{pageName(page)}</b><span dir="ltr">{page.id}</span></div>
                {problem && <small className="page-menu-problem">{problem}</small>}
                {page.id === active?.id && <Check size={15} />}
              </button>
            );
          })}
          {!list.length && <div className="page-menu-empty">هنوز پیجی وصل نشده</div>}
          <button type="button" role="menuitem" className="page-menu-add" onClick={() => { setOpen(false); onAddPage(); }}>
            <Plus size={15} /> افزودن پیج
          </button>
        </div>
      )}
    </div>
  );
}
