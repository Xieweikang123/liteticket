#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * In development this loads TypeScript directly through tsx so `node
 * bin/liteticket.js` works straight from a git clone — no build step, which is
 * the whole point of the project. Once `pnpm build` has produced dist/, that
 * output is preferred because it needs no loader at all.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const compiled = join(root, 'dist', 'server.js');
const source = join(root, 'src', 'server.ts');

// Dynamic import() requires a file:// URL; a bare Windows path like D:\... is
// rejected by the ESM loader as an unsupported scheme.
const load = (p) => import(pathToFileURL(p).href);

if (existsSync(compiled)) {
  await load(compiled);
} else if (existsSync(source)) {
  // Register the TypeScript loader, then hand off to the real entry point.
  await import('tsx/esm');
  await load(source);
} else {
  console.error('liteticket: could not find dist/server.js or src/server.ts');
  process.exit(1);
}
