import { describe, expect, it } from "vitest";
import { filterInboxThreads, type InboxThread } from "../shared/inbox";

const threads: InboxThread[] = [
  {
    id: 1,
    name: "حسین رضایی",
    handle: "hossein.rz",
    channel: "DM",
    message: "برای شمش ۱۲۵ قیمت روز رو می‌فرمایید؟",
    time: "اکنون",
    tag: "قیمت‌گیری",
    tagTone: "gold",
    unread: true,
    priority: true,
    avatar: "ح",
    messages: [],
  },
  {
    id: 2,
    name: "نیما احمدی",
    handle: "nima.a",
    channel: "کامنت",
    message: "قراضه آهن هم از کارگاه خرید دارید؟",
    time: "دیروز",
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
    expect(filterInboxThreads(threads, "۱۲۵", "all", "all").map((thread) => thread.id)).toEqual([1]);
  });

  it("combines unread and channel filters", () => {
    expect(filterInboxThreads(threads, "", "unread", "کامنت")).toHaveLength(0);
    expect(filterInboxThreads(threads, "", "unread", "DM").map((thread) => thread.id)).toEqual([1]);
  });

  it("filters priority conversations", () => {
    expect(filterInboxThreads(threads, "", "priority", "all").map((thread) => thread.id)).toEqual([1]);
  });
});
