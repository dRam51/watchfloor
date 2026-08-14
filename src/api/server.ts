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

  registerHealth(server, deps);

  registerFeed(server, {
    db: deps.db,
    decayConfig: deps.decayConfig,
    overridesConfig: deps.overridesConfig,
  });

  registerSources(server, { db: deps.db, sources: deps.sources });

  // `countFailingSources` is task 5's definition of failing — enabled, and
  // either in an explicit error streak or stale against its OWN configured
  // poll_interval. Task 6 shipped a deliberately minimal placeholder
  // (`consecutiveFailures > 0`) behind this injection point precisely so the
  // real definition could replace it without editing its files, and its
  // report asked for this wiring. Without it the header strip's failing count
  // would miss the silent-stale case §7 cares most about — a feed that has
  // not succeeded in weeks while reporting zero failures because nothing is
  // polling it.
  registerDashboard(server, {
    db: deps.db,
    sources: deps.sources,
    countFailingSources,
  });

  registerSearch(server, { db: deps.db });

  return server;
}
