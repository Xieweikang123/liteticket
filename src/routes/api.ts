import { Hono } from 'hono';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { TICKET_PRIORITIES, TICKET_STATUSES } from '../db/schema.ts';
import { verifyToken } from '../auth.ts';
import type { AuthContext } from '../auth.ts';
import * as svc from '../services/tickets.ts';

/** Context variables set by the auth middleware. */
type ApiEnv = { Variables: { auth: AuthContext } };

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

const createUserSchema = z.object({
  email: z.email('email must be a valid email'),
  name: z.string().min(1, 'name is required').max(200),
});

const updateUserSchema = z.object({
  email: z.email().optional(),
  name: z.string().min(1).max(200).optional(),
});

const listQuerySchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  assigneeId: z.coerce.number().int().positive().optional(),
  tag: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
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
   * Every other /api route requires a bearer token. Mounted before the
   * handlers so a new endpoint is protected by default, rather than by
   * remembering to add a check.
   */
  api.use('*', async (c, next) => {
    const header = c.req.header('Authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    if (!presented) {
      return c.json({ error: 'missing bearer token' }, 401);
    }

    const auth = await verifyToken(db, presented);
    if (!auth) {
      return c.json({ error: 'invalid token' }, 401);
    }

    c.set('auth', auth);
    await next();
  });

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

  api.delete('/tickets/:id', async (c) => {
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

    const comment = await svc.addComment(db, id, parsed.data);
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

  api.post('/users', async (c) => {
    const raw = await c.req.json().catch(() => null);
    if (raw == null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = createUserSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'validation failed', issues: issues(parsed.error) }, 422);

    if (await svc.getUserByEmail(db, parsed.data.email)) {
      return c.json({ error: 'email already in use' }, 409);
    }

    const user = await svc.createUser(db, parsed.data);
    return c.json(user, 201);
  });

  api.patch('/users/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    const raw = await c.req.json().catch(() => null);
    if (raw == null) return c.json({ error: 'invalid JSON body' }, 400);

    const parsed = updateUserSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'validation failed', issues: issues(parsed.error) }, 422);

    if (parsed.data.email !== undefined) {
      const clash = await svc.getUserByEmail(db, parsed.data.email);
      if (clash && clash.id !== id) return c.json({ error: 'email already in use' }, 409);
    }

    const user = await svc.updateUser(db, id, parsed.data);
    if (!user) return c.json({ error: 'user not found' }, 404);
    return c.json(user);
  });

  api.delete('/users/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);

    if (!(await svc.deleteUser(db, id))) return c.json({ error: 'user not found' }, 404);
    return c.body(null, 204);
  });

  api.get('/tags', async (c) => c.json({ items: await svc.listTags(db) }));
  api.get('/stats', async (c) => c.json(await svc.stats(db)));

  return api;
}
