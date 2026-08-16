import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/connection.ts';
import type { Source } from '../../sources/load.ts';
import { BEATS } from '../../domain/item.ts';
import {
  getBeatRefreshStatus,
  getFailingSourceCount,
  getEnrichmentSpendToday,
  getEnrichmentStatus,
} from '../../domain/headerStrip.ts';
import type { LlmConfig } from '../../enrich/llm/config.ts';
import {
  getLaneLayout,
  setLaneLayout,
  InvalidLaneLayoutError,
  type LaneLayoutEntry,
} from '../../domain/laneState.ts';

/**
 * §7 header strip + server-side lane layout (M3 task 6).
 *
 * Deliberately its own `registerDashboard(server, deps)` rather than a
 * change to `src/api/server.ts` -- two Wave 2 siblings (feed, source
 * health) are adding routes to that same file in parallel this wave, and
 * editing it here would clobber them. The coordinator wires this function
 * into `buildServer` separately, after all three land. See
 * tests/api/dashboard.test.ts for the "build a server locally" pattern this
 * module is tested against (Fastify() + registerAuth + registerDashboard).
 *
 * JSON convention (shared across this wave's three route files, per the
 * coordinator's brief): camelCase on the wire, snake_case stays in the DB;
 * bare objects, no `{ data: ... }` envelope; errors are always
 * `{ error: string }`; timestamps are canonical `YYYY-MM-DDTHH:mm:ss.sssZ`
 * strings, never epoch numbers or pre-formatted relative time; nulls stay
 * null rather than being coerced to `""` or omitted.
 */
export interface DashboardDeps {
  db: Db;
  /** Normally `config/sources.yaml`, loaded once at boot via `loadSourcesFile`. */
  sources: Source[];
  /** Defaults to `process.env`; overridable for tests. */
  env?: NodeJS.ProcessEnv;
  /**
   * Overrides `getFailingSourceCount`'s minimal definition
   * (src/domain/headerStrip.ts) with a fuller one -- intended for Task 5's
   * source-health module, once it exports one, to be wired in here without
   * touching this file's logic. Defaults to the minimal definition.
   */
  countFailingSources?: (db: Db, sources: readonly Source[], now?: string) => number;
  /** Overridable clock for tests; defaults to the wall clock. */
  now?: () => string;
  /**
   * `config/llm.yaml`, loaded once at boot by `src/bin/api.ts` -- what makes
   * `enrichment.backend` answerable (M5 task 14).
   *
   * Optional, for exactly the reason `EnrichmentSpendSources` is: a caller
   * without it still gets the cost-gate answer, which is pure environment.
   * The risk that buys is this project's characteristic defect -- an optional
   * dep nothing passes is a feature that is inert in production while every
   * route test stays green -- so the wiring is pinned in
   * tests/api/dashboardEnrichmentStatus.test.ts rather than assumed.
   */
  llmConfig?: LlmConfig;
}

function defaultNow(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// PUT /dashboard/layout request validation
// ---------------------------------------------------------------------------

// Zod checks shape (a beat is A string, collapsed is a boolean, and there
// are exactly BEATS.length entries); it deliberately does NOT check for
// duplicates or that all six particular beats are present -- that
// permutation check already lives in src/domain/laneState.ts's
// assertIsCompletePermutation, and duplicating it here in a second form
// would be exactly the kind of drift-prone double validation this project
// keeps flagging elsewhere. A schema-shape failure and a permutation
// failure both end up as the same 400 `{ error }` response below; the
// caller cannot tell which layer caught it, nor does it need to.
const LaneEntrySchema = z.object({
  beat: z.string().min(1),
  collapsed: z.boolean(),
});

const PutLayoutBodySchema = z.object({
  lanes: z.array(LaneEntrySchema).length(
    BEATS.length,
    `lanes must contain exactly ${BEATS.length} entries, one per beat -- PUT is a full replace, not a partial update`,
  ),
});

function serializeLayout(lanes: LaneLayoutEntry[]): { lanes: LaneLayoutEntry[] } {
  return { lanes };
}

export function registerDashboard(server: FastifyInstance, deps: DashboardDeps): void {
  const now = deps.now ?? defaultNow;
  const countFailingSources = deps.countFailingSources ?? getFailingSourceCount;

  // -------------------------------------------------------------------
  // GET /dashboard/header
  // -------------------------------------------------------------------
  server.get('/dashboard/header', () => {
    const env = deps.env ?? process.env;
    const at = now();
    const refreshStatus = getBeatRefreshStatus(deps.db, deps.sources);

    const beats: Record<string, { lastRefreshAt: string | null; sourceCount: number }> = {};
    for (const status of refreshStatus) {
      beats[status.beat] = { lastRefreshAt: status.lastRefreshAt, sourceCount: status.sourceCount };
    }

    return {
      beats,
      // One instant for the whole response: `now()` is read once and passed to
      // both. Before M4a these disagreed -- `enrichmentSpend` honoured the
      // injected clock while the failing count silently read the wall clock,
      // so a test pinning `now` got a header whose two halves were computed at
      // different times. See countFailingSources' doc comment in
      // ./sources.ts for how that surfaced (a suite that went red 12 hours
      // after it was written, with no code change).
      failingSources: countFailingSources(deps.db, deps.sources, at),
      // M5 task 3: the third argument is what turns `enrichmentSpend` from a
      // structural zero into a measured figure. The field's SHAPE is
      // unchanged -- its M3 report promised real numbers at M5 without a
      // change to what it publishes, and this is that, one parameter wide.
      //
      // `WF_TZ` is read out of the same `env` the cost gate is read from,
      // rather than plumbed through `ServerDeps`: the API process always has
      // it (loadEnv requires it) and adding it here would mean editing
      // src/api/server.ts, which a concurrent sibling owns this wave.
      // getEnrichmentSpendToday falls back, loudly and in its own note, if it
      // is missing or is not a valid IANA zone.
      enrichmentSpend: getEnrichmentSpendToday(env, at, { db: deps.db }),
      // M5 task 14, and §15's second clause: "the API returns a clear
      // 'disabled by cost policy' status". A SIBLING of enrichmentSpend, not
      // a widening of it -- spend is money and this is configuration, and one
      // field publishing both is one field whose two halves can disagree. See
      // getEnrichmentStatus' own doc comment for the three facts that must
      // never collapse into each other.
      //
      // Same `at` as everything above: one instant for the whole response.
      enrichment: getEnrichmentStatus(env, at, {
        db: deps.db,
        ...(deps.llmConfig !== undefined ? { llmConfig: deps.llmConfig } : {}),
      }),
    };
  });

  // -------------------------------------------------------------------
  // GET /dashboard/layout
  // -------------------------------------------------------------------
  server.get('/dashboard/layout', () => {
    return serializeLayout(getLaneLayout(deps.db));
  });

  // -------------------------------------------------------------------
  // PUT /dashboard/layout -- full replace (see module doc comment and
  // src/domain/laneState.ts for why a partial per-lane PATCH was rejected).
  // -------------------------------------------------------------------
  server.put('/dashboard/layout', async (request, reply) => {
    const parsed = PutLayoutBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'invalid layout';
      await reply.code(400).send({ error: message });
      return;
    }

    try {
      const saved = setLaneLayout(deps.db, parsed.data.lanes, now());
      return serializeLayout(saved);
    } catch (cause) {
      if (cause instanceof InvalidLaneLayoutError) {
        await reply.code(400).send({ error: cause.message });
        return;
      }
      throw cause;
    }
  });
}
