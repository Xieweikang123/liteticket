import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from './db/index.ts';
import { tokens, users } from './db/schema.ts';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

const SCRYPT_KEYLEN = 64;

/**
 * Hash a password with scrypt. A fresh salt per call means two users with the
 * same password produce different digests. Stored form is `salt:hash` in hex.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/** Constant-time verify of a password against a stored `salt:hash` digest. */
export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface AuthContext {
  /** Token row id, so a token can be revoked or listed. */
  tokenId: number;
  /** Owning user, when the token is bound to one. */
  userId: number | null;
  tokenName: string;
  /**
   * Effective role.
   *
   * A token bound to a user inherits that user's role, re-read on every
   * request so a demotion takes effect immediately. An unbound token is a
   * machine credential with no user behind it and carries full rights — that
   * is what deployments script against.
   */
  role: 'admin' | 'agent';
}

/**
 * Verify a bearer token. Returns null when the token is unknown.
 *
 * Lookup is by hash against an indexed unique column, so there is no scan. The
 * constant-time compare guards the (astronomically unlikely) collision path.
 *
 * A token bound to a user inherits that user's role, read live from the users
 * table so a role change applies on the next request rather than never.
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

  let role: 'admin' | 'agent' = 'admin';
  if (row.userId != null) {
    const owner = (await db.select().from(users).where(eq(users.id, row.userId)).limit(1))[0];
    // The token outlived its owner (cascade did not fire on an old row, or the
    // row was removed out of band): treat it as unusable rather than as a
    // userless admin credential.
    if (!owner) return null;
    role = owner.role;
  }

  return {
    tokenId: row.id,
    userId: row.userId ?? null,
    tokenName: row.name,
    role,
  };
}

/**
 * Look up a user by email along with the stored password hash, for login.
 * Returns null when the email is unknown.
 */
export async function findUserForLogin(db: Db, email: string) {
  const row = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role, passwordHash: row.passwordHash };
}

/**
 * Create a token, storing only its hash.
 *
 * Pass `value` to use a caller-supplied token instead of a generated one —
 * this is what makes LITETICKET_TOKEN work for deployments that need a known
 * credential. The value is hashed exactly like a generated one.
 */
export async function createToken(
  db: Db,
  name: string,
  userId?: number | null,
  value?: string,
): Promise<string> {
  const token = value && value.length > 0 ? value : generateToken();
  await db.insert(tokens).values({
    name,
    tokenHash: hashToken(token),
    userId: userId ?? null,
  });
  return token;
}

/** Revoke a single token by id. Scoped by owner so one user cannot drop another's. */
export async function revokeToken(db: Db, tokenId: number, ownerId?: number): Promise<boolean> {
  const rows = await db.select().from(tokens).where(eq(tokens.id, tokenId)).limit(1);
  const row = rows[0];
  if (!row) return false;
  if (ownerId !== undefined && row.userId !== ownerId) return false;

  await db.delete(tokens).where(eq(tokens.id, tokenId));
  return true;
}

/** Tokens belonging to a user, newest first. Never exposes the hash or value. */
export async function listTokens(db: Db, userId: number) {
  const rows = await db.select().from(tokens).where(eq(tokens.userId, userId));
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
    }))
    .sort((a, b) => b.id - a.id);
}

/**
 * Create the bootstrap API token if none exists yet. Returns the plaintext so
 * the caller can print it once, or null when a token was already present.
 */
export async function ensureBootstrapToken(db: Db, preset?: string): Promise<string | null> {
  const existing = (await db.select({ id: tokens.id }).from(tokens).limit(1))[0];
  if (existing) return null;

  return createToken(db, 'bootstrap', null, preset);
}

/** Idempotent: makes sure at least one user exists so tickets can be assigned. */
export async function ensureUser(db: Db, email: string, name: string): Promise<number> {
  const existing = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  if (existing) return existing.id;

  const inserted = (await db.insert(users).values({ email, name }).returning())[0]!;
  return inserted.id;
}
