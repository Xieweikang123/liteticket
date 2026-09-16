import { and, asc, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { comments, menus, roles, tags, ticketTags, tickets, tokens, users } from '../db/schema.ts';
import type { Comment, Menu, Permission, Role, Ticket, User } from '../db/schema.ts';
import { hashPassword } from '../auth.ts';
import { nowIso } from '../time.ts';

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
): Promise<TicketWithMeta | null> {
  const existing = (await db.select().from(tickets).where(eq(tickets.id, id)).limit(1))[0];
  if (!existing) return null;

  const now = nowIso();
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

  await db.transaction(async (tx) => {
    await tx.update(tickets).set(values).where(eq(tickets.id, id));
    if (patch.tags !== undefined) await setTags(tx, id, patch.tags);
  });

  return getTicket(db, id);
}

export async function deleteTicket(db: Db, id: number): Promise<boolean> {
  const existing = (await db.select().from(tickets).where(eq(tickets.id, id)).limit(1))[0];
  if (!existing) return false;
  await db.delete(tickets).where(eq(tickets.id, id));
  return true;
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

  const now = nowIso();
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
