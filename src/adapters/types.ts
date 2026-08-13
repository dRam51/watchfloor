/**
 * The one contract every source-format adapter implements (Tasks 6-9: rss,
 * json, news_sitemap, google_news). This file is deliberately small: it
 * defines the interface every adapter is judged against, plus the pieces of
 * behaviour that are identical across all four rather than something each
 * adapter would otherwise reimplement (and re-debug) on its own. See the
 * doc comments below for what is centralized here and why; task-6-report.md
 * records what was deliberately left to each adapter instead.
 *
 * No adapter-specific parsing lives here. In particular, this file must
 * never import `fast-xml-parser` (or take a parameter shaped by its output)
 * -- that dependency is intentionally isolated to src/adapters/rss.ts alone,
 * so replacing it later is a one-file change, not a contract change.
 */

import type { Source } from '../sources/load.ts';
import type { FetchState } from '../db/fetchState.ts';
import type { RawItem } from '../normalize/item.ts';
import type { FetchResult } from '../fetch/http.ts';

/**
 * The set of values `source.type` (config/sources.yaml, validated by
 * src/sources/load.ts) can take. Derived from `Source['type']` via an
 * indexed access type rather than redeclared as its own literal union: the
 * Zod schema in src/sources/load.ts is the one place that union is allowed
 * to be spelled out, so `SourceType` can never silently drift out of sync
 * with it. `src/sources/load.ts` does not export this name itself (only
 * `Source`), so this is that "comes from load.ts" type made concrete
 * without touching a file outside this task's scope.
 *
 * One wrinkle for this adapter specifically: the schema's `type` union
 * includes both `'rss'` and `'atom'` as distinct values, but `rss.ts` below
 * handles BOTH formats behind a single adapter that content-sniffs which one
 * it received. Per the M1 plan's own verified-source table, the one real
 * Atom source in the M1 set (`simonwillison`) is configured with
 * `type: rss`, not `type: atom` -- so `rssAdapter.type` below is `'rss'`.
 * `'atom'` as a distinct configured value is not exercised by any M1 source
 * and has no adapter registered for it; if Task 10's scheduler or Task 11's
 * config ever wants to write `type: atom` for clarity, it should route that
 * key to this same adapter instance rather than expecting a second one.
 */
export type SourceType = Source['type'];

/**
 * Every complete scheduler registry needs one `Adapter` per `SourceType`.
 * Declaring a registry with this type (`const registry: AdapterRegistry =
 * {...}`) rather than as an untyped object literal makes a missing
 * `SourceType` key a COMPILE error, not a routing hole only discovered at
 * runtime the day a source of that type is configured -- exactly the
 * mechanical enforcement the `'atom'` wrinkle above needs and a prose
 * comment alone can't provide.
 *
 * `'atom'` is not actually unhandled: `rssAdapter` (src/adapters/rss.ts)
 * covers it, since it content-sniffs the format rather than trusting
 * `source.type`. A conforming registry must still list `atom: rssAdapter`
 * explicitly, the same instance as `rss:` -- `Record<SourceType, Adapter>`
 * requires every key to be present and has no way to know two keys should
 * resolve to the same value without being told.
 */
export type AdapterRegistry = Record<SourceType, Adapter>;

/**
 * Implemented by each format adapter. `type` identifies which `SourceType`
 * a scheduler should dispatch to this adapter (see the note on rss/atom
 * above for the one case that isn't a straight 1:1 mapping); `fetch` performs
 * one poll attempt for one source and must resolve to an `AdapterResult` or
 * reject -- see `AdapterResult` and the `EntryParser` convention below for
 * exactly what "resolve" vs. "reject" each mean.
 */
export interface Adapter {
  readonly type: SourceType;
  fetch(source: Source, state: FetchState | null): Promise<AdapterResult>;
}

/**
 * What every adapter hands back to the scheduler (Task 10) after one poll
 * attempt that did not throw. `notModified: true` means the source
 * confirmed (e.g. via HTTP 304) that nothing has changed since `state`;
 * `items` is always `[]` in that case -- see `notModifiedResult` below,
 * which is how every adapter should construct this branch rather than
 * building it by hand.
 */
export interface AdapterResult {
  items: RawItem[];
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
  /**
   * How many raw entries this fetch attempted to parse but discarded --
   * either a legitimate per-entry defect (see `EntryParser`) or an
   * `EntryParser` bug that threw (see `parseEntries`'s backstop catch).
   * Optional: a `notModifiedResult` has nothing to report (nothing was
   * parsed at all), so it is left `undefined` there rather than a
   * fabricated `0`. When present (every `fetchedResult` call populates it),
   * it is what makes `items: []` distinguishable between two states that
   * otherwise look identical: a source that genuinely published nothing new
   * this cycle (`skipped: 0`), versus one whose entries all failed to parse
   * (`skipped: <entries.length>`) -- the same `recordSuccess(itemCount: 0)`
   * a scheduler would otherwise call in both cases with no way to tell them
   * apart. Consumed by the source-health page (Task 10's `PollReport`), not
   * required for correctness today. Added fix round 1, Finding 3.
   */
  skipped?: number;
}

// ---------------------------------------------------------------------------
// Shared helper: turning a politeFetch result into an AdapterResult.
//
// Every adapter wraps src/fetch/http.ts's politeFetch the same way: send the
// prior state's validators, and if the response is a 304, return an empty,
// notModified result; otherwise parse the body and return the parsed items.
// The 304 branch has one non-obvious rule (see notModifiedResult's own doc
// comment), so it is centralized here rather than repeated -- and possibly
// gotten slightly wrong four different ways -- in each adapter.
// ---------------------------------------------------------------------------

/**
 * Builds the `AdapterResult` for a 304. `etag`/`lastModified` prefer the
 * fresh response headers but fall back to the prior `FetchState` when the
 * response omits them: RFC 7232 SS4.1 says a 304 SHOULD repeat the
 * validators a 200 would have sent, but not every origin complies. Silently
 * writing `null` here whenever a response doesn't repeat them (rather than
 * carrying the already-known-good prior value forward) would permanently
 * lose the conditional-request validator after a single non-compliant 304:
 * the NEXT poll would send no `If-None-Match` at all and silently degrade to
 * a full fetch every cycle from then on, for a source that never actually
 * changed.
 */
export function notModifiedResult(fetchResult: FetchResult, state: FetchState | null): AdapterResult {
  return {
    items: [],
    etag: fetchResult.etag ?? state?.etag ?? null,
    lastModified: fetchResult.lastModified ?? state?.lastModified ?? null,
    notModified: true,
  };
}

/**
 * Builds the `AdapterResult` for an ordinary 2xx fetch, from a
 * `ParseEntriesResult` (see `parseEntries` below) so `skipped` is always
 * populated alongside `items` -- there is no code path that produces one
 * without the other. Unlike `notModifiedResult`, there is no fallback to
 * prior state for the validators: a 2xx response is authoritative about its
 * own current ones, and a source that simply doesn't send an ETag shouldn't
 * be made to look like one that does by reusing an old value that may no
 * longer describe the (possibly just-changed) content.
 */
export function fetchedResult(fetchResult: FetchResult, parsed: ParseEntriesResult): AdapterResult {
  return {
    items: parsed.items,
    etag: fetchResult.etag,
    lastModified: fetchResult.lastModified,
    notModified: false,
    skipped: parsed.skipped,
  };
}

// ---------------------------------------------------------------------------
// The malformed-entry convention.
//
// This is the single most important shared rule in this file: how an
// adapter is expected to behave when ONE entry in an otherwise-good feed is
// broken, as opposed to when the ENTIRE feed is unreadable. Making this a
// literal, shared, generic helper -- rather than four independent prose
// descriptions each implementer interprets slightly differently -- is
// exactly the kind of thing this file exists to hold.
// ---------------------------------------------------------------------------

/**
 * The contract every adapter's per-entry extraction function follows.
 * Attempt to build one `RawItem` from one raw feed entry/record, and return
 * `null` -- never throw -- for anything wrong with just THAT entry (no
 * usable link, no usable title, or whatever else a given format requires).
 *
 * `RawItem`'s own optional fields (`publishedAt`, `summary`, `author`) are
 * never grounds to return `null` for the whole entry: extract whatever is
 * there, verbatim, or pass `null` for that ONE field and keep the entry.
 * In particular, an entry-level date that looks unparseable is still passed
 * through as the raw string on `publishedAt` -- deciding whether a date
 * parses is `normalizeItem`'s job (src/normalize/item.ts), never this
 * layer's. An adapter that dropped a whole entry because it declined to
 * interpret a date would be silently discarding a real, uniquely-URLed
 * article for a reason `RawItem`'s own shape (`publishedAt?: string | null`)
 * already says is fine.
 *
 * Reserve throwing (from the adapter as a whole, not from an `EntryParser`)
 * for when the ENTIRE response cannot be read as the expected format at
 * all: not that format, corrupted beyond recovery, or not a feed document in
 * the first place (e.g. an HTML error page served with 200). That is the
 * one case the scheduler must see as a genuine fetch failure via
 * `recordFailure`; every other case must leave the surviving items usable.
 */
export type EntryParser<TRawEntry> = (rawEntry: TRawEntry) => RawItem | null;

/** `parseEntries`'s return shape -- see `AdapterResult.skipped` for why the count travels alongside the items rather than being discarded. */
export interface ParseEntriesResult {
  items: RawItem[];
  skipped: number;
}

/**
 * Applies an `EntryParser` across a batch of raw entries, keeping the ones
 * that parsed and counting the ones that didn't. The counting and the
 * null-means-skip mechanics are deliberately trivial: the value here is
 * making that convention impossible to miss, and making "one bad entry
 * can't take the rest of the batch down" (and, since fix round 1's Finding
 * 3, "a discarded entry is always counted, never silently dropped from both
 * the items AND the record of what happened") a property of the shared
 * contract rather than of each implementer's diligence. The try/catch is a
 * backstop, not the primary mechanism -- an `EntryParser` is expected to
 * return `null`, not throw, for a single bad entry, but a bug that throws
 * unexpectedly (an unguarded property access on an unusually-shaped entry,
 * say) still only costs its own entry here, not the batch, and is still
 * counted in `skipped` the same as a well-behaved `null`.
 */
export function parseEntries<TRawEntry>(
  rawEntries: TRawEntry[],
  parseOne: EntryParser<TRawEntry>,
): ParseEntriesResult {
  const items: RawItem[] = [];
  let skipped = 0;
  for (const rawEntry of rawEntries) {
    try {
      const item = parseOne(rawEntry);
      if (item !== null) items.push(item);
      else skipped++;
    } catch {
      // See the doc comment above.
      skipped++;
    }
  }
  return { items, skipped };
}
