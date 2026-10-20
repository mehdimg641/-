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
  name: varchar("name", { length: 120 }).notNull(),
  keywords: json("keywords").$type<string[]>().notNull(),
  channels: json("channels").$type<Array<"comment" | "dm">>().notNull(),
  /** "send" may go out automatically when META_AUTO_REPLY=true; "approval" always waits for an operator. */
  action: mysqlEnum("action", ["send", "approval"]).default("approval").notNull(),
  /** Supports {{username}}. */
  template: text("template").notNull(),
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
    text: text("text").notNull(),
    status: mysqlEnum("status", ["pending", "sending", "sent", "rejected", "failed"]).default("pending").notNull(),
    error: text("error"),
    /** users.id of the operator who approved, rejected or wrote the reply. */
    decidedBy: int("decidedBy"),
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
