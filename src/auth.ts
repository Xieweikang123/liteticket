import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from './db/index.ts';
import { tokens, users } from './db/schema.ts';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface AuthContext {
  userId: number | null;
  tokenName: string;
}

/**
 * Verify a bearer token. Returns null when the token is unknown.
 *
 * Lookup is by hash against an indexed unique column, so there is no scan. The
 * constant-time compare guards the (astronomically unlikely) collision path.
 */
export async function verifyToken(db: Db, presented: string): Promise<AuthContext | null> {
  const presentedHash = hashToken(presented);

  const rows = await db
    .select()
    .from(tokens)
    .where(eq(tokens.tokenHash, presentedHash))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const a = Buffer.from(row.tokenHash, 'hex');
  const b = Buffer.from(presentedHash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  await db
    .update(tokens)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(tokens.id, row.id));

  return { userId: row.userId ?? null, tokenName: row.name };
}

export async function createToken(
  db: Db,
  name: string,
  userId?: number | null,
): Promise<string> {
  const token = generateToken();
  await db.insert(tokens).values({
    name,
    tokenHash: hashToken(token),
    userId: userId ?? null,
  });
  return token;
}

/** Idempotent: makes sure at least one user exists so tickets can be assigned. */
export async function ensureUser(db: Db, email: string, name: string): Promise<number> {
  const existing = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  if (existing) return existing.id;

  const inserted = (await db.insert(users).values({ email, name }).returning())[0]!;
  return inserted.id;
}
