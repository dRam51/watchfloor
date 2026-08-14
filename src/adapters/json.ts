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
   * (config/sources.yaml, verbatim -- whatever query params it already
   * carries, e.g. nvd-cve's own `?resultsPerPage=5`) and the current
   * instant, and returns the url this poll should actually request. Absent
   * for four of the five sources registered below, which have no reason to
   * vary their request across polls -- those fetch `source.url` completely
   * unchanged, exactly as every JSON source did before this field existed.
   *
   * Deliberately NOT a templating language, a query-string DSL, or a
   * general per-source config hook -- it is one plain function, taking the
   * two inputs a source's per-poll url could ever need with the state this
   * adapter already has in hand (no cursor, no page token, nothing else is
   * threaded through `parseJsonBody` or persisted between polls). A source
   * that genuinely needed more than "the configured url plus the current
   * time" -- a cursor from the previous response, say -- would need a
   * different mechanism than this, not a bigger one wedged into this shape.
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
 * (verified live: a several-year span 404s) -- 7 is nowhere near that
 * ceiling, chosen instead against this source's own `poll_interval` (3h,
 * config/sources.yaml): more than 50x that cadence is generous enough that
 * a source sitting un-polled for a while (a missed cycle, a stretch of
 * consecutive-failure backoff) does not open a gap between one successful
 * poll's window and the next's. A CVE modified more than once inside two
 * overlapping windows is simply re-fetched -- `parseNvdCveEntry` below has
 * no memory of a previous poll and does not need one; see the module doc
 * comment's "skip vs throw" section and `AdapterResult`'s own docs
 * (src/adapters/types.ts) for how downstream storage is expected to treat
 * a re-seen item.
 */
const NVD_WINDOW_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * NVD's CVE API 2.0, with no date filter, sorts ascending from the very
 * start of its entire catalog rather than by recency -- verified live and
 * against this file's own fixture (tests/fixtures/adapters/nvd-cve.json):
 * its first entry is CVE-1999-0095, published 1988-10-01. Every poll of an
 * unfiltered query returns that same ancient handful, forever --
 * technically "working," permanently useless, and under append-only
 * storage a source of repeated inserts of the same 1980s records.
 * `lastModStartDate`/`lastModEndDate` is NVD's own documented recency
 * filter and fixes this (verified live: a 7-day window against the real
 * API returns thousands of genuinely current results, not the 1988-era
 * handful) -- but the window has to be computed relative to "now" at
 * request time, which a static config url can never express. This is the
 * one registered `buildUrl` today -- see `JsonSourceMapper`'s doc comment
 * (module-level, above) for the general mechanism.
 *
 * Built with `URL`/`searchParams.set` -- the same reason `cisaKevUrl` above
 * uses it over string interpolation -- so any query param already on the
 * CONFIGURED url (e.g. nvd-cve's own `?resultsPerPage=5`) survives
 * untouched; this only adds/overwrites the two date-window params. The
 * resulting percent-encoded ISO-8601 values (`searchParams.set` escapes the
 * colons) were verified live to be accepted identically to an unencoded
 * form -- NVD decodes the query string normally, as any compliant server
 * would.
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
  return url.href;
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
  },
  'hn-algolia': { extractEntries: extractArrayField('hits'), parseEntry: parseHnAlgoliaEntry },
  'federal-register': { extractEntries: extractArrayField('results'), parseEntry: parseFederalRegisterEntry },
  'nws-fl-alerts': { extractEntries: extractArrayField('features'), parseEntry: parseNwsFlAlertEntry },
};

// ---------------------------------------------------------------------------
// Top-level: dispatch on source id, fetch, parse the body.
// ---------------------------------------------------------------------------

function parseJsonBody(
  body: string,
  sourceUrl: string,
  sourceId: string,
  mapper: JsonSourceMapper,
): ParseEntriesResult {
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch (cause) {
    throw new JsonParseError(sourceUrl, sourceId, `body is not valid JSON: ${(cause as Error).message}`, {
      cause,
    });
  }

  const entries = mapper.extractEntries(parsedBody, sourceUrl, sourceId);
  return parseEntries(entries, mapper.parseEntry);
}

// Not annotated `: Adapter` (compare rss.ts/newsSitemap.ts/googleNews.ts,
// which all use that plain annotation) -- deliberately `satisfies Adapter`
// instead. An explicit `: Adapter` annotation would WIDEN this object's own
// static type down to exactly the `Adapter` interface, which only declares
// a 2-parameter `fetch(source, state)` -- erasing the third `now` parameter
// below from anything a direct importer (this file's own tests) could
// legally pass, even though the interface itself is never touched and
// every existing consumer (src/bin/scheduler.ts, calling through
// `AdapterRegistry`/`Adapter`) keeps working unchanged: a function with an
// extra optional/defaulted parameter is still structurally assignable
// anywhere a shorter function type is expected. `satisfies` checks this
// object against `Adapter` at THIS declaration (a real `type: 'json'`
// typo, or a `fetch` genuinely incompatible with `Adapter`, still fails to
// compile right here) while preserving the wider, more specific inferred
// type on the `jsonAdapter` binding itself.
export const jsonAdapter = {
  type: 'json',

  async fetch(source: Source, state: FetchState | null, now: Date = new Date()): Promise<AdapterResult> {
    // Dispatch first, before any network call -- see UnknownJsonSourceError.
    const mapper = JSON_SOURCE_MAPPERS[source.id];
    if (!mapper) throw new UnknownJsonSourceError(source.id);

    // Per-source url construction -- see `JsonSourceMapper.buildUrl`'s doc
    // comment above. Absent for four of the five registered sources, which
    // fetch `source.url` exactly as configured, byte-for-byte unchanged
    // from before this field existed. `now` is read exactly once for this
    // whole fetch -- as this method's own defaulted parameter, never inside
    // a builder -- so every production caller (the scheduler, calling
    // `fetch(source, state)` with no third argument) gets a real,
    // current-instant window with zero code changes, while a test can pass
    // a fixed `Date` as the third argument for a fully deterministic
    // assertion on the exact url requested.
    const fetchUrl = mapper.buildUrl ? mapper.buildUrl(source.url, now) : source.url;

    const fetchResult: FetchResult = await politeFetch(fetchUrl, {
      etag: state?.etag ?? undefined,
      lastModified: state?.lastModified ?? undefined,
    });

    if (fetchResult.notModified) return notModifiedResult(fetchResult, state);

    if (fetchResult.body === null) {
      // politeFetch's contract guarantees a non-null body whenever
      // notModified is false (null only ever accompanies a 304, handled
      // above) -- this asserts that contract rather than silently treating
      // an impossible state as an empty document.
      throw new JsonParseError(fetchUrl, source.id, 'politeFetch returned a null body for a non-304 response');
    }

    const parsed = parseJsonBody(fetchResult.body, fetchUrl, source.id, mapper);
    return fetchedResult(fetchResult, parsed);
  },
} satisfies Adapter;
