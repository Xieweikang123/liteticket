import { serve } from '@hono/node-server';
import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { createToken, ensureUser } from './auth.ts';
import { getDb } from './db/index.ts';
import { tokens } from './db/schema.ts';

const config = loadConfig();
const app = await createApp(config.dbFile);
const { db } = getDb();

/**
 * Bootstrap the first API token.
 *
 * The plaintext token is shown exactly once, on the boot that creates it. If
 * LITETICKET_TOKEN is set, that value is used so deployments can pre-seed a
 * known token; otherwise one is generated and printed here.
 */
await ensureUser(db, 'admin@localhost', 'Admin');

const existing = await db.select({ id: tokens.id }).from(tokens).limit(1);
let bootstrapToken: string | null = null;

if (existing.length === 0) {
  bootstrapToken = await createToken(db, 'bootstrap', null);
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${info.port}`;
  console.log('');

  // `pnpm dev` prints its own banner (with port selection, db path, etc.), so
  // it sets this to avoid a duplicate. A bare `node src/server.ts` still gets
  // the full output.
  if (process.env.LITETICKET_QUIET_BANNER !== '1') {
    console.log('  liteticket 0.1.0');
    console.log(`  Web UI    ${url}`);
    console.log(`  REST API  ${url}/api`);
    console.log(`  Database  ${config.dbFile}`);
  }

  if (bootstrapToken) {
    console.log('');
    console.log('  API token (shown once — save it now):');
    console.log(`    ${bootstrapToken}`);
  }
  console.log('');
});
