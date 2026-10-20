export type InboxChannel = "DM" | "کامنت";
export type InboxKind = "comment" | "dm";
export type ReplyStatus = "pending" | "sending" | "sent" | "rejected" | "failed";

export type InboxMessage = {
  id: string;
  from: "contact" | "agent";
  text: string;
  at: Date;
  /** Only for agent messages. */
  status?: ReplyStatus;
  error?: string | null;
  /** "dm": a private reply sent to a commenter's inbox. */
  via?: "dm";
};

export type InboxThread = {
  /** `${kind}:${senderId}` */
  id: string;
  kind: InboxKind;
  channel: InboxChannel;
  senderId: string;
  name: string;
  handle: string;
  message: string;
  updatedAt: Date;
  tag: string;
  tagTone: string;
  unread: boolean;
  /** Has a reply waiting for operator approval. */
  priority: boolean;
  avatar: string;
  /** Latest incoming event; manual replies answer this one. */
  lastEventId: number;
  messages: InboxMessage[];
};

export type ApprovalItem = {
  id: number;
  threadId: string;
  channel: InboxChannel;
  name: string;
  handle: string;
  incoming: string;
  draft: string;
  reason: string;
  /** "reply": answer in place (comment reply / DM); "private": DM to the commenter. */
  replyChannel: "reply" | "private";
  mediaId: string | null;
  tone: string;
  status: ReplyStatus;
  error: string | null;
  createdAt: Date;
};

export const channelOf = (kind: InboxKind): InboxChannel => (kind === "dm" ? "DM" : "کامنت");

export function filterInboxThreads(
  threads: InboxThread[],
  search: string,
  filter: "all" | "unread" | "priority",
  channelFilter: "all" | InboxChannel,
) {
  return threads.filter((thread) => {
    const matchesSearch = `${thread.name} ${thread.handle} ${thread.message} ${thread.tag}`.toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filter === "all" || (filter === "unread" ? thread.unread : thread.priority);
    const matchesChannel = channelFilter === "all" || thread.channel === channelFilter;
    return matchesSearch && matchesFilter && matchesChannel;
  });
}
