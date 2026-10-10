export type InboxChannel = "DM" | "کامنت";

export type InboxThread = {
  id: number;
  name: string;
  handle: string;
  channel: InboxChannel;
  message: string;
  time: string;
  tag: string;
  tagTone: string;
  unread: boolean;
  priority?: boolean;
  avatar: string;
  messages: { from: "contact" | "agent"; text: string; time: string }[];
};

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
