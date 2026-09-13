import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sqlNow } from '../time.ts';

/**
 * The permission catalog is fixed in code, not data.
 *
 * A permission is a capability the server actually checks at a route. Keeping
 * the list here — rather than letting roles invent strings — means a typo in a
 * role cannot silently grant or revoke nothing, and every permission has
 * exactly one meaning. Roles are rows; permissions are constants.
 */
export const PERMISSIONS = [
  'tickets.read',
  'tickets.write',
  'tickets.delete',
  'users.read',
  'users.manage',
  'roles.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Roles are named sets of permissions. `users.role` stores the role's `name`
 * (the machine key), so a user's capabilities are resolved live on each request
 * — a permission edit takes effect immediately, without re-issuing tokens.
 *
 * `name` is immutable once created: user rows reference it, and renaming would
 * have to cascade. `label` is the display name (the UI is Chinese).
 * `isSystem` marks the built-in `admin` / `agent` roles, which the API refuses
 * to edit or delete so the instance cannot lock itself out.
 */
export const roles = sqliteTable(
  'roles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    permissions: text('permissions', { mode: 'json' })
      .$type<Permission[]>()
      .notNull()
      .default(sql`'[]'`),
    isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at')
      .notNull()
      .default(sqlNow()),
  },
  (t) => [uniqueIndex('roles_name_unique').on(t.name)],
);

/**
 * Users are agents who log into the UI. Their capabilities come from `role`,
 * a role name resolved against the roles table on every request.
 *
 * `username` is the login identifier; `email` is a contact field. Both are
 * unique. `passwordHash` is a scrypt digest in `salt:hash` hex form — never the
 * plaintext. It is nullable so pre-existing rows survive the migration; the
 * seed step fills it on first boot.
 */
export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull().default('agent'),
    passwordHash: text('password_hash'),
    createdAt: text('created_at')
      .notNull()
      .default(sqlNow()),
  },
  (t) => [
    uniqueIndex('users_username_unique').on(t.username),
    uniqueIndex('users_email_unique').on(t.email),
  ],
);

/**
 * Small key/value store for server-managed secrets (notably the session
 * signing key). Keeping the key in the database means a single-command boot
 * needs no config and sessions still survive a restart.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sqlNow()),
});

/**
 * Bearer tokens, stored as a SHA-256 hash — the plaintext is shown once at
 * creation time and never again.
 *
 * `kind` separates the two things that would otherwise be one: a long-lived
 * `api` credential the user names and revokes from the token page, and a
 * `session` row minted by every login. They are the same verification
 * mechanism, but they have opposite lifetimes — an API token is meant to
 * outlive the login that created it, a session is not. Keeping them apart lets
 * the token page list only the former, and lets sessions expire and be purged
 * without touching a script's credential. Existing rows predate the column and
 * are API tokens, which is why the default is `api`.
 *
 * `expiresAt` is an ISO timestamp for `session` rows; `api` tokens leave it
 * null and live until revoked. Expiry is enforced in `verifyToken` (fail
 * closed) and the rows are swept on login and on boot.
 */
export const tokens = sqliteTable(
  'tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    kind: text('kind', { enum: ['api', 'session'] })
      .notNull()
      .default('api'),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at')
      .notNull()
      .default(sqlNow()),
    lastUsedAt: text('last_used_at'),
    expiresAt: text('expires_at'),
  },
  (t) => [uniqueIndex('tokens_hash_unique').on(t.tokenHash)],
);

/**
 * The one table that matters.
 *
 * `status` is a closed set of three values. README commits to open/pending/closed
 * and explicitly rejects "complex SLA engines" — so there is no SLA column, no
 * state-machine table, no escalation rules. Enforcement lives in the service
 * layer.
 */
export const tickets = sqliteTable(
  'tickets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    subject: text('subject').notNull(),
    body: text('body').notNull().default(''),
    status: text('status', { enum: ['open', 'pending', 'closed'] })
      .notNull()
      .default('open'),
    priority: text('priority', { enum: ['low', 'normal', 'high', 'urgent'] })
      .notNull()
      .default('normal'),
    requesterEmail: text('requester_email').notNull(),
    requesterName: text('requester_name'),
    assigneeId: integer('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: text('created_at')
      .notNull()
      .default(sqlNow()),
    updatedAt: text('updated_at')
      .notNull()
      .default(sqlNow()),
    closedAt: text('closed_at'),
  },
  (t) => [
    index('tickets_status_idx').on(t.status),
    index('tickets_assignee_idx').on(t.assigneeId),
    index('tickets_updated_idx').on(t.updatedAt),
  ],
);

/**
 * Comments carry the internal-note vs public-reply distinction the README calls
 * for. `isInternal` is the whole point: an internal note must never be visible
 * to the requester through any surface (API or UI).
 */
export const comments = sqliteTable(
  'comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
    authorEmail: text('author_email'),
    isInternal: integer('is_internal', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at')
      .notNull()
      .default(sqlNow()),
  },
  (t) => [index('comments_ticket_idx').on(t.ticketId)],
);

export const tags = sqliteTable(
  'tags',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
  },
  (t) => [uniqueIndex('tags_name_unique').on(t.name)],
);

export const ticketTags = sqliteTable(
  'ticket_tags',
  {
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('ticket_tags_unique').on(t.ticketId, t.tagId)],
);

export type User = typeof users.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type Role = typeof roles.$inferSelect;

export const TICKET_STATUSES = ['open', 'pending', 'closed'] as const;
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
