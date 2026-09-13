import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Db } from './db/index.ts';
import * as svc from './services/tickets.ts';
import { SESSION_COOKIE, passwordMarker, sessionSecret, verifySession } from './auth.ts';

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'agent';
}

type SessionEnv = { Variables: { user: SessionUser } };

/**
 * Resolve the signed session cookie to a live user.
 *
 * The cookie only carries an id and role snapshot; the row is re-read every
 * request so a renamed, demoted, or deleted user is reflected immediately
 * rather than after the cookie expires.
 */
export async function readSession(
  c: Context,
  db: Db,
): Promise<SessionUser | null> {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (!cookie) return null;

  const secret = await sessionSecret(db);
  const data = verifySession(secret, cookie);
  if (!data) return null;

  // Fetch the auth row (with the hash) so a password change can be detected.
  const record = await svc.getUserByIdForAuth(db, data.uid);
  if (!record) return null;
  if (passwordMarker(record.passwordHash) !== data.pw) return null;

  return { id: record.id, email: record.email, name: record.name, role: record.role };
}

/**
 * Require a session for browser routes. Requests to /api/* fall through: the
 * API surface authenticates itself and must not be redirected to the login page.
 */
export function requireSession(db: Db): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path.startsWith('/api')) return next();

    const user = await readSession(c, db);
    if (!user) {
      const target = encodeURIComponent(c.req.path);
      return c.redirect(`/login?next=${target}`, 303);
    }
    c.set('user', user);
    await next();
  };
}

/** Require the admin role, on top of requireSession. */
export function requireAdmin(): MiddlewareHandler {
  return async (c, next) => {
    const user = (c as Context<SessionEnv>).get('user');
    if (user.role !== 'admin') {
      if (c.req.path.startsWith('/api')) {
        return c.json({ error: 'admin role required' }, 403);
      }
      return c.text('403 Forbidden — admin role required', 403);
    }
    await next();
  };
}
