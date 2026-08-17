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
  // ==========================================================================
  // WHY maplibre-gl IS PINNED TO v5 AND NOT v6
  //
  // v6 does not work under Vite here, and the failure is almost perfectly
  // disguised. The map RENDERS -- countries, borders, atmosphere, all correct
  // -- and the `load` event never fires. Everything that gets its data after
  // load (facility markers, supply arcs, the day/night terminator) stays
  // empty; `map.getSource()` returns undefined, `getStyle()` reports no
  // sources, and `setPaintProperty` throws "Style is not done loading". No
  // console error, no `error` event, no failed request. A globe that looks
  // finished and is inert.
  //
  // Isolated by building a probe map with NO SOURCES AT ALL, just a background
  // layer: it never loaded either. That ruled out the style, the data, and the
  // GeoJSON, and left the worker -- v6 ships its renderer as a separate ES
  // module worker (`maplibre-gl-worker.mjs`), and Vite mishandles it in two
  // different ways depending on configuration:
  //
  //   - pre-bundled: "the file does not exist at
  //     .vite/deps/maplibre-gl-worker.mjs which is in the optimize deps
  //     directory"
  //   - `optimizeDeps.exclude`: Vite serves it through its own transform
  //     pipeline, which prepends `import { injectQuery } from "/@vite/client"`.
  //     `/@vite/client` uses `document`; a Worker has no `document`.
  //
  // `worker: { format: 'es' }` fixed the format half and not the rest.
  //
  // **v5 inlines its worker** -- the only separate worker files it ships are
  // the CSP variants -- so none of Vite's worker handling applies. It carries
  // everything §7.2 needs, verified against its own type declarations, not its
  // docs: `ProjectionSpecification`, `SkySpecification`, `atmosphere-blend`,
  // `setProjection`. Nothing was given up.
  //
  // The lesson worth keeping: this class of bug is invisible to `npm run
  // build:web` AND to the test suite. `web/tests/mapLazy.test.ts` was green
  // throughout -- the chunks split correctly, they just did not work. It was
  // found by opening the page and asking why one event had not fired.
  // ==========================================================================
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
