import { mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import type { Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the migrations directory: alongside the compiled output in the
 * published package, or two levels up when running from src/ during dev.
 */
function migrationsDir(): string | null {
  const candidates = [
    join(here, '..', '..', 'drizzle'),
    join(here, '..', 'drizzle'),
  ];
  if (process.env.LITETICKET_MIGRATIONS) {
    candidates.unshift(resolve(process.env.LITETICKET_MIGRATIONS));
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * The fallback schema, used when `drizzle/` is absent (e.g. a fresh git clone
 * before `pnpm db:generate`). Kept in sync with src/db/schema.ts by hand — it
 * is the safety net, not the source of truth.
 */
const BOOTSTRAP_SQL = [
  `CREATE TABLE IF NOT EXISTS roles (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     label TEXT NOT NULL,
     description TEXT,
     permissions TEXT NOT NULL DEFAULT '[]',
     is_system INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS roles_name_unique ON roles (name)`,

  `CREATE TABLE IF NOT EXISTS menus (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     label TEXT NOT NULL,
     path TEXT NOT NULL,
     permission TEXT,
     sort INTEGER NOT NULL DEFAULT 0,
     visible INTEGER NOT NULL DEFAULT 1,
     is_system INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS menus_name_unique ON menus (name)`,

  `CREATE TABLE IF NOT EXISTS users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     username TEXT NOT NULL,
     email TEXT NOT NULL,
     name TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'agent',
     password_hash TEXT,

     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (username)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email)`,

  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   )`,

  `CREATE TABLE IF NOT EXISTS tokens (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     token_hash TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'api',
     user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     last_used_at TEXT,
     expires_at TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS tokens_hash_unique ON tokens (token_hash)`,

  `CREATE TABLE IF NOT EXISTS tickets (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     subject TEXT NOT NULL,
     body TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'open',
     priority TEXT NOT NULL DEFAULT 'normal',
     requester_email TEXT NOT NULL,
     requester_name TEXT,
     assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     closed_at TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets (status)`,
  `CREATE INDEX IF NOT EXISTS tickets_assignee_idx ON tickets (assignee_id)`,
  `CREATE INDEX IF NOT EXISTS tickets_updated_idx ON tickets (updated_at)`,

  `CREATE TABLE IF NOT EXISTS comments (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
     body TEXT NOT NULL,
     author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     author_email TEXT,
     is_internal INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   )`,
  `CREATE INDEX IF NOT EXISTS comments_ticket_idx ON comments (ticket_id)`,

  `CREATE TABLE IF NOT EXISTS comment_mentions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
     ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     read_at TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS comment_mentions_unique ON comment_mentions (comment_id, user_id)`,
  `CREATE INDEX IF NOT EXISTS comment_mentions_ticket_user_idx ON comment_mentions (ticket_id, user_id)`,
  `CREATE INDEX IF NOT EXISTS comment_mentions_user_unread_idx ON comment_mentions (user_id, read_at)`,

  `CREATE TABLE IF NOT EXISTS tags (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS tags_name_unique ON tags (name)`,

  `CREATE TABLE IF NOT EXISTS ticket_tags (
     ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
     tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ticket_tags_unique ON ticket_tags (ticket_id, tag_id)`,

  `CREATE TABLE IF NOT EXISTS attachments (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
     filename TEXT NOT NULL,
     stored_name TEXT NOT NULL,
     content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
     size INTEGER NOT NULL,
     uploaded_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   )`,
  `CREATE INDEX IF NOT EXISTS attachments_ticket_idx ON attachments (ticket_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS attachments_stored_unique ON attachments (ticket_id, stored_name)`,

  `CREATE TABLE IF NOT EXISTS ticket_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
     field TEXT NOT NULL,
     from_value TEXT,
     to_value TEXT,
     actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
     actor_name TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   )`,
  `CREATE INDEX IF NOT EXISTS ticket_events_ticket_idx ON ticket_events (ticket_id)`,
];

/**
 * Apply migrations by hand rather than through drizzle's migrator: the
 * published package ships `drizzle/*.sql`, and reading them directly keeps
 * drizzle-kit a devDependency instead of a runtime requirement.
 */
async function migrate(client: Client): Promise<void> {
  const dir = migrationsDir();

  if (!dir) {
    for (const stmt of BOOTSTRAP_SQL) await client.execute(stmt);
    return;
  }

  await client.execute(
    `CREATE TABLE IF NOT EXISTS __migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     )`,
  );

  const appliedRows = await client.execute('SELECT name FROM __migrations');
  const applied = new Set(appliedRows.rows.map((r) => String(r.name)));

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    for (const stmt of BOOTSTRAP_SQL) await client.execute(stmt);
    return;
  }

  for (const file of files) {
    if (applied.has(file)) continue;

    const sqlText = readFileSync(join(dir, file), 'utf8');
    const statements = sqlText
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const stmt of statements) await client.execute(stmt);
    await client.execute({
      sql: 'INSERT INTO __migrations (name) VALUES (?)',
      args: [file],
    });
  }
}

export type Db = ReturnType<typeof buildDb>['db'];

function buildDb(url: string) {
  const client = createClient({ url });
  const db = drizzle(client, { schema });
  return { db, client };
}

let singleton: ReturnType<typeof buildDb> | null = null;
let ready: Promise<void> | null = null;

/** Convert a filesystem path to the file: URL libsql expects. */
export function toFileUrl(file: string): string {
  if (file.startsWith('file:') || file.startsWith('libsql:') || file.startsWith('http')) {
    return file;
  }
  return `file:${resolve(file)}`;
}

export async function initDb(file?: string): Promise<ReturnType<typeof buildDb>> {
  if (singleton) {
    await ready;
    return singleton;
  }

  const target = file ?? process.env.LITETICKET_DB ?? './data/liteticket.db';
  const url = toFileUrl(target);

  // A local file database needs its parent directory to exist.
  if (url.startsWith('file:')) {
    const dir = dirname(url.slice('file:'.length));
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  singleton = buildDb(url);
  ready = (async () => {
    await singleton!.client.execute('PRAGMA journal_mode = WAL');
    await singleton!.client.execute('PRAGMA foreign_keys = ON');
    await migrate(singleton!.client);
  })();

  await ready;
  return singleton;
}

/** Accessor for code paths that run after initDb() has resolved. */
export function getDb(): ReturnType<typeof buildDb> {
  if (!singleton) {
    throw new Error('database not initialized — call initDb() first');
  }
  return singleton;
}

export { schema };
