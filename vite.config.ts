import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The client builds into web/dist, which the Hono server serves as static
 * files (see src/app.ts). In dev, Vite serves the app on its own port and
 * proxies /api to the API server, so there is no CORS surface and the client
 * always talks to a same-origin /api either way.
 */
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: Number.parseInt(process.env.LITETICKET_WEB_PORT ?? '5173', 10),
    strictPort: true,
    proxy: {
      '/api': {
        // Set by scripts/dev.mjs so the proxy follows the API's chosen port
        // when the default is already taken.
        target: process.env.LITETICKET_API_TARGET ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
