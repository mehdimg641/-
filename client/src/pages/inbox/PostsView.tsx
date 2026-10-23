import { useState } from "react";
import { AlertCircle, ArrowUpLeft, Check, Download, ImageIcon, Mail, MessageSquareText, Plus, RefreshCw, Workflow, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { postLabel, RuleBuilder } from "./AutomationView";
import type { RouterOutputs } from "./types";
import { errorMessage, faNum, relativeTime, StatusPill } from "./ui";

type Post = RouterOutputs["posts"]["list"][number];
type PostComment = RouterOutputs["posts"]["comments"][number];
type Reply = PostComment["replies"][number];

const statusLabel: Record<Reply["status"], { text: string; tone: string }> = {
  pending: { text: "در انتظار تأیید", tone: "orange" },
  sending: { text: "در حال ارسال", tone: "blue" },
  sent: { text: "ارسال شد", tone: "green" },
  failed: { text: "ناموفق", tone: "orange" },
  rejected: { text: "رد شد", tone: "slate" },
};

/** Posts with their comments, the reply under each comment and the DM sent to its author. */
export function PostsView() {
  const utils = trpc.useUtils();
  const posts = trpc.posts.list.useQuery();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const sync = trpc.posts.sync.useMutation({
    onSuccess: (r) => {
      setNotice({ ok: true, text: `${faNum(r.synced)} پست از اینستاگرام دریافت شد.` });
      utils.posts.list.invalidate();
    },
    onError: (e) => setNotice({ ok: false, text: errorMessage(e) }),
  });

  const list = posts.data ?? [];
  const selected = list.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="content-wrap subpage">
      <section className="page-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> POSTS / COMMENTS</div><h1>پست‌ها</h1><p>کامنت‌های هر پست، پاسخ زیر هر کامنت و دایرکتی که برای نویسنده‌اش رفته؛ با قوانین مخصوص همان پست.</p></div>
        <button className="primary-button" disabled={sync.isPending} onClick={() => { setNotice(null); sync.mutate(); }}><RefreshCw size={16} /> {sync.isPending ? "در حال دریافت..." : "همگام‌سازی پست‌ها"}</button>
      </section>
      {notice && <div className={notice.ok ? "settings-success" : "settings-warning"}>{notice.ok ? <Check size={16} /> : <AlertCircle size={16} />}<span>{notice.text}</span></div>}
      {posts.error && <div className="settings-warning"><AlertCircle size={16} /><span>{errorMessage(posts.error)}</span></div>}

      <div className={`posts-layout ${selected ? "with-detail" : ""}`}>
        <div className="post-grid">
          {list.map((post) => <PostCard key={post.id} post={post} selected={post.id === selectedId} onOpen={() => setSelectedId(post.id === selectedId ? null : post.id)} />)}
          {posts.data && !list.length && <div className="empty-state"><ImageIcon size={24} /><b>هنوز پستی نیست</b><span>«همگام‌سازی پست‌ها» را بزنید تا پست‌های اینستاگرام اینجا بیایند.</span></div>}
        </div>
        {selected && <PostDetail key={selected.id} post={selected} onClose={() => setSelectedId(null)} />}
      </div>
    </div>
  );
}

type ImportTotals = Pick<RouterOutputs["posts"]["importComments"], "fetched" | "imported" | "alreadyThere" | "own" | "answered">;

function importMessage(r: ImportTotals, post: Post) {
  if (!r.fetched) {
    if (!post.igComments) return "اینستاگرام برای این پست کامنتی گزارش نمی‌کند.";
    return `اینستاگرام می‌گوید این پست ${faNum(post.igComments)} کامنت دارد ولی متنشان را نداد. توکن مشکلی ندارد (درخواست بدون خطا انجام شد و ساختن توکن تازه لازم نیست)؛ برنامهٔ Meta در حالت Development است و Meta کامنت کسانی را که در App roles نیستند پنهان می‌کند. بعد از Live شدن برنامه دوباره امتحان کنید؛ تا آن موقع کامنت حساب‌هایی که Instagram Tester هستند می‌آید.`;
  }
  const parts = [`${faNum(r.fetched)} کامنت از اینستاگرام خوانده شد`];
  if (r.imported) parts.push(`${faNum(r.imported)} کامنت تازه وارد شد و پیش‌نویس‌هایش در صف تأیید است (ارسال خودکار نمی‌شوند)`);
  if (r.alreadyThere) parts.push(`${faNum(r.alreadyThere)} کامنت از قبل در برنامه بود`);
  if (r.answered) parts.push(`${faNum(r.answered)} کامنت که در اینستاگرام جوابش داده شده بود «جواب‌داده» ثبت شد و پیش‌نویس نمی‌گیرد`);
  if (r.own) parts.push(`${faNum(r.own)} کامنت خود صفحه نادیده گرفته شد`);
  return parts.join("؛ ") + ".";
}

/** Instagram image links expire after a while; show the placeholder until the next sync. */
function PostImage({ url, size }: { url: string | null; size: number }) {
  const [broken, setBroken] = useState(false);
  return url && !broken ? <img src={url} alt="" loading="lazy" onError={() => setBroken(true)} /> : <ImageIcon size={size} />;
}

function PostCard({ post, selected, onOpen }: { post: Post; selected: boolean; onOpen: () => void }) {
  return (
    <button className={`post-card ${selected ? "selected" : ""}`} onClick={onOpen}>
      <div className="post-image"><PostImage url={post.imageUrl} size={26} /></div>
      <div className="post-body">
        <p>{postLabel(post)}</p>
        <div className="post-stats">
          <span title="واردشده در برنامه / گزارش اینستاگرام"><MessageSquareText size={12} /> {faNum(post.comments)}{post.igComments != null && post.igComments !== post.comments ? ` / ${faNum(post.igComments)}` : ""}</span>
          <span><Mail size={12} /> {faNum(post.dmsSent)}</span>
          {post.pending > 0 && <StatusPill tone="orange">{faNum(post.pending)} در انتظار</StatusPill>}
          {post.rules > 0 && <StatusPill tone="blue">{faNum(post.rules)} قانون</StatusPill>}
        </div>
        {post.postedAt && <small>{relativeTime(post.postedAt)}</small>}
      </div>
    </button>
  );
}

function PostDetail({ post, onClose }: { post: Post; onClose: () => void }) {
  const utils = trpc.useUtils();
  const comments = trpc.posts.comments.useQuery({ mediaId: post.id }, { refetchInterval: 15_000 });
  const rules = trpc.rules.list.useQuery();
  const templates = trpc.templates.list.useQuery();
  const posts = trpc.posts.list.useQuery();
  const [building, setBuilding] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const refresh = () => {
    utils.posts.invalidate();
    utils.approvals.list.invalidate();
    utils.inbox.invalidate();
  };
  const importComments = trpc.posts.importComments.useMutation();
  const [importing, setImporting] = useState("");
  // Instagram gives 200 comments per call; keep calling with the cursor until the post is done.
  const importAll = async () => {
    setNotice(null);
    const totals: ImportTotals = { fetched: 0, imported: 0, alreadyThere: 0, own: 0, answered: 0 };
    let after: string | null = null;
    try {
      do {
        setImporting(`در حال دریافت… ${faNum(totals.fetched)}${post.igComments ? ` از حدود ${faNum(post.igComments)}` : ""} کامنت`);
        const r = await importComments.mutateAsync({ mediaId: post.id, after });
        totals.fetched += r.fetched;
        totals.imported += r.imported;
        totals.alreadyThere += r.alreadyThere;
        totals.own += r.own;
        totals.answered += r.answered;
        after = r.next;
        refresh();
      } while (after);
      setNotice({ ok: totals.fetched > 0, text: importMessage(totals, post) });
    } catch (e) {
      setNotice({ ok: false, text: `${errorMessage(e)}${totals.fetched ? ` (تا این‌جا ${faNum(totals.fetched)} کامنت خوانده شد؛ دوباره بزنید تا ادامه دهد)` : ""}` });
    } finally {
      setImporting("");
    }
  };
  const postRules = (rules.data ?? []).filter((r) => r.mediaIds?.includes(post.id));

  return (
    <aside className="post-detail panel">
      <div className="post-detail-head">
        <div className="post-detail-image"><PostImage url={post.imageUrl} size={24} /></div>
        <div>
          <b>{postLabel(post)}</b>
          <span>{faNum(post.comments)} کامنت در برنامه{post.igComments != null ? ` (اینستاگرام: ${faNum(post.igComments)})` : ""} · {faNum(post.repliesSent)} پاسخ · {faNum(post.dmsSent)} دایرکت</span>
          {post.permalink && <a className="text-button" href={post.permalink} target="_blank" rel="noreferrer">مشاهده در اینستاگرام <ArrowUpLeft size={13} /></a>}
        </div>
        <button className="icon-button" aria-label="بستن" onClick={onClose}><X size={16} /></button>
      </div>

      <div className="builder-buttons">
        <button className="secondary-button" disabled={Boolean(importing)} onClick={importAll}><Download size={15} /> {importing ? "در حال دریافت..." : "دریافت همهٔ کامنت‌ها"}</button>
        <button className="secondary-button" onClick={() => setBuilding((v) => !v)}><Plus size={15} /> قانون برای این پست</button>
      </div>
      {importing && <div className="queue-progress">{importing}</div>}
      {notice && <div className={notice.ok ? "settings-success" : "settings-warning"}>{notice.ok ? <Check size={16} /> : <AlertCircle size={16} />}<span>{notice.text}</span></div>}

      <div className="post-rules">
        <b><Workflow size={14} /> قوانین این پست</b>
        {postRules.length ? postRules.map((r) => <StatusPill key={r.id} tone={r.enabled ? "blue" : "slate"}>{r.name}{r.keywords.length ? `: ${r.keywords.join("، ")}` : ""}</StatusPill>) : <span className="field-tip">قانون مخصوصی ندارد؛ قوانین عمومی کامنت اعمال می‌شوند.</span>}
      </div>
      {building && <RuleBuilder rule={null} templates={templates.data ?? []} posts={posts.data ?? []} presetMediaIds={[post.id]} onDone={() => setBuilding(false)} />}

      <div className="post-comments">
        {comments.data?.map((c) => <CommentRow key={c.eventId} comment={c} onChange={refresh} />)}
        {comments.data && !comments.data.length && <div className="empty-state"><MessageSquareText size={22} /><b>کامنتی ثبت نشده</b><span>کامنت‌های جدید خودکار می‌آیند؛ برای قبلی‌ها «دریافت کامنت‌های قبلی» را بزنید.</span></div>}
      </div>
    </aside>
  );
}

function CommentRow({ comment, onChange }: { comment: PostComment; onChange: () => void }) {
  const [error, setError] = useState("");
  const approve = trpc.approvals.approve.useMutation({ onSuccess: (r) => { setError(r.ok ? "" : r.error); onChange(); }, onError: (e) => setError(errorMessage(e)) });
  const reject = trpc.approvals.reject.useMutation({ onSuccess: onChange, onError: (e) => setError(errorMessage(e)) });
  return (
    <div className="comment-row">
      <div className="comment-head"><b>@{comment.username}</b><small>{relativeTime(comment.at)}</small><StatusPill tone={comment.tone}>{comment.rule}</StatusPill></div>
      <p className="comment-text">{comment.text}</p>
      {comment.replies.map((r) => (
        <div key={r.id} className={`comment-reply ${r.channel}`}>
          <span className="reply-kind-label">{r.channel === "private" ? <><Mail size={11} /> دایرکت</> : <><MessageSquareText size={11} /> پاسخ</>}</span>
          <p>{r.text}</p>
          <StatusPill tone={statusLabel[r.status].tone}>{statusLabel[r.status].text}</StatusPill>
          {(r.status === "pending" || r.status === "failed") && (
            <span className="rule-actions">
              <button className="text-button" disabled={approve.isPending} onClick={() => approve.mutate({ id: r.id })}><Check size={13} /> {r.status === "failed" ? "تلاش مجدد" : "تأیید و ارسال"}</button>
              <button className="text-button danger" disabled={reject.isPending} onClick={() => reject.mutate({ id: r.id })}><X size={13} /> رد</button>
            </span>
          )}
          {r.error && <span className="error-text">{r.error}</span>}
        </div>
      ))}
      {!comment.replies.length && <span className="field-tip">بدون پاسخ</span>}
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}
