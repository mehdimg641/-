import { and, desc, eq, inArray } from "drizzle-orm";
import {
  igEvents,
  replies,
  replyRules,
  type IgEvent,
  type InsertIgEvent,
  type InsertReply,
  type InsertReplyRule,
  type Reply,
  type ReplyRule,
} from "../drizzle/schema";
import { getDb } from "./db";
import { DEFAULT_RULES } from "./replyRules";

export type RuleInput = Omit<InsertReplyRule, "id" | "createdAt" | "updatedAt">;
export type ReplyPatch = Partial<Pick<Reply, "text" | "status" | "error" | "decidedBy" | "sentAt">>;

export interface InboxStore {
  readonly persistent: boolean;
  /** Returns null when the event was already stored (Meta retry or duplicate delivery). */
  insertEvent(event: Omit<InsertIgEvent, "id" | "createdAt" | "isRead">): Promise<IgEvent | null>;
  getEvent(id: number): Promise<IgEvent | undefined>;
  listEvents(limit: number): Promise<IgEvent[]>;
  markRead(kind: IgEvent["kind"], senderId: string): Promise<void>;
  listRules(): Promise<ReplyRule[]>;
  createRule(rule: RuleInput): Promise<ReplyRule>;
  updateRule(id: number, patch: Partial<RuleInput>): Promise<ReplyRule | undefined>;
  deleteRule(id: number): Promise<void>;
  createReply(reply: Omit<InsertReply, "id" | "createdAt">): Promise<Reply>;
  getReply(id: number): Promise<Reply | undefined>;
  updateReply(id: number, patch: ReplyPatch): Promise<void>;
  /** Atomically moves a reply to "sending" if it is in one of `from`; false means someone else got it. */
  claimReply(id: number, from: Reply["status"][]): Promise<boolean>;
  listReplies(filter: { status?: Reply["status"]; eventIds?: number[] }): Promise<Reply[]>;
}

function ruleDefaults(rule: RuleInput, id: number, now: Date): ReplyRule {
  return {
    id,
    name: rule.name,
    keywords: rule.keywords,
    channels: rule.channels,
    action: rule.action ?? "approval",
    template: rule.template,
    priority: rule.priority ?? 100,
    enabled: rule.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
}

/** Used when DATABASE_URL is not set (local preview, tests). Data is lost on restart. */
export class MemoryInboxStore implements InboxStore {
  readonly persistent = false;
  private events: IgEvent[] = [];
  private rules: ReplyRule[] = [];
  private replies: Reply[] = [];
  private nextId = 1;

  constructor(seedRules: RuleInput[] = DEFAULT_RULES) {
    const now = new Date();
    this.rules = seedRules.map((rule) => ruleDefaults(rule, this.nextId++, now));
  }

  async insertEvent(event: Omit<InsertIgEvent, "id" | "createdAt" | "isRead">) {
    const duplicate = this.events.some(
      (e) => e.accountId === event.accountId && e.kind === event.kind && e.externalId === event.externalId,
    );
    if (duplicate) return null;
    const stored: IgEvent = {
      id: this.nextId++,
      accountId: event.accountId,
      kind: event.kind,
      externalId: event.externalId,
      senderId: event.senderId,
      username: event.username ?? null,
      text: event.text,
      mediaId: event.mediaId ?? null,
      ruleId: event.ruleId ?? null,
      isRead: false,
      createdAt: new Date(),
    };
    this.events.push(stored);
    return stored;
  }

  async getEvent(id: number) {
    return this.events.find((e) => e.id === id);
  }

  async listEvents(limit: number) {
    return [...this.events].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id).slice(0, limit);
  }

  async markRead(kind: IgEvent["kind"], senderId: string) {
    for (const e of this.events) if (e.kind === kind && e.senderId === senderId) e.isRead = true;
  }

  async listRules() {
    return [...this.rules];
  }

  async createRule(rule: RuleInput) {
    const stored = ruleDefaults(rule, this.nextId++, new Date());
    this.rules.push(stored);
    return stored;
  }

  async updateRule(id: number, patch: Partial<RuleInput>) {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) return undefined;
    Object.assign(rule, patch, { updatedAt: new Date() });
    return rule;
  }

  async deleteRule(id: number) {
    this.rules = this.rules.filter((r) => r.id !== id);
  }

  async createReply(reply: Omit<InsertReply, "id" | "createdAt">) {
    const stored: Reply = {
      id: this.nextId++,
      eventId: reply.eventId,
      ruleId: reply.ruleId ?? null,
      source: reply.source,
      text: reply.text,
      status: reply.status ?? "pending",
      error: reply.error ?? null,
      decidedBy: reply.decidedBy ?? null,
      createdAt: new Date(),
      sentAt: reply.sentAt ?? null,
    };
    this.replies.push(stored);
    return stored;
  }

  async getReply(id: number) {
    return this.replies.find((r) => r.id === id);
  }

  async updateReply(id: number, patch: ReplyPatch) {
    const reply = this.replies.find((r) => r.id === id);
    if (reply) Object.assign(reply, patch);
  }

  async claimReply(id: number, from: Reply["status"][]) {
    const reply = this.replies.find((r) => r.id === id);
    if (!reply || !from.includes(reply.status)) return false;
    reply.status = "sending";
    return true;
  }

  async listReplies(filter: { status?: Reply["status"]; eventIds?: number[] }) {
    return this.replies.filter(
      (r) => (!filter.status || r.status === filter.status) && (!filter.eventIds || filter.eventIds.includes(r.eventId)),
    );
  }
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/** MariaDB stores JSON as LONGTEXT, so the driver can hand back a string instead of an array. */
function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {}
  }
  return [];
}

function normalizeRule(rule: ReplyRule): ReplyRule {
  return { ...rule, keywords: parseJsonArray(rule.keywords), channels: parseJsonArray(rule.channels) };
}

function isDuplicateKeyError(error: unknown) {
  // drizzle wraps the mysql2 error in `cause`.
  for (let e = error as { code?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === "ER_DUP_ENTRY") return true;
  }
  return false;
}

export class DrizzleInboxStore implements InboxStore {
  readonly persistent = true;
  private seeded = false;

  constructor(private db: Db) {}

  async insertEvent(event: Omit<InsertIgEvent, "id" | "createdAt" | "isRead">) {
    try {
      const [{ id }] = await this.db.insert(igEvents).values(event).$returningId();
      return (await this.getEvent(id)) ?? null;
    } catch (error) {
      if (isDuplicateKeyError(error)) return null;
      throw error;
    }
  }

  async getEvent(id: number) {
    const rows = await this.db.select().from(igEvents).where(eq(igEvents.id, id)).limit(1);
    return rows[0];
  }

  async listEvents(limit: number) {
    return this.db.select().from(igEvents).orderBy(desc(igEvents.createdAt), desc(igEvents.id)).limit(limit);
  }

  async markRead(kind: IgEvent["kind"], senderId: string) {
    await this.db
      .update(igEvents)
      .set({ isRead: true })
      .where(and(eq(igEvents.kind, kind), eq(igEvents.senderId, senderId)));
  }

  async listRules() {
    const rows = await this.db.select().from(replyRules);
    if (rows.length > 0 || this.seeded) return rows.map(normalizeRule);
    this.seeded = true;
    await this.db.insert(replyRules).values(DEFAULT_RULES);
    return (await this.db.select().from(replyRules)).map(normalizeRule);
  }

  private async getRule(id: number) {
    const rows = await this.db.select().from(replyRules).where(eq(replyRules.id, id)).limit(1);
    return rows[0] ? normalizeRule(rows[0]) : undefined;
  }

  async createRule(rule: RuleInput) {
    const [{ id }] = await this.db.insert(replyRules).values(rule).$returningId();
    return (await this.getRule(id))!;
  }

  async updateRule(id: number, patch: Partial<RuleInput>) {
    await this.db.update(replyRules).set(patch).where(eq(replyRules.id, id));
    return this.getRule(id);
  }

  async deleteRule(id: number) {
    // Don't re-seed defaults in this process after an operator deletes the last rule.
    this.seeded = true;
    await this.db.delete(replyRules).where(eq(replyRules.id, id));
  }

  async createReply(reply: Omit<InsertReply, "id" | "createdAt">) {
    const [{ id }] = await this.db.insert(replies).values(reply).$returningId();
    const rows = await this.db.select().from(replies).where(eq(replies.id, id)).limit(1);
    return rows[0];
  }

  async getReply(id: number) {
    const rows = await this.db.select().from(replies).where(eq(replies.id, id)).limit(1);
    return rows[0];
  }

  async updateReply(id: number, patch: ReplyPatch) {
    await this.db.update(replies).set(patch).where(eq(replies.id, id));
  }

  async claimReply(id: number, from: Reply["status"][]) {
    const [result] = await this.db
      .update(replies)
      .set({ status: "sending" })
      .where(and(eq(replies.id, id), inArray(replies.status, from)));
    return result.affectedRows === 1;
  }

  async listReplies(filter: { status?: Reply["status"]; eventIds?: number[] }) {
    if (filter.eventIds && filter.eventIds.length === 0) return [];
    const conditions = [
      filter.status ? eq(replies.status, filter.status) : undefined,
      filter.eventIds ? inArray(replies.eventId, filter.eventIds) : undefined,
    ].filter((c) => c !== undefined);
    return this.db
      .select()
      .from(replies)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(replies.createdAt));
  }
}

let _store: InboxStore | null = null;

export async function getInboxStore(): Promise<InboxStore> {
  if (_store) return _store;
  const db = await getDb();
  if (db) {
    _store = new DrizzleInboxStore(db);
  } else {
    console.warn("[Inbox] DATABASE_URL is not set; using in-memory storage (data is lost on restart).");
    _store = new MemoryInboxStore();
  }
  return _store;
}

/** Test hook. */
export function setInboxStore(store: InboxStore | null) {
  _store = store;
}
