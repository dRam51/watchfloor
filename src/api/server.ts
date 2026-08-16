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
import { registerItems } from './routes/items.ts';
import { registerEntities } from './routes/entities.ts';

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
        // `kind` (fix-news-sources-and-kind task) is resolved from source
        // config by id, the same list registerSources/registerDashboard
        // already receive below -- see FeedDeps.sources' own doc comment.
        sources: deps.sources,
      });

      registerSources(api, { db: deps.db, sources: deps.sources });

      // `countFailingSources` is task 5's definition of failing — enabled,
      // and either in an explicit error streak or stale against its OWN
      // configured poll_interval. Task 6 shipped a deliberately minimal
      // placeholder (`consecutiveFailures > 0`) behind this injection point
      // precisely so the real definition could replace it without editing its
      // files, and its report asked for this wiring. Without it the header
      // strip's failing count would miss the silent-stale case §7 cares most
      // about — a feed that has not succeeded in weeks while reporting zero
      // failures because nothing is polling it.
      registerDashboard(api, {
        db: deps.db,
        sources: deps.sources,
        countFailingSources,
      });

      registerSearch(api, { db: deps.db });

      // §7's `s` (save) and `x` (dismiss) need somewhere to POST. Task 3
      // built the domain layer and task 4's feed reads the state onto each
      // row, but no Wave 2 task owned exposing the writes — so the dashboard
      // could display state it had no way to change.
      //
      // M5 task 15: `vault` is what makes §8.1's `saved/` promotion happen at
      // SAVE TIME. It has to be threaded from here, because this is the only
      // place that holds the validated Env — and it is the second half of the
      // wiring, the half a route-level test cannot see. `WF_VAULT_ROOT` is
      // commented out in `.env`, so `null` is the ordinary value and means "no
      // promotion", quietly.
      registerItems(api, {
        db: deps.db,
        vault: { root: deps.env.WF_VAULT_ROOT ?? null, tz: deps.env.WF_TZ },
      });

      // M5 task 17: §7.4's entity graph. Registered here and pinned by
      // tests/api/entitiesWiring.test.ts, because every route test in
      // tests/api/ builds its own Fastify instance — correctly, so a route
      // test does not depend on this file — and would therefore stay green
      // with this line missing. That is `registerItems`' own history, and it
      // is number one in CLAUDE.md's table of unreachable components.
      //
      // Needs only the db: the graph is a pure function of the corpus, with
      // no decay, no `now`, and no source list.
      registerEntities(api, { db: deps.db });
    },
    { prefix: '/api' },
  );

  return server;
}
