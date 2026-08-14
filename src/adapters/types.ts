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
 *
 * `now`, third and optional: the single instant this fetch should treat as
 * "the current time," for the rare adapter whose request depends on it (M1
 * follow-up: `src/adapters/json.ts`'s per-source `buildUrl`, which nvd-cve
 * uses to compute a lastModified date window -- see that file for the full
 * mechanism). Optional, not required, so the three adapters with no such
 * need (`rss.ts`, `newsSitemap.ts`, `googleNews.ts`) need zero changes --
 * TypeScript's normal function-arity assignability already makes their
 * existing 2-parameter `fetch` implementations valid `Adapter`s with this
 * third parameter simply never supplied at their call site. A caller that
 * omits it (any adapter that ignores its own third parameter, or code
 * calling through the bare `Adapter` type) gets undefined; an implementation
 * that cares is expected to default it to `new Date()` itself, exactly the
 * way `jsonAdapter.fetch` does, so that omitting it always means "use the
 * real current time," never a crash or a silently-wrong fixed instant.
 *
 * Threaded explicitly by `src/scheduler/run.ts`'s `pollOneSource`, from the
 * SAME already-validated `now` string `runPollCycle` receives (see that
 * function's own doc comment on why every side effect in one poll cycle
 * agrees on one instant) -- not a second, independent `new Date()` a
 * defaulted parameter would otherwise evaluate one frame up from the
 * scheduler's own clock read. Before this parameter existed, an adapter's
 * only way to receive an injected `now` at all was a caller bypassing the
 * `Adapter` type and calling a concrete adapter's own wider signature
 * directly (as this codebase's tests already did) -- reachable from tests,
 * unreachable from the one real production caller. Growing the shared
 * interface, rather than leaving that gap, closes it for every adapter at
 * once, present or future, not just json.ts's own `fetch`.
 */
export interface Adapter {
  readonly type: SourceType;
  fetch(source: Source, state: FetchState | null, now?: Date): Promise<AdapterResult>;
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
  /**
   * How many otherwise-valid entries an adapter's own volume policy
   * excluded this fetch -- known to exist, deliberately not represented in
   * `items`, but never because of a defect. Deliberately DISTINCT from
   * `skipped` (see that field's doc comment just above): `skipped` means
   * "this entry was broken or an EntryParser bug ate it," which is a
   * health signal a source-health page should treat as a possible problem.
   * An item cut by a cap is neither -- folding the two together would make
   * a healthy, working-as-designed, at-capacity poll look identical to a
   * parser that just broke on hundreds of entries.
   *
   * Two genuinely different shapes of "excluded by policy" both use this
   * SAME field, deliberately not two separate ones -- a source-health
   * consumer needs to know "how far behind is this poll," not which of the
   * two mechanically produced that number:
   *   - fetched, parsed, then discarded to stay under a fixed count --
   *     `news_sitemap` (src/adapters/newsSitemap.ts)'s MAX_ITEMS_PER_FETCH,
   *     the original M1 task 8 use of this field: every excluded entry was
   *     individually in hand, if only briefly.
   *   - known via the source's OWN reported total count but never
   *     individually requested at all -- `json.ts`'s nvd-cve mapper (M1
   *     follow-up, fix round 1), whose pagination is bounded to a fixed
   *     number of pages per poll regardless of how many total results NVD
   *     itself reports; the remainder was never fetched, parsed, or
   *     defective, merely not asked for this cycle. `capped` here is
   *     `totalAvailable - entriesRetrieved`, not a discard count.
   *
   * Optional because most adapters have no cap at all and must never
   * fabricate a `0`: `rss`/`atom` and `google_news` never set this field;
   * `json.ts` sets it only for its one paginated mapper. Leave it
   * `undefined` on a fetch the cap didn't bind on (nothing excluded, or the
   * true total genuinely couldn't be determined) -- same "undefined, not a
   * fabricated 0, when there is nothing to report" convention `skipped`
   * already uses for a `notModifiedResult`.
   *
   * Closes a blind spot `skipped` alone cannot: without this, `items: 150,
   * skipped: 0` cannot distinguish "the source published exactly 150 and
   * every one of them is here" from "the source published 585 and only the
   * most recent 150 were kept" -- exactly the coverage question a
   * source-health consumer most needs answered at cold start or after an
   * outage, when a capped source is furthest behind. Added M1 task 8 fix
   * round 1 (contract addition, authorized after tasks 6/7/9 all landed).
   *
   * ## The direction invariant -- read before rendering this number
   *
   * **`capped` counts entries at the OLD end of the source's range, never
   * the new end.** Both producers guarantee it, by different mechanisms:
   * `news_sitemap` keeps the most recent N and discards older ones
   * (`capToMostRecent`), and `json.ts`'s nvd-cve mapper anchors its walk to
   * the TAIL of NVD's ascending-by-CVE-id ordering, so what goes unrequested
   * is history, not today. Any future capped producer must preserve this or
   * change this contract deliberately.
   *
   * This is stated explicitly because **the meaning inverted once already**.
   * Under nvd-cve's fix round 1 the walk started at `startIndex=0`, the
   * HEAD, so `capped` counted the *newest* entries -- content genuinely
   * missed. Fix round 2 moved the anchor to the tail, so the same field name
   * now counts the *oldest* -- content deliberately not asked for. Same
   * number, opposite alarm level. Anything written against the round-1
   * framing is now backwards.
   *
   * Two consequences for the M3 source-health page, which does not exist yet
   * and is the first real consumer:
   *
   * - **Magnitude is not comparable across sources, and `capped` is not a
   *   behind-ness ranking.** Live on 2026-08-14, nvd-cve reports `capped`
   *   around 358,900 while holding CVEs published minutes earlier -- the
   *   backlog is a historical NVD bulk-rescore event sitting ~50-60 days
   *   back, not a coverage failure. Sorting sources by `capped` descending
   *   would put the healthiest, most current source at the top of a "furthest
   *   behind" list.
   * - **A large `capped` is not by itself actionable.** What matters is
   *   whether the *newest* entry retrieved is current, which this field does
   *   not answer. Pair it with the freshest `publishedAt` in `items` before
   *   drawing any conclusion about a source's health.
   */
  capped?: number;
  /**
   * How many otherwise-valid, structurally-fine entries were excluded this fetch by a
   * source's own CONTENT policy -- `config/sources.yaml`'s `filters` map (validated by
   * `src/sources/load.ts`), not a parsing defect and not a volume ceiling. Added
   * fix-ap-language-filter task, whose concrete (and, as of that task, only) producer is
   * `news_sitemap`'s `filters.languages` allow-list: an AP entry whose declared
   * `<news:language>` is not in that list is dropped here, at ingest, and never stored --
   * an entirely deliberate exclusion, not a failure of any kind.
   *
   * ## Why neither `skipped` nor `capped` could carry this instead
   *
   * Both were considered and rejected, not overlooked:
   *
   * - **`skipped` means "defective."** Its own doc comment above frames every entry it
   *   counts as either a per-entry parse failure or an `EntryParser` bug -- exactly the
   *   signal a source-health page should treat as "something is broken." A well-formed
   *   Spanish-language article is not broken; it parses perfectly and would be stored
   *   verbatim if the operator's config allowed it. Folding a content decision into
   *   `skipped` would make a healthy AP poll -- correctly filtering exactly as configured
   *   -- indistinguishable from a parser that started failing on a third of its entries,
   *   which is precisely the false alarm `skipped`'s own doc comment already warns against
   *   for a different mechanism (the item cap) that has the same shape of problem.
   * - **`capped` means "volume policy," with a direction invariant this would violate.**
   *   `capped`'s doc comment above pins, deliberately and explicitly (after that meaning
   *   inverted once already), that it counts entries at the OLD end of a source's range,
   *   never the new end -- because both of its real producers are anchored to recency
   *   (`news_sitemap` keeps the newest N; `nvd-cve` walks from the tail of an ascending id
   *   order). A language exclusion has no relationship to recency at all: a brand-new,
   *   this-minute Spanish article is excluded exactly as readily as a week-old one, so
   *   folding it into `capped` would make that field sometimes count the NEW end of the
   *   range too, corrupting the one cross-source invariant it was just pinned to have
   *   before M3's source-health page -- the first real consumer of either field -- even
   *   exists to read it.
   *
   * `filtered` is deliberately named after the `filters` config key that drives it, so a
   * reader of a source-health page can trace a nonzero count straight back to
   * `config/sources.yaml`'s `filters` section for that source. Named generically (not
   * `filteredLanguage`) on purpose, mirroring how `capped` itself already generalizes two
   * mechanically different producers under one field (see that field's doc comment): a
   * future `keywords` or `min_points` filter (both already forward-documented,
   * unconsumed, in `config/sources.yaml`'s header) should report through this SAME field
   * rather than adding a fourth exclusion-reporting field per filter type -- a
   * source-health consumer needs to know "how many entries did this source's own config
   * choose not to store," not which filter key mechanically produced that number.
   *
   * Optional, same "undefined rather than a fabricated 0" convention `skipped` and
   * `capped` already use: stays `undefined` both when a source has no content filter
   * configured at all (the overwhelming common case -- every source except `ap-news` as
   * of this task) AND when one is configured but happened to exclude nothing this fetch.
   * Consequently `filtered: undefined` cannot by itself distinguish "no filter configured"
   * from "filter configured, nothing to exclude this cycle" -- accepted here because
   * `capped` already carries the identical ambiguity (see its own doc comment) and a
   * source-health page can always resolve it by reading `config/sources.yaml` directly,
   * the same way it would have to for `capped`.
   */
  filtered?: number;
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
