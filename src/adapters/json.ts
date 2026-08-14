/**
 * JSON adapter: one `Adapter` (src/adapters/types.ts) covering five sources
 * whose JSON shapes share nothing structurally -- CISA's KEV catalog, NVD's
 * CVE API 2.0, Hacker News via Algolia, the Federal Register API, and NWS's
 * CAP alerts as GeoJSON. Unlike rss.ts (one shared shape, format sniffed
 * from the parsed body), a JSON response's shape reveals nothing about
 * which of the five it is -- there is no `<rss>` vs `<feed>` root element to
 * inspect. Dispatch therefore happens on `source.id`, before any network
 * call, via the `JSON_SOURCE_MAPPERS` registry below. Adding a sixth JSON
 * source is one new registry entry -- an `EntryParser` plus, for every shape
 * seen so far, an `extractArrayField(fieldName)` call -- never a new adapter
 * file and never a change to `fetch()` itself.
 *
 * ---------------------------------------------------------------------------
 * Skip vs. throw -- the same rule as rss.ts, JSON-shaped
 * ---------------------------------------------------------------------------
 * A malformed INDIVIDUAL entry -- for every mapper below, this always means
 * "the field(s) needed to build a `url` or a `title` are missing or blank";
 * every other `RawItem` field is optional and extracted as whatever raw
 * value (or `null`) is present, never a reason to drop the entry -- is
 * dropped by that source's per-entry parser returning `null`. `parseEntries`
 * (types.ts) keeps everything that didn't and counts what did, so this never
 * throws and one bad entry never affects its neighbours.
 *
 * A WHOLLY unparseable body throws `JsonParseError`, from exactly two kinds
 * of place: `JSON.parse` itself failing (not JSON at all -- truncated,
 * empty, an HTML error page served with 200), or a mapper's `extractEntries`
 * finding that the envelope it parsed into doesn't have the one array field
 * that source is known to carry its entries in (present with the wrong
 * type, or missing entirely -- e.g. an API error body like
 * `{"status": 503, "title": "Service Unavailable"}`, which is syntactically
 * valid JSON but not this source's shape at all). Either throw propagates
 * out of `fetch()` so the scheduler records a real failure, mirroring
 * rss.ts's `FeedParseError`.
 *
 * A well-formed envelope whose array field is simply EMPTY is NOT an error:
 * it resolves with `items: []`, `skipped: 0`. This is explicitly not a
 * hypothetical for nws-fl-alerts -- Florida legitimately has zero active
 * alerts on many days, and that must read as a healthy quiet source, not a
 * broken fetch (the plan's own instruction). The same handling applies to
 * the other four sources on general principle, even though a quiet day is
 * less likely for, say, a 1600+-entry vulnerability catalog.
 *
 * A source id with no registered mapper throws `UnknownJsonSourceError` at
 * dispatch, before any network call -- see that class's doc comment.
 *
 * ---------------------------------------------------------------------------
 * What every mapper constructs vs. extracts (read this before reviewing)
 * ---------------------------------------------------------------------------
 * Two of the five sources -- cisa-kev and nvd-cve -- have no first-party
 * link field on their entries at all (verified against live captures: see
 * each mapper's own doc comment below). Both construct a URL rather than
 * leaving it unset -- `RawItem.url` is required and non-nullable, unlike
 * `publishedAt`/`summary`/`author`, so there is no "pass through as absent"
 * option the way there is for those fields -- or guessing at one of several
 * unstructured URLs sometimes embedded in a KEV entry's free-text `notes`
 * field. This is a genuine adapter-level judgment call, not a pass-through
 * extraction, and is flagged as such in the task report for review.
 *
 * Fix round 1, Finding 1 (CRITICAL): an earlier version of this file had
 * BOTH mappers construct the identical NVD per-CVE URL
 * (`https://nvd.nist.gov/vuln/detail/<id>`), reasoning that sharing one
 * stable, first-party authority was safer than guessing. That reasoning was
 * wrong, and the consequence is not hypothetical: `deriveItemKey`
 * (src/domain/item.ts) is `sha256(canonicalUrl)`, and `getCurrentItem`
 * resolves ties with `order by fetched_at desc, rowid desc limit 1` -- so
 * the same CVE fetched from both sources would make whichever fetched LAST
 * the only version any reader ever sees, silently discarding the other
 * source's entirely different fields (CISA's own `dueDate`/
 * `knownRansomwareCampaignUse`/`requiredAction`/`notes` vs. NVD's
 * `cvssMetricV2`/`weaknesses`/`configurations`/`references` -- neither
 * schema contains the other's data). Under append-only storage this is also
 * a one-way door: catching it after real data has landed fragments each
 * affected CVE's history into two unrelated `item_key` chains with no way
 * to merge them back. `nvd-cve` keeps the NVD url below (genuinely
 * first-party, and confirmed against the live fixture that no `references`
 * entry already points there -- not assumed); `cisa-kev` now builds its own
 * url on CISA's own domain instead -- see `cisaKevUrl`'s doc comment for
 * exactly which one, including why the first shape considered for it
 * doesn't actually work.
 *
 * ---------------------------------------------------------------------------
 * Fix (disabled sources, M1 follow-up): a per-source URL builder
 * ---------------------------------------------------------------------------
 * `nvd-cve` shipped `enabled: false` (config/sources.yaml, M1 task 11)
 * because its only usable query (a `lastModStartDate`/`lastModEndDate`
 * recency window) has to be computed relative to "now" at request time, and
 * every JSON source before this fetched `source.url` verbatim, forever --
 * no source had ever needed its request to vary poll to poll. `project-zero`
 * was disabled for an unrelated reason (an oversized, unbounded response)
 * and is `type: rss`, entirely out of this file -- see src/fetch/http.ts's
 * `MAX_BYTES_OVERRIDES` doc comment for that one.
 *
 * `JsonSourceMapper` below gained exactly one new optional field,
 * `buildUrl(configuredUrl, now)` -- symmetric with the `extractEntries`/
 * `parseEntry` pair every mapper already had, registered the same way, in
 * the same registry, never a second mechanism bolted on elsewhere. Four of
 * the five sources have no `buildUrl` at all and are completely unaffected:
 * no behavior change, no new code path exercised, `source.url` fetched
 * exactly as before this existed. See `JsonSourceMapper`'s own doc comment
 * for the full shape and why it deliberately stops there rather than
 * growing into a templating language, and `nvdCveUrl` below for the one
 * registered builder.
 *
 * Fix round 1 (re-review), Finding 1 (CRITICAL): the date window alone was
 * not the whole fix -- the configured url's own `resultsPerPage=5`, with no
 * pagination, meant a poll retrieved 5 of a much larger total (verified
 * live: 5 of 6,090, 0.08%), all sharing one tied `lastModified` timestamp,
 * recurring across many consecutive polls -- the SAME "technically working,
 * permanently near-useless, silently incomplete" pathology this fix set out
 * to eliminate, just relocated. `JsonSourceMapper` gained a second optional
 * field for this, `paginate` -- see its own doc comment for the shape, and
 * `NVD_RESULTS_PER_PAGE`/`NVD_MAX_PAGES_PER_POLL`'s doc comments (below,
 * nvd-cve's section) for the live-verified numbers and the honest limits of
 * what a BOUNDED per-poll page count can promise against an unbounded,
 * source-controlled total -- `AdapterResult.capped` (src/adapters/types.ts)
 * is what makes the remainder visible rather than hidden, not a guarantee
 * of complete coverage every poll.
 */

import { politeFetch, type FetchResult } from '../fetch/http.ts';
import type { Source } from '../sources/load.ts';
import type { FetchState } from '../db/fetchState.ts';
import type { RawItem } from '../normalize/item.ts';
import {
  fetchedResult,
  notModifiedResult,
  parseEntries,
  type Adapter,
  type AdapterResult,
  type EntryParser,
  type ParseEntriesResult,
} from './types.ts';

/**
 * Thrown at dispatch, before any network call, when `source.id` has no
 * entry in `JSON_SOURCE_MAPPERS`. Deliberately loud: a misconfigured or
 * newly-added JSON source silently yielding `items: []` forever because
 * nobody wired up its shape would be indistinguishable, on the source-health
 * page, from a healthy quiet day -- exactly the failure mode this milestone
 * exists to catch. The fix is always a one-entry registry addition (a new
 * mapper), never a code change to `fetch()` itself.
 */
export class UnknownJsonSourceError extends Error {
  constructor(sourceId: string) {
    super(
      `no JSON mapper registered for source id "${sourceId}" -- add one to ` +
        `JSON_SOURCE_MAPPERS in src/adapters/json.ts rather than letting it ` +
        `silently yield zero items`,
    );
    this.name = 'UnknownJsonSourceError';
  }
}

/**
 * Thrown when a response cannot be read as the JSON shape `sourceId` is
 * known to have, at all. See the module doc comment above for exactly which
 * conditions raise this versus which are silently tolerated (a malformed
 * entry) or silently accepted (a well-formed, empty entries array).
 */
export class JsonParseError extends Error {
  constructor(url: string, sourceId: string, reason: string, opts?: { cause?: unknown }) {
    super(
      `could not parse ${url} (source "${sourceId}") as its expected JSON shape: ${reason}`,
      opts?.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = 'JsonParseError';
  }
}

// ---------------------------------------------------------------------------
// Small JSON-value helpers -- the JSON equivalent of rss.ts's textOf/isBlank.
// Unlike XML, a JSON string field is already a plain string with no
// attribute-wrapper shape to unwrap, so these are simpler than their XML
// counterparts, but the never-coerce, blank-is-absent conventions match.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A JSON string value, or `null` for anything else (absent, wrong type, or `null` itself). Never coerces -- a number or boolean field is never silently stringified. */
function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Empty-after-trim is the same as absent -- an empty string is not a title, and not a url. Matches rss.ts's identical rule. */
function isBlank(value: string | null): boolean {
  return value === null || value.trim() === '';
}

/**
 * The first of the two that is non-blank, or `null` if both are blank or
 * absent. Unlike `a ?? b`, a present-but-EMPTY string on the left does NOT
 * suppress the fallback -- `??` only triggers on `null`/`undefined`, and an
 * empty string is neither. Needed anywhere a JSON field can legitimately be
 * present-but-empty rather than strictly absent.
 *
 * Fix round 1, Finding 2: `parseNwsFlAlertEntry` below originally used
 * `asString(properties.headline) ?? asString(properties.event)` directly,
 * which meant a real alert with `headline: ''` and a perfectly good `event`
 * was wrongly dropped as blank-titled instead of falling back -- the same
 * mistake `parseHnAlgoliaEntry`'s url fallback above never made, since it
 * was already written with an explicit `isBlank` check rather than `??`.
 */
function firstNonBlank(a: string | null, b: string | null): string | null {
  return !isBlank(a) ? a : b;
}

// ---------------------------------------------------------------------------
// The per-source-id registry.
// ---------------------------------------------------------------------------

/**
 * One entry per registered source id. `extractEntries` pulls the raw entry
 * array out of the parsed envelope, or throws `JsonParseError` if the
 * envelope isn't shaped the way this source is known to shape it (see
 * `extractArrayField` below, which every one of the five current mappers
 * uses, since each of their five otherwise-unrelated JSON APIs happens to
 * nest its entries under exactly one top-level named array).
 * `extractEntries` is a function rather than a bare field-name string so
 * that a future JSON source whose entries are NOT a single top-level array
 * -- a paginated envelope requiring a merge, NDJSON, whatever shape a
 * not-yet-seen API turns out to use -- is still just one more registry
 * entry, never a change to this type or to `fetch()` below.
 */
interface JsonSourceMapper {
  extractEntries(body: unknown, sourceUrl: string, sourceId: string): unknown[];
  parseEntry: EntryParser<unknown>;
  /**
   * Optional, symmetric with `extractEntries`/`parseEntry` above: one
   * function per source id, registered here rather than invented as a
   * separate concept elsewhere. Takes the CONFIGURED url
   * (config/sources.yaml, verbatim) and the current instant, and returns
   * the url this poll should actually request. Absent for four of the five
   * sources registered below, which have no reason to vary their request
   * across polls -- those fetch `source.url` completely unchanged, exactly
   * as every JSON source did before this field existed.
   *
   * Deliberately NOT a templating language, a query-string DSL, or a
   * general per-source config hook -- it is one plain function, taking the
   * two inputs a source's per-poll FIRST-page url could ever need with the
   * state this adapter already has in hand (no cursor, no page token,
   * nothing persisted between polls -- `paginate` below, not this field,
   * is what a source with a WITHIN-one-poll cursor uses). A source that
   * genuinely needed more than "the configured url plus the current time"
   * for its first request would need a different mechanism than this, not
   * a bigger one wedged into this shape.
   *
   * `now` is a parameter here, and MUST be treated as the only source of
   * the current time -- never `new Date()`/`Date.now()` inside a builder
   * itself. `jsonAdapter.fetch` below reads the real clock exactly once
   * (its own `now` parameter, defaulted so production callers need no
   * changes) and passes that single value down to whichever builder runs;
   * a builder that read the clock itself would make its own output
   * untestable without either mocking global time or writing a test that
   * tolerates "whenever this happened to run," which is exactly the
   * nondeterminism this parameter exists to avoid. See `nvdCveUrl` below
   * for the one registered builder today.
   */
  buildUrl?(configuredUrl: string, now: Date): string;
  /**
   * Optional pagination policy (M1 follow-up, fix round 1, Finding 1
   * CRITICAL) -- a source with this field is fetched by `jsonAdapter.fetch`
   * via a BOUNDED loop of `politeFetch` calls instead of the ordinary
   * single call every other mapper still gets. Absent for four of the five
   * sources; nvd-cve is the one registered user today (see
   * `nvdNextPageUrl`/`nvdTotalAvailable`/`NVD_MAX_PAGES_PER_POLL` below).
   *
   * - `maxPages`: a hard ceiling on how many pages ONE `fetch()` call will
   *   ever request, independent of `nextPageUrl`'s or `totalAvailable`'s
   *   own opinion -- the reason a source whose real backlog is enormous
   *   (see nvd-cve's own doc comment for a concrete, live-verified case)
   *   still costs a small, fixed, predictable number of requests per poll,
   *   never "however many pages the backlog happens to have."
   * - `nextPageUrl(currentPageUrl, entriesOnThisPage)`: given the page
   *   just fetched and how many RAW entries it contained (before
   *   `parseEntry` dropped any malformed ones -- a malformed entry still
   *   occupied a slot in that page), returns the next page's url, or
   *   `null` to stop early (this page was short -- fewer entries than a
   *   full page -- meaning there is nothing more to fetch, independent of
   *   `maxPages`). Never receives the parsed envelope: everything it needs
   *   to construct the next request is either the page count it already
   *   knows about or already present on the CURRENT page's own url.
   * - `totalAvailable(parsedEnvelope)`: reads the source's own reported
   *   total-available count off one page's ALREADY-parsed envelope (so
   *   this never re-parses a body `parseJsonBody` already parsed), or
   *   `null` if that field is absent or the wrong type. Feeds
   *   `AdapterResult.capped` ONLY -- never loop control (`nextPageUrl`
   *   alone decides when to stop), so a missing or malformed total-count
   *   field degrades to "capped is not reported" rather than to a broken
   *   or infinite loop.
   */
  paginate?: {
    maxPages: number;
    nextPageUrl(currentPageUrl: string, entriesOnThisPage: number): string | null;
    totalAvailable(parsedEnvelope: unknown): number | null;
  };
}

/**
 * Shared by every current mapper (see `JsonSourceMapper`'s doc comment
 * above): reads `body[field]`, requiring it to be present and an array. An
 * array that is merely EMPTY is a fully valid envelope -- e.g. nws-fl-alerts
 * genuinely returns `features: []` when Florida has no active alerts, which
 * is a success reporting zero items, not a parse failure (see
 * `parseEntries`, types.ts, for how that flows into `AdapterResult.skipped`
 * downstream). Only the field being ABSENT, or present with the wrong type,
 * means the response cannot be read as this source's expected shape at all
 * -- e.g. an API error body that is syntactically valid JSON but shaped
 * nothing like a real response.
 */
function extractArrayField(field: string): JsonSourceMapper['extractEntries'] {
  return (body, sourceUrl, sourceId) => {
    if (!isRecord(body)) {
      throw new JsonParseError(sourceUrl, sourceId, 'response body is not a JSON object');
    }
    const value = body[field];
    if (!Array.isArray(value)) {
      throw new JsonParseError(sourceUrl, sourceId, `no "${field}" array in the response envelope`);
    }
    return value;
  };
}

// ---------------------------------------------------------------------------
// cisa-kev -- { vulnerabilities: [{ cveID, vulnerabilityName, dateAdded, shortDescription, ... }] }
// ---------------------------------------------------------------------------

/**
 * CISA's own KEV catalog page, filtered to one CVE via the page's own
 * `field_cve` exposed-filter field. Built with `URL`/`searchParams` rather
 * than template-literal interpolation so the value is correctly
 * percent-encoded regardless of content -- not because a well-formed CVE id
 * (`CVE-\d{4}-\d{4,}`) ever actually needs it, but because there is no
 * reason to hand-roll encoding when the platform does it correctly for
 * free.
 *
 * Verified live, twice, against real CVE ids from the fixture:
 * `?field_cve=<id>` returns 200 and genuinely filters server-side (the
 * filtered page contains exactly the one requested CVE id; the unfiltered
 * base page contains 21 distinct ones). `field_cve` is not a guess -- it is
 * the literal `name` attribute on this page's own catalog-search form
 * (`<input ... id="edit-field-cve" name="field_cve" ...>`).
 *
 * This specific shape replaced a first attempt, `?cve=<id>`, which is
 * plausible-looking but wrong: verified live, it returns 403, not a
 * harmless no-op. Isolated the cause before concluding this: a second,
 * semantically unrelated, harmless probe (`?test=1`, an unrecognized name
 * with an inert value) 403s identically, which rules out "cve" the
 * parameter NAME or the CVE-shaped VALUE as the trigger -- this route's WAF
 * appears to allow only the query parameters the page's own form actually
 * defines, and rejects any other name outright.
 */
function cisaKevUrl(cveId: string): string {
  const url = new URL('https://www.cisa.gov/known-exploited-vulnerabilities-catalog');
  url.searchParams.set('field_cve', cveId);
  return url.href;
}

/**
 * CISA's KEV catalog entries carry no link of their own -- verified against
 * a live capture (tests/fixtures/adapters/cisa-kev.json, trimmed from the
 * live 1665-entry catalog to 30 -- see the task report): the closest thing,
 * `notes`, is unstructured prose that sometimes embeds one or more URLs (an
 * advisory link, a BOD-guidance link, occasionally an NVD link) with no
 * reliable, parseable position or count -- extracting "the" URL from it
 * would be guessing, the same failure mode this codebase's date-parsing
 * goes out of its way to avoid (src/normalize/item.ts). `url` is instead
 * constructed on CISA's OWN domain via `cisaKevUrl` -- see that function's
 * doc comment for exactly which page and why. An earlier version of this
 * mapper pointed here at NVD's per-CVE page instead, the same one nvd-cve
 * below uses -- fix round 1, Finding 1 (see the module doc comment)
 * establishes why that was a bug, not a simplification: the two sources
 * must never resolve to the same host for the same CVE.
 */
function parseCisaKevEntry(rawEntry: unknown): RawItem | null {
  if (!isRecord(rawEntry)) return null;

  const cveId = asString(rawEntry.cveID);
  const title = asString(rawEntry.vulnerabilityName);
  if (isBlank(cveId) || isBlank(title)) return null;

  return {
    url: cisaKevUrl(cveId as string),
    title: title as string,
    // "YYYY-MM-DD", no time component -- passed through exactly as written.
    // normalizeItem's ISO-8601 parser requires an explicit time and offset,
    // so this becomes null at normalization, never a guessed midnight UTC.
    publishedAt: asString(rawEntry.dateAdded),
    summary: asString(rawEntry.shortDescription),
    // No author concept on this feed at all.
    author: null,
    raw: rawEntry,
  };
}

// ---------------------------------------------------------------------------
// nvd-cve -- NVD API 2.0: { vulnerabilities: [{ cve: { id, published, descriptions: [...], ... } }] }
// ---------------------------------------------------------------------------

/**
 * How far back each poll's `lastModStartDate`/`lastModEndDate` window
 * looks. NVD's own documented ceiling for this window is 120 days
 * (verified live: a several-year span 404s).
 *
 * Widened from an original 7 to 90 (fix round 1, Important item) --
 * re-reasoned against actual backoff behavior, not just `poll_interval`
 * directly: `src/db/fetchState.ts`'s backoff ceiling is `max(6h,
 * poll_interval)`, reached after the FIRST failure and never growing, so
 * repeated failures retry roughly every 6h indefinitely -- there is no cap
 * on how many times in a row that can happen. A 7-day window survives
 * about 28 consecutive failed attempts before a gap opens between one
 * successful poll's window and the next's; this is a single-user,
 * self-hosted box with no uptime guarantee, where an outage measured in
 * weeks (vacation, hardware replacement, a stretch of failures against a
 * struggling upstream) is a real, not hypothetical, scenario. 90 days
 * survives roughly 12x that -- comfortably past a month-plus outage --
 * while leaving 30 days of headroom below NVD's 120-day ceiling, the same
 * "not up against it" margin DEFAULT_MAX_BYTES/MAX_BYTES_OVERRIDES
 * (src/fetch/http.ts) already use for their own ceilings. Re-fetching a CVE
 * already seen in an earlier overlapping window is harmless and expected
 * (`parseNvdCveEntry` has no memory of a previous poll and does not need
 * one -- see the module doc comment's "skip vs throw" section and
 * `AdapterResult`'s own docs, src/adapters/types.ts, for how downstream
 * storage is expected to treat a re-seen item), so widening this costs
 * nothing beyond the (bounded, see NVD_MAX_PAGES_PER_POLL below) extra
 * requests pagination already accounts for.
 *
 * One live-verified caveat, discovered investigating THIS widening rather
 * than assumed: window width and per-poll COVERAGE are in real tension,
 * not independent knobs. `totalResults` does not grow smoothly with window
 * width -- verified live (2026-08-14): 1d=1,577, 7d=6,095 (matches the
 * reviewer's own 6,090 finding), 14d=11,043, 30d=24,148, but then 50d=
 * 32,897 jumping to 60d=359,579 and 90d=359,625 -- a single historical
 * bulk-modification event (NVD rescoring roughly 326,700 old CVEs at
 * once, apparently sometime 50-60 days before this was measured) that a
 * window wide enough for outage resilience walks directly into, while a
 * narrower one would have avoided it entirely FOR NOW. Deliberately did
 * NOT shrink the window to dodge this: doing so would overfit to a
 * transient, point-in-time anomaly (it ages out of any fixed window
 * eventually, and a DIFFERENT bulk event could sit at a different offset
 * next time) and defeats the actual, stated purpose of widening in the
 * first place. The resolution is downstream, not here: NVD_MAX_PAGES_PER_POLL
 * bounds the request/byte cost regardless of totalResults, and `capped`
 * (see jsonAdapter.fetch below) honestly reports whatever coverage
 * shortfall results -- large and visible during an anomaly like the one
 * discovered here, small on an ordinary day -- rather than a fixed
 * coverage percentage this design cannot actually promise against an
 * unbounded, source-controlled total. See NVD_MAX_PAGES_PER_POLL's own doc
 * comment for the concrete numbers this produces today.
 */
const NVD_WINDOW_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Fix round 1, Finding 1 (CRITICAL): the ORIGINAL fix for this source (a
 * date-window `buildUrl`, above) verified that the window filter worked,
 * but never checked whether a single, still-unpaginated page could
 * retrieve a meaningful fraction of it. It could not: the configured url's
 * `resultsPerPage=5` capped every response at 5 entries regardless of the
 * window, and NVD's stable default sort (ascending by `lastModified`, tied
 * entries breaking in an unspecified but repeatable order) meant the SAME
 * 5-entry tied block recurred across many consecutive polls -- reviewer
 * live-verified, the exact url this code built returned 5 of 6,090 total
 * results (0.08%), all 5 sharing one exact-millisecond `lastModified` from
 * an NVD bulk-rescore batch. Technically working (real CVE ids, recent
 * timestamps, `skipped: 0`, no errors) and permanently near-useless --
 * indistinguishable, in `AdapterResult`, from a complete poll. The two
 * constants below, and `nvdNextPageUrl`/`nvdTotalAvailable`'s registration
 * in `JsonSourceMapper.paginate` further down, are the fix: retrieve more
 * than one page per poll, bounded, and report what's left uncovered via
 * `AdapterResult.capped` rather than leaving it silent.
 *
 * `NVD_RESULTS_PER_PAGE = 200`: live-verified (2026-08-14) against the
 * exact window/query this code builds -- 200 entries measured 467,442
 * bytes (~456 KB), comfortably under `politeFetch`'s 5 MiB default ceiling
 * (nvd-cve has no `MAX_BYTES_OVERRIDES` entry, src/fetch/http.ts, and does
 * not need one at this page size). Sized for headroom beyond today's
 * measurement, not just today's number: the reviewer separately found
 * `resultsPerPage=2000` exceeding 25 MB in a DIFFERENT window (a
 * bulk-rescore batch's entries apparently carry unusually heavy multi-source
 * CVSS metrics) -- averaging ~12.5 KB/entry worst-case, 200 entries is
 * ~2.5 MB, still comfortably under 5 MiB (2x margin) even under that
 * heavier assumption, not just under today's lighter ~2.3 KB/entry
 * average. `resultsPerPage=2000` was not chosen at any size specifically
 * to chase maximum throughput -- see `NVD_MAX_PAGES_PER_POLL` below for why
 * a bigger page size would not meaningfully change the actual coverage
 * problem anyway.
 *
 * `NVD_MAX_PAGES_PER_POLL = 5`: chosen to equal, not exceed, NVD's own
 * publicly documented unauthenticated rate guidance (5 requests per 30s;
 * see docs/costs.md) -- a full-throttle poll (5 pages, each spaced by
 * politeFetch's own default 2s per-host minimum interval) completes its
 * whole burst within about 8-10 seconds, safely inside a single 30s
 * window, by construction rather than by tuning a custom interval. This
 * bounds one poll to 5 requests / up to 1,000 entries, REGARDLESS of
 * `totalResults` -- on a quiet day (a few thousand modified, see
 * NVD_WINDOW_DAYS's own doc comment for real measured totals well under
 * this) that is strong, often complete, coverage; during a bulk-rescore
 * anomaly like the one discovered widening the window above (hundreds of
 * thousands), it is a small fraction. Both are correct, expected
 * behavior for a fixed per-poll budget against an unbounded, source-
 * controlled total -- `capped` (jsonAdapter.fetch below) is what makes
 * either case visible on a source-health page rather than indistinguishable
 * from each other or from a fully complete poll.
 */
const NVD_RESULTS_PER_PAGE = 200;
const NVD_MAX_PAGES_PER_POLL = 5;

/**
 * NVD's CVE API 2.0, with no date filter, sorts ascending from the very
 * start of its entire catalog rather than by recency -- verified live and
 * against this file's own fixture (tests/fixtures/adapters/nvd-cve.json):
 * its first entry is CVE-1999-0095, published 1988-10-01. Every poll of an
 * unfiltered query returns that same ancient handful, forever --
 * technically "working," permanently useless, and under append-only
 * storage a source of repeated inserts of the same 1980s records.
 * `lastModStartDate`/`lastModEndDate` is NVD's own documented recency
 * filter and fixes this (verified live: a wide window against the real API
 * returns thousands of genuinely current results, not the 1988-era
 * handful) -- but the window has to be computed relative to "now" at
 * request time, which a static config url can never express. This is the
 * one registered `buildUrl` today -- see `JsonSourceMapper`'s doc comment
 * (module-level, above) for the general mechanism.
 *
 * Also sets `resultsPerPage`/`startIndex` explicitly, UNCONDITIONALLY
 * overwriting whatever the configured url carries (fix round 1: the
 * configured url previously carried its own `?resultsPerPage=5`, which is
 * exactly Finding 1's defect -- see NVD_RESULTS_PER_PAGE's own doc comment
 * just above). These two values are now entirely code-owned rather than
 * config-owned, on purpose: `nvdNextPageUrl` below increments `startIndex`
 * by exactly `NVD_RESULTS_PER_PAGE` and decides "was this page short" by
 * comparing an entry count against that SAME constant -- if the actual
 * requested page size could silently drift out of sync with what
 * `nvdNextPageUrl` assumes (e.g. someone editing `config/sources.yaml`'s
 * url without knowing this code hardcodes a page size), pagination would
 * misbehave in a way neither file's own diff would make obvious. Fixing
 * both at this one call site, always applied regardless of what the
 * configured url happens to contain, removes that whole class of drift.
 *
 * Built with `URL`/`searchParams.set` -- the same reason `cisaKevUrl` above
 * uses it over string interpolation -- so any OTHER query param already on
 * the configured url survives untouched; this only adds/overwrites these
 * four params. The resulting percent-encoded ISO-8601 date values
 * (`searchParams.set` escapes the colons) were verified live to be
 * accepted identically to an unencoded form -- NVD decodes the query
 * string normally, as any compliant server would.
 *
 * Uses `now` (and `now` minus `NVD_WINDOW_DAYS`) exactly as given -- never
 * reads the clock itself, see `JsonSourceMapper.buildUrl`'s doc comment for
 * why. `toISOString()` always renders in UTC regardless of the host's own
 * configured zone (verified live that NVD accepts exactly this
 * "Z"-suffixed form), so this needs no timezone handling of its own --
 * consistent with this project's portability rule against ever deriving
 * behavior from the system timezone (CLAUDE.md §12).
 */
function nvdCveUrl(configuredUrl: string, now: Date): string {
  const url = new URL(configuredUrl);
  const windowStart = new Date(now.getTime() - NVD_WINDOW_DAYS * MS_PER_DAY);
  url.searchParams.set('lastModStartDate', windowStart.toISOString());
  url.searchParams.set('lastModEndDate', now.toISOString());
  url.searchParams.set('resultsPerPage', String(NVD_RESULTS_PER_PAGE));
  url.searchParams.set('startIndex', '0');
  return url.href;
}

/**
 * `JsonSourceMapper.paginate.nextPageUrl` for nvd-cve. A page shorter than
 * `NVD_RESULTS_PER_PAGE` (verified live: this holds even for the very last
 * page of a result set, which is simply whatever remains) means there is
 * nothing left to fetch -- `entriesOnThisPage` is the RAW count `jsonAdapter.
 * fetch` passes in, before `parseEntry` dropped any malformed ones, so a
 * page that was full-sized but contained a few unparseable entries is
 * still correctly treated as full, not short. Otherwise increments
 * `startIndex` by exactly one page's worth on the SAME url, leaving every
 * other param (including the date window, fixed for this whole poll) untouched
 * -- verified live that consecutive `startIndex` pages return disjoint,
 * sequential entries with a stable `totalResults` across pages.
 */
function nvdNextPageUrl(currentPageUrl: string, entriesOnThisPage: number): string | null {
  if (entriesOnThisPage < NVD_RESULTS_PER_PAGE) return null;
  const url = new URL(currentPageUrl);
  const currentStartIndex = Number(url.searchParams.get('startIndex') ?? '0');
  url.searchParams.set('startIndex', String(currentStartIndex + NVD_RESULTS_PER_PAGE));
  return url.href;
}

/**
 * `JsonSourceMapper.paginate.totalAvailable` for nvd-cve. Reads NVD's own
 * `totalResults` envelope field -- present on every live response observed
 * (including error-free empty results) -- for `AdapterResult.capped`
 * ONLY, never for loop control (`nvdNextPageUrl` above decides that on its
 * own). `null` for anything not shaped like a number, so a malformed or
 * missing field degrades to "capped is not reported" (see
 * `AdapterResult.capped`'s own doc comment, src/adapters/types.ts, on why
 * that is the correct default over fabricating a number).
 */
function nvdTotalAvailable(parsedEnvelope: unknown): number | null {
  if (!isRecord(parsedEnvelope)) return null;
  const total = parsedEnvelope.totalResults;
  return typeof total === 'number' ? total : null;
}

/**
 * NVD's CVE Schema 2.0 has no headline/title field at all (verified: none
 * of the 5 live entries in the fixture carry one, and the schema doesn't
 * define one) -- the CVE id itself is the only thing every entry is
 * guaranteed to have that identifies it at a glance, so it doubles as
 * `title`. `url` is NVD's own per-CVE detail page
 * (`https://nvd.nist.gov/vuln/detail/<id>`) -- genuinely first-party here
 * (the id used to build it and the page it points to share the same
 * authority), and confirmed against the live fixture that no entry in
 * `references` already points there, so constructing it duplicates nothing
 * NVD itself would rather have linked instead.
 *
 * Deliberately NOT the same construction cisa-kev uses below, despite both
 * needing to construct a url for the same underlying reason -- fix round 1,
 * Finding 1 (see the module doc comment) found that sharing this convention
 * was a real bug, not a harmless simplification: `cisaKevUrl`'s doc comment
 * has the detail.
 */
function parseNvdCveEntry(rawEntry: unknown): RawItem | null {
  if (!isRecord(rawEntry)) return null;

  const cve = rawEntry.cve;
  if (!isRecord(cve)) return null;

  const id = asString(cve.id);
  if (isBlank(id)) return null;

  const descriptions: unknown[] = Array.isArray(cve.descriptions) ? cve.descriptions : [];
  const englishDescription = descriptions.find(
    (d): d is Record<string, unknown> => isRecord(d) && d.lang === 'en',
  );

  return {
    url: `https://nvd.nist.gov/vuln/detail/${id}`,
    title: id as string,
    // e.g. "1988-10-01T04:00:00.000" -- NVD omits any UTC offset or "Z" on
    // this field, which normalizeItem's ISO-8601 parser deliberately
    // refuses to interpret (an offset-less date-time is only meaningful
    // relative to a local clock, and this is a self-hosted server that
    // could run in any zone), so this becomes null at normalization.
    // Passed through verbatim regardless -- interpreting it is not this
    // layer's job.
    publishedAt: asString(cve.published),
    summary: englishDescription ? asString(englishDescription.value) : null,
    author: null,
    raw: rawEntry,
  };
}

// ---------------------------------------------------------------------------
// hn-algolia -- { hits: [{ objectID, title, url, author, created_at, story_text, ... }] }
// ---------------------------------------------------------------------------

/**
 * Most stories carry their own `url`; a text post (Ask HN, a poll, a
 * text-only Show HN) legitimately has `url: null` and only a discussion
 * page, at the conventional
 * `https://news.ycombinator.com/item?id=<objectID>` -- the same address
 * HN's own "N comments" link points to. Falling back to it (rather than
 * dropping the entry) keeps a genuine, well-formed HN story rather than
 * discarding it for a reason `RawItem`'s own shape doesn't require. The
 * live fixture's 10 hits all happen to carry `url` (verified), so this
 * fallback path is exercised by a synthetic entry in the test file, not by
 * the captured fixture -- noted in the task report.
 */
function parseHnAlgoliaEntry(rawEntry: unknown): RawItem | null {
  if (!isRecord(rawEntry)) return null;

  const title = asString(rawEntry.title);
  if (isBlank(title)) return null;

  const directUrl = asString(rawEntry.url);
  const objectId = asString(rawEntry.objectID);
  const url = !isBlank(directUrl)
    ? directUrl
    : !isBlank(objectId)
      ? `https://news.ycombinator.com/item?id=${objectId}`
      : null;
  if (isBlank(url)) return null;

  return {
    url: url as string,
    title: title as string,
    // ISO-8601 with an explicit "Z" -- normalizeItem parses this natively.
    // (Algolia also exposes `created_at_i`, the same instant as epoch
    // seconds; `created_at` is preferred as the more directly verifiable of
    // the two and is never absent on any hit this API returns.)
    publishedAt: asString(rawEntry.created_at),
    // Ask-HN-style text posts carry their body here; link posts have none.
    summary: asString(rawEntry.story_text),
    author: asString(rawEntry.author),
    raw: rawEntry,
  };
}

// ---------------------------------------------------------------------------
// federal-register -- { results: [{ title, html_url, publication_date, abstract, agencies: [...], ... }] }
// ---------------------------------------------------------------------------

/**
 * `html_url` is the Federal Register's own canonical per-document page --
 * present on every one of the live fixture's 5 results, and, per the API's
 * own documentation, always populated. No `author` concept is extracted: a
 * Federal Register document belongs to an issuing agency, not a byline, and
 * `agencies[0].name` would be a different KIND of fact (an organization,
 * often more than one, not a person) than every other mapper's `author`
 * field means here -- left `null` rather than guessed at.
 */
function parseFederalRegisterEntry(rawEntry: unknown): RawItem | null {
  if (!isRecord(rawEntry)) return null;

  const url = asString(rawEntry.html_url);
  const title = asString(rawEntry.title);
  if (isBlank(url) || isBlank(title)) return null;

  return {
    url: url as string,
    title: title as string,
    // "YYYY-MM-DD" -- same shape and the same fate at normalization as
    // cisa-kev's dateAdded above.
    publishedAt: asString(rawEntry.publication_date),
    summary: asString(rawEntry.abstract),
    author: null,
    raw: rawEntry,
  };
}

// ---------------------------------------------------------------------------
// nws-fl-alerts -- GeoJSON: { features: [{ id, properties: { headline, event, sent, description, senderName, ... } }] }
// ---------------------------------------------------------------------------

/**
 * A GeoJSON Feature's top-level `id` on api.weather.gov is itself the
 * absolute, dereferenceable API URL for that specific alert (verified
 * against every one of the 15 live features:
 * `"https://api.weather.gov/alerts/urn:oid:..."`), not merely an opaque
 * identifier -- so it doubles as `url` the same way NVD's per-CVE page does
 * above, except here it needs no construction at all: it already IS one.
 *
 * `headline` is NWS's own human-authored summary line (e.g. "Special
 * Weather Statement issued August 13 at 5:04PM EDT by NWS Jacksonville FL")
 * and is what every one of the 15 live features carries; `event` (the alert
 * type alone, e.g. "Heat Advisory") is the fallback for the rarer alert
 * that OMITS OR BLANKS it -- both fields are part of the CAP spec this API
 * implements. An alert with genuinely neither is skipped rather than titled
 * with nothing. Same fallback shape, same reason, for `sent`/`effective`.
 *
 * Fix round 1, Finding 2: both fallbacks originally used `??` directly
 * (`asString(properties.headline) ?? asString(properties.event)`), which
 * only falls through on `null`/`undefined` -- a present-but-EMPTY string
 * survives `??` unchanged and never reaches the fallback. `firstNonBlank`
 * (above) closes that gap for both fields.
 */
function parseNwsFlAlertEntry(rawEntry: unknown): RawItem | null {
  if (!isRecord(rawEntry)) return null;

  const url = asString(rawEntry.id);
  if (isBlank(url)) return null;

  const properties = isRecord(rawEntry.properties) ? rawEntry.properties : {};
  const title = firstNonBlank(asString(properties.headline), asString(properties.event));
  if (isBlank(title)) return null;

  return {
    url: url as string,
    title: title as string,
    // ISO-8601 with an explicit numeric offset (e.g. "-04:00") --
    // normalizeItem parses this natively.
    publishedAt: firstNonBlank(asString(properties.sent), asString(properties.effective)),
    summary: asString(properties.description),
    // The issuing forecast office, e.g. "NWS Jacksonville FL" -- the
    // closest CAP concept to a byline this feed has.
    author: asString(properties.senderName),
    raw: rawEntry,
  };
}

// ---------------------------------------------------------------------------
// The registry itself.
// ---------------------------------------------------------------------------

const JSON_SOURCE_MAPPERS: Record<string, JsonSourceMapper> = {
  'cisa-kev': { extractEntries: extractArrayField('vulnerabilities'), parseEntry: parseCisaKevEntry },
  'nvd-cve': {
    extractEntries: extractArrayField('vulnerabilities'),
    parseEntry: parseNvdCveEntry,
    buildUrl: nvdCveUrl,
    paginate: {
      maxPages: NVD_MAX_PAGES_PER_POLL,
      nextPageUrl: nvdNextPageUrl,
      totalAvailable: nvdTotalAvailable,
    },
  },
  'hn-algolia': { extractEntries: extractArrayField('hits'), parseEntry: parseHnAlgoliaEntry },
  'federal-register': { extractEntries: extractArrayField('results'), parseEntry: parseFederalRegisterEntry },
  'nws-fl-alerts': { extractEntries: extractArrayField('features'), parseEntry: parseNwsFlAlertEntry },
};

// ---------------------------------------------------------------------------
// Top-level: dispatch on source id, fetch, parse the body.
// ---------------------------------------------------------------------------

/**
 * `ParseEntriesResult` (items/skipped) plus the two extra pieces of
 * information the PAGINATED path below needs that the single-page path
 * doesn't: the envelope itself (so `JsonSourceMapper.paginate.totalAvailable`
 * can read a field like `totalResults` off it without re-parsing the same
 * body a second time) and the RAW entry count for this one page, before
 * `parseEntries` dropped any malformed ones (so pagination can tell "a full
 * page" from "the last, short page," and so `capped` can count "entries we
 * actually retrieved" -- successfully parsed or not -- rather than only the
 * ones that survived). A plain, non-exported, local type: `ParseEntriesResult`
 * itself (types.ts) stays exactly what every other adapter already relies
 * on, unchanged.
 */
interface ParsedJsonPage extends ParseEntriesResult {
  parsedBody: unknown;
  entriesOnThisPage: number;
}

function parseJsonBody(
  body: string,
  sourceUrl: string,
  sourceId: string,
  mapper: JsonSourceMapper,
): ParsedJsonPage {
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch (cause) {
    throw new JsonParseError(sourceUrl, sourceId, `body is not valid JSON: ${(cause as Error).message}`, {
      cause,
    });
  }

  const entries = mapper.extractEntries(parsedBody, sourceUrl, sourceId);
  const { items, skipped } = parseEntries(entries, mapper.parseEntry);
  return { items, skipped, parsedBody, entriesOnThisPage: entries.length };
}

export const jsonAdapter: Adapter = {
  type: 'json',

  // `now` defaults to the real current time, so every production caller
  // (the scheduler, threading its own single validated instant through
  // Adapter.fetch's now-optional third parameter -- see that interface's
  // doc comment, types.ts) gets a real, current-instant window with zero
  // special-casing, while a test can pass a fixed Date directly for a fully
  // deterministic assertion on the exact url(s) requested.
  async fetch(source: Source, state: FetchState | null, now: Date = new Date()): Promise<AdapterResult> {
    // Dispatch first, before any network call -- see UnknownJsonSourceError.
    const mapper = JSON_SOURCE_MAPPERS[source.id];
    if (!mapper) throw new UnknownJsonSourceError(source.id);

    // Per-source url construction -- see `JsonSourceMapper.buildUrl`'s doc
    // comment above. Absent for four of the five registered sources, which
    // fetch `source.url` exactly as configured, byte-for-byte unchanged
    // from before this field existed.
    const firstUrl = mapper.buildUrl ? mapper.buildUrl(source.url, now) : source.url;

    const firstFetch: FetchResult = await politeFetch(firstUrl, {
      etag: state?.etag ?? undefined,
      lastModified: state?.lastModified ?? undefined,
    });

    if (firstFetch.notModified) return notModifiedResult(firstFetch, state);

    if (firstFetch.body === null) {
      // politeFetch's contract guarantees a non-null body whenever
      // notModified is false (null only ever accompanies a 304, handled
      // above) -- this asserts that contract rather than silently treating
      // an impossible state as an empty document.
      throw new JsonParseError(firstUrl, source.id, 'politeFetch returned a null body for a non-304 response');
    }

    if (!mapper.paginate) {
      // Four of five sources: unchanged from before pagination existed --
      // one request, one parse, done.
      const parsed = parseJsonBody(firstFetch.body, firstUrl, source.id, mapper);
      return fetchedResult(firstFetch, parsed);
    }

    // ---------------------------------------------------------------------
    // Paginated path -- nvd-cve today (see JsonSourceMapper.paginate's doc
    // comment above for the general mechanism, and nvdNextPageUrl/
    // nvdTotalAvailable/NVD_MAX_PAGES_PER_POLL below for nvd-cve's own
    // policy). Bounded strictly by maxPages regardless of what nextPageUrl
    // or the source's own reported total says -- one poll can never turn
    // into more than that many requests or run past that many round-trips,
    // no matter how large the backlog behind it is.
    // ---------------------------------------------------------------------
    const { maxPages, nextPageUrl, totalAvailable } = mapper.paginate;

    const items: RawItem[] = [];
    let skipped = 0;
    let entriesSeen = 0;
    let available: number | null = null;
    // `url`/`fetchResult` always describe the SAME page as each other --
    // reassigned together, at the bottom of the loop, before the next
    // iteration processes them. Explicit `: string` (not `string | null`)
    // on `url` deliberately: the loop's own `break`s are what end iteration
    // when there is no next page, never a null sentinel threaded back
    // through this variable -- simpler for the type checker to follow
    // across loop iterations, and simpler to read.
    let url: string = firstUrl;
    let fetchResult: FetchResult = firstFetch;

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      if (fetchResult.body === null) {
        throw new JsonParseError(url, source.id, 'politeFetch returned a null body for a non-304 response');
      }

      const page = parseJsonBody(fetchResult.body, url, source.id, mapper);
      items.push(...page.items);
      skipped += page.skipped;
      entriesSeen += page.entriesOnThisPage;
      // Later pages of the SAME query report the same total in practice
      // (verified live), but if one page's envelope is missing/malformed
      // where an earlier one wasn't, keep the last known-good reading
      // rather than losing it to a single page's absence.
      available = totalAvailable(page.parsedBody) ?? available;

      if (pageNum >= maxPages) break; // hard ceiling reached -- stop regardless of nextPageUrl's own opinion

      const next: string | null = nextPageUrl(url, page.entriesOnThisPage);
      if (next === null) break; // a short page -- nothing left to fetch

      url = next;
      // Page 2+ carries no conditional-request validators. `state`'s
      // etag/lastModified describes a prior poll's PAGE-1-EQUIVALENT
      // identity (the same url this poll's own page 1 was conditionally
      // requested against) -- it was never issued for, and has no
      // "unchanged since" meaning against, a DIFFERENT page. An
      // unconditional GET here is the only correct request, not a
      // politeness shortcut being skipped.
      fetchResult = await politeFetch(url, {});
    }

    return {
      items,
      etag: firstFetch.etag,
      lastModified: firstFetch.lastModified,
      notModified: false,
      skipped,
      // Never fabricated: undefined unless the source's own reported total
      // was legible AND genuinely exceeds what this poll actually
      // retrieved (parsed or not) -- see AdapterResult.capped's own doc
      // comment (types.ts) for why "undefined, not 0, when there is
      // nothing to report" is the shared rule across every adapter that
      // sets this field.
      capped: available !== null && available > entriesSeen ? available - entriesSeen : undefined,
    };
  },
};
