import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { initDb } from './db/index.ts';
import { apiRoutes } from './routes/api.ts';

/**
 * Compose the server over one database.
 *
 * /api/*  → JSON, bearer-token authenticated. This is the whole backend; the
 *           React client in web/ is just another consumer of it.
 * /*      → the built SPA (web/dist), served as static files.
 *
 * There is no server-rendered HTML left: the API is the only surface, so the
 * two cannot drift.
 */
export async function createApp(dbFile?: string) {
  const { db } = await initDb(dbFile);

  const app = new Hono();

  app.route('/api', apiRoutes(db));

  /**
   * Serve the built client. Everything that is not a real file falls back to
   * index.html so client-side routes (/tickets/42) survive a hard refresh
   * instead of 404ing.
   *
   * The fallback deliberately excludes /api: an unmatched API path must stay a
   * JSON 404, otherwise a typo'd endpoint would silently return the SPA shell
   * with a 200 and the client would fail on "Unexpected token '<'".
   */
  const dist = './web/dist';
  const hasDist = existsSync(dist);

  if (hasDist) {
    app.use(
      '/assets/*',
      serveStatic({ root: dist, rewriteRequestPath: (p) => p.replace(/^/, '/') }),
    );
    app.use('*', serveStatic({ root: dist }));
    app.get('*', (c) => {
      // An unmatched API path must stay a JSON 404 rather than falling through
      // to the SPA shell, which would answer a typo'd endpoint with 200 HTML.
      if (c.req.path.startsWith('/api')) return c.json({ error: 'not found' }, 404);
      return c.html(readFileSync(join(dist, 'index.html'), 'utf8'));
    });
  } else {
    // A bare API run (tests, `tsx src/server.ts`) should not need a client
    // build. Say so plainly instead of returning a confusing 404.
    app.get('*', (c) =>
      c.req.path.startsWith('/api')
        ? c.json({ error: 'not found' }, 404)
        : c.text('Client not built. Run `pnpm build:web` (or `pnpm dev` for the dev server).', 503),
    );
  }

  app.notFound((c) =>
    c.req.path.startsWith('/api')
      ? c.json({ error: 'not found' }, 404)
      : c.text('404 Not Found', 404),
  );

  return app;
}
