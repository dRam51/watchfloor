/**
 * `get_source_health` (M5 task 11).
 *
 * §8.2: *"`get_source_health()` — so the bot can tell 'no news' from 'the feed
 * broke'."* That is the whole requirement, and it is the reason this tool
 * exists at all: every other tool here can only ever report absence, and
 * absence has two completely different causes.
 *
 * ---------------------------------------------------------------------------
 * Why this is a SECOND implementation, and how it is kept honest
 * ---------------------------------------------------------------------------
 * `src/api/routes/sources.ts` already computes `stale`/`failing` for the §7
 * health page, and this module deliberately does not call it. Two reasons:
 *
 *  - `src/mcp/sourceRules.ts` forbids importing the api package into this
 *    process. *"Separate process is only true if the other process is not in
 *    this one's module graph."*
 *  - That module reaches further than its name suggests: `computeSourceHealth`
 *    constructs a `GitHubClient` for its `sweep`/`degraded` fields. Pulling an
 *    HTTP client into a process whose entire claim is that it cannot reach
 *    anything would be a poor trade for two fields a bot cannot act on. So
 *    `sweep` and `degraded` are **omitted here, not reimplemented** — they are
 *    a coverage prediction about GitHub's rate limit, not an answer to "did
 *    this feed break".
 *
 * Duplication is the drift hazard this repository keeps finding, so it is
 * closed the way `plannedRequestsPerPoll` is: by a test rather than by hope.
 * `tests/mcp/tools/sourceHealth.test.ts` feeds identical inputs to both
 * implementations across every state §7 distinguishes and asserts they agree,
 * and pins `parseBotPollIntervalMs` against the scheduler's own parser over
 * every real `poll_interval` in `config/sources.yaml`.
 *
 * ---------------------------------------------------------------------------
 * `as_of` is REFUSED here, and that is the interesting decision
 * ---------------------------------------------------------------------------
 * Every other tool in this package accepts `as_of` and answers as of that
 * instant. This one cannot: `source_fetch_state` is **mutable operational
 * state**, updated in place on every poll (its own migration says so, and
 * explains that append-only triggers would make a second fetch impossible to
 * record). There is no history to reconstruct.
 *
 * The three available behaviours were: answer with current state and ignore
 * `as_of`; answer with current state and flag it; or refuse. The first two put
 * *today's* health inside a backtest window — in the one tool a bot consults
 * to decide whether a gap in the news is real. That is exactly the lookahead
 * §8.2's point-in-time clause exists to prevent, arriving through the side
 * door. So it refuses, as a tool EXECUTION error the caller can self-correct by
 * dropping the argument, and the refusal carries `sources: null` rather than
 * the data it declined to timestamp.
 *
 * `itemsFetchedTotal` is the one health-adjacent number that IS reconstructible
 * — `items` is append-only — so it is read from there rather than from the
 * tumbling `items_yielded_7d` window, whose honest limits `/api/sources`
 * documents at length.
 */

import { z } from 'zod';
import { defineTool, type McpTool, type McpToolResult } from '../registry.ts';
import type { ReadOnlyCorpus } from '../readonly.ts';
import type { BotToolDeps } from './deps.ts';
import { indexSources, type BotSource } from './sources.ts';

/** The mutable per-source row, hydrated. Mirrors `source_fetch_state`. */
export interface BotFetchState {
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly nextEligibleAt: string | null;
  readonly itemsYieldedSinceWindowStart: number;
  readonly windowStartedAt: string | null;
  readonly updatedAt: string;
}

export interface BotSourceHealth extends BotSource {
  readonly pollIntervalMs: number;
  readonly everPolled: boolean;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly nextEligibleAt: string | null;
  readonly inBackoff: boolean;
  /** The TUMBLING window from `source_fetch_state`, named for what it is. */
  readonly itemsYieldedSinceWindowStart: number;
  readonly windowStartedAt: string | null;
  /** Item versions this source has ever contributed. Exact — `items` is append-only. */
  readonly itemsFetchedTotal: number;
  readonly updatedAt: string | null;
  readonly stale: boolean;
  readonly failing: boolean;
}

const POLL_INTERVAL_PATTERN = /^([1-9]\d*)([mhd])$/;
const POLL_INTERVAL_UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * `config/sources.yaml`'s `poll_interval` in milliseconds.
 *
 * A deliberate, tested duplicate of `src/scheduler/run.ts`'s
 * `parsePollIntervalMs`. Importing that function would drag `src/fetch/robots.ts`
 * and the whole ingest stack into this process's module graph for six lines of
 * arithmetic. The zero-value trap is preserved verbatim, because it is the
 * interesting part: `"0h"` would make backoff instantaneous for exactly the
 * source that most needs it, so a non-positive result throws rather than
 * returning zero.
 */
export function parseBotPollIntervalMs(sourceId: string, pollInterval: string): number {
  const match = POLL_INTERVAL_PATTERN.exec(pollInterval);
  const value = match ? Number(match[1]) * POLL_INTERVAL_UNIT_MS[match[2] as 'm' | 'h' | 'd'] : NaN;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`source ${sourceId} has an unusable poll_interval ${JSON.stringify(pollInterval)}`);
  }
  return value;
}

/**
 * The judgement, per source. `now` is a parameter, never a clock read — the
 * §7 module's own comment records the day its suite went red twelve hours
 * after being written because this one function read the wall clock.
 *
 * The rules are §7's, restated so they can be compared field by field against
 * `computeSourceHealth`:
 *
 *  - **stale**: no successful poll within this source's OWN `poll_interval`.
 *    No recorded success at all is maximally stale, not exempt.
 *  - **failing**: an explicit error streak OR stale. The OR is the point — a
 *    source with zero recorded failures that simply stopped being polled reads
 *    as healthy under any check that only looks at `consecutive_failures`.
 *  - A DISABLED source is never broken: an operator decision, not a fault. The
 *    raw history still passes through.
 */
export function computeBotSourceHealth(
  source: BotSource,
  state: BotFetchState | null,
  itemsFetchedTotal: number,
  now: string,
): BotSourceHealth {
  const pollIntervalMs = parseBotPollIntervalMs(source.id, source.pollInterval);
  const nowMs = Date.parse(now);

  const lastSuccessAt = state?.lastSuccessAt ?? null;
  const consecutiveFailures = state?.consecutiveFailures ?? 0;
  const nextEligibleAt = state?.nextEligibleAt ?? null;

  const rawStale = lastSuccessAt === null || nowMs - Date.parse(lastSuccessAt) > pollIntervalMs;
  const rawFailing = consecutiveFailures > 0 || rawStale;
  const rawInBackoff = nextEligibleAt !== null && Date.parse(nextEligibleAt) > nowMs;

  return {
    ...source,
    pollIntervalMs,
    everPolled: state !== null,
    lastSuccessAt,
    lastFailureAt: state?.lastFailureAt ?? null,
    lastError: state?.lastError ?? null,
    consecutiveFailures,
    nextEligibleAt,
    inBackoff: source.enabled && rawInBackoff,
    itemsYieldedSinceWindowStart: state?.itemsYieldedSinceWindowStart ?? 0,
    windowStartedAt: state?.windowStartedAt ?? null,
    itemsFetchedTotal,
    updatedAt: state?.updatedAt ?? null,
    stale: source.enabled && rawStale,
    failing: source.enabled && rawFailing,
  };
}

function readFetchState(corpus: ReadOnlyCorpus): Map<string, BotFetchState> {
  const rows = corpus.all(
    `select source_id as source_id, last_success_at as last_success_at, last_failure_at as last_failure_at,
            last_error as last_error, consecutive_failures as consecutive_failures,
            next_eligible_at as next_eligible_at, items_yielded_7d as items_yielded_7d,
            items_yielded_7d_window_started_at as window_started_at, updated_at as updated_at
     from source_fetch_state`,
  );
  const states = new Map<string, BotFetchState>();
  for (const row of rows) {
    states.set(String(row.source_id), {
      lastSuccessAt: row.last_success_at === null ? null : String(row.last_success_at),
      lastFailureAt: row.last_failure_at === null ? null : String(row.last_failure_at),
      lastError: row.last_error === null ? null : String(row.last_error),
      consecutiveFailures: Number(row.consecutive_failures),
      nextEligibleAt: row.next_eligible_at === null ? null : String(row.next_eligible_at),
      itemsYieldedSinceWindowStart: Number(row.items_yielded_7d),
      windowStartedAt: row.window_started_at === null ? null : String(row.window_started_at),
      updatedAt: String(row.updated_at),
    });
  }
  return states;
}

function readItemCounts(corpus: ReadOnlyCorpus): Map<string, number> {
  const rows = corpus.all('select source_id as source_id, count(*) as n from items group by source_id');
  return new Map(rows.map((row) => [String(row.source_id), Number(row.n)]));
}

export interface SourceHealthReport {
  readonly sources: BotSourceHealth[];
  readonly summary: {
    configured: number;
    enabled: number;
    neverPolled: number;
    stale: number;
    failing: number;
    inBackoff: number;
  };
}

export function readSourceHealth(corpus: ReadOnlyCorpus, deps: BotToolDeps, now: string): SourceHealthReport {
  const index = indexSources(deps.sources);
  const states = readFetchState(corpus);
  const counts = readItemCounts(corpus);

  // config/sources.yaml's own declaration order -- no sorting is imposed, the
  // same decision /api/sources made. Display order is the caller's business.
  const sources = [...index.values()].map((source) =>
    computeBotSourceHealth(source, states.get(source.id) ?? null, counts.get(source.id) ?? 0, now),
  );

  return {
    sources,
    summary: {
      configured: sources.length,
      enabled: sources.filter((s) => s.enabled).length,
      neverPolled: sources.filter((s) => !s.everPolled).length,
      stale: sources.filter((s) => s.stale).length,
      failing: sources.filter((s) => s.failing).length,
      inBackoff: sources.filter((s) => s.inBackoff).length,
    },
  };
}

/** See this module's doc comment: mutable state has no point-in-time answer. */
function asOfRefusal(asOf: string): McpToolResult {
  const detail =
    'get_source_health cannot answer a point-in-time question. Source health comes from ' +
    'source_fetch_state, which is MUTABLE operational state updated in place on every poll and ' +
    'keeps no history — so returning current health for a past as_of would put today\'s knowledge ' +
    'inside your backtest window, in the one tool you use to decide whether a gap in the news was ' +
    'real. Call it without as_of for current health; get_items_for_entity is point-in-time because ' +
    'items are append-only.';
  return {
    structured: {
      status: 'as_of_unsupported',
      tool: 'get_source_health',
      sources: null,
      summary: null,
      detail,
      request: { asOf },
    },
    text: detail,
    isError: true,
    rows: 0,
  };
}

export function createSourceHealthTool(deps: BotToolDeps): McpTool<never> {
  return defineTool({
    name: 'get_source_health',
    title: 'Source health',
    description:
      'Per-source operational health: last success, last failure, the error string, consecutive ' +
      'failures, backoff state, items contributed, and whether the source is stale or failing. Use ' +
      'it to tell "no news" from "the feed broke" before concluding anything from an empty result. ' +
      'Does NOT accept as_of: this data is mutable state with no history, and a point-in-time ' +
      'answer would be fabricated.',
    inputSchema: z.object({
      asOf: z
        .string()
        .optional()
        .describe('Declared so the refusal is specific rather than a generic unknown-argument error. Always refused — see the tool description.'),
    }),
    run: (args: { asOf?: string }, ctx): McpToolResult => {
      if (args.asOf !== undefined) return asOfRefusal(args.asOf);
      const report = readSourceHealth(ctx.corpus, deps, ctx.now);
      return {
        structured: {
          status: 'ok',
          observedAt: ctx.now,
          // The wire mapping is EXPLICIT and total, not a spread of the
          // internal type -- the same rule /api/sources states for its own
          // shape, so a field added to `BotSourceHealth` cannot reach a bot
          // without someone deciding it should.
          sources: report.sources.map((source) => ({
            id: source.id,
            name: source.name,
            beats: [...source.beats],
            kind: source.kind,
            weight: source.weight,
            pollInterval: source.pollInterval,
            pollIntervalMs: source.pollIntervalMs,
            enabled: source.enabled,
            everPolled: source.everPolled,
            lastSuccessAt: source.lastSuccessAt,
            lastFailureAt: source.lastFailureAt,
            lastError: source.lastError,
            consecutiveFailures: source.consecutiveFailures,
            nextEligibleAt: source.nextEligibleAt,
            inBackoff: source.inBackoff,
            itemsYieldedSinceWindowStart: source.itemsYieldedSinceWindowStart,
            windowStartedAt: source.windowStartedAt,
            itemsFetchedTotal: source.itemsFetchedTotal,
            updatedAt: source.updatedAt,
            stale: source.stale,
            failing: source.failing,
          })),
          summary: { ...report.summary },
        },
        rows: report.sources.length,
      };
    },
  }) as McpTool<never>;
}
