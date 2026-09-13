import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { initDb } from './db/index.ts';
import { apiRoutes } from './routes/api.ts';
import { uiRoutes } from './routes/ui.tsx';
import { loginRoutes } from './routes/login.tsx';

/**
 * Compose the surfaces over one database.
 *
 * /api/*  → JSON, session- or token-authenticated, for programs.
 * /ui/*   → HTML, session-authenticated, for the browser.
 * /login  → public.
 *
 * API and UI call the same service layer, so the API cannot silently fall
 * behind the UI: they are the same operations with different renderings.
 */
export async function createApp(dbFile?: string) {
  const { db } = await initDb(dbFile);

  const app = new Hono();

  // Static assets and login are public; everything else sits behind auth.
  app.use(
    '/static/*',
    serveStatic({
      root: './public',
      rewriteRequestPath: (p) => p.replace(/^\/static/, ''),
    }),
  );

  app.route('/', loginRoutes(db));
  app.route('/api', apiRoutes(db));
  app.route('/', uiRoutes(db));

  app.notFound((c) =>
    c.req.path.startsWith('/api')
      ? c.json({ error: 'not found' }, 404)
      : c.text('404 Not Found', 404),
  );

  return app;
}
