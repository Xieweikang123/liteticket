import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { ensureBootstrapToken, ensureSystemMenus, ensureSystemRoles, ensureUser, hashPassword, purgeExpiredTokens } from './auth.ts';
import { getDb } from './db/index.ts';
import { users } from './db/schema.ts';

const config = loadConfig();
const app = await createApp(config.dbFile);
const { db } = getDb();

// Roles before users: a user's permissions resolve against this table, and the
// seed admin below is assigned the `admin` role by name.
await ensureSystemRoles(db);

// The built-in tabs are reconciled from code, so a new menu-gated page reaches
// an existing install without a migration.
await ensureSystemMenus(db);

// A restart is a natural cleanup point for sessions that expired while the
// server was down; login sweeps again, so the table stays bounded either way.
await purgeExpiredTokens(db);

/**
 * Seed the first admin.
 *
 * Without this a fresh install would have no way to log in. The password comes
 * from LITETICKET_ADMIN_PASSWORD, falling back to "1" for the local-first,
 * one-command experience this project targets. Existing installs are untouched:
 * a user that already has a password and the admin role is left alone.
 */
const adminId = await ensureUser(db, config.adminUsername, config.adminEmail, 'Admin');
const admin = (await db.select().from(users).where(eq(users.id, adminId)).limit(1))[0];
const seededAdmin = Boolean(admin && !admin.passwordHash);
if (admin && (admin.role !== 'admin' || !admin.passwordHash)) {
  await db
    .update(users)
    .set({
      role: 'admin',
      passwordHash: admin.passwordHash ?? hashPassword(config.adminPassword),
    })
    .where(eq(users.id, adminId));
}

/**
 * Bootstrap the first API token.
 *
 * The plaintext token is shown exactly once, on the boot that creates it. If
 * LITETICKET_TOKEN is set, that value becomes the token so deployments can
 * pre-seed a known credential (tests, containers); otherwise one is generated
 * and printed. Either way only the hash is stored.
 */
const bootstrapToken = await ensureBootstrapToken(db, config.bootstrapToken);

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

  if (seededAdmin) {
    console.log('');
    console.log('  Admin login (change the password after signing in):');
    console.log(`    ${config.adminUsername} / ${config.adminPassword}`);
  }
  console.log('');
});
