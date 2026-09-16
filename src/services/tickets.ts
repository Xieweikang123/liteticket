import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import {
  attachments,
  commentMentions,
  comments,
  menus,
  roles,
  tags,
  ticketEvents,
  ticketTags,
  tickets,
  tokens,
  users,
} from '../db/schema.ts';
import type {
  Attachment,
  Comment,
  Menu,
  Permission,
  Role,
  Ticket,
  TicketEvent,
  User,
} from '../db/schema.ts';
import { hashPassword } from '../auth.ts';
import { nowIso } from '../time.ts';

/** Who performed a mutating action — used for the ticket change timeline. */
export interface Actor {
  id: number | null;
  name: string | null;
}

/** Cap a single upload so a runaway client cannot fill the disk. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Soft cap per ticket; enough for screenshots and logs without unbounded growth. */
export const MAX_ATTACHMENTS_PER_TICKET = 50;

/**
 * Read a Blob/File with a hard byte ceiling. Aborts the stream as soon as the
 * cap is exceeded so an oversized part is not held as one contiguous buffer.
 */
export async function readBlobCapped(
  blob: Blob,
  maxBytes: number,
): Promise<{ ok: true; data: Uint8Array } | { ok: false; error: 'too_large' }> {
  // Declared size is authoritative when present; skip streaming an oversize part.
  if (typeof blob.size === 'number' && blob.size > maxBytes) {
    return { ok: false, error: 'too_large' };
  }

  const reader = blob.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, error: 'too_large' };
    }
    chunks.push(value);
  }

  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, data };
}

/**
 * Metadata safe to return over the API. `storedName` is an opaque on-disk key
 * and must never leave the server — downloads are addressed by attachment id.
 */
export type PublicAttachment = Omit<Attachment, 'storedName'>;

const PUBLIC_ATTACHMENT_COLUMNS = {
  id: attachments.id,
  ticketId: attachments.ticketId,
  filename: attachments.filename,
  contentType: attachments.contentType,
  size: attachments.size,
  uploadedById: attachments.uploadedById,
  createdAt: attachments.createdAt,
};

export interface TicketWithMeta extends Ticket {
  assigneeName: string | null;
  tags: string[];
  commentCount: number;
  /** Set when the list/detail call knows the viewer; false for machine tokens. */
  mentionedMe: boolean;
  /** True when the viewer has at least one unread mention on this ticket. */
  mentionUnread: boolean;
}

/** A resolved @username target, safe to embed on a comment. */
export interface MentionRef {
  userId: number;
  username: string;
  name: string;
}

export interface CommentWithMentions extends Comment {
  mentions: MentionRef[];
}

export type TicketSort = 'updated' | 'priority' | 'id';

export interface ListOptions {
  status?: 'open' | 'pending' | 'closed';
  assigneeId?: number;
  tag?: string;
  /** Free text over subject + body + requester. */
  q?: string;
  /** Defaults to `updated`; the list page exposes these as sortable headers. */
  sort?: TicketSort;
  /** Defaults to `desc`. */
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  /**
   * Restrict to tickets where this user was @-mentioned in a comment.
   * Driven by `?mentioned=me` on the list route.
   */
  mentionedUserId?: number;
  /** With `mentionedUserId`, keep only tickets that still have an unread mention. */
  mentionUnread?: boolean;
  /** Viewer for `mentionedMe` / `mentionUnread` hydration; omit for machine tokens. */
  viewerUserId?: number;
}

async function hydrate(
  db: Db,
  rows: Ticket[],
  viewerUserId?: number,
): Promise<TicketWithMeta[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const tagRows = await db
    .select({ ticketId: ticketTags.ticketId, name: tags.name })
    .from(ticketTags)
    .innerJoin(tags, eq(tags.id, ticketTags.tagId))
    .where(inArray(ticketTags.ticketId, ids));

  const tagsByTicket = new Map<number, string[]>();
  for (const r of tagRows) {
    const list = tagsByTicket.get(r.ticketId) ?? [];
    list.push(r.name);
    tagsByTicket.set(r.ticketId, list);
  }

  const countRows = await db
    .select({ ticketId: comments.ticketId, n: sql<number>`count(*)` })
    .from(comments)
    .where(inArray(comments.ticketId, ids))
    .groupBy(comments.ticketId);

  const counts = new Map<number, number>();
  for (const r of countRows) counts.set(r.ticketId, Number(r.n));

  const assigneeIds = [
    ...new Set(rows.map((r) => r.assigneeId).filter((v): v is number => v != null)),
  ];
  const names = new Map<number, string>();
  if (assigneeIds.length > 0) {
    const userRows = await db.select().from(users).where(inArray(users.id, assigneeIds));
    for (const u of userRows) names.set(u.id, u.name);
  }

  const mentioned = new Set<number>();
  const unread = new Set<number>();
  if (viewerUserId != null) {
    const mentionRows = await db
      .select({
        ticketId: commentMentions.ticketId,
        readAt: commentMentions.readAt,
      })
      .from(commentMentions)
      .where(
        and(
          eq(commentMentions.userId, viewerUserId),
          inArray(commentMentions.ticketId, ids),
        ),
      );
    for (const r of mentionRows) {
      mentioned.add(r.ticketId);
      if (r.readAt == null) unread.add(r.ticketId);
    }
  }

  return rows.map((r) => ({
    ...r,
    assigneeName: r.assigneeId != null ? (names.get(r.assigneeId) ?? null) : null,
    tags: (tagsByTicket.get(r.id) ?? []).sort(),
    commentCount: counts.get(r.id) ?? 0,
    mentionedMe: mentioned.has(r.id),
    mentionUnread: unread.has(r.id),
  }));
}

export async function listTickets(
  db: Db,
  opts: ListOptions = {},
): Promise<{ items: TicketWithMeta[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const filters = [];
  if (opts.status) filters.push(eq(tickets.status, opts.status));
  if (opts.assigneeId != null) filters.push(eq(tickets.assigneeId, opts.assigneeId));
  if (opts.q) {
    const needle = `%${opts.q}%`;
    filters.push(
      or(
        like(tickets.subject, needle),
        like(tickets.body, needle),
        like(tickets.requesterEmail, needle),
      )!,
    );
  }
  if (opts.tag) {
    const sub = db
      .select({ ticketId: ticketTags.ticketId })
      .from(ticketTags)
      .innerJoin(tags, eq(tags.id, ticketTags.tagId))
      .where(eq(tags.name, opts.tag));
    filters.push(inArray(tickets.id, sub));
  }
  if (opts.mentionedUserId != null) {
    const mentionFilters = [eq(commentMentions.userId, opts.mentionedUserId)];
    if (opts.mentionUnread) mentionFilters.push(isNull(commentMentions.readAt));
    const sub = db
      .select({ ticketId: commentMentions.ticketId })
      .from(commentMentions)
      .where(and(...mentionFilters));
    filters.push(inArray(tickets.id, sub));
  }

  const where = filters.length > 0 ? and(...filters) : undefined;

  const dir = opts.order === 'asc' ? asc : desc;
  // `priority` has no natural SQL order — the enum is alphabetical on disk, so
  // a plain `desc` would sort `urgent` below `normal`. Rank it instead.
  const priorityRank = sql`case ${tickets.priority}
    when 'urgent' then 4 when 'high' then 3 when 'normal' then 2 else 1 end`;

  const order =
    opts.sort === 'priority'
      ? [dir(priorityRank), desc(tickets.updatedAt), desc(tickets.id)]
      : opts.sort === 'id'
        ? [dir(tickets.id)]
        : [dir(tickets.updatedAt), desc(tickets.id)];

  const rows = await db
    .select()
    .from(tickets)
    .where(where)
    .orderBy(...order)
    .limit(limit)
    .offset(offset);

  const totalRow = (
    await db.select({ n: sql<number>`count(*)` }).from(tickets).where(where)
  )[0];

  return {
    items: await hydrate(db, rows, opts.viewerUserId),
    total: Number(totalRow?.n ?? 0),
  };
}

export async function getTicket(
  db: Db,
  id: number,
  viewerUserId?: number,
): Promise<TicketWithMeta | null> {
  const rows = await db.select().from(tickets).where(eq(tickets.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return (await hydrate(db, [row], viewerUserId))[0] ?? null;
}

export interface CreateTicketInput {
  subject: string;
  body?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  requesterEmail: string;
  requesterName?: string | null;
  assigneeId?: number | null;
  tags?: string[];
}

export async function createTicket(db: Db, input: CreateTicketInput): Promise<TicketWithMeta> {
  const now = nowIso();
  const id = await db.transaction(async (tx) => {
    const created = (
      await tx
        .insert(tickets)
        .values({
          subject: input.subject,
          body: input.body ?? '',
          priority: input.priority ?? 'normal',
          status: 'open',
          requesterEmail: input.requesterEmail,
          requesterName: input.requesterName ?? null,
          assigneeId: input.assigneeId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
    )[0]!;

    if (input.tags?.length) await setTags(tx, created.id, input.tags);
    return created.id;
  });

  return (await getTicket(db, id))!;
}

export type TicketPatch = Partial<{
  subject: string;
  body: string;
  status: 'open' | 'pending' | 'closed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  assigneeId: number | null;
  tags: string[];
}>;

export async function updateTicket(
  db: Db,
  id: number,
  patch: TicketPatch,
  actor: Actor = { id: null, name: null },
): Promise<TicketWithMeta | null> {
  const existing = (await db.select().from(tickets).where(eq(tickets.id, id)).limit(1))[0];
  if (!existing) return null;

  const now = nowIso();
  const values: Record<string, unknown> = { updatedAt: now };
  const pendingEvents: { field: string; fromValue: string | null; toValue: string | null }[] = [];

  if (patch.subject !== undefined && patch.subject !== existing.subject) {
    values.subject = patch.subject;
    pendingEvents.push({
      field: 'subject',
      fromValue: existing.subject,
      toValue: patch.subject,
    });
  }
  if (patch.body !== undefined) values.body = patch.body;
  if (patch.priority !== undefined && patch.priority !== existing.priority) {
    values.priority = patch.priority;
    pendingEvents.push({
      field: 'priority',
      fromValue: existing.priority,
      toValue: patch.priority,
    });
  }
  if (patch.assigneeId !== undefined && patch.assigneeId !== existing.assigneeId) {
    values.assigneeId = patch.assigneeId;
    const fromName = await resolveUserLabel(db, existing.assigneeId);
    const toName = await resolveUserLabel(db, patch.assigneeId);
    pendingEvents.push({ field: 'assignee', fromValue: fromName, toValue: toName });
  }

  if (patch.status !== undefined && patch.status !== existing.status) {
    values.status = patch.status;
    // closedAt is derived, never client-supplied — otherwise it drifts out of
    // sync with status the moment a ticket is reopened.
    values.closedAt = patch.status === 'closed' ? (existing.closedAt ?? now) : null;
    pendingEvents.push({
      field: 'status',
      fromValue: existing.status,
      toValue: patch.status,
    });
  }

  if (patch.tags !== undefined) {
    const before = (await getTicket(db, id))!.tags;
    const after = [...new Set(patch.tags.map((n) => n.trim()).filter(Boolean))].sort();
    const beforeKey = before.slice().sort().join(', ');
    const afterKey = after.join(', ');
    if (beforeKey !== afterKey) {
      pendingEvents.push({
        field: 'tags',
        fromValue: beforeKey || null,
        toValue: afterKey || null,
      });
    }
  }

  await db.transaction(async (tx) => {
    await tx.update(tickets).set(values).where(eq(tickets.id, id));
    if (patch.tags !== undefined) await setTags(tx, id, patch.tags);
    if (pendingEvents.length > 0) {
      await tx.insert(ticketEvents).values(
        pendingEvents.map((e) => ({
          ticketId: id,
          field: e.field,
          fromValue: e.fromValue,
          toValue: e.toValue,
          actorId: actor.id,
          actorName: actor.name,
          createdAt: now,
        })),
      );
    }
  });

  return getTicket(db, id);
}

/**
 * Remove the ticket row (cascading comments / tags / attachments / events) and
 * the on-disk attachment directory. The directory wipe is best-effort after the
 * DB commit: a leftover empty folder is harmless; a deleted row with orphaned
 * files would be worse, so the database goes first.
 */
export async function deleteTicket(
  db: Db,
  id: number,
  attachmentsDir?: string,
): Promise<boolean> {
  const existing = (await db.select().from(tickets).where(eq(tickets.id, id)).limit(1))[0];
  if (!existing) return false;
  await db.delete(tickets).where(eq(tickets.id, id));
  if (attachmentsDir) {
    await rm(ticketAttachDir(attachmentsDir, id), { recursive: true, force: true }).catch(() => {
      /* directory may not exist */
    });
  }
  return true;
}

async function resolveUserLabel(db: Db, userId: number | null | undefined): Promise<string | null> {
  if (userId == null) return null;
  const user = await getUser(db, userId);
  return user?.name ?? `#${userId}`;
}

export async function listTicketEvents(db: Db, ticketId: number): Promise<TicketEvent[]> {
  return db
    .select()
    .from(ticketEvents)
    .where(eq(ticketEvents.ticketId, ticketId))
    .orderBy(desc(ticketEvents.createdAt), desc(ticketEvents.id));
}

/**
 * A connection that can run statements: the pooled database, or the transaction
 * handle passed to a `db.transaction` callback. `setTags` must accept both so
 * it can take part in a caller's transaction instead of running beside it.
 */
type Executor = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function setTags(db: Executor, ticketId: number, names: string[]): Promise<void> {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];

  // Replace the set in a fixed number of statements rather than one query per
  // tag: resolve existing ids and missing names up front, insert only what is
  // new, then relink. `delete` and the inserts run inside the caller's
  // transaction, so a failure cannot leave the ticket with no tags.
  await db.delete(ticketTags).where(eq(ticketTags.ticketId, ticketId));
  if (clean.length === 0) return;

  const existing = await db.select().from(tags).where(inArray(tags.name, clean));
  const have = new Set(existing.map((t) => t.name));
  const missing = clean.filter((n) => !have.has(n)).map((name) => ({ name }));

  const inserted = missing.length
    ? await db.insert(tags).values(missing).onConflictDoNothing().returning()
    : [];

  const byName = new Map([...existing, ...inserted].map((t) => [t.name, t.id]));
  const links = clean
    .map((name) => byName.get(name))
    .filter((tagId): tagId is number => tagId != null)
    .map((tagId) => ({ ticketId, tagId }));

  if (links.length > 0) await db.insert(ticketTags).values(links).onConflictDoNothing();
}

export async function listComments(
  db: Db,
  ticketId: number,
  opts: { includeInternal?: boolean } = {},
): Promise<CommentWithMentions[]> {
  const filters = [eq(comments.ticketId, ticketId)];
  // The load-bearing line for the internal-note guarantee.
  if (!opts.includeInternal) filters.push(eq(comments.isInternal, false));

  const rows = await db
    .select()
    .from(comments)
    .where(and(...filters))
    .orderBy(comments.createdAt, comments.id);

  return attachMentions(db, rows);
}

/**
 * Username charset matches the login identifier. A leading boundary keeps
 * `user@example.com` from being treated as a mention of `example.com`.
 */
const MENTION_RE = /(?:^|[^a-zA-Z0-9._-])@([a-zA-Z0-9._-]+)/g;

/** Unique `@username` tokens from a comment body, in first-seen order. */
export function extractMentionUsernames(body: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  MENTION_RE.lastIndex = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    const name = m[1]!;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(name);
  }
  return found;
}

async function attachMentions(db: Db, rows: Comment[]): Promise<CommentWithMentions[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const links = await db
    .select({
      commentId: commentMentions.commentId,
      userId: users.id,
      username: users.username,
      name: users.name,
    })
    .from(commentMentions)
    .innerJoin(users, eq(users.id, commentMentions.userId))
    .where(inArray(commentMentions.commentId, ids));

  const byComment = new Map<number, MentionRef[]>();
  for (const r of links) {
    const list = byComment.get(r.commentId) ?? [];
    list.push({ userId: r.userId, username: r.username, name: r.name });
    byComment.set(r.commentId, list);
  }

  return rows.map((r) => ({
    ...r,
    mentions: (byComment.get(r.id) ?? []).sort((a, b) =>
      a.username.localeCompare(b.username),
    ),
  }));
}

export interface CreateCommentInput {
  body: string;
  isInternal?: boolean;
  authorId?: number | null;
  authorEmail?: string | null;
}

export async function addComment(
  db: Db,
  ticketId: number,
  input: CreateCommentInput,
): Promise<CommentWithMentions | null> {
  const ticket = (
    await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1)
  )[0];
  if (!ticket) return null;

  const now = nowIso();
  const usernames = extractMentionUsernames(input.body);
  // Resolve by exact username; unknown tokens are left as plain text.
  const mentionedUsers =
    usernames.length > 0
      ? await db
          .select({ id: users.id, username: users.username, name: users.name })
          .from(users)
          .where(inArray(users.username, usernames))
      : [];

  // Self-mentions are noise for the "mentioned me" badge; skip storing them.
  const targets = mentionedUsers.filter((u) => u.id !== input.authorId);

  const created = await db.transaction(async (tx) => {
    const row = (
      await tx
        .insert(comments)
        .values({
          ticketId,
          body: input.body,
          isInternal: input.isInternal ?? false,
          authorId: input.authorId ?? null,
          authorEmail: input.authorEmail ?? null,
          createdAt: now,
        })
        .returning()
    )[0]!;

    if (targets.length > 0) {
      await tx.insert(commentMentions).values(
        targets.map((u) => ({
          commentId: row.id,
          ticketId,
          userId: u.id,
          createdAt: now,
        })),
      );
    }

    // A reply bumps updatedAt so list ordering reflects real activity.
    await tx.update(tickets).set({ updatedAt: now }).where(eq(tickets.id, ticketId));
    return row;
  });

  return {
    ...created,
    mentions: targets
      .map((u) => ({ userId: u.id, username: u.username, name: u.name }))
      .sort((a, b) => a.username.localeCompare(b.username)),
  };
}

/**
 * Mark every unread mention of `userId` on this ticket as read. Opening the
 * ticket is the only read signal — there is no per-comment inbox.
 */
export async function markMentionsRead(
  db: Db,
  ticketId: number,
  userId: number,
): Promise<number> {
  const now = nowIso();
  const updated = await db
    .update(commentMentions)
    .set({ readAt: now })
    .where(
      and(
        eq(commentMentions.ticketId, ticketId),
        eq(commentMentions.userId, userId),
        isNull(commentMentions.readAt),
      ),
    )
    .returning({ id: commentMentions.id });
  return updated.length;
}

/**
 * The user shape safe to return over the API or render in the UI. `passwordHash`
 * is deliberately absent — it is never selected, so it cannot leak by accident.
 */
export type PublicUser = Omit<User, 'passwordHash'>;

const PUBLIC_USER_COLUMNS = {
  id: users.id,
  username: users.username,
  email: users.email,
  name: users.name,
  role: users.role,
  createdAt: users.createdAt,
};

export async function listUsers(db: Db): Promise<PublicUser[]> {
  return db.select(PUBLIC_USER_COLUMNS).from(users).orderBy(users.name);
}

export async function getUser(db: Db, id: number): Promise<PublicUser | null> {
  const rows = await db.select(PUBLIC_USER_COLUMNS).from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Full row including the password hash — for authentication only. */
export async function getUserForAuth(db: Db, username: string) {
  const rows = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return rows[0] ?? null;
}

/** Full row by id, including the password hash — for session validation. */
export async function getUserByIdForAuth(db: Db, id: number) {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getUserByUsername(db: Db, username: string): Promise<PublicUser | null> {
  const rows = await db
    .select(PUBLIC_USER_COLUMNS)
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  return rows[0] ?? null;
}

export async function getUserByEmail(db: Db, email: string): Promise<PublicUser | null> {
  const rows = await db.select(PUBLIC_USER_COLUMNS).from(users).where(eq(users.email, email)).limit(1);
  return rows[0] ?? null;
}

export interface CreateUserInput {
  username: string;
  email: string;
  name: string;
  /** A role name; falls back to `agent` when omitted. */
  role?: string;
  password?: string;
}

/**
 * Returns the existing user when the username is already taken, so the
 * operation is idempotent. Use `getUserByUsername` when a duplicate must be an
 * error.
 */
export async function createUser(db: Db, input: CreateUserInput): Promise<PublicUser> {
  const existing = await getUserByUsername(db, input.username);
  if (existing) return existing;

  const inserted = (
    await db
      .insert(users)
      .values({
        username: input.username,
        email: input.email,
        name: input.name,
        role: input.role ?? 'agent',
        passwordHash: input.password ? hashPassword(input.password) : null,
      })
      .returning(PUBLIC_USER_COLUMNS)
  )[0]!;
  return inserted;
}

export interface UpdateUserInput {
  username?: string;
  email?: string;
  name?: string;
  /** A role name; validated against the roles table by the caller. */
  role?: string;
  password?: string;
}

export async function updateUser(
  db: Db,
  id: number,
  patch: UpdateUserInput,
): Promise<PublicUser | null> {
  const existing = await getUser(db, id);
  if (!existing) return null;

  const values: Record<string, unknown> = {};
  if (patch.username !== undefined) values.username = patch.username;
  if (patch.email !== undefined) values.email = patch.email;
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.role !== undefined) values.role = patch.role;

  const changingPassword = patch.password !== undefined && patch.password.length > 0;
  if (changingPassword) {
    values.passwordHash = hashPassword(patch.password!);
  }

  if (Object.keys(values).length > 0) {
    await db.update(users).set(values).where(eq(users.id, id));
  }

  /**
   * Changing a password revokes every token issued under the old one.
   *
   * Without this, a password change would be cosmetic: an attacker holding a
   * token minted from the compromised password would keep access indefinitely,
   * because tokens are looked up by hash and never re-checked against the
   * password. This is the token-based equivalent of "log out everywhere".
   */
  if (changingPassword) {
    await db.delete(tokens).where(eq(tokens.userId, id));
  }

  return getUser(db, id);
}

/**
 * Tickets and comments reference users with ON DELETE SET NULL, so removing a
 * user unassigns their tickets and leaves comment attribution null rather than
 * deleting the ticket history.
 */
export async function deleteUser(db: Db, id: number): Promise<boolean> {
  const existing = await getUser(db, id);
  if (!existing) return false;
  await db.delete(users).where(eq(users.id, id));
  return true;
}

/**
 * Count users who can administer roles, so the last one cannot be demoted,
 * deleted, or have their role stripped of `roles.manage`. This is the lockout
 * guard — losing the final role manager would leave no one able to grant it
 * back.
 *
 * Permissions live in a JSON column, so the filter happens in JS rather than
 * SQL; the users table is small and this only runs on a privileged write.
 */
export async function countRoleManagers(db: Db, excludeId?: number): Promise<number> {
  const rows = await db
    .select({ id: users.id, permissions: roles.permissions })
    .from(users)
    .innerJoin(roles, eq(roles.name, users.role));
  return rows.filter(
    (r) => r.id !== excludeId && r.permissions.includes('roles.manage'),
  ).length;
}

// ---- roles ----------------------------------------------------------------

export async function listRoles(db: Db): Promise<Role[]> {
  return db.select().from(roles).orderBy(desc(roles.isSystem), roles.name);
}

export async function getRole(db: Db, id: number): Promise<Role | null> {
  const rows = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getRoleByName(db: Db, name: string): Promise<Role | null> {
  const rows = await db.select().from(roles).where(eq(roles.name, name)).limit(1);
  return rows[0] ?? null;
}

/** Users currently assigned a role, for the "role still in use" guards. */
export async function listUsersByRole(db: Db, name: string): Promise<PublicUser[]> {
  return db.select(PUBLIC_USER_COLUMNS).from(users).where(eq(users.role, name));
}

/**
 * Count role managers whose role is *not* `name`. Used when a role is about to
 * lose `roles.manage`: if no manager exists outside it, the edit would strand
 * the instance with no one able to grant the permission back.
 */
export async function countRoleManagersExcludingRole(db: Db, name: string): Promise<number> {
  const rows = await db
    .select({ role: users.role, permissions: roles.permissions })
    .from(users)
    .innerJoin(roles, eq(roles.name, users.role));
  return rows.filter(
    (r) => r.role !== name && r.permissions.includes('roles.manage'),
  ).length;
}

export interface CreateRoleInput {
  name: string;
  label: string;
  description?: string | null;
  permissions: Permission[];
}

export async function createRole(db: Db, input: CreateRoleInput): Promise<Role> {
  return (
    await db
      .insert(roles)
      .values({
        name: input.name,
        label: input.label,
        description: input.description ?? null,
        permissions: input.permissions,
      })
      .returning()
  )[0]!;
}

export interface UpdateRoleInput {
  label?: string;
  description?: string | null;
  permissions?: Permission[];
}

export async function updateRole(
  db: Db,
  id: number,
  patch: UpdateRoleInput,
): Promise<Role | null> {
  const existing = await getRole(db, id);
  if (!existing) return null;

  const values: Record<string, unknown> = {};
  if (patch.label !== undefined) values.label = patch.label;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.permissions !== undefined) values.permissions = patch.permissions;

  if (Object.keys(values).length > 0) {
    await db.update(roles).set(values).where(eq(roles.id, id));
  }
  return getRole(db, id);
}

export async function deleteRole(db: Db, id: number): Promise<boolean> {
  const existing = await getRole(db, id);
  if (!existing) return false;
  await db.delete(roles).where(eq(roles.id, id));
  return true;
}

export async function listTags(db: Db) {
  return db.select().from(tags).orderBy(tags.name);
}

// ---- menus ----------------------------------------------------------------

export async function listMenus(db: Db): Promise<Menu[]> {
  return db.select().from(menus).orderBy(asc(menus.sort), asc(menus.id));
}

export async function getMenu(db: Db, id: number): Promise<Menu | null> {
  const rows = await db.select().from(menus).where(eq(menus.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getMenuByName(db: Db, name: string): Promise<Menu | null> {
  const rows = await db.select().from(menus).where(eq(menus.name, name)).limit(1);
  return rows[0] ?? null;
}

export interface CreateMenuInput {
  name: string;
  label: string;
  path: string;
  permission?: Permission | null;
  sort?: number;
  visible?: boolean;
}

export async function createMenu(db: Db, input: CreateMenuInput): Promise<Menu> {
  return (
    await db
      .insert(menus)
      .values({
        name: input.name,
        label: input.label,
        path: input.path,
        permission: input.permission ?? null,
        sort: input.sort ?? 0,
        visible: input.visible ?? true,
      })
      .returning()
  )[0]!;
}

/**
 * A custom menu may change everything, including `name`: unlike a role key,
 * nothing references a menu row, so renaming is not a cascade.
 */
export interface UpdateMenuInput {
  name?: string;
  label?: string;
  path?: string;
  permission?: Permission | null;
  sort?: number;
  visible?: boolean;
}

export async function updateMenu(
  db: Db,
  id: number,
  patch: UpdateMenuInput,
): Promise<Menu | null> {
  const existing = await getMenu(db, id);
  if (!existing) return null;

  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.label !== undefined) values.label = patch.label;
  if (patch.path !== undefined) values.path = patch.path;
  if (patch.permission !== undefined) values.permission = patch.permission;
  if (patch.sort !== undefined) values.sort = patch.sort;
  if (patch.visible !== undefined) values.visible = patch.visible;

  if (Object.keys(values).length > 0) {
    await db.update(menus).set(values).where(eq(menus.id, id));
  }
  return getMenu(db, id);
}

export async function deleteMenu(db: Db, id: number): Promise<boolean> {
  const existing = await getMenu(db, id);
  if (!existing) return false;
  await db.delete(menus).where(eq(menus.id, id));
  return true;
}

export async function stats(db: Db) {
  const rows = await db
    .select({ status: tickets.status, n: sql<number>`count(*)` })
    .from(tickets)
    .groupBy(tickets.status);

  const out: Record<string, number> = { open: 0, pending: 0, closed: 0, total: 0 };
  for (const r of rows) {
    const n = Number(r.n);
    out[r.status] = n;
    out.total = (out.total ?? 0) + n;
  }
  return out as { open: number; pending: number; closed: number; total: number };
}

// ---- attachments ----------------------------------------------------------

function ticketAttachDir(root: string, ticketId: number): string {
  return join(root, String(ticketId));
}

function attachmentPath(root: string, ticketId: number, storedName: string): string {
  return join(ticketAttachDir(root, ticketId), storedName);
}

/**
 * Keep a usable display name without letting path separators or control
 * characters into Content-Disposition or the database.
 */
export function sanitizeFilename(name: string): string {
  const base = name.replace(/^.*[/\\]/, '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  const cleaned = base.replace(/[<>:"|?*]/g, '_');
  return (cleaned || 'file').slice(0, 200);
}

export async function listAttachments(db: Db, ticketId: number): Promise<PublicAttachment[]> {
  return db
    .select(PUBLIC_ATTACHMENT_COLUMNS)
    .from(attachments)
    .where(eq(attachments.ticketId, ticketId))
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
}

export interface AddAttachmentInput {
  filename: string;
  contentType?: string;
  data: Uint8Array;
  uploadedById?: number | null;
}

export type AddAttachmentResult =
  | { ok: true; attachment: PublicAttachment }
  | { ok: false; error: 'ticket_not_found' | 'too_large' | 'too_many' | 'empty' };

/**
 * Persist bytes under `{root}/{ticketId}/{storedName}` and insert the metadata
 * row. The file is written before the insert so a failed write never leaves a
 * dangling row; a failed insert leaves an orphan file that a later upload to
 * the same ticket can coexist with (stored names are unique random keys).
 */
export async function addAttachment(
  db: Db,
  ticketId: number,
  root: string,
  input: AddAttachmentInput,
): Promise<AddAttachmentResult> {
  if (!(await getTicket(db, ticketId))) return { ok: false, error: 'ticket_not_found' };
  if (input.data.byteLength === 0) return { ok: false, error: 'empty' };
  if (input.data.byteLength > MAX_ATTACHMENT_BYTES) return { ok: false, error: 'too_large' };

  const existing = await db
    .select({ n: sql<number>`count(*)` })
    .from(attachments)
    .where(eq(attachments.ticketId, ticketId));
  if (Number(existing[0]?.n ?? 0) >= MAX_ATTACHMENTS_PER_TICKET) {
    return { ok: false, error: 'too_many' };
  }

  const filename = sanitizeFilename(input.filename);
  const storedName = randomBytes(16).toString('hex');
  const contentType =
    (input.contentType && input.contentType.trim()) || 'application/octet-stream';
  const dir = ticketAttachDir(root, ticketId);
  await mkdir(dir, { recursive: true });
  await writeFile(attachmentPath(root, ticketId, storedName), input.data);

  const now = nowIso();
  const created = (
    await db
      .insert(attachments)
      .values({
        ticketId,
        filename,
        storedName,
        contentType: contentType.slice(0, 200),
        size: input.data.byteLength,
        uploadedById: input.uploadedById ?? null,
        createdAt: now,
      })
      .returning(PUBLIC_ATTACHMENT_COLUMNS)
  )[0]!;

  await db.update(tickets).set({ updatedAt: now }).where(eq(tickets.id, ticketId));
  return { ok: true, attachment: created };
}

export async function getAttachment(
  db: Db,
  ticketId: number,
  attachmentId: number,
): Promise<Attachment | null> {
  const rows = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.ticketId, ticketId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function readAttachmentFile(
  db: Db,
  ticketId: number,
  attachmentId: number,
  root: string,
): Promise<{ meta: PublicAttachment; data: Buffer } | null> {
  const row = await getAttachment(db, ticketId, attachmentId);
  if (!row) return null;
  const data = await readFile(attachmentPath(root, ticketId, row.storedName));
  const { storedName: _omit, ...meta } = row;
  return { meta, data };
}

export async function deleteAttachment(
  db: Db,
  ticketId: number,
  attachmentId: number,
  root: string,
): Promise<boolean> {
  const row = await getAttachment(db, ticketId, attachmentId);
  if (!row) return false;

  await db.delete(attachments).where(eq(attachments.id, attachmentId));
  await unlink(attachmentPath(root, ticketId, row.storedName)).catch(() => {
    /* file may already be gone */
  });
  await db.update(tickets).set({ updatedAt: nowIso() }).where(eq(tickets.id, ticketId));
  return true;
}
