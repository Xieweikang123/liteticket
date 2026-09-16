import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { PERMISSIONS, TICKET_PRIORITIES, TICKET_STATUSES } from '../db/schema.ts';
import type { Permission } from '../db/schema.ts';
import {
  createToken,
  findUserForLogin,
  listTokens,
  purgeExpiredTokens,
  revokeSession,
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
  role: string;
  permissions: Permission[];
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

/** A role key: lowercase, greppable, and safe to store on the user row. */
const roleName = z
  .string()
  .min(1, 'name is required')
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/, 'name must start with a letter and use a-z, 0-9, _ -');

const createUserSchema = z.object({
  username,
  email: z.email('email must be a valid email'),
  name: z.string().min(1, 'name is required').max(200),
  role: roleName.optional(),
  password: z.string().min(1).max(200).optional(),
});

const updateUserSchema = z.object({
  username: username.optional(),
  email: z.email().optional(),
  name: z.string().min(1).max(200).optional(),
  role: roleName.optional(),
  password: z.string().min(1).max(200).optional(),
});

const createRoleSchema = z.object({
  name: roleName,
  label: z.string().min(1, 'label is required').max(100),
  description: z.string().max(500).nullish(),
  permissions: z.array(z.enum(PERMISSIONS)).default([]),
});

const updateRoleSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullish(),
  permissions: z.array(z.enum(PERMISSIONS)).optional(),
});

/**
 * A nav tab. `name` is a stable machine key; `path` must be an in-app route,
 * so it starts with `/` and never with `//` (which a browser reads as a
 * protocol-relative URL). `permission` null means every signed-in user sees it.
 */
const menuPath = z
  .string()
  .min(1, 'path is required')
  .max(200)
  .regex(/^\/[^/]/, 'path must be an absolute in-app route, e.g. /reports');

const menuPermission = z.enum(PERMISSIONS).nullish();

const createMenuSchema = z.object({
  name: roleName,
  label: z.string().min(1, 'label is required').max(100),
  path: menuPath,
  permission: menuPermission,
  sort: z.number().int().min(0).max(100000).optional(),
  visible: z.boolean().optional(),
});

const updateMenuSchema = z.object({
  name: roleName.optional(),
  label: z.string().min(1).max(100).optional(),
  path: menuPath.optional(),
  permission: menuPermission,
  sort: z.number().int().min(0).max(100000).optional(),
  visible: z.boolean().optional(),
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

/**
 * A user changing their own password. The current password is required and
 * verified, so a stolen session token alone cannot lock the owner out.
 */
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'currentPassword is required').max(200),
  newPassword: z.string().min(1, 'newPassword is required').max(200),
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
   *
   * The token is a `session`: it has an expiry and is deleted on logout. It is
   * kept out of the token page, which lists only the user's long-lived `api`
   * credentials.
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

    // A login is the natural moment to sweep stale sessions: the table stays
    // bounded by live sessions instead of growing with every sign-in.
    await purgeExpiredTokens(db);

    const name = parsed.data.tokenName ?? `login-${new Date().toISOString().slice(0, 10)}`;
    const token = await createToken(db, name, user.id, { kind: 'session' });

    const role = await svc.getRoleByName(db, user.role);
    return c.json({
      token,
      user: { id: user.id, username: user.username, email: user.email, name: user.name, role: user.role },
      permissions: role?.permissions ?? [],
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
      permissions: auth.permissions,
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
      permissions: p.permissions,
      user,
    });
  });

  /**
   * Log out: delete the server-side session the caller presented.
   *
   * Clearing localStorage alone left the row in the database valid forever, so
   * the token had to expire; this is what makes sign-out real. Scoped to
   * `session` rows — a login cannot be used to cancel a named API token, which
   * is deliberate and not a side effect of signing out. Idempotent: a token
   * that is already gone still answers 204.
   */
  api.post('/auth/logout', async (c) => {
    const p = c.get('auth');
    await revokeSession(db, p.tokenId);
    return c.body(null, 204);
  });

  /**
   * Change your own password.
   *
   * Gated on a bound user rather than on `users.manage`: a password is a
   * property of the account, not a management capability, so an agent with no
   * administrative rights can still rotate their own. The current password is
   * re-verified because a bearer token is enough to act as the user but is not
   * proof that the holder knows the password — without this, a leaked token
   * could be used to seize the account. Changing the password revokes every
   * token for that user (see `updateUser`), so the caller must log in again.
   */
  api.post('/auth/password', async (c) => {
    const p = c.get('auth');
    if (p.userId == null) return c.json({ error: 'token is not bound to a user' }, 400);

    const raw = await c.req.json().catch(() => null);
    if (raw == null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = changePasswordSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'validation failed', issues: issues(parsed.error) }, 422);

    const row = await svc.getUserByIdForAuth(db, p.userId);
    if (!row) return c.json({ error: 'user not found' }, 404);

    // 403, not 401: the client treats every 401 on an authenticated request as
    // a dead token — it clears the stored token and bounces the user to login.
    // A mistyped current password is a bad argument, not an expired session, so
    // returning 401 here logged people out and replaced this message with
    // 登录已失效. 401 stays reserved for "your token is no longer valid".
    if (!verifyPassword(parsed.data.currentPassword, row.passwordHash)) {
      return c.json({ error: '当前密码不正确' }, 403);
    }

    await svc.updateUser(db, p.userId, { password: parsed.data.newPassword });
    return c.body(null, 204);
  });

  /**
   * Guard a route on a capability rather than a role name. Roles are
   * data, so a route must not test for `role === 'admin'` — that would tie the
   * permission model back to two hard-coded names. An unbound machine token
   * carries every permission and therefore passes.
   */
  const can = (permission: Permission): MiddlewareHandler<ApiEnv> => async (c, next) => {
    const principal = c.get('auth');
    if (principal.permissions.includes(permission)) return next();
    return c.json({ error: `permission required: ${permission}` }, 403);
  };

  api.get('/tickets', can('tickets.read'), async (c) => {
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

  api.get('/tickets/:id', can('tickets.read'), async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    const ticket = await svc.getTicket(db, id);
    if (!ticket) return c.json({ error: 'ticket not found' }, 404);

    // Public API callers never see internal notes unless they explicitly ask.
    const includeInternal = c.req.query('includeInternal') === 'true';
    const commentList = await svc.listComments(db, id, { includeInternal });
    return c.json({ ...ticket, comments: commentList });
  });

  api.post('/tickets', can('tickets.write'), async (c) => {
    const raw = await c.req.json().catch(() => null);
    if (raw == null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = createTicketSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'validation failed', issues: issues(parsed.error) }, 422);

    // `assigneeId` is a foreign key, so a value pointing at a missing user
    // would surface as a raw SQLite constraint error (500) rather than a
    // structured rejection. Check it here so the failure is a 422.
    if (parsed.data.assigneeId != null && !(await svc.getUser(db, parsed.data.assigneeId))) {
      return c.json({ error: 'assignee not found' }, 422);
    }

    const ticket = await svc.createTicket(db, parsed.data);
    return c.json(ticket, 201);
  });

  api.patch('/tickets/:id', can('tickets.write'), async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    const raw = await c.req.json().catch(() => null);
    if (raw == null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = updateTicketSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'validation failed', issues: issues(parsed.error) }, 422);

    if (parsed.data.assigneeId != null && !(await svc.getUser(db, parsed.data.assigneeId))) {
      return c.json({ error: 'assignee not found' }, 422);
    }

    const ticket = await svc.updateTicket(db, id, parsed.data);
    if (!ticket) return c.json({ error: 'ticket not found' }, 404);
    return c.json(ticket);
  });

  api.delete('/tickets/:id', can('tickets.delete'), async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    if (!(await svc.deleteTicket(db, id))) return c.json({ error: 'ticket not found' }, 404);
    return c.body(null, 204);
  });

  api.get('/tickets/:id/comments', can('tickets.read'), async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
    if (!(await svc.getTicket(db, id))) return c.json({ error: 'ticket not found' }, 404);

    const includeInternal = c.req.query('includeInternal') === 'true';
    return c.json({ items: await svc.listComments(db, id, { includeInternal }) });
  });

  api.post('/tickets/:id/comments', can('tickets.write'), async (c) => {
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

    // Same foreign-key guard as `assigneeId`: an author that does not exist is
    // a rejected input, not a database crash.
    if (input.authorId != null && !(await svc.getUser(db, input.authorId))) {
      return c.json({ error: 'author not found' }, 422);
    }

    const comment = await svc.addComment(db, id, input);
    if (!comment) return c.json({ error: 'ticket not found' }, 404);
    return c.json(comment, 201);
  });

  // Listing users is needed to populate the assignee picker on a ticket, so it
  // is gated on `users.read` — which the built-in agent role has.
  api.get('/users', can('users.read'), async (c) => c.json({ items: await svc.listUsers(db) }));

  api.get('/users/:id', can('users.read'), async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    const user = await svc.getUser(db, id);
    if (!user) return c.json({ error: 'user not found' }, 404);
    return c.json(user);
  });

  api.post('/users', can('users.manage'), async (c) => {
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
    if (parsed.data.role !== undefined && !(await svc.getRoleByName(db, parsed.data.role))) {
      return c.json({ error: 'role not found' }, 422);
    }

    const user = await svc.createUser(db, parsed.data);
    return c.json(user, 201);
  });

  api.patch('/users/:id', can('users.manage'), async (c) => {
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

    if (parsed.data.role !== undefined) {
      const target = await svc.getUser(db, id);
      if (!target) return c.json({ error: 'user not found' }, 404);
      if (!(await svc.getRoleByName(db, parsed.data.role))) {
        return c.json({ error: 'role not found' }, 422);
      }

      // Moving a user off a role that can manage roles must not remove the
      // last such user — the system would lock itself out.
      const targetRole = await svc.getRoleByName(db, target.role);
      const losingRoleManage =
        targetRole?.permissions.includes('roles.manage') &&
        !(await svc.getRoleByName(db, parsed.data.role))!.permissions.includes('roles.manage');
      if (losingRoleManage && (await svc.countRoleManagers(db, id)) === 0) {
        return c.json({ error: 'cannot remove the last role manager' }, 409);
      }
    }

    const user = await svc.updateUser(db, id, parsed.data);
    if (!user) return c.json({ error: 'user not found' }, 404);
    return c.json(user);
  });

  api.delete('/users/:id', can('users.manage'), async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    const target = await svc.getUser(db, id);
    if (!target) return c.json({ error: 'user not found' }, 404);

    const targetRole = await svc.getRoleByName(db, target.role);
    if (targetRole?.permissions.includes('roles.manage') && (await svc.countRoleManagers(db, id)) === 0) {
      return c.json({ error: 'cannot delete the last role manager' }, 409);
    }

    await svc.deleteUser(db, id);
    return c.body(null, 204);
  });

  // ---- Roles -------------------------------------------------------------

  api.get('/roles', can('users.read'), async (c) => c.json({ items: await svc.listRoles(db) }));

  api.get('/permissions', can('users.read'), (c) => c.json({ items: PERMISSIONS }));

  api.post('/roles', can('roles.manage'), async (c) => {
    const raw = await c.req.json().catch(() => null);
    if (raw == null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = createRoleSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'validation failed', issues: issues(parsed.error) }, 422);

    if (await svc.getRoleByName(db, parsed.data.name)) {
      return c.json({ error: 'role name already in use' }, 409);
    }

    const role = await svc.createRole(db, parsed.data);
    return c.json(role, 201);
  });

  api.patch('/roles/:id', can('roles.manage'), async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    const role = await svc.getRole(db, id);
    if (!role) return c.json({ error: 'role not found' }, 404);
    // System roles are reconciled from code on every boot, so editing them here
    // would be silently undone. Refuse rather than surprise the caller.
    if (role.isSystem) return c.json({ error: 'system role cannot be edited' }, 409);

    const raw = await c.req.json().catch(() => null);
    if (raw == null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = updateRoleSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'validation failed', issues: issues(parsed.error) }, 422);

    // Removing `roles.manage` from a role must not leave nobody able to grant
    // it back. Users on this role are counted; if they are the only managers,
    // refuse.
    if (parsed.data.permissions !== undefined && role.permissions.includes('roles.manage')) {
      const keeps = parsed.data.permissions.includes('roles.manage');
      if (!keeps) {
        const holders = await svc.listUsersByRole(db, role.name);
        const remaining = await svc.countRoleManagersExcludingRole(db, role.name);
        if (holders.length > 0 && remaining === 0) {
          return c.json({ error: 'cannot remove the last role manager' }, 409);
        }
      }
    }

    const updated = await svc.updateRole(db, id, parsed.data);
    if (!updated) return c.json({ error: 'role not found' }, 404);
    return c.json(updated);
  });

  api.delete('/roles/:id', can('roles.manage'), async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    const role = await svc.getRole(db, id);
    if (!role) return c.json({ error: 'role not found' }, 404);
    if (role.isSystem) return c.json({ error: 'system role cannot be deleted' }, 409);

    // A role still held by users cannot be deleted: their `users.role` would
    // point at nothing and they would silently lose all access.
    const holders = await svc.listUsersByRole(db, role.name);
    if (holders.length > 0) {
      return c.json({ error: `role is assigned to ${holders.length} user(s)` }, 409);
    }

    await svc.deleteRole(db, id);
    return c.body(null, 204);
  });

  api.get('/tags', can('tickets.read'), async (c) => c.json({ items: await svc.listTags(db) }));
  api.get('/stats', can('tickets.read'), async (c) => c.json(await svc.stats(db)));

  // ---- Menus -------------------------------------------------------------
  //
  // The nav is data, so every signed-in user needs to read it. `GET /menus`
  // returns only the tabs the caller may actually see: hidden rows are
  // dropped, and a row gated on a permission the caller lacks is dropped too.
  // That filtering lives here rather than in the client because the client
  // cannot be trusted with a menu it must not render — and because a menu
  // pointing at a forbidden page would be a dead end anyway.
  //
  // `?all=true` is the management view: it returns hidden and ungated rows and
  // is gated on `menus.manage` instead.
  api.get('/menus', async (c) => {
    const principal = c.get('auth');
    const menus = await svc.listMenus(db);
    const all = c.req.query('all') === 'true';

    if (all) {
      if (!principal.permissions.includes('menus.manage')) {
        return c.json({ error: 'permission required: menus.manage' }, 403);
      }
      return c.json({ items: menus });
    }

    const visible = menus.filter(
      (m) =>
        m.visible &&
        (m.permission == null || principal.permissions.includes(m.permission)),
    );
    return c.json({ items: visible });
  });

  api.post('/menus', can('menus.manage'), async (c) => {
    const raw = await c.req.json().catch(() => null);
    if (raw == null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = createMenuSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'validation failed', issues: issues(parsed.error) }, 422);

    if (await svc.getMenuByName(db, parsed.data.name)) {
      return c.json({ error: 'menu name already in use' }, 409);
    }

    const menu = await svc.createMenu(db, parsed.data);
    return c.json(menu, 201);
  });

  api.patch('/menus/:id', can('menus.manage'), async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    const menu = await svc.getMenu(db, id);
    if (!menu) return c.json({ error: 'menu not found' }, 404);

    const raw = await c.req.json().catch(() => null);
    if (raw == null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = updateMenuSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'validation failed', issues: issues(parsed.error) }, 422);

    if (parsed.data.name !== undefined) {
      const clash = await svc.getMenuByName(db, parsed.data.name);
      if (clash && clash.id !== id) return c.json({ error: 'menu name already in use' }, 409);
    }

    // A built-in tab targets a route the SPA owns and a permission its page
    // actually enforces; letting either drift would produce a tab that 404s or
    // that shows a page which then 403s. `ensureSystemMenus` reconciles both on
    // boot, so an accepted edit here would be silently undone — refuse by
    // dropping them from the patch rather than reporting a change that will not
    // persist. `label`, `sort`, and `visible` are the admin's.
    const patch = { ...parsed.data };
    if (menu.isSystem) {
      delete patch.name;
      delete patch.path;
      delete patch.permission;
    }

    const updated = await svc.updateMenu(db, id, patch);
    if (!updated) return c.json({ error: 'menu not found' }, 404);
    return c.json(updated);
  });

  api.delete('/menus/:id', can('menus.manage'), async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    const menu = await svc.getMenu(db, id);
    if (!menu) return c.json({ error: 'menu not found' }, 404);
    // A built-in tab's SPA route remains routable, so removing the tab would
    // hide a page with no way back. Hiding it (`visible: false`) is the
    // supported alternative.
    if (menu.isSystem) return c.json({ error: 'system menu cannot be deleted' }, 409);

    await svc.deleteMenu(db, id);
    return c.body(null, 204);
  });

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

    // The plaintext is returned exactly once; only the hash is stored. This is
    // an explicit, named `api` credential — unlike the session minted by login.
    const token = await createToken(db, parsed.data.name, userId, { kind: 'api' });
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
