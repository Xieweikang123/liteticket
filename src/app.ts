import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { initDb } from './db/index.ts';
import { apiRoutes } from './routes/api.ts';
import { uiRoutes } from './routes/ui.tsx';

/**
 * Compose the two surfaces over one database.
 *
 * /api/* → JSON, token-protected, for programs.
 * /ui/*  → HTML, for the browser.
 *
 * Both call the same service layer, so the API cannot silently fall behind the
 * UI: they are the same operations with different renderings.
 */
export async function createApp(dbFile?: string) {
  const { db } = await initDb(dbFile);

  const app = new Hono();

  app.route('/api', apiRoutes(db));
  app.route('/', uiRoutes(db));

  // htmx is served from disk rather than a CDN so the app works offline and
  // behind a firewall — consistent with "no external dependencies".
  app.use(
    '/static/*',
    serveStatic({
      root: './public',
      rewriteRequestPath: (p) => p.replace(/^\/static/, ''),
    }),
  );

  app.notFound((c) =>
    c.req.path.startsWith('/api')
      ? c.json({ error: 'not found' }, 404)
      : c.text('404 Not Found', 404),
  );

  return app;
}
