import { randomBytes } from 'node:crypto';

export interface Config {
  port: number;
  host: string;
  dbFile: string;
  /** Public base URL, used when the UI calls its own API. */
  selfBase: string;
  /** Set once on first boot; printed to the console. */
  bootstrapToken: string;
  /** Seed admin, created on first boot. */
  adminEmail: string;
  adminPassword: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): Config {
  const port = envInt('PORT', envInt('LITETICKET_PORT', 8787));
  const host = process.env.HOST ?? process.env.LITETICKET_HOST ?? '127.0.0.1';
  return {
    port,
    host,
    dbFile: process.env.LITETICKET_DB ?? './data/liteticket.db',
    // The UI talks to the API over loopback. 127.0.0.1 avoids the IPv6/IPv4
    // resolution mismatch that bites when host is "localhost".
    selfBase: process.env.LITETICKET_SELF_BASE ?? `http://127.0.0.1:${port}`,
    bootstrapToken: process.env.LITETICKET_TOKEN ?? randomBytes(24).toString('base64url'),
    adminEmail: process.env.LITETICKET_ADMIN_EMAIL ?? 'admin@localhost',
    // The default is intentionally weak: this is a local-first tool and the UI
    // binds to 127.0.0.1 by default. Set LITETICKET_ADMIN_PASSWORD before
    // exposing it on a network.
    adminPassword: process.env.LITETICKET_ADMIN_PASSWORD ?? '1',
  };
}
