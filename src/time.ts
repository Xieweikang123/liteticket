import { sql } from 'drizzle-orm';

/**
 * Timestamps are stored as UTC ISO-8601 strings (`2026-09-13T13:05:07.112Z`),
 * one format everywhere: every text timestamp column defaults to this shape in
 * SQL, and application writes go through `nowIso()`.
 *
 * The point is that a row can never hold two formats. Mixing SQLite's
 * `datetime('now')` (`2026-09-13 13:05:07`) with JavaScript's `toISOString()`
 * used to happen inside a single row — e.g. a token's `createdAt` from the DB
 * default next to a `lastUsedAt` written by the app. The two are not comparable
 * as strings, and a lexicographic `ORDER BY updated_at` silently misorders them
 * because a space sorts before `T`.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Column default matching `nowIso()`: second precision from SQLite plus `.000`,
 * so it is byte-identical to `new Date().toISOString()` at that instant.
 */
export function sqlNow() {
  return sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
}
