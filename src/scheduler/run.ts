/**
 * The poll loop (Task 10) -- ties together every module the prior nine M1
 * tasks produced into one working cycle: fetch-state persistence
 * (src/db/fetchState.ts), the polite HTTP layer + robots.txt gate
 * (src/fetch/http.ts, src/fetch/robots.ts), the adapter contract
 * (src/adapters/types.ts), the normalizer (src/normalize/item.ts), and
 * append-only storage (src/domain/item.ts).
 *
 * ---------------------------------------------------------------------------
 * The headline guarantee: one dead feed never takes down the run
 * ---------------------------------------------------------------------------
 * `pollOneSource` below is the unit of isolation. Every source's entire
 * pipeline -- eligibility, robots.txt, the adapter fetch, normalize, insert
 * -- runs inside ONE try/catch. A throw from ANY of those steps is caught,
 * recorded via `recordFailure`, and reported as a `'failure'` outcome; it
 * never propagates to `runPollCycle`'s own caller and never stops the next
 * source in the list from being attempted. `tests/scheduler/run.test.ts`'s
 * very first test proves this directly: three sources, the middle one
 * throws, the other two still ingest.
 *
 * ---------------------------------------------------------------------------
 * Five carried-forward constraints (see the task-10 brief) and how each is
 * handled here
 * ---------------------------------------------------------------------------
 * 1. `isAllowed(robotsTxt, userAgent, path, origin)` takes FOUR arguments,
 *    `origin` required. `path` is derived here as `url.pathname + url.search`
 *    from the SAME `source.url` whose origin is passed as `origin` -- by
 *    construction they always agree, UNLESS `source.url`'s path itself starts
 *    with `//` (a legal but unusual shape), which `isAllowed` resolves as a
 *    protocol-relative reference to a DIFFERENT host and throws
 *    `RobotsHostMismatchError`. This is never caught specially: it propagates
 *    to the generic catch-all below like any other thrown error, so it is
 *    recorded as a genuine `'failure'` (via `recordFailure`), never silently
 *    treated as allow or deny. See
 *    "a robots.txt host mismatch is a real failure" in the test file.
 *
 * 2. A failed robots.txt fetch (`RobotsUnavailableError`, thrown by
 *    `fetchRobots` for a 5xx/timeout/transport failure -- NOT a 404, which
 *    resolves to `''` meaning no restrictions) means the operator's rules are
 *    UNKNOWN, not absent. Caught specifically (inside its own inner
 *    try/catch, before the generic one) and turned into a `'robots-
 *    unavailable'` outcome. Deliberately does NOT call `recordFailure`:
 *    `fetchRobots` itself already never caches a failure (see its own doc
 *    comment -- "the very next call retries the network"), so layering this
 *    system's exponential content-backoff on top would conflate two
 *    different kinds of trouble (the robots.txt endpoint being briefly
 *    unreachable vs. the source's own content feed failing) and would delay
 *    the next legitimate content poll for a problem that wasn't the content
 *    feed's fault. "Recording the skip" (the brief's own words) means
 *    recording it in THIS cycle's `PollReport` -- which every cycle does,
 *    visibly, for as long as the condition persists -- not mutating
 *    `source_fetch_state`. Disclosed explicitly in the task report as the one
 *    area with real interpretive latitude in an otherwise fully-specified
 *    brief.
 *
 * 3. `poll_interval: "0m"` is a live landmine: a zero delay makes
 *    `recordFailure` compute `nextEligibleAt = now`, so a FAILING source
 *    becomes eligible on every tick -- hot-looping a server that is already
 *    struggling. Two independent gates:
 *      - Gate 1: `src/sources/load.ts`'s schema regex is tightened to
 *        `/^[1-9]\d*[mhd]$/`, rejecting a zero (or negative-shaped) interval
 *        at config-LOAD time, before a source can ever reach the scheduler.
 *      - Gate 2 (this file): `parsePollIntervalMs` parses with a
 *        deliberately MORE permissive pattern than gate 1's (it still
 *        accepts "0m") so that the very next check -- `value <= 0` -- is
 *        what actually rejects it, independent of gate 1 ever running at
 *        all. `safePollIntervalMs` wraps it with a safe MAX_BACKOFF_MS
 *        fallback, and is the ONLY value ever passed to `recordFailure` from
 *        this file -- so a bad `poll_interval` can never reach it unguarded,
 *        regardless of which failure path triggered the call.
 *
 * 4. The adapter registry is typed as `SchedulerAdapterRegistry =
 *    Pick<AdapterRegistry, M1SourceType>`, not the full `AdapterRegistry`
 *    (`Record<SourceType, Adapter>`, which demands all 8 source types
 *    including `github_search`/`api`/`market_data` -- out of M1's scope per
 *    the plan). This still gives compile-time enforcement that all 5 M1
 *    adapter kinds are wired (a missing key is a compile error), without
 *    inventing three fictional stub adapters. `'atom'` is a real key in that
 *    Pick, routed to whatever the caller registers there (in production,
 *    the same `rssAdapter` instance as `'rss'` -- see rss.ts's own doc
 *    comment on why one adapter legitimately serves both). A source whose
 *    `type` is one of the three excluded values is handled gracefully at
 *    runtime by `resolveAdapter` throwing `UnsupportedSourceTypeError`,
 *    caught by the same generic per-source catch-all as any other failure --
 *    a misconfigured source type is just one more per-source failure, never
 *    a crash.
 *
 * 5. `AdapterResult.skipped` (entries that were individually defective) and
 *    `.capped` (entries that parsed fine but were excluded by volume policy)
 *    are carried through onto `SourceOutcome` as two SEPARATE optional
 *    fields (`skippedEntries` and `capped`), never merged into one number and
 *    never fabricated as `0` when the adapter reported nothing (see
 *    `AdapterResult.capped`'s own doc comment in src/adapters/types.ts for
 *    why that distinction matters to a source-health page). Named
 *    `skippedEntries` rather than bare `skipped` specifically so it cannot be
 *    confused with `SourceOutcome.kind === 'skipped'` (a SOURCE-level
 *    outcome meaning "never attempted, source.enabled is false") -- those are
 *    unrelated concepts that happen to share the English word "skip".
 *
 * ---------------------------------------------------------------------------
 * Fix round 1 (four changes, task-10-report.md has the full findings)
 * ---------------------------------------------------------------------------
 * Finding 1 (CRITICAL) -- `isEligible` reflects BACKOFF only
 * (`FetchState.nextEligibleAt`, written only by `recordFailure`);
 * `recordSuccess` always clears it back to `null`, so a healthy source that
 * just succeeded was unconditionally `isEligible` again on the very next
 * tick. `poll_interval` was being consumed only as the backoff base, never
 * as a source's own healthy polling cadence -- every enabled, healthy
 * source's real-world cadence was `src/bin/scheduler.ts`'s tick interval,
 * not its configured `poll_interval`, and every re-fetch of an
 * unconditional-request feed (no ETag/Last-Modified support) re-inserted
 * the same items as new append-only versions. Fixed by a second gate, after
 * the backoff check: a source whose `lastSuccessAt` is more recent than its
 * own `poll_interval` (via `safePollIntervalMs`, so a malformed value fails
 * toward LESS frequent polling, not more) is `'not-due'` -- a new outcome
 * kind, distinct from `'backoff'` (failure-driven) and `'skipped'`
 * (`enabled: false`) so a health page can tell all three apart. A source
 * with no recorded success yet (first attempt, or one that has only ever
 * failed) is never gated by this -- there is nothing to measure a healthy
 * cadence against, and backoff already governs failure-retry timing.
 *
 * Finding 2 (Important) -- one item with an unusable URL (e.g. a relative
 * link -- `src/adapters/rss.ts` passes `<link>` through with no
 * absolute-URL check, so this is genuinely reachable) used to throw
 * `InvalidUrlError` out of `canonicalizeUrl`, aborting the whole item loop:
 * every item after the bad one was silently lost, AND the source was marked
 * `'failure'` even though the adapter's own fetch had succeeded -- which
 * meant `recordSuccess` never ran, `etag`/`lastModified` never advanced, and
 * a feed with no conditional-request support would re-fetch and re-insert
 * the SAME surviving items as new rows on every subsequent retry, forever,
 * under append-only storage. Fixed by moving normalize+insert inside its
 * OWN per-item try/catch: a bad item is now counted (`itemFailures`) and
 * skipped, exactly like an adapter's own per-entry `skipped` count, and the
 * source still reports `'success'` with `recordSuccess` run normally.
 *
 * Finding 4 (Important) -- the plan is explicit that a robots.txt denial
 * "must be skipped and marked in fetch state, never fetched anyway"; the
 * original version marked nothing. `recordFailure` is the only marking
 * mechanism `source_fetch_state` has, so a denial now goes through it (via
 * `safePollIntervalMs`, same as every other failure path), applying normal
 * backoff. Deliberately NOT applied to `robots-unavailable` just above it
 * (upheld, Finding 5): a denial is a confirmed, stable answer (the
 * operator's rules were read successfully and clearly say no); an
 * unreachable robots.txt is transient uncertainty with no analogous upside
 * to backing off, since `fetchRobots` already retries on its own.
 *
 * Minor -- `skippedEntries`/`capped` are now tracked in outer-scoped
 * variables (alongside `insertedCount`) so a 'failure' outcome reached after
 * `adapter.fetch` succeeded carries them too, rather than silently dropping
 * a partially-failed batch's adapter-reported counts.
 */

import type { Db } from '../db/connection.ts';
import {
  getFetchState,
  isEligible,
  recordSuccess,
  recordFailure,
  MAX_BACKOFF_MS,
} from '../db/fetchState.ts';
import { fetchRobots, isAllowed, PRODUCT_TOKEN, RobotsUnavailableError } from '../fetch/robots.ts';
import { normalizeItem } from '../normalize/item.ts';
import { insertItem } from '../domain/item.ts';
import { assertCanonicalTimestamp } from '../domain/item.ts';
import type { Source } from '../sources/load.ts';
import type { Adapter, AdapterRegistry } from '../adapters/types.ts';

// ---------------------------------------------------------------------------
// The M1-scoped adapter registry (constraint 4).
// ---------------------------------------------------------------------------

/**
 * The 5 source types M1 actually ships an adapter for (docs/superpowers/
 * plans/2026-08-13-m1-ingest.md, Tasks 6-9 plus the 'atom' routing note in
 * src/adapters/types.ts). `github_search`, `api`, and `market_data` are the
 * remaining 3 values `Source['type']` legally allows (M4a/M4b territory,
 * explicitly out of scope for M1 per the plan's own acceptance table) -- see
 * `resolveAdapter` for how a source carrying one of those is handled instead
 * of being a type error.
 */
const M1_SOURCE_TYPES = ['rss', 'atom', 'json', 'news_sitemap', 'google_news'] as const;
export type M1SourceType = (typeof M1_SOURCE_TYPES)[number];

/**
 * A complete registry needs exactly these 5 keys -- a missing one is a
 * COMPILE error, the same enforcement `AdapterRegistry` itself provides,
 * without that type's demand for 3 out-of-scope stub adapters. See the
 * module doc comment, constraint 4.
 */
export type SchedulerAdapterRegistry = Pick<AdapterRegistry, M1SourceType>;

function isM1SourceType(type: Source['type']): type is M1SourceType {
  return (M1_SOURCE_TYPES as readonly string[]).includes(type);
}

/**
 * Thrown by `resolveAdapter` when a source's type has no M1 adapter (i.e. is
 * one of `github_search`/`api`/`market_data`). Always caught by
 * `pollOneSource`'s generic catch-all and reported as an ordinary
 * `'failure'` outcome -- a misconfigured or not-yet-implemented source type
 * costs only that source, the same "one dead feed" isolation as any other
 * per-source error.
 */
export class UnsupportedSourceTypeError extends Error {
  constructor(sourceId: string, type: string) {
    super(
      `source "${sourceId}" has type "${type}", which has no M1 adapter registered ` +
        `(github_search/api/market_data are out of scope for M1 -- see the plan's own exclusion list)`,
    );
    this.name = 'UnsupportedSourceTypeError';
  }
}

function resolveAdapter(adapters: SchedulerAdapterRegistry, source: Source): Adapter {
  if (!isM1SourceType(source.type)) {
    throw new UnsupportedSourceTypeError(source.id, source.type);
  }
  return adapters[source.type];
}

// ---------------------------------------------------------------------------
// poll_interval parsing -- constraint 3, gate 2.
// ---------------------------------------------------------------------------

// Deliberately permissive: matches "0m" too. The rejection happens in
// parsePollIntervalMs's own value check below, NOT in this pattern -- see
// that function's doc comment for why that separation is the point.
const POLL_INTERVAL_PATTERN = /^(\d+)([mhd])$/;

const POLL_INTERVAL_UNIT_MS: Record<'m' | 'h' | 'd', number> = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

export class InvalidPollIntervalError extends Error {
  constructor(sourceId: string, pollInterval: string) {
    super(
      `source "${sourceId}" has poll_interval "${pollInterval}", which does not parse to a ` +
        `positive number of milliseconds`,
    );
    this.name = 'InvalidPollIntervalError';
  }
}

/**
 * Parses a source's `poll_interval` ("15m", "6h", "1d") into milliseconds.
 *
 * Deliberately uses a MORE PERMISSIVE pattern than `src/sources/load.ts`'s
 * own schema regex (gate 1, tightened by this same task to
 * `/^[1-9]\d*[mhd]$/` so a zero-leading value is rejected at config-load
 * time): this function's pattern still accepts a leading zero ("0m") so that
 * the very next line -- `value <= 0` -- is what actually rejects it, not the
 * pattern. That is the point of having two gates rather than one written
 * twice: they are independent. If gate 1 were ever accidentally reverted to
 * accept "0m" again, this runtime guard still catches it right before the
 * one call site (`recordFailure`, via `safePollIntervalMs` below) that would
 * otherwise act on a zero delay and hot-loop a failing source (see
 * `recordFailure`'s own backoff-invariant doc comment in
 * src/db/fetchState.ts). A negative value cannot actually be produced by
 * this pattern at all -- no sign character is matched -- but `<= 0` is
 * checked rather than `=== 0` as cheap insurance against a future edit to
 * the pattern reintroducing one.
 */
export function parsePollIntervalMs(sourceId: string, pollInterval: string): number {
  const match = POLL_INTERVAL_PATTERN.exec(pollInterval);
  const value = match ? Number(match[1]) * POLL_INTERVAL_UNIT_MS[match[2] as 'm' | 'h' | 'd'] : NaN;
  if (!Number.isFinite(value) || value <= 0) {
    throw new InvalidPollIntervalError(sourceId, pollInterval);
  }
  return value;
}

/**
 * The `pollIntervalMs` value `recordFailure` receives on any per-source
 * failure, from ANY cause -- not only an actually-invalid `poll_interval`.
 * NEVER returns a value <= 0: if the source's own `poll_interval` can't be
 * trusted (`parsePollIntervalMs` throws), falls back to `MAX_BACKOFF_MS`
 * itself, the single longest delay this system ever applies to a healthy
 * source. That is deliberate, not arbitrary -- a source whose config can't
 * even be parsed is exactly the situation where hot-looping against it would
 * be worst, so the safe direction to fail is the WIDEST backoff, not the
 * narrowest. Because this is the ONLY place in this file that computes the
 * value passed to `recordFailure`, every failure path (adapter throw,
 * unsupported type, a genuinely malformed `poll_interval`, a
 * RobotsHostMismatchError, anything else) is guarded uniformly, not
 * case-by-case.
 */
function safePollIntervalMs(source: Source): number {
  try {
    return parsePollIntervalMs(source.id, source.poll_interval);
  } catch {
    return MAX_BACKOFF_MS;
  }
}

// ---------------------------------------------------------------------------
// PollReport -- constraint 6: every outcome the source-health page needs to
// tell apart, with skipped/capped kept distinct (constraint 5).
// ---------------------------------------------------------------------------

export type SourceOutcomeKind =
  | 'success'
  | 'skipped'
  | 'backoff'
  | 'not-due'
  | 'robots-denied'
  | 'robots-unavailable'
  | 'failure';

export interface SourceOutcome {
  sourceId: string;
  kind: SourceOutcomeKind;
  /** Items normalized and inserted this cycle. 0 for every non-'success' kind, and for a notModified success. On 'failure', reflects however many items were inserted before the failure, not necessarily 0 -- a partial batch's earlier items are genuinely persisted (append-only storage; nothing rolls them back). */
  itemCount: number;
  /** How many items in this fetch's batch threw during normalize/insert (e.g. an unusable URL) and were skipped rather than aborting the rest of the batch -- fix round 1, Finding 2. Undefined until the fetch actually reached the item-processing phase (a notModified response, or any earlier failure, has nothing to report); a definite 0-or-higher number once it did, even if the outcome later became 'failure' for an unrelated reason after the loop ran. Distinct from `skippedEntries` (an ADAPTER-level count, before a RawItem ever existed) -- this is a SCHEDULER-level count, one layer downstream. */
  itemFailures?: number;
  /** AdapterResult.skipped -- entries that were individually defective. Undefined when no fetch attempt happened (skipped/backoff/not-due/robots-*) or a notModified response had nothing to parse. Named distinctly from `kind: 'skipped'`, which is an unrelated, source-level concept -- see the module doc comment. */
  skippedEntries?: number;
  /** AdapterResult.capped -- entries that parsed fine but were excluded by an adapter's own volume cap. Deliberately never fabricated as 0; undefined unless the adapter actually reported a cap binding this fetch. */
  capped?: number;
  /** True only for a 'success' outcome produced by a 304 (AdapterResult.notModified). */
  notModified?: boolean;
  /** Present for 'backoff': when this source next becomes eligible (FetchState.nextEligibleAt). */
  nextEligibleAt?: string | null;
  /** Present for 'failure', 'robots-unavailable', and 'robots-denied' (fix round 1, Finding 4): the recorded error/reason message. */
  error?: string;
  /** Wall-clock time this source's whole pipeline took, ms. */
  durationMs: number;
}

export interface PollReport {
  /** Echoes runPollCycle's `now` parameter -- the logical instant every recordSuccess/recordFailure/fetchedAt write during this cycle used. */
  now: string;
  /** Wall-clock ISO timestamp when the cycle actually finished. Independent of `now`, which a caller (e.g. a test) may have pinned to any value. */
  finishedAt: string;
  /** Wall-clock duration of the whole cycle, ms. */
  durationMs: number;
  sources: SourceOutcome[];
}

// ---------------------------------------------------------------------------
// Per-source pipeline. Never throws -- see the module doc comment's
// "headline guarantee" section.
// ---------------------------------------------------------------------------

async function pollOneSource(
  db: Db,
  source: Source,
  adapters: SchedulerAdapterRegistry,
  now: string,
): Promise<SourceOutcome> {
  const startedAtMs = Date.now();
  const elapsed = () => Date.now() - startedAtMs;

  // Cheapest, most authoritative check first: an operator who set
  // enabled:false has explicitly said not to poll this source at all, so
  // there is no reason to even look at fetch state.
  if (!source.enabled) {
    return { sourceId: source.id, kind: 'skipped', itemCount: 0, durationMs: elapsed() };
  }

  // Backoff respected: a source in backoff is skipped for this cycle, not
  // retried in-loop. Reading fetch state is also cheap (local DB, no I/O).
  if (!isEligible(db, source.id, now)) {
    const state = getFetchState(db, source.id);
    return {
      sourceId: source.id,
      kind: 'backoff',
      itemCount: 0,
      nextEligibleAt: state?.nextEligibleAt ?? null,
      durationMs: elapsed(),
    };
  }

  // Fix round 1, Finding 1 (CRITICAL): isEligible above reflects BACKOFF
  // only. A healthy source that just succeeded has no gate at all without
  // this check -- see the module doc comment for the full reasoning and the
  // reproduction this fixes. Queried once here and reused below (for
  // adapter.fetch's second argument) rather than queried again later --
  // nothing between here and there writes to source_fetch_state, so it
  // stays accurate, and this also removes a second identical query the
  // pre-fix version had.
  const priorState = getFetchState(db, source.id);
  if (priorState?.lastSuccessAt != null) {
    const dueIntervalMs = safePollIntervalMs(source);
    const sinceLastSuccessMs = Date.parse(now) - Date.parse(priorState.lastSuccessAt);
    if (sinceLastSuccessMs < dueIntervalMs) {
      return { sourceId: source.id, kind: 'not-due', itemCount: 0, durationMs: elapsed() };
    }
  }
  // A source with no recorded success yet (first-ever attempt, or one that
  // has only ever failed) has nothing to measure a healthy cadence against
  // and falls through unconditionally -- backoff (above) already governs
  // failure-retry timing for that case.

  let insertedCount = 0;
  let itemFailureCount = 0;
  let itemsAttempted = false; // true once the item-processing phase actually starts, even over an empty batch
  let skippedEntries: number | undefined;
  let capped: number | undefined;
  try {
    const url = new URL(source.url);
    const origin = url.origin;
    const path = url.pathname + url.search; // isAllowed's documented contract: query string included, fragment excluded (url.search/.pathname already drop it)

    let robotsTxt: string;
    try {
      robotsTxt = await fetchRobots(origin);
    } catch (err) {
      // Constraint 2: an unreachable robots.txt means the operator's rules
      // are UNKNOWN, not absent -- skip this source for this cycle, and
      // never fetch anyway. Deliberately NOT recordFailure -- see the
      // module doc comment, point 2.
      if (err instanceof RobotsUnavailableError) {
        return {
          sourceId: source.id,
          kind: 'robots-unavailable',
          itemCount: 0,
          error: err.message,
          durationMs: elapsed(),
        };
      }
      throw err; // anything else is a genuine, unexpected failure -- falls to the catch-all below
    }

    // Constraint 1: origin is required and always derived from the SAME
    // source.url as path, so RobotsHostMismatchError is not expected in
    // normal operation -- but if source.url's path itself starts with "//",
    // isAllowed resolves it as a different host and throws. That is
    // deliberately NOT caught here: it falls to the generic catch-all below,
    // which records it as a real 'failure', never silently allow or deny.
    if (!isAllowed(robotsTxt, PRODUCT_TOKEN, path, origin)) {
      // Fix round 1, Finding 4: the plan is explicit that a denial "must be
      // skipped and marked in fetch state, never fetched anyway" --
      // recordFailure is the only marking mechanism source_fetch_state has,
      // so this now applies normal backoff, same as any other failure.
      // Deliberately different from robots-unavailable just above (upheld,
      // Finding 5, unchanged here): a denial is a confirmed, stable answer,
      // not transient uncertainty -- see the module doc comment.
      const reason = `robots.txt at ${origin} disallows ${path}`;
      recordFailure(db, source.id, reason, safePollIntervalMs(source), now);
      return { sourceId: source.id, kind: 'robots-denied', itemCount: 0, error: reason, durationMs: elapsed() };
    }

    const adapter = resolveAdapter(adapters, source);
    const result = await adapter.fetch(source, priorState);

    if (result.notModified) {
      // Constraint: 304 short-circuits without inserting and without
      // tripping backoff -- recordSuccess with itemCount 0 is success, never
      // a failure.
      recordSuccess(db, source.id, { etag: result.etag, lastModified: result.lastModified, itemCount: 0 }, now);
      return {
        sourceId: source.id,
        kind: 'success',
        itemCount: 0,
        notModified: true,
        durationMs: elapsed(),
      };
    }

    skippedEntries = result.skipped;
    capped = result.capped;
    itemsAttempted = true;

    // Fix round 1, Finding 2 (Important): each item is normalized and
    // inserted inside its OWN try/catch. A throw here (e.g. an unusable URL
    // -- canonicalizeUrl's InvalidUrlError; src/adapters/rss.ts passes
    // <link> through with no absolute-URL check, so this is genuinely
    // reachable) used to abort the whole loop, silently discarding every
    // item after it AND marking the whole source 'failure' despite the
    // adapter's own fetch having succeeded -- see the module doc comment for
    // why that was also self-perpetuating under append-only storage.
    // Isolating each item keeps the surviving ones (matching
    // src/adapters/types.ts's own "every other case must leave the
    // surviving items usable" principle, extended one layer downstream from
    // the adapter's own entry parsing to this one) and still lets
    // recordSuccess run normally below.
    for (const raw of result.items) {
      try {
        const newItem = normalizeItem(raw, source, now);
        insertItem(db, newItem);
        insertedCount++;
      } catch {
        itemFailureCount++;
      }
    }

    recordSuccess(
      db,
      source.id,
      { etag: result.etag, lastModified: result.lastModified, itemCount: insertedCount },
      now,
    );
    return {
      sourceId: source.id,
      kind: 'success',
      itemCount: insertedCount,
      itemFailures: itemFailureCount,
      skippedEntries,
      capped,
      notModified: false,
      durationMs: elapsed(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordFailure(db, source.id, message, safePollIntervalMs(source), now);
    return {
      sourceId: source.id,
      kind: 'failure',
      itemCount: insertedCount,
      // Minor (fix round 1): carried through rather than dropped, so a
      // 'failure' reached AFTER the adapter's own fetch succeeded (e.g.
      // recordSuccess itself failing) still reports what the adapter saw.
      // itemFailures only when the item-processing phase actually started;
      // skippedEntries/capped are already undefined-until-assigned above.
      itemFailures: itemsAttempted ? itemFailureCount : undefined,
      skippedEntries,
      capped,
      error: message,
      durationMs: elapsed(),
    };
  }
}

// ---------------------------------------------------------------------------
// The poll cycle.
// ---------------------------------------------------------------------------

/**
 * Runs one poll cycle over `sources`, dispatching each through `adapters` by
 * its `type`. Every source is fully isolated (see `pollOneSource`): a throw
 * from any one of them is caught, recorded via `recordFailure`, and reported
 * as a `'failure'` outcome, never stopping the remaining sources from being
 * attempted. Sources are processed sequentially, not concurrently -- the
 * simplest, most deterministic shape, adequate for M1's scope (correctness
 * and isolation, not throughput) and easiest to reason about for the "one
 * dead feed" property specifically; per-host politeness spacing
 * (src/fetch/http.ts's `politeFetch`) and the RobotsUnavailableError
 * "just retry next time" contract both already assume no scheduler-level
 * concurrency control is needed.
 *
 * `now` is the logical instant this whole cycle runs at: every
 * `isEligible`/`recordSuccess`/`recordFailure`/`normalizeItem` call during
 * this cycle uses it, so backoff, item timestamps, and the report all agree
 * on "when" this cycle happened, and callers (tests, and `src/bin/
 * scheduler.ts`) get a single deterministic value to control. Must already
 * be a canonical UTC timestamp (`YYYY-MM-DDTHH:mm:ss.sssZ`) -- validated up
 * front via `assertCanonicalTimestamp`, matching every other `now`-accepting
 * function in this codebase, so a bad clock reading fails loudly at the
 * point it entered the pipeline rather than resurfacing confusingly deep
 * inside a per-source call. `new Date().toISOString()` (what
 * `src/bin/scheduler.ts` passes in production) is always this shape and is
 * always UTC regardless of the host's configured system timezone -- `Date`
 * represents an absolute instant internally, so this satisfies "schedule
 * arithmetic derives from WF_TZ, never the system clock's zone" trivially:
 * there is no local-calendar math anywhere in this cycle for a system
 * timezone to leak into. WF_TZ instead governs any HUMAN-readable time
 * display around this cycle, which is `src/bin/scheduler.ts`'s
 * responsibility, not this pure-computation function's.
 */
export async function runPollCycle(
  db: Db,
  sources: Source[],
  adapters: SchedulerAdapterRegistry,
  now: string,
): Promise<PollReport> {
  assertCanonicalTimestamp('now', now);

  const startedAtMs = Date.now();
  const outcomes: SourceOutcome[] = [];
  for (const source of sources) {
    outcomes.push(await pollOneSource(db, source, adapters, now));
  }

  return {
    now,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAtMs,
    sources: outcomes,
  };
}
