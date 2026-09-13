/**
 * One-command launcher.
 *
 * `pnpm dev` should just work from a fresh clone: install check, database
 * bootstrap, free-port selection, browser open. Everything a first-time user
 * would otherwise have to discover by reading the README.
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

const url = `http://127.0.0.1:${port}`;

// The port must be exported before the server module reads it.
process.env.PORT = String(port);
process.env.LITETICKET_SELF_BASE = url;
// The launcher already printed the banner; suppress the server's duplicate.
process.env.LITETICKET_QUIET_BANNER = '1';

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
log(`  ${dim('api')}    ${cyan(`${url}/api`)}`);
log(`  ${dim('db')}     ${dbFile}`);
log('');
log(dim('  starting…'));
log('');

if (!hadToken) {
  log(yellow('  First run: an API token will be printed below. Save it —'));
  log(yellow('  it is shown once and stored only as a hash.'));
  log('');
}

// Open the browser once the server is actually accepting connections.
if (!noOpen) {
  void (async () => {
    for (let i = 0; i < 100; i += 1) {
      try {
        await fetch(`${url}/api/health`);
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
// data/*.db-shm per request, which looks like a source change.
const tsxEntry = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const child = spawn(
  process.execPath,
  [tsxEntry, 'watch', '--include', 'src/**/*', 'src/server.ts'],
  {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  },
);

child.on('exit', (code) => process.exit(code ?? 0));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
