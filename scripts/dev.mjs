/**
 * One-command launcher.
 *
 * `pnpm dev` should just work from a fresh clone: install check, database
 * bootstrap, free-port selection, browser open. Everything a first-time user
 * would otherwise have to discover by reading the README.
 *
 * Two processes run side by side: the API (tsx watch) and the Vite dev server
 * for the React client. Vite is what you open — it proxies /api to the API
 * port, so the browser only ever talks to one origin and there is no CORS
 * surface in dev.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = new Set(process.argv.slice(2));
const noOpen = args.has('--no-open');
const resetDb = args.has('--reset');
const quiet = args.has('--quiet');

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

const log = (...a) => {
  if (!quiet) console.log(...a);
};

/** Fail early with an actionable message instead of a stack trace. */
if (!existsSync(join(root, 'node_modules'))) {
  console.error(yellow('Dependencies are not installed.'));
  console.error(`Run ${bold('pnpm install')} first, then try again.`);
  process.exit(1);
}

const dbFile = process.env.LITETICKET_DB ?? './data/liteticket.db';
const dbPath = join(root, dbFile);

if (resetDb) {
  const { rmSync } = await import('node:fs');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
  log(dim('  database reset'));
}

/** Find a free port starting at `preferred`, so a stale server is not fatal. */
async function findPort(preferred, attempts = 12) {
  for (let p = preferred; p < preferred + attempts; p += 1) {
    const free = await new Promise((resolve) => {
      const srv = createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(p, '127.0.0.1');
    });
    if (free) return p;
  }
  return null;
}

const preferred = Number.parseInt(process.env.PORT ?? '8787', 10);
const port = await findPort(Number.isFinite(preferred) ? preferred : 8787);

if (port === null) {
  console.error(yellow('No free port found in range.'));
  console.error(`Set one explicitly, e.g. ${bold('$env:PORT=9000; pnpm dev')}`);
  process.exit(1);
}

const preferredWeb = Number.parseInt(process.env.WEB_PORT ?? '5173', 10);
const webPort = await findPort(Number.isFinite(preferredWeb) ? preferredWeb : 5173, 20);

if (webPort === null) {
  console.error(yellow('No free port found for the Vite dev server.'));
  console.error(`Set one explicitly, e.g. ${bold('$env:WEB_PORT=5200; pnpm dev')}`);
  process.exit(1);
}

const apiUrl = `http://127.0.0.1:${port}`;
const url = `http://127.0.0.1:${webPort}`;

// The port must be exported before the server module reads it.
process.env.PORT = String(port);
process.env.LITETICKET_SELF_BASE = apiUrl;
// The launcher already printed the banner; suppress the server's duplicate.
process.env.LITETICKET_QUIET_BANNER = '1';
// Vite proxies /api here, so the client works on the Vite origin in dev.
process.env.LITETICKET_API_TARGET = apiUrl;
process.env.LITETICKET_WEB_PORT = String(webPort);

/**
 * Report whether this boot will mint a token. The server prints it once; this
 * makes that visible before the log scrolls.
 */
async function existingTokenCount() {
  if (!existsSync(dbPath)) return 0;
  try {
    const client = createClient({ url: `file:${dbPath}` });
    const res = await client.execute('SELECT count(*) AS n FROM tokens');
    await client.close();
    return Number(res.rows[0]?.n ?? 0);
  } catch {
    // Table missing or file unreadable: treat as a fresh install.
    return 0;
  }
}

const hadToken = (await existingTokenCount()) > 0;

log('');
log(`  ${bold('liteticket')} ${dim('0.1.0')}`);
log(`  ${dim('web')}    ${cyan(url)}`);
log(`  ${dim('api')}    ${cyan(`${apiUrl}/api`)}`);
log(`  ${dim('db')}     ${dbFile}`);
log('');
log(dim('  starting api + vite…'));
log('');

if (!hadToken) {
  log(yellow('  First run: an admin login and an API token will be printed below.'));
  log(yellow('  Save the token — it is shown once and stored only as a hash.'));
  log('');
}

// Open the browser once the Vite dev server is actually accepting connections.
if (!noOpen) {
  void (async () => {
    for (let i = 0; i < 200; i += 1) {
      try {
        await fetch(url);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    const cmd =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    try {
      spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref();
    } catch {
      // Opening a browser is a convenience; never fail the run over it.
    }
  })();
}

// Hand off to tsx watching the source.
//
// Resolve tsx's JS entry and run it with the current node binary rather than
// shelling out to the .cmd shim: `shell: true` with args triggers a Node
// deprecation warning and does not escape arguments.
//
// The watch set is scoped with --include to src/ only. Watching the whole
// project would restart the server on every SQLite write: WAL mode touches
// data/*.db-shm per request, which looks like a source change. It also keeps
// Vite's own file churn from restarting the API.
const tsxEntry = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const api = spawn(
  process.execPath,
  [tsxEntry, 'watch', '--include', 'src/**/*', 'src/server.ts'],
  {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  },
);

// Vite's own JS entry, run the same way, for the same reason.
const viteEntry = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const web = spawn(
  process.execPath,
  [viteEntry, '--port', String(webPort), '--strictPort'],
  {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  },
);

let exiting = false;

/**
 * If either process dies, stop the other: a half-running pair is worse than a
 * clean exit, because the browser gets connection errors with no explanation.
 */
function shutdown(code) {
  if (exiting) return;
  exiting = true;
  for (const child of [api, web]) {
    if (child.exitCode === null) child.kill();
  }
  process.exitCode = code;
}

api.on('exit', (code) => shutdown(code ?? 1));
web.on('exit', (code) => shutdown(code ?? 1));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const child of [api, web]) {
      if (child.exitCode === null) child.kill(sig);
    }
  });
}
