import { describe, expect, it } from "vitest";
import { filterInboxThreads, normalizeAccountIds, type InboxThread } from "../shared/inbox";

const threads: InboxThread[] = [
  {
    id: "dm:1",
    kind: "dm",
    senderId: "1",
    lastEventId: 1,
    name: "حسین رضایی",
    handle: "hossein.rz",
    channel: "DM",
    message: "برای شمش ۱۲۵ قیمت روز رو می‌فرمایید؟",
    updatedAt: new Date(),
    tag: "قیمت‌گیری",
    tagTone: "gold",
    unread: true,
    priority: true,
    avatar: "ح",
    messages: [],
  },
  {
    id: "comment:2",
    kind: "comment",
    senderId: "2",
    lastEventId: 2,
    name: "نیما احمدی",
    handle: "nima.a",
    channel: "کامنت",
    message: "قراضه آهن هم از کارگاه خرید دارید؟",
    updatedAt: new Date(),
    tag: "قراضه",
    tagTone: "green",
    unread: false,
    priority: false,
    avatar: "ن",
    messages: [],
  },
];

describe("filterInboxThreads", () => {
  it("finds a thread by message text", () => {
    expect(filterInboxThreads(threads, "۱۲۵", "all", "all").map((thread) => thread.id)).toEqual(["dm:1"]);
  });

  it("combines unread and channel filters", () => {
    expect(filterInboxThreads(threads, "", "unread", "کامنت")).toHaveLength(0);
    expect(filterInboxThreads(threads, "", "unread", "DM").map((thread) => thread.id)).toEqual(["dm:1"]);
  });

  it("filters conversations whose latest message has no sent reply", () => {
    const at = new Date();
    const withMessages: InboxThread[] = [
      { ...threads[0], messages: [{ id: "1", from: "contact", text: "قیمت؟", at }, { id: "r1", from: "agent", text: "سلام", at, status: "sent" }] },
      { ...threads[1], messages: [{ id: "2", from: "contact", text: "قراضه؟", at }, { id: "r2", from: "agent", text: "سلام", at, status: "pending" }] },
    ];
    expect(filterInboxThreads(withMessages, "", "unanswered", "all").map((thread) => thread.id)).toEqual(["comment:2"]);
    withMessages[0].messages.push({ id: "3", from: "contact", text: "ممنون، ارسال دارید؟", at });
    expect(filterInboxThreads(withMessages, "", "unanswered", "all")).toHaveLength(2);
  });

  it("filters priority conversations", () => {
    expect(filterInboxThreads(threads, "", "priority", "all").map((thread) => thread.id)).toEqual(["dm:1"]);
  });
});

describe("normalizeAccountIds", () => {
  it("accepts ids typed on a Persian keyboard", () => {
    expect(normalizeAccountIds("۱۷۸۴۱۴۵۷۲۸۳۳۰۳۸۵۸")).toBe("17841457283303858");
    expect(normalizeAccountIds(" 17841457283303858، ١٢٣ ")).toBe("17841457283303858,123");
    expect(normalizeAccountIds("")).toBe("");
  });
});
