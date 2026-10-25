import { boolean, index, int, json, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Incoming Instagram comments and DMs received through the Meta webhook.
 * The unique (accountId, kind, externalId) key makes Meta's retries idempotent.
 */
export const igEvents = mysqlTable(
  "igEvents",
  {
    id: int("id").autoincrement().primaryKey(),
    /** Instagram professional account that received the event (entry.id). */
    accountId: varchar("accountId", { length: 64 }).notNull(),
    kind: mysqlEnum("kind", ["comment", "dm"]).notNull(),
    /** Comment id or message mid. */
    externalId: varchar("externalId", { length: 191 }).notNull(),
    /** Instagram-scoped id of the person who wrote the comment or message. */
    senderId: varchar("senderId", { length: 64 }).notNull(),
    username: varchar("username", { length: 64 }),
    text: text("text").notNull(),
    mediaId: varchar("mediaId", { length: 64 }),
    /** Rule matched when the event arrived, if any. */
    ruleId: int("ruleId"),
    isRead: boolean("isRead").default(false).notNull(),
    /** DMs: our reaction on the customer's message ("love"), or null. */
    reaction: varchar("reaction", { length: 16 }),
    /** Comments: hidden on Instagram by an operator. */
    hidden: boolean("hidden").default(false).notNull(),
    /** Comments: deleted on Instagram by an operator; kept here for the record. */
    deleted: boolean("deleted").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("igEvents_external_unique").on(table.accountId, table.kind, table.externalId),
    index("igEvents_sender_idx").on(table.senderId),
  ],
);

export type IgEvent = typeof igEvents.$inferSelect;
export type InsertIgEvent = typeof igEvents.$inferInsert;

/** Keyword rules that turn an incoming event into a reply draft. Lower priority runs first. */
export const replyRules = mysqlTable("replyRules", {
  id: int("id").autoincrement().primaryKey(),
  /** The Instagram page this rule belongs to (igAccounts.id). Null on rows from before pages; they belong to the first page. */
  accountId: varchar("accountId", { length: 64 }),
  name: varchar("name", { length: 120 }).notNull(),
  keywords: json("keywords").$type<string[]>().notNull(),
  channels: json("channels").$type<Array<"comment" | "dm">>().notNull(),
  /** "send" may go out automatically when META_AUTO_REPLY=true; "approval" always waits for an operator. */
  action: mysqlEnum("action", ["send", "approval"]).default("approval").notNull(),
  /**
   * Reply text (supports {{username}}): the public reply for comments, the DM reply for DMs.
   * Ignored when templateId is set; empty with no templateId means "no public reply".
   */
  template: text("template").notNull(),
  templateId: int("templateId"),
  /** Comments only: also DM the commenter (Instagram private reply). Text or a saved template. */
  dmTemplate: text("dmTemplate"),
  dmTemplateId: int("dmTemplateId"),
  /** Comments only: limit the rule to these posts. Null or empty = every post. */
  mediaIds: json("mediaIds").$type<string[]>(),
  /**
   * Buttons under the rule's DM (Instagram quick replies). Tapping one sends that option's reply,
   * which also lifts the one-private-reply limit because the customer has now answered.
   */
  dmButtons: json("dmButtons").$type<Array<{ title: string; reply: string }>>(),
  priority: int("priority").default(100).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ReplyRule = typeof replyRules.$inferSelect;
export type InsertReplyRule = typeof replyRules.$inferInsert;

/** Outgoing replies: rule drafts waiting for approval, plus everything that was sent or failed. */
export const replies = mysqlTable(
  "replies",
  {
    id: int("id").autoincrement().primaryKey(),
    eventId: int("eventId").notNull(),
    ruleId: int("ruleId"),
    source: mysqlEnum("source", ["rule", "manual"]).notNull(),
    /** "reply" answers in place (comment reply or DM); "private" DMs a commenter about their comment. */
    channel: mysqlEnum("channel", ["reply", "private"]).default("reply").notNull(),
    text: text("text").notNull(),
    /** Quick-reply buttons sent with this message; the payload tells the webhook which option was tapped. */
    quickReplies: json("quickReplies").$type<Array<{ title: string; payload: string }>>(),
    status: mysqlEnum("status", ["pending", "sending", "sent", "rejected", "failed"]).default("pending").notNull(),
    error: text("error"),
    /** users.id of the operator who approved, rejected or wrote the reply. */
    decidedBy: int("decidedBy"),
    /** Id Instagram gave what we sent (DM message_id or reply comment id). */
    externalId: varchar("externalId", { length: 191 }),
    /** Emoji the customer reacted to our DM with, or null. */
    customerReaction: varchar("customerReaction", { length: 32 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    sentAt: timestamp("sentAt"),
  },
  (table) => [index("replies_event_idx").on(table.eventId), index("replies_status_idx").on(table.status)],
);

export type Reply = typeof replies.$inferSelect;
export type InsertReply = typeof replies.$inferInsert;
/** Key/value settings edited from the dashboard (e.g. the Meta connection). Values are encrypted. */
export const appSettings = mysqlTable("appSettings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type AppSetting = typeof appSettings.$inferSelect;

/** Reusable reply texts, picked by rules or inserted into the composer. Supports {{username}}. */
export const replyTemplates = mysqlTable("replyTemplates", {
  id: int("id").autoincrement().primaryKey(),
  /** The page whose library this template is in; null on rows from before pages. */
  accountId: varchar("accountId", { length: 64 }),
  title: varchar("title", { length: 120 }).notNull(),
  category: varchar("category", { length: 60 }).default("").notNull(),
  text: text("text").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ReplyTemplate = typeof replyTemplates.$inferSelect;
export type InsertReplyTemplate = typeof replyTemplates.$inferInsert;

/** Instagram posts, synced from the Graph API so comments can be grouped and rules scoped per post. */
export const igMedia = mysqlTable("igMedia", {
  id: varchar("id", { length: 64 }).primaryKey(),
  /** The page that posted it; null on rows from before pages. */
  accountId: varchar("accountId", { length: 64 }),
  caption: text("caption"),
  mediaType: varchar("mediaType", { length: 32 }),
  mediaUrl: text("mediaUrl"),
  thumbnailUrl: text("thumbnailUrl"),
  permalink: text("permalink"),
  postedAt: timestamp("postedAt"),
  commentsCount: int("commentsCount"),
  syncedAt: timestamp("syncedAt").defaultNow().onUpdateNow().notNull(),
});

export type IgMedia = typeof igMedia.$inferSelect;
export type InsertIgMedia = typeof igMedia.$inferInsert;

/**
 * Instagram pages connected to the dashboard. `id` is the professional account id, the same as
 * the webhook's entry.id. Each page has its own token (encrypted like appSettings), rules,
 * templates and posts.
 */
export const igAccounts = mysqlTable("igAccounts", {
  id: varchar("id", { length: 64 }).primaryKey(),
  username: varchar("username", { length: 64 }),
  name: varchar("name", { length: 120 }),
  /** AES-256-GCM encrypted access token. */
  token: text("token").notNull(),
  tokenExpiresAt: timestamp("tokenExpiresAt"),
  tokenRefreshedAt: timestamp("tokenRefreshedAt"),
  /** Last failure talking to Instagram for this page (e.g. a token refresh), shown in Settings. */
  lastError: text("lastError"),
  enabled: boolean("enabled").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type IgAccount = typeof igAccounts.$inferSelect;
export type InsertIgAccount = typeof igAccounts.$inferInsert;
