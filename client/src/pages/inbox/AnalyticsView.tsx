import { AlertCircle, Clock3, MessageSquareText, ShieldCheck } from "lucide-react";
import type { InboxStats } from "./types";
import { faNum, StatusPill, weekday } from "./ui";

const W = 600;
const H = 220;

export function AnalyticsView({ stats }: { stats: InboxStats | undefined }) {
  if (!stats) return <div className="content-wrap subpage"><div className="empty-state"><Clock3 size={24} /><b>در حال بارگذاری...</b></div></div>;

  const totals = stats.days.map((d) => d.dm + d.comment);
  const max = Math.max(4, ...totals);
  // RTL: the oldest day sits on the right, matching the day labels below.
  const points = totals.map((value, i) => [(1 - i / (totals.length - 1)) * W, H - 12 - (value / max) * (H - 30)] as const);
  const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const weekTotal = totals.reduce((a, b) => a + b, 0);
  const all = stats.dm + stats.comment;
  const pct = (part: number) => (all ? Math.round((part / all) * 100) : 0);
  const avg = stats.avgResponseMinutes;

  return (
    <div className="content-wrap subpage">
      <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> ANALYTICS / SIGNALS</div><h1>تحلیل عملکرد</h1><p>تصویری سریع از فشار Inbox، سرعت پاسخ و فرصت‌های فروش.</p></div><span className="secondary-button"><Clock3 size={16} /> ۷ روز اخیر</span></section>
      <div className="analytics-grid">
        <div className="big-chart panel">
          <div className="chart-heading"><div><b>ورودی گفتگوها</b><span>ترکیب کامنت و دایرکت</span></div><StatusPill tone="gold">{faNum(weekTotal)} پیام</StatusPill></div>
          <div className="chart-area">
            <div className="y-labels">{[1, 0.75, 0.5, 0.25, 0].map((f) => <span key={f}>{faNum(Math.round(max * f))}</span>)}</div>
            <div className="chart">
              <div className="grid-line one" /><div className="grid-line two" /><div className="grid-line three" /><div className="grid-line four" />
              <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="تعداد پیام‌ها در ۷ روز اخیر">
                <defs><linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#e5b960" stopOpacity=".32" /><stop offset="100%" stopColor="#e5b960" stopOpacity="0" /></linearGradient></defs>
                <path d={`${line} L0,${H} L${W},${H} Z`} fill="url(#chartFill)" />
                <path d={line} fill="none" stroke="#e5b960" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              </svg>
              <div className="x-labels">{stats.days.map((d) => <span key={d.date.toISOString()}>{weekday(d.date)}</span>)}</div>
            </div>
          </div>
        </div>
        <div className="response-card panel">
          <div className="chart-heading"><div><b>سرعت پاسخ‌گویی</b><span>میانگین تا اولین پاسخ ارسال‌شده</span></div><Clock3 size={18} className="muted-icon" /></div>
          <div className="response-number">{avg === null ? "—" : avg < 60 ? <>{faNum(avg)} <small>دقیقه</small></> : <>{faNum(Math.floor(avg / 60))} ساعت <small>و {faNum(avg % 60)} دقیقه</small></>}</div>
          <div className="progress-track"><span style={{ width: `${avg === null ? 0 : Math.max(5, Math.min(100, 100 - (avg / 120) * 100))}%` }} /></div>
          <div className="response-foot"><span>هدف: زیر ۲ ساعت</span><b>{avg === null ? "بدون داده" : avg <= 120 ? "در محدوده هدف" : "بالاتر از هدف"}</b></div>
          <div className="mini-stat-row"><div><span>کامنت</span><b>{faNum(pct(stats.comment))}٪</b></div><div><span>دایرکت</span><b>{faNum(pct(stats.dm))}٪</b></div></div>
        </div>
      </div>
      <div className="insight-grid">
        <div className="insight-card"><div className="insight-icon gold"><ShieldCheck size={17} /></div><div><b>صف تأیید</b><p>{stats.pending ? `${faNum(stats.pending)} پیش‌نویس منتظر تأیید شماست.` : "هیچ پیش‌نویسی منتظر تأیید نیست."}</p></div></div>
        <div className="insight-card"><div className="insight-icon blue">{stats.failed ? <AlertCircle size={17} /> : <MessageSquareText size={17} />}</div><div><b>پاسخ‌های ارسال‌شده</b><p>{faNum(stats.sent)} پاسخ ارسال شده ({faNum(stats.autoSent)} خودکار){stats.failed ? ` و ${faNum(stats.failed)} ارسال ناموفق.` : "."}</p></div></div>
      </div>
    </div>
  );
}
