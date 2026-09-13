import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { comments, tags, ticketTags, tickets, tokens, users } from '../db/schema.ts';
import type { Comment, Ticket, User } from '../db/schema.ts';
import { hashPassword } from '../auth.ts';

export interface TicketWithMeta extends Ticket {
  assigneeName: string | null;
  tags: string[];
  commentCount: number;
}

export interface ListOptions {
  status?: 'open' | 'pending' | 'closed';
  assigneeId?: number;
  tag?: string;
  /** Free text over subject + body + requester. */
  q?: string;
  limit?: number;
  offset?: number;
}

async function hydrate(db: Db, rows: Ticket[]): Promise<TicketWithMeta[]> {
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

  return rows.map((r) => ({
    ...r,
    assigneeName: r.assigneeId != null ? (names.get(r.assigneeId) ?? null) : null,
    tags: (tagsByTicket.get(r.id) ?? []).sort(),
    commentCount: counts.get(r.id) ?? 0,
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

  const where = filters.length > 0 ? and(...filters) : undefined;

  const rows = await db
    .select()
    .from(tickets)
    .where(where)
    .orderBy(desc(tickets.updatedAt), desc(tickets.id))
    .limit(limit)
    .offset(offset);

  const totalRow = (
    await db.select({ n: sql<number>`count(*)` }).from(tickets).where(where)
  )[0];

  return { items: await hydrate(db, rows), total: Number(totalRow?.n ?? 0) };
}

export async function getTicket(db: Db, id: number): Promise<TicketWithMeta | null> {
  const rows = await db.select().from(tickets).where(eq(tickets.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return (await hydrate(db, [row]))[0] ?? null;
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
  const now = new Date().toISOString();
  const created = (
    await db
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

  if (input.tags?.length) await setTags(db, created.id, input.tags);
  return (await getTicket(db, created.id))!;
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
): Promise<TicketWithMeta | null> {
  const existing = (await db.select().from(tickets).where(eq(tickets.id, id)).limit(1))[0];
  if (!existing) return null;

  const now = new Date().toISOString();
  const values: Record<string, unknown> = { updatedAt: now };

  if (patch.subject !== undefined) values.subject = patch.subject;
  if (patch.body !== undefined) values.body = patch.body;
  if (patch.priority !== undefined) values.priority = patch.priority;
  if (patch.assigneeId !== undefined) values.assigneeId = patch.assigneeId;

  if (patch.status !== undefined) {
    values.status = patch.status;
    // closedAt is derived, never client-supplied — otherwise it drifts out of
    // sync with status the moment a ticket is reopened.
    values.closedAt = patch.status === 'closed' ? (existing.closedAt ?? now) : null;
  }

  await db.update(tickets).set(values).where(eq(tickets.id, id));
  if (patch.tags !== undefined) await setTags(db, id, patch.tags);

  return getTicket(db, id);
}

export async function deleteTicket(db: Db, id: number): Promise<boolean> {
  const existing = (await db.select().from(tickets).where(eq(tickets.id, id)).limit(1))[0];
  if (!existing) return false;
  await db.delete(tickets).where(eq(tickets.id, id));
  return true;
}

export async function setTags(db: Db, ticketId: number, names: string[]): Promise<void> {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  await db.delete(ticketTags).where(eq(ticketTags.ticketId, ticketId));

  for (const name of clean) {
    const found = (await db.select().from(tags).where(eq(tags.name, name)).limit(1))[0];
    const tag = found ?? (await db.insert(tags).values({ name }).returning())[0]!;
    await db.insert(ticketTags).values({ ticketId, tagId: tag.id }).onConflictDoNothing();
  }
}

export async function listComments(
  db: Db,
  ticketId: number,
  opts: { includeInternal?: boolean } = {},
): Promise<Comment[]> {
  const filters = [eq(comments.ticketId, ticketId)];
  // The load-bearing line for the internal-note guarantee.
  if (!opts.includeInternal) filters.push(eq(comments.isInternal, false));

  return db
    .select()
    .from(comments)
    .where(and(...filters))
    .orderBy(comments.createdAt, comments.id);
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
): Promise<Comment | null> {
  const ticket = (
    await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1)
  )[0];
  if (!ticket) return null;

  const now = new Date().toISOString();
  const created = (
    await db
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

  // A reply bumps updatedAt so list ordering reflects real activity.
  await db.update(tickets).set({ updatedAt: now }).where(eq(tickets.id, ticketId));

  return created;
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
  role?: 'admin' | 'agent';
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
  role?: 'admin' | 'agent';
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

/** Count admins, so the last one cannot be demoted or deleted by mistake. */
export async function countAdmins(db: Db, excludeId?: number): Promise<number> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'));
  return rows.filter((r) => r.id !== excludeId).length;
}

export async function listTags(db: Db) {
  return db.select().from(tags).orderBy(tags.name);
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
