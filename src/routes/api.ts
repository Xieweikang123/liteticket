import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { TICKET_PRIORITIES, TICKET_STATUSES, USER_ROLES } from '../db/schema.ts';
import {
  createToken,
  findUserForLogin,
  listTokens,
  revokeToken,
  verifyPassword,
  verifyToken,
} from '../auth.ts';
import * as svc from '../services/tickets.ts';

/**
 * Who is making the request, resolved from a bearer token.
 *
 * A token bound to a user carries that user's role. A token with no owner is a
 * machine credential and carries full rights.
 */
export interface Principal {
  source: 'token';
  tokenId: number;
  userId: number | null;
  name: string;
  role: 'admin' | 'agent';
}

/** Context variables set by the auth middleware. */
type ApiEnv = { Variables: { auth: Principal } };

const createTicketSchema = z.object({
  subject: z.string().min(1, 'subject is required').max(500),
  body: z.string().max(100_000).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  requesterEmail: z.email('requesterEmail must be a valid email'),
  requesterName: z.string().max(200).nullish(),
  assigneeId: z.number().int().positive().nullish(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
});

const updateTicketSchema = z.object({
  subject: z.string().min(1).max(500).optional(),
  body: z.string().max(100_000).optional(),
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  assigneeId: z.number().int().positive().nullable().optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
});

const createCommentSchema = z.object({
  body: z.string().min(1, 'body is required').max(100_000),
  isInternal: z.boolean().optional(),
  authorEmail: z.email().nullish(),
  authorId: z.number().int().positive().nullish(),
});

/** Login identifiers are usernames: no spaces, kept short and greppable. */
const username = z
  .string()
  .min(1, 'username is required')
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, 'username may only contain letters, digits, . _ -');

const createUserSchema = z.object({
  username,
  email: z.email('email must be a valid email'),
  name: z.string().min(1, 'name is required').max(200),
  role: z.enum(USER_ROLES).optional(),
  password: z.string().min(1).max(200).optional(),
});

const updateUserSchema = z.object({
  username: username.optional(),
  email: z.email().optional(),
  name: z.string().min(1).max(200).optional(),
  role: z.enum(USER_ROLES).optional(),
  password: z.string().min(1).max(200).optional(),
});

const listQuerySchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  assigneeId: z.coerce.number().int().positive().optional(),
  tag: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const loginSchema = z.object({
  /**
   * The login identifier. Deliberately looser than the create-user rule: an
   * existing account must still be able to sign in even if its username
   * predates or sidesteps the current validation.
   */
  username: z.string().min(1, 'username is required').max(64),
  password: z.string().min(1, 'password is required').max(200),
  /** Label for the token minted by this login. */
  tokenName: z.string().min(1).max(100).optional(),
});

const createTokenSchema = z.object({
  name: z.string().min(1, 'name is required').max(100),
});

/** Turn a ZodError into a flat, client-friendly shape. */
function issues(err: z.ZodError) {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

export function apiRoutes(db: Db) {
  const api = new Hono<ApiEnv>();

  // Health is intentionally public: monitoring and container liveness probes
  // must not need credentials.
  api.get('/health', (c) => c.json({ ok: true, version: '0.1.0' }));

  /**
   * Log in and receive a bearer token.
   *
   * This is public (it is how a client obtains credentials) and it mints a
   * *user-bound* token, so the resulting credential carries the user's role
   * rather than blanket admin rights.
   */
  api.post('/auth/login', async (c) => {
    const raw = await c.req.json().catch(() => null);
    if (raw == null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = loginSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'validation failed', issues: issues(parsed.error) }, 422);

    const user = await findUserForLogin(db, parsed.data.username);
    // Same response for unknown username and wrong password, so the endpoint
    // does not confirm which accounts exist.
    if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
      return c.json({ error: '用户名或密码不正确' }, 401);
    }

    const name = parsed.data.tokenName ?? `login-${new Date().toISOString().slice(0, 10)}`;
    const token = await createToken(db, name, user.id);

    return c.json({
      token,
      user: { id: user.id, username: user.username, email: user.email, name: user.name, role: user.role },
    });
  });

  /**
   * Every other /api route requires a bearer token.
   *
   * Mounted before the handlers so a new endpoint is protected by default,
   * rather than by remembering to add a check. `/health` and `/auth/login`
   * are registered above this line and are therefore public.
   */
  api.use('*', async (c, next) => {
    const header = c.req.header('Authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    if (!presented) return c.json({ error: 'authentication required' }, 401);

    const auth = await verifyToken(db, presented);
    if (!auth) return c.json({ error: 'invalid token' }, 401);

    c.set('auth', {
      source: 'token',
      tokenId: auth.tokenId,
      userId: auth.userId,
      name: auth.tokenName,
      role: auth.role,
    });
    return next();
  });

  /**
   * `GET /auth/me` describes the caller. The SPA uses it to validate a stored
   * token on boot, so a revoked or demoted credential is caught immediately
   * instead of on the first failed write. Registered after the middleware
   * above, which is what populates `auth`.
   *
   * For a user-bound token this includes the owner's identity, so the client
   * can render the signed-in user without a second, permission-sensitive call
   * (listing users is admin-only, which would break the agent role).
   */
  api.get('/auth/me', async (c) => {
    const p = c.get('auth');
    let user: { id: number; username: string; email: string; name: string; role: string } | null = null;

    if (p.userId != null) {
      const row = await svc.getUser(db, p.userId);
      if (row) user = { id: row.id, username: row.username, email: row.email, name: row.name, role: row.role };
    }

    return c.json({
      source: p.source,
      tokenId: p.tokenId,
      userId: p.userId,
      name: p.name,
      role: p.role,
      user,
    });
  });

  /**
   * Guard privileged routes. An unbound machine token always passes; a user-bound token needs the admin role.
   */
  const admin: MiddlewareHandler<ApiEnv> = async (c, next) => {
    const principal = c.get('auth');
    if (principal.role === 'admin') return next();
    return c.json({ error: 'admin role required' }, 403);
  };

  api.get('/tickets', async (c) => {
    const parsed = listQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'invalid query', issues: issues(parsed.error) }, 400);

    const result = await svc.listTickets(db, parsed.data);
    return c.json({
      items: result.items,
      total: result.total,
      limit: parsed.data.limit ?? 50,
      offset: parsed.data.offset ?? 0,
    });
  });

  api.get('/tickets/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    const ticket = await svc.getTicket(db, id);
    if (!ticket) return c.json({ error: 'ticket not found' }, 404);

    // Public API callers never see internal notes unless they explicitly ask.
    const includeInternal = c.req.query('includeInternal') === 'true';
    const commentList = await svc.listComments(db, id, { includeInternal });
    return c.json({ ...ticket, comments: commentList });
  });

  api.post('/tickets', async (c) => {
    const raw = await c.req.json().catch(() => null);
    if (raw == null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = createTicketSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'validation failed', issues: issues(parsed.error) }, 422);

    const ticket = await svc.createTicket(db, parsed.data);
    return c.json(ticket, 201);
  });

  api.patch('/tickets/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    const raw = await c.req.json().catch(() => null);
    if (raw == null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = updateTicketSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'validation failed', issues: issues(parsed.error) }, 422);

    const ticket = await svc.updateTicket(db, id, parsed.data);
    if (!ticket) return c.json({ error: 'ticket not found' }, 404);
    return c.json(ticket);
  });

  api.delete('/tickets/:id', admin, async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    if (!(await svc.deleteTicket(db, id))) return c.json({ error: 'ticket not found' }, 404);
    return c.body(null, 204);
  });

  api.get('/tickets/:id/comments', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
    if (!(await svc.getTicket(db, id))) return c.json({ error: 'ticket not found' }, 404);

    const includeInternal = c.req.query('includeInternal') === 'true';
    return c.json({ items: await svc.listComments(db, id, { includeInternal }) });
  });

  api.post('/tickets/:id/comments', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    const raw = await c.req.json().catch(() => null);
    if (raw == null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = createCommentSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'validation failed', issues: issues(parsed.error) }, 422);

    // A user-bound token attributes to its owner; an unbound machine token may
    // attribute to anyone (or no one) via the request body.
    const principal = c.get('auth');
    const input = principal.userId != null
      ? { ...parsed.data, authorId: principal.userId, authorEmail: null }
      : parsed.data;

    const comment = await svc.addComment(db, id, input);
    if (!comment) return c.json({ error: 'ticket not found' }, 404);
    return c.json(comment, 201);
  });

  api.get('/users', async (c) => c.json({ items: await svc.listUsers(db) }));

  api.get('/users/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    const user = await svc.getUser(db, id);
    if (!user) return c.json({ error: 'user not found' }, 404);
    return c.json(user);
  });

  api.post('/users', admin, async (c) => {
    const raw = await c.req.json().catch(() => null);
    if (raw == null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = createUserSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'validation failed', issues: issues(parsed.error) }, 422);

    if (await svc.getUserByUsername(db, parsed.data.username)) {
      return c.json({ error: 'username already in use' }, 409);
    }
    if (await svc.getUserByEmail(db, parsed.data.email)) {
      return c.json({ error: 'email already in use' }, 409);
    }

    const user = await svc.createUser(db, parsed.data);
    return c.json(user, 201);
  });

  api.patch('/users/:id', admin, async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    const raw = await c.req.json().catch(() => null);
    if (raw == null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = updateUserSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'validation failed', issues: issues(parsed.error) }, 422);

    if (parsed.data.username !== undefined) {
      const clash = await svc.getUserByUsername(db, parsed.data.username);
      if (clash && clash.id !== id) return c.json({ error: 'username already in use' }, 409);
    }

    if (parsed.data.email !== undefined) {
      const clash = await svc.getUserByEmail(db, parsed.data.email);
      if (clash && clash.id !== id) return c.json({ error: 'email already in use' }, 409);
    }

    // Never let the last admin be demoted — the system would lock itself out.
    if (parsed.data.role === 'agent' && (await svc.countAdmins(db, id)) === 0) {
      return c.json({ error: 'cannot demote the last admin' }, 409);
    }

    const user = await svc.updateUser(db, id, parsed.data);
    if (!user) return c.json({ error: 'user not found' }, 404);
    return c.json(user);
  });

  api.delete('/users/:id', admin, async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    const target = await svc.getUser(db, id);
    if (!target) return c.json({ error: 'user not found' }, 404);

    if (target.role === 'admin' && (await svc.countAdmins(db, id)) === 0) {
      return c.json({ error: 'cannot delete the last admin' }, 409);
    }

    await svc.deleteUser(db, id);
    return c.body(null, 204);
  });

  api.get('/tags', async (c) => c.json({ items: await svc.listTags(db) }));
  api.get('/stats', async (c) => c.json(await svc.stats(db)));

  // ---- Tokens (self-service) ---------------------------------------------

  /**
   * A user may manage their own tokens; an unbound machine token may not,
   * because it has no owner to scope the listing to.
   */
  const ownTokens = (c: { get: (k: 'auth') => Principal }) => {
    const p = c.get('auth');
    return p.userId;
  };

  api.get('/tokens', async (c) => {
    const userId = ownTokens(c);
    if (userId == null) return c.json({ error: 'token is not bound to a user' }, 400);
    return c.json({ items: await listTokens(db, userId) });
  });

  api.post('/tokens', async (c) => {
    const userId = ownTokens(c);
    if (userId == null) return c.json({ error: 'token is not bound to a user' }, 400);

    const raw = await c.req.json().catch(() => null);
    if (raw == null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = createTokenSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'validation failed', issues: issues(parsed.error) }, 422);

    // The plaintext is returned exactly once; only the hash is stored.
    const token = await createToken(db, parsed.data.name, userId);
    return c.json({ token, name: parsed.data.name }, 201);
  });

  api.delete('/tokens/:id', async (c) => {
    const userId = ownTokens(c);
    if (userId == null) return c.json({ error: 'token is not bound to a user' }, 400);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    // Scoped by owner: one user cannot revoke another user's token.
    if (!(await revokeToken(db, id, userId))) return c.json({ error: 'token not found' }, 404);
    return c.body(null, 204);
  });

  return api;
}
