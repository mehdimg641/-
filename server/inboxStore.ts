import { and, desc, eq, inArray, isNull, or, type AnyColumn } from "drizzle-orm";
import {
  igAccounts,
  igEvents,
  igMedia,
  replies,
  replyRules,
  replyTemplates,
  type IgAccount,
  type IgEvent,
  type IgMedia,
  type InsertIgAccount,
  type InsertIgMedia,
  type InsertReplyTemplate,
  type ReplyTemplate,
  type InsertIgEvent,
  type InsertReply,
  type InsertReplyRule,
  type Reply,
  type ReplyRule,
} from "../drizzle/schema";
import { getDb } from "./db";
import { DEFAULT_RULES, DEFAULT_TEMPLATES } from "./replyRules";

export type RuleInput = Omit<InsertReplyRule, "id" | "createdAt" | "updatedAt">;
export type TemplateInput = Omit<InsertReplyTemplate, "id" | "createdAt" | "updatedAt">;
export type MediaInput = Omit<InsertIgMedia, "syncedAt">;
export type ReplyPatch = Partial<Pick<Reply, "text" | "status" | "error" | "decidedBy" | "sentAt" | "channel" | "source" | "quickReplies" | "externalId" | "customerReaction">>;
export type EventFlags = Partial<Pick<IgEvent, "reaction" | "hidden" | "deleted">>;
export type AccountPatch = Partial<Omit<InsertIgAccount, "id" | "createdAt">>;

/**
 * Rules, templates and posts belong to one page. Rows from before pages existed have no page;
 * they count for every page until assignOrphans() gives them to the first one.
 */
const belongs = (rowAccount: string | null | undefined, accountId: string | undefined) =>
  accountId === undefined || rowAccount == null || rowAccount === accountId;

export interface InboxStore {
  readonly persistent: boolean;
  /** Returns null when the event was already stored (Meta retry or duplicate delivery). */
  insertEvent(event: Omit<InsertIgEvent, "id">): Promise<IgEvent | null>;
  getEvent(id: number): Promise<IgEvent | undefined>;
  /** Newest first; only that page's events when `accountId` is given. */
  listEvents(limit: number, accountId?: string): Promise<IgEvent[]>;
  markRead(accountId: string, kind: IgEvent["kind"], senderId: string): Promise<void>;
  setEventRule(id: number, ruleId: number | null): Promise<void>;
  setEventFlags(id: number, flags: EventFlags): Promise<void>;
  findEvent(accountId: string, kind: IgEvent["kind"], externalId: string): Promise<IgEvent | undefined>;
  /** The reply Instagram knows by this id (our sent DM's message_id), for customer reactions. */
  findReplyByExternalId(externalId: string): Promise<Reply | undefined>;
  listRules(accountId?: string): Promise<ReplyRule[]>;
  createRule(rule: RuleInput): Promise<ReplyRule>;
  updateRule(id: number, patch: Partial<RuleInput>): Promise<ReplyRule | undefined>;
  deleteRule(id: number): Promise<void>;
  createReply(reply: Omit<InsertReply, "id" | "createdAt">): Promise<Reply>;
  getReply(id: number): Promise<Reply | undefined>;
  updateReply(id: number, patch: ReplyPatch): Promise<void>;
  /** Drops drafts that are still pending (others are kept), so a rule change can rebuild them. */
  deletePendingReplies(ids: number[]): Promise<void>;
  /** Atomically moves a reply to "sending" if it is in one of `from`; false means someone else got it. */
  claimReply(id: number, from: Reply["status"][]): Promise<boolean>;
  listReplies(filter: { status?: Reply["status"]; eventIds?: number[] }): Promise<Reply[]>;
  listTemplates(accountId?: string): Promise<ReplyTemplate[]>;
  createTemplate(template: TemplateInput): Promise<ReplyTemplate>;
  updateTemplate(id: number, patch: Partial<TemplateInput>): Promise<ReplyTemplate | undefined>;
  deleteTemplate(id: number): Promise<void>;
  upsertMedia(media: MediaInput[]): Promise<void>;
  listMedia(accountId?: string): Promise<IgMedia[]>;
  listAccounts(): Promise<IgAccount[]>;
  getAccount(id: string): Promise<IgAccount | undefined>;
  /** Insert or replace a page (keeps createdAt). */
  saveAccount(account: InsertIgAccount): Promise<IgAccount>;
  updateAccount(id: string, patch: AccountPatch): Promise<void>;
  /** Gives rules, templates and posts without a page to this one. */
  assignOrphans(accountId: string): Promise<void>;
}

function ruleDefaults(rule: RuleInput, id: number, now: Date): ReplyRule {
  return {
    id,
    accountId: rule.accountId ?? null,
    name: rule.name,
    keywords: rule.keywords,
    channels: rule.channels,
    action: rule.action ?? "approval",
    template: rule.template,
    templateId: rule.templateId ?? null,
    dmTemplate: rule.dmTemplate ?? null,
    dmTemplateId: rule.dmTemplateId ?? null,
    mediaIds: rule.mediaIds ?? null,
    dmButtons: rule.dmButtons ?? null,
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
  private templates: ReplyTemplate[] = [];
  private media = new Map<string, IgMedia>();
  private accounts = new Map<string, IgAccount>();
  private nextId = 1;

  constructor(seedRules: RuleInput[] = DEFAULT_RULES, seedTemplates: TemplateInput[] = DEFAULT_TEMPLATES) {
    const now = new Date();
    this.rules = seedRules.map((rule) => ruleDefaults(rule, this.nextId++, now));
    this.templates = seedTemplates.map((t) => ({ id: this.nextId++, accountId: t.accountId ?? null, title: t.title, category: t.category ?? "", text: t.text, createdAt: now, updatedAt: now }));
  }

  async insertEvent(event: Omit<InsertIgEvent, "id">) {
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
      isRead: event.isRead ?? false,
      reaction: event.reaction ?? null,
      hidden: event.hidden ?? false,
      deleted: event.deleted ?? false,
      createdAt: event.createdAt ?? new Date(),
    };
    this.events.push(stored);
    return stored;
  }

  async getEvent(id: number) {
    return this.events.find((e) => e.id === id);
  }

  async listEvents(limit: number, accountId?: string) {
    return this.events
      .filter((e) => accountId === undefined || e.accountId === accountId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)
      .slice(0, limit);
  }

  async markRead(accountId: string, kind: IgEvent["kind"], senderId: string) {
    for (const e of this.events) if (e.accountId === accountId && e.kind === kind && e.senderId === senderId) e.isRead = true;
  }

  async setEventRule(id: number, ruleId: number | null) {
    const event = this.events.find((e) => e.id === id);
    if (event) event.ruleId = ruleId;
  }

  async setEventFlags(id: number, flags: EventFlags) {
    const event = this.events.find((e) => e.id === id);
    if (event) Object.assign(event, flags);
  }

  async findReplyByExternalId(externalId: string) {
    return this.replies.find((r) => r.externalId === externalId);
  }

  async findEvent(accountId: string, kind: IgEvent["kind"], externalId: string) {
    return this.events.find((e) => e.accountId === accountId && e.kind === kind && e.externalId === externalId);
  }

  async listRules(accountId?: string) {
    return this.rules.filter((r) => belongs(r.accountId, accountId));
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
      channel: reply.channel ?? "reply",
      text: reply.text,
      quickReplies: reply.quickReplies ?? null,
      status: reply.status ?? "pending",
      error: reply.error ?? null,
      decidedBy: reply.decidedBy ?? null,
      externalId: reply.externalId ?? null,
      customerReaction: reply.customerReaction ?? null,
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

  async deletePendingReplies(ids: number[]) {
    this.replies = this.replies.filter((r) => !(ids.includes(r.id) && r.status === "pending"));
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

  async listTemplates(accountId?: string) {
    return this.templates.filter((t) => belongs(t.accountId, accountId));
  }

  async createTemplate(template: TemplateInput) {
    const now = new Date();
    const stored: ReplyTemplate = { id: this.nextId++, accountId: template.accountId ?? null, title: template.title, category: template.category ?? "", text: template.text, createdAt: now, updatedAt: now };
    this.templates.push(stored);
    return stored;
  }

  async updateTemplate(id: number, patch: Partial<TemplateInput>) {
    const template = this.templates.find((t) => t.id === id);
    if (!template) return undefined;
    Object.assign(template, patch, { updatedAt: new Date() });
    return template;
  }

  async deleteTemplate(id: number) {
    this.templates = this.templates.filter((t) => t.id !== id);
  }

  async upsertMedia(media: MediaInput[]) {
    for (const m of media) {
      this.media.set(m.id, {
        id: m.id,
        accountId: m.accountId ?? null,
        caption: m.caption ?? null,
        mediaType: m.mediaType ?? null,
        mediaUrl: m.mediaUrl ?? null,
        thumbnailUrl: m.thumbnailUrl ?? null,
        permalink: m.permalink ?? null,
        postedAt: m.postedAt ?? null,
        commentsCount: m.commentsCount ?? null,
        syncedAt: new Date(),
      });
    }
  }

  async listMedia(accountId?: string) {
    return Array.from(this.media.values())
      .filter((m) => belongs(m.accountId, accountId))
      .sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0));
  }

  async listAccounts() {
    return Array.from(this.accounts.values()).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async getAccount(id: string) {
    return this.accounts.get(id);
  }

  async saveAccount(account: InsertIgAccount) {
    const previous = this.accounts.get(account.id);
    const stored: IgAccount = {
      id: account.id,
      username: account.username ?? null,
      name: account.name ?? null,
      token: account.token,
      tokenExpiresAt: account.tokenExpiresAt ?? null,
      tokenRefreshedAt: account.tokenRefreshedAt ?? null,
      lastError: account.lastError ?? null,
      enabled: account.enabled ?? true,
      createdAt: previous?.createdAt ?? new Date(),
    };
    this.accounts.set(account.id, stored);
    return stored;
  }

  async updateAccount(id: string, patch: AccountPatch) {
    const account = this.accounts.get(id);
    if (account) Object.assign(account, patch);
  }

  async assignOrphans(accountId: string) {
    for (const r of this.rules) r.accountId ??= accountId;
    for (const t of this.templates) t.accountId ??= accountId;
    for (const m of Array.from(this.media.values())) m.accountId ??= accountId;
  }
}

/** Rows of this page, plus rows from before pages existed. */
const ofAccount = (column: AnyColumn, accountId: string | undefined) => (accountId === undefined ? undefined : or(isNull(column), eq(column, accountId)));

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
  return {
    ...rule,
    keywords: parseJsonArray(rule.keywords),
    channels: parseJsonArray(rule.channels),
    mediaIds: rule.mediaIds == null ? null : parseJsonArray<string>(rule.mediaIds),
    dmButtons: rule.dmButtons == null ? null : parseJsonArray(rule.dmButtons),
  };
}

/** MariaDB returns JSON columns as strings. */
function normalizeReply(reply: Reply): Reply {
  return { ...reply, quickReplies: reply.quickReplies == null ? null : parseJsonArray(reply.quickReplies) };
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
  private templatesSeeded = false;

  constructor(private db: Db) {}

  async insertEvent(event: Omit<InsertIgEvent, "id">) {
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

  async listEvents(limit: number, accountId?: string) {
    return this.db
      .select()
      .from(igEvents)
      .where(accountId === undefined ? undefined : eq(igEvents.accountId, accountId))
      .orderBy(desc(igEvents.createdAt), desc(igEvents.id))
      .limit(limit);
  }

  async markRead(accountId: string, kind: IgEvent["kind"], senderId: string) {
    await this.db
      .update(igEvents)
      .set({ isRead: true })
      .where(and(eq(igEvents.accountId, accountId), eq(igEvents.kind, kind), eq(igEvents.senderId, senderId)));
  }

  async setEventRule(id: number, ruleId: number | null) {
    await this.db.update(igEvents).set({ ruleId }).where(eq(igEvents.id, id));
  }

  async setEventFlags(id: number, flags: EventFlags) {
    if (Object.keys(flags).length) await this.db.update(igEvents).set(flags).where(eq(igEvents.id, id));
  }

  async findEvent(accountId: string, kind: IgEvent["kind"], externalId: string) {
    const rows = await this.db
      .select()
      .from(igEvents)
      .where(and(eq(igEvents.accountId, accountId), eq(igEvents.kind, kind), eq(igEvents.externalId, externalId)))
      .limit(1);
    return rows[0];
  }

  async findReplyByExternalId(externalId: string) {
    const rows = await this.db.select().from(replies).where(eq(replies.externalId, externalId)).limit(1);
    return rows[0] ? normalizeReply(rows[0]) : undefined;
  }

  async listRules(accountId?: string) {
    const read = async () => (await this.db.select().from(replyRules).where(ofAccount(replyRules.accountId, accountId))).map(normalizeRule);
    const rows = await read();
    if (rows.length > 0 || this.seeded) return rows;
    this.seeded = true;
    // Only a brand-new install gets the starter rules; a new page starts empty (or copies another's).
    if ((await this.db.select({ id: replyRules.id }).from(replyRules).limit(1)).length) return rows;
    await this.db.insert(replyRules).values(DEFAULT_RULES.map((r) => ({ ...r, accountId: accountId ?? null })));
    return read();
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
    return normalizeReply(rows[0]);
  }

  async getReply(id: number) {
    const rows = await this.db.select().from(replies).where(eq(replies.id, id)).limit(1);
    return rows[0] ? normalizeReply(rows[0]) : undefined;
  }

  async updateReply(id: number, patch: ReplyPatch) {
    await this.db.update(replies).set(patch).where(eq(replies.id, id));
  }

  async deletePendingReplies(ids: number[]) {
    if (!ids.length) return;
    await this.db.delete(replies).where(and(inArray(replies.id, ids), eq(replies.status, "pending")));
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
    const rows = await this.db
      .select()
      .from(replies)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(replies.createdAt));
    return rows.map(normalizeReply);
  }

  async listTemplates(accountId?: string) {
    const read = () => this.db.select().from(replyTemplates).where(ofAccount(replyTemplates.accountId, accountId)).orderBy(replyTemplates.id);
    const rows = await read();
    if (rows.length > 0 || this.templatesSeeded) return rows;
    this.templatesSeeded = true;
    if ((await this.db.select({ id: replyTemplates.id }).from(replyTemplates).limit(1)).length) return rows;
    await this.db.insert(replyTemplates).values(DEFAULT_TEMPLATES.map((t) => ({ ...t, accountId: accountId ?? null })));
    return read();
  }

  async createTemplate(template: TemplateInput) {
    const [{ id }] = await this.db.insert(replyTemplates).values(template).$returningId();
    const rows = await this.db.select().from(replyTemplates).where(eq(replyTemplates.id, id)).limit(1);
    return rows[0];
  }

  async updateTemplate(id: number, patch: Partial<TemplateInput>) {
    await this.db.update(replyTemplates).set(patch).where(eq(replyTemplates.id, id));
    const rows = await this.db.select().from(replyTemplates).where(eq(replyTemplates.id, id)).limit(1);
    return rows[0];
  }

  async deleteTemplate(id: number) {
    this.templatesSeeded = true;
    await this.db.delete(replyTemplates).where(eq(replyTemplates.id, id));
  }

  async upsertMedia(media: MediaInput[]) {
    for (const m of media) {
      const { id, ...rest } = m;
      await this.db.insert(igMedia).values(m).onDuplicateKeyUpdate({ set: rest });
    }
  }

  async listMedia(accountId?: string) {
    return this.db.select().from(igMedia).where(ofAccount(igMedia.accountId, accountId)).orderBy(desc(igMedia.postedAt));
  }

  async listAccounts() {
    return this.db.select().from(igAccounts).orderBy(igAccounts.createdAt);
  }

  async getAccount(id: string) {
    const rows = await this.db.select().from(igAccounts).where(eq(igAccounts.id, id)).limit(1);
    return rows[0];
  }

  async saveAccount(account: InsertIgAccount) {
    const { id, createdAt: _, ...rest } = account;
    await this.db.insert(igAccounts).values(account).onDuplicateKeyUpdate({ set: rest });
    return (await this.getAccount(id))!;
  }

  async updateAccount(id: string, patch: AccountPatch) {
    if (Object.keys(patch).length) await this.db.update(igAccounts).set(patch).where(eq(igAccounts.id, id));
  }

  async assignOrphans(accountId: string) {
    await this.db.update(replyRules).set({ accountId }).where(isNull(replyRules.accountId));
    await this.db.update(replyTemplates).set({ accountId }).where(isNull(replyTemplates.accountId));
    await this.db.update(igMedia).set({ accountId }).where(isNull(igMedia.accountId));
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
