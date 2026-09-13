import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from './db/index.ts';
import { settings, tokens, users } from './db/schema.ts';

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

/**
 * Read a setting, creating it with `generate()` on first access. Used for the
 * session signing key so it is minted once and persists across restarts.
 */
export async function getOrCreateSetting(
  db: Db,
  key: string,
  generate: () => string,
): Promise<string> {
  const existing = (await db.select().from(settings).where(eq(settings.key, key)).limit(1))[0];
  if (existing) return existing.value;

  const value = generate();
  await db.insert(settings).values({ key, value }).onConflictDoNothing();
  // Re-read: a concurrent boot may have inserted first.
  const row = (await db.select().from(settings).where(eq(settings.key, key)).limit(1))[0];
  return row?.value ?? value;
}

export async function sessionSecret(db: Db): Promise<string> {
  return getOrCreateSetting(db, 'session_secret', () => randomBytes(32).toString('hex'));
}

export interface SessionData {
  /** User id. The live row is re-read each request, so role changes apply at once. */
  uid: number;
  /**
   * Short digest of the user's password hash at login time. Bumping the
   * password changes it, which invalidates every outstanding session — the
   * stateless equivalent of "log out everywhere".
   */
  pw: string;
  exp: number;
}

/** Derive the session's password marker from a stored password hash. */
export function passwordMarker(passwordHash: string | null): string {
  return createHash('sha256').update(passwordHash ?? '').digest('hex').slice(0, 16);
}

/**
 * Sign a session payload as `base64url(json).base64url(hmac)`. The cookie is
 * stateless — no session table, no lookup — which fits the single-command
 * deployment this project targets.
 */
export function signSession(secret: string, data: SessionData): string {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(secret: string, cookie: string): SessionData | null {
  const dot = cookie.lastIndexOf('.');
  if (dot <= 0) return null;

  const payload = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionData;
    if (typeof data.uid !== 'number' || typeof data.exp !== 'number') return null;
    if (typeof data.pw !== 'string') return null;
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = 'lt_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

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
