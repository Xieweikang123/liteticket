import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

export const USER_ROLES = ['admin', 'agent'] as const;

/**
 * Users are agents who log into the UI. `admin` can manage users and delete
 * tickets; `agent` can work tickets but not administer.
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
    role: text('role', { enum: ['admin', 'agent'] })
      .notNull()
      .default('agent'),
    passwordHash: text('password_hash'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
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
    .default(sql`(datetime('now'))`),
});

/**
 * API tokens. Stored as a SHA-256 hash — the plaintext token is shown once at
 * creation time and never again.
 */
export const tokens = sqliteTable(
  'tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    lastUsedAt: text('last_used_at'),
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
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
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
      .default(sql`(datetime('now'))`),
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

export const TICKET_STATUSES = ['open', 'pending', 'closed'] as const;
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
