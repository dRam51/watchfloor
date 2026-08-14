import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// ---------------------------------------------------------------------------
// Watchfloor frontend build config (M3 task 7). See the task 7 report
// (.superpowers/sdd/2026-08-14-m3-api-dashboard/task-7-report.md) for the
// full reasoning behind every decision below; this file only summarizes.
//
// SERVING DECISION: `vite` (dev) and `vite preview` (prod) are the ONLY
// processes that ever serve web/dist -- the token-gated Fastify API
// (src/api/server.ts) never does. src/api/auth.ts's onRequest hook is
// registered at the Fastify ROOT instance specifically so it protects every
// route on that server, including ones added after buildServer() returns --
// there is no supported way to exempt a broad set of static paths from it
// without editing that file, which is out of scope for this task. Separately,
// a browser cannot attach a custom Authorization header to a plain page
// navigation at all, so index.html could never be requested through that
// hook regardless. Serving statics from a second, unauthenticated listener
// sidesteps both problems and needed zero new dependencies: `vite preview`
// already ships with Vite.
// ---------------------------------------------------------------------------

// Read directly from process.env, matching every other entrypoint in this
// repo (`node --env-file=.env ...` -- see package.json's "dev:web" and
// "preview:web" scripts). No dotenv-style package, no VITE_-prefixed client
// exposure: the port number is not a secret, but keeping to one way this
// repo reads .env is worth more than saving a few characters here.
const apiPort = Number(process.env.WF_API_PORT ?? 8787);
const apiTarget = `http://127.0.0.1:${apiPort}`;

// src/api/server.ts namespaces every route under `/api` except `/health`,
// which stays at the root as an unauthenticated liveness probe (see that
// file's own comment on the `/api` prefix: it exists partly so a future
// client-side route of the same name -- `/search` as a UI view, for
// instance -- cannot collide with an API route, and so this proxy has
// exactly one clean pattern to forward). Two entries, not a list of every
// individual route: a new backend route under `/api` needs zero changes
// here.
const apiRoutePaths = ['/health', '/api'];

const proxy = Object.fromEntries(
  apiRoutePaths.map((path) => [path, { target: apiTarget, changeOrigin: true }]),
);

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: { proxy },
  // `preview` does not inherit `server.proxy` automatically -- Vite treats
  // them as separate config surfaces, so this is repeated deliberately
  // rather than assumed.
  preview: { proxy },
  build: {
    outDir: 'dist', // resolves to web/dist -- distinct from the server's own dist/ (tsc -p tsconfig.json)
    emptyOutDir: true,
  },
});
