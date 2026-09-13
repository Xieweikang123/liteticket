import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { eq, and, lt } from 'drizzle-orm';
import type { Db } from './db/index.ts';
import { PERMISSIONS, roles, tokens, users } from './db/schema.ts';
import type { Permission } from './db/schema.ts';
import { nowIso } from './time.ts';

/** Every capability, for the built-in admin role and unbound machine tokens. */
export const ALL_PERMISSIONS: Permission[] = [...PERMISSIONS];

/**
 * How long a login session lives. Long enough to be invisible to a human using
 * the UI daily, short enough that an abandoned browser does not hold a valid
 * credential forever. An API token has no such cap: it lives until revoked.
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type TokenKind = 'api' | 'session';

export interface RoleSeed {
  name: string;
  label: string;
  description: string;
  permissions: Permission[];
}

/**
 * The two roles liteticket has always had. They are seeded on every boot and
 * their permissions are reconciled against this list, so an upgrade that adds
 * a permission grants it to `admin` without a migration.
 */
export const SYSTEM_ROLES: RoleSeed[] = [
  {
    name: 'admin',
    label: '管理员',
    description: '全部权限，可管理用户与角色。',
    permissions: ALL_PERMISSIONS,
  },
  {
    name: 'agent',
    label: '客服',
    description: '处理工单，不能管理用户、角色或删除工单。',
    permissions: ['tickets.read', 'tickets.write', 'users.read'],
  },
];

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
   * Role name in force for this request. A token bound to a user inherits that
   * user's role name; an unbound machine token reports `admin` but carries the
   * full permission set directly (see `permissions`).
   */
  role: string;
  /**
   * Effective capabilities, resolved live.
   *
   * For a user-bound token these come from the user's role row, re-read on
   * every request, so a permission edit takes effect immediately. An unbound
   * token is a machine credential with no user behind it and carries full
   * rights — that is what deployments script against.
   */
  permissions: Permission[];
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

  // Expiry is checked before the constant-time compare: a session past its
  // deadline is invalid regardless of the hash, and this is the fail-closed
  // path if a sweep has not run yet.
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return null;

  const a = Buffer.from(row.tokenHash, 'hex');
  const b = Buffer.from(presentedHash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  await db
    .update(tokens)
    .set({ lastUsedAt: nowIso() })
    .where(eq(tokens.id, row.id));

  // An unbound token has no user to resolve a role for and carries everything.
  let role = 'admin';
  let permissions = ALL_PERMISSIONS;
  if (row.userId != null) {
    const owner = (await db.select().from(users).where(eq(users.id, row.userId)).limit(1))[0];
    // The token outlived its owner (cascade did not fire on an old row, or the
    // row was removed out of band): treat it as unusable rather than as a
    // userless admin credential.
    if (!owner) return null;
    role = owner.role;

    // Resolve permissions from the role row. A role name with no row (an
    // upgrade gap, or a row deleted out of band) confers nothing rather than
    // falling back to a default — fail closed.
    const roleRow = (
      await db.select().from(roles).where(eq(roles.name, owner.role)).limit(1)
    )[0];
    permissions = roleRow?.permissions ?? [];
  }

  return {
    tokenId: row.id,
    userId: row.userId ?? null,
    tokenName: row.name,
    role,
    permissions,
  };
}

/**
 * Look up a user by username along with the stored password hash, for login.
 * Returns null when the username is unknown.
 */
export async function findUserForLogin(db: Db, username: string) {
  const row = (await db.select().from(users).where(eq(users.username, username)).limit(1))[0];
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    name: row.name,
    role: row.role,
    passwordHash: row.passwordHash,
  };
}

/**
 * Create a token, storing only its hash.
 *
 * `kind` picks the lifetime: a `session` gets an `expiresAt` from the TTL, an
 * `api` token does not. The token page and the token-management routes only
 * ever see `api` rows, so a login never pollutes a user's named credentials.
 *
 * Pass `value` to use a caller-supplied token instead of a generated one —
 * this is what makes LITETICKET_TOKEN work for deployments that need a known
 * credential. The value is hashed exactly like a generated one.
 */
export async function createToken(
  db: Db,
  name: string,
  userId?: number | null,
  opts: { kind?: TokenKind; value?: string } = {},
): Promise<string> {
  const kind = opts.kind ?? 'api';
  const token = opts.value && opts.value.length > 0 ? opts.value : generateToken();
  await db.insert(tokens).values({
    name,
    tokenHash: hashToken(token),
    kind,
    userId: userId ?? null,
    expiresAt: kind === 'session' ? new Date(Date.now() + SESSION_TTL_MS).toISOString() : null,
  });
  return token;
}

/**
 * Delete expired session rows. API tokens have no expiry and are untouched.
 * Called on boot and before each login, which bounds the table by the number
 * of live sessions rather than by every login ever made.
 */
export async function purgeExpiredTokens(db: Db): Promise<void> {
  await db
    .delete(tokens)
    .where(and(eq(tokens.kind, 'session'), lt(tokens.expiresAt, new Date().toISOString())));
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

/**
 * The user's own *api* tokens, newest first. Sessions are excluded: they are
 * an implementation detail of logging in, not something a user manages. Never
 * exposes the hash or value.
 */
export async function listTokens(db: Db, userId: number) {
  const rows = await db
    .select()
    .from(tokens)
    .where(and(eq(tokens.userId, userId), eq(tokens.kind, 'api')));
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
 * Drop the login session behind the presented token. Scoped to `session` rows
 * so a machine token cannot be cancelled through the logout endpoint — that
 * path requires the plaintext, and revoking an explicit API token is a
 * deliberate action, not a side effect of signing out.
 */
export async function revokeSession(db: Db, tokenId: number): Promise<void> {
  await db.delete(tokens).where(and(eq(tokens.id, tokenId), eq(tokens.kind, 'session')));
}

/**
 * Create the bootstrap API token if none exists yet. Returns the plaintext so
 * the caller can print it once, or null when a token was already present.
 */
export async function ensureBootstrapToken(db: Db, preset?: string): Promise<string | null> {
  const existing = (await db.select({ id: tokens.id }).from(tokens).limit(1))[0];
  if (existing) return null;

  return createToken(db, 'bootstrap', null, { value: preset });
}

/**
 * Idempotent: makes sure at least one user exists so tickets can be assigned.
 *
 * Matched on username, which is the login identifier — an existing install
 * whose seeded admin has a different email must not spawn a second account.
 * `email` is a contact field and is not required to be unique here; that
 * constraint is enforced at the user-management API instead.
 */
export async function ensureUser(db: Db, username: string, email: string, name: string): Promise<number> {
  const existing = (await db.select().from(users).where(eq(users.username, username)).limit(1))[0];
  if (existing) return existing.id;

  const inserted = (await db.insert(users).values({ username, email, name }).returning())[0]!;
  return inserted.id;
}

/**
 * Seed the built-in roles, and reconcile their permissions against
 * `SYSTEM_ROLES` on every boot.
 *
 * Reconciliation is what lets the code add a permission to `admin` and have it
 * take effect on an existing install with no migration and no manual edit. It
 * is safe because system roles are exactly the ones the API refuses to edit.
 */
export async function ensureSystemRoles(db: Db): Promise<void> {
  for (const seed of SYSTEM_ROLES) {
    const existing = (await db.select().from(roles).where(eq(roles.name, seed.name)).limit(1))[0];
    if (!existing) {
      await db.insert(roles).values({
        name: seed.name,
        label: seed.label,
        description: seed.description,
        permissions: seed.permissions,
        isSystem: true,
      });
      continue;
    }

    const changed =
      existing.label !== seed.label ||
      existing.description !== seed.description ||
      JSON.stringify(existing.permissions) !== JSON.stringify(seed.permissions) ||
      !existing.isSystem;
    if (changed) {
      await db
        .update(roles)
        .set({
          label: seed.label,
          description: seed.description,
          permissions: seed.permissions,
          isSystem: true,
        })
        .where(eq(roles.id, existing.id));
    }
  }
}
