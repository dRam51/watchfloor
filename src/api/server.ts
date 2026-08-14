import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '../db/connection.ts';
import type { Env } from '../config/env.ts';
import type { Source } from '../sources/load.ts';
import type { DecayConfig } from '../score/decay.ts';
import type { OverridesConfig } from '../score/overrides.ts';
import { registerHealth } from './routes/health.ts';
import { registerAuth } from './auth.ts';
import { registerFeed } from './routes/feed.ts';
import { registerSources, countFailingSources } from './routes/sources.ts';
import { registerDashboard } from './routes/dashboard.ts';
import { registerSearch } from './routes/search.ts';

export interface ServerDeps {
  db: Db;
  env: Env;
  /**
   * The validated source list, not just its count. M3's source-health and
   * dashboard routes both need the full entries (name, beats, poll_interval,
   * enabled) to answer "is this source failing or merely quiet", which cannot
   * be derived from a number. `/health` still reports only the count.
   */
  sources: Source[];
  decayConfig: DecayConfig;
  overridesConfig: OverridesConfig;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const server = Fastify({ logger: false });

  // Registered first, at the root instance, before any route exists yet.
  // Because this hook is added at the root (not inside a `.register()`
  // plugin context), Fastify's encapsulation model makes it apply to every
  // route regardless of registration order — a route added by a later task,
  // or even by a test after buildServer() returns, is still covered. See
  // src/api/auth.ts for the exemption list and the reasoning behind it.
  registerAuth(server, deps.env.WF_API_TOKEN);

  // `/health` stays at the root, unprefixed and unauthenticated: it is a
  // liveness probe for process supervision (§12), and a supervisor should not
  // have to know about an API namespace to ask whether the process is alive.
  registerHealth(server, deps);

  // Everything else lives under `/api`. Wave 2's three route modules each
  // registered bare paths (`/feed`, `/dashboard/header`) except sources,
  // which hardcoded `/api/sources` — an inconsistency that only became
  // visible once all of them were wired into one server. Applying the prefix
  // HERE rather than editing each module keeps that decision in one place,
  // and leaves every route test working against bare paths on its own local
  // server, since the prefix is a property of this composition rather than of
  // the routes themselves.
  //
  // The namespace is not cosmetic. Task 7 serves the built frontend from this
  // same origin, so without it a client-side route (`/search` as a UI view)
  // would collide with an API route of the same name, and the Vite dev proxy
  // would have no clean pattern to forward.
  //
  // The auth hook is registered above at the ROOT instance, so it still
  // covers everything inside this encapsulated context — Fastify propagates
  // root hooks down into child scopes, which is why prefixing cannot
  // accidentally create an unauthenticated namespace.
  server.register(
    async (api) => {
      registerFeed(api, {
        db: deps.db,
        decayConfig: deps.decayConfig,
        overridesConfig: deps.overridesConfig,
      });

      registerSources(api, { db: deps.db, sources: deps.sources });

  // `countFailingSources` is task 5's definition of failing — enabled, and
  // either in an explicit error streak or stale against its OWN configured
  // poll_interval. Task 6 shipped a deliberately minimal placeholder
  // (`consecutiveFailures > 0`) behind this injection point precisely so the
  // real definition could replace it without editing its files, and its
  // report asked for this wiring. Without it the header strip's failing count
  // would miss the silent-stale case §7 cares most about — a feed that has
  // not succeeded in weeks while reporting zero failures because nothing is
  // polling it.
      registerDashboard(api, {
        db: deps.db,
        sources: deps.sources,
        countFailingSources,
      });

      registerSearch(api, { db: deps.db });
    },
    { prefix: '/api' },
  );

  return server;
}
