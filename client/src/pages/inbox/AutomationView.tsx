import { useState } from "react";
import { Bot, ChevronLeft, FlaskConical, ListChecks, RefreshCw, Workflow } from "lucide-react";
import type { ApprovalItem } from "@shared/inbox";
import { trpc } from "@/lib/trpc";
import { ApprovalQueue } from "./ApprovalQueue";
import { RulesTab, RuleTester } from "./RulesTab";
import { errorMessage, faNum } from "./ui";

// The Posts page builds post-specific rules with the same form.
export { postLabel, RuleBuilder } from "./RulesTab";

type AutomationTab = "queue" | "rules" | "test";
const TAB_KEY = "sepand.automationTab";

function savedTab(): AutomationTab {
  try {
    const value = window.localStorage.getItem(TAB_KEY);
    return value === "rules" || value === "test" ? value : "queue";
  } catch {
    return "queue";
  }
}

export function AutomationView({ approvals, autoReply, onBack }: { approvals: ApprovalItem[]; autoReply: boolean; onBack: () => void }) {
  const utils = trpc.useUtils();
  const [tab, setTabState] = useState<AutomationTab>(savedTab);
  const setTab = (next: AutomationTab) => {
    setTabState(next);
    try {
      window.localStorage.setItem(TAB_KEY, next);
    } catch {}
  };
  const [applyNotice, setApplyNotice] = useState("");
  const rules = trpc.rules.list.useQuery();
  const templates = trpc.templates.list.useQuery();
  const posts = trpc.posts.list.useQuery();
  const apply = trpc.rules.applyToUnanswered.useMutation({
    onSuccess: (result) => {
      const parts = [
        result.updated ? `${faNum(result.updated)} پیش‌نویس با قوانین فعلی به‌روز شد` : "",
        result.drafted ? `برای ${faNum(result.drafted)} پیام بی‌پاسخ پیش‌نویس تازه ساخته شد` : "",
      ].filter(Boolean);
      setApplyNotice(parts.length ? `${parts.join("؛ ")}.` : "صف تأیید با قوانین فعلی هماهنگ است و پیام بی‌پاسخ منطبقی پیدا نشد.");
      utils.approvals.list.invalidate();
      utils.inbox.invalidate();
    },
    onError: (error) => setApplyNotice(errorMessage(error)),
  });
  const ruleCount = rules.data?.length ?? 0;
  const failed = approvals.filter((a) => a.status === "failed").length;

  const tabs: { id: AutomationTab; label: string; icon: typeof Bot; count?: number }[] = [
    { id: "queue", label: "صف تأیید", icon: ListChecks, count: approvals.length },
    { id: "rules", label: "قوانین", icon: Workflow, count: ruleCount },
    { id: "test", label: "آزمایش قانون", icon: FlaskConical },
  ];

  return (
    <div className="content-wrap automation-page">
      <section className="page-bar">
        <div className="page-bar-title">
          <span className="page-bar-icon automation"><Bot size={20} /></span>
          <div>
            <h1>اتوماسیون پاسخ‌گویی</h1>
            <p>هر کامنت یا دایرکت با اولین قانون منطبق پیش‌نویس می‌سازد و اینجا منتظر تأیید شما می‌ماند.</p>
          </div>
        </div>
        <div className="page-bar-actions">
          <span className={`auto-chip ${autoReply ? "on" : ""}`}><Bot size={14} /> {autoReply ? "ارسال خودکار روشن (فقط قوانین «ارسال مستقیم»)" : "ارسال خودکار خاموش"}</span>
          <button className="secondary-button" disabled={apply.isPending} onClick={() => { setApplyNotice(""); apply.mutate(); }} title="پیش‌نویس‌های صف را با قوانین فعلی هماهنگ می‌کند و برای پیام‌های بی‌پاسخ پیش‌نویس می‌سازد">
            <RefreshCw size={15} /> {apply.isPending ? "در حال بررسی..." : "اعمال قوانین فعلی"}
          </button>
          <button className="secondary-button" onClick={onBack}><ChevronLeft size={15} /> بازگشت</button>
        </div>
      </section>
      {applyNotice && <div className="settings-success page-notice"><span>{applyNotice}</span></div>}

      <nav className="page-tabs" role="tablist">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              <Icon size={16} /> {t.label}
              {t.count !== undefined && <span className={t.id === "queue" && failed ? "warn" : ""}>{faNum(t.count)}</span>}
            </button>
          );
        })}
      </nav>

      {tab === "queue" && <ApprovalQueue items={approvals} />}
      {tab === "rules" && <RulesTab rules={rules.data ?? []} templates={templates.data ?? []} posts={posts.data ?? []} error={rules.error ? errorMessage(rules.error) : undefined} />}
      {tab === "test" && <RuleTester posts={posts.data ?? []} />}
    </div>
  );
}
