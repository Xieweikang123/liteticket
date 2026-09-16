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
  'menus.manage',
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
 * The top navigation, as data rather than markup.
 *
 * Each row is one tab: where it points, what it is called, and who may see it.
 * `permission` is optional — null means any signed-in user sees the tab, which
 * is how 工单 and 我的令牌 stay visible to everyone. Built-in tabs are seeded
 * from code (`SYSTEM_MENUS`) and reconciled on boot, the same way roles are, so
 * an upgrade that adds a tab does not need a migration; `isSystem` marks those
 * rows and the API refuses to delete them, since the SPA route they target
 * still exists.
 *
 * `sort` orders the tabs explicitly rather than by id, so reordering does not
 * depend on insertion history.
 */
export const menus = sqliteTable(
  'menus',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    label: text('label').notNull(),
    path: text('path').notNull(),
    permission: text('permission').$type<Permission | null>(),
    sort: integer('sort').notNull().default(0),
    visible: integer('visible', { mode: 'boolean' }).notNull().default(true),
    isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at')
      .notNull()
      .default(sqlNow()),
  },
  (t) => [uniqueIndex('menus_name_unique').on(t.name)],
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

/**
 * Who was @-mentioned in a comment. Rows are written at comment create time by
 * resolving `@username` tokens against the users table — not re-parsed on read —
 * so the ticket list can filter "mentioned me" without scanning comment bodies.
 *
 * `ticketId` is denormalised so that filter is a single indexed lookup.
 * `readAt` is null until the mentioned user opens the ticket; the list badge
 * uses that to distinguish unread mentions from historical ones.
 */
export const commentMentions = sqliteTable(
  'comment_mentions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    commentId: integer('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at')
      .notNull()
      .default(sqlNow()),
    readAt: text('read_at'),
  },
  (t) => [
    uniqueIndex('comment_mentions_unique').on(t.commentId, t.userId),
    index('comment_mentions_ticket_user_idx').on(t.ticketId, t.userId),
    index('comment_mentions_user_unread_idx').on(t.userId, t.readAt),
  ],
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

/**
 * Files attached to a ticket. Bytes live on disk under the attachments root
 * (`{ticketId}/{storedName}`); this row is the metadata the API returns and
 * the only thing that must stay consistent with the filesystem.
 *
 * `filename` is the original client name (for Content-Disposition). `storedName`
 * is a random opaque key so a crafted upload cannot escape the ticket's
 * directory. Deleting the ticket cascades the rows; the service also removes
 * the on-disk directory so orphans do not accumulate.
 */
export const attachments = sqliteTable(
  'attachments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    storedName: text('stored_name').notNull(),
    contentType: text('content_type').notNull().default('application/octet-stream'),
    size: integer('size').notNull(),
    uploadedById: integer('uploaded_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: text('created_at')
      .notNull()
      .default(sqlNow()),
  },
  (t) => [
    index('attachments_ticket_idx').on(t.ticketId),
    uniqueIndex('attachments_stored_unique').on(t.ticketId, t.storedName),
  ],
);

/**
 * A one-line history of field changes on a ticket.
 *
 * Not a full audit log: only the fields an agent edits through `updateTicket`
 * (status, priority, assignee, subject, tags). `fromValue` / `toValue` are
 * display strings so the UI can render the timeline without joining users or
 * tags again. `actorName` is denormalised for the same reason — a deleted user
 * still shows as who made the change.
 */
export const ticketEvents = sqliteTable(
  'ticket_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ticketId: integer('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    field: text('field').notNull(),
    fromValue: text('from_value'),
    toValue: text('to_value'),
    actorId: integer('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorName: text('actor_name'),
    createdAt: text('created_at')
      .notNull()
      .default(sqlNow()),
  },
  (t) => [index('ticket_events_ticket_idx').on(t.ticketId)],
);

export type User = typeof users.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type CommentMention = typeof commentMentions.$inferSelect;
export type Tag = typeof tags.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type Menu = typeof menus.$inferSelect;
export type NewMenu = typeof menus.$inferInsert;
export type Attachment = typeof attachments.$inferSelect;
export type TicketEvent = typeof ticketEvents.$inferSelect;

export const TICKET_STATUSES = ['open', 'pending', 'closed'] as const;
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
