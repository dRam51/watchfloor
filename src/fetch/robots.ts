/**
 * robots.txt gate -- decides whether Watchfloor is permitted to fetch a
 * given path from a given origin.
 *
 * **This module is a safety gate, not a convenience** (task-5 brief). A bug
 * that wrongly returns "allowed" makes this system do something a publisher
 * explicitly asked it not to; a bug that wrongly returns "denied" only costs
 * us a source. Those are not equally bad, and every decision below that
 * turns on that asymmetry is called out where it's made.
 *
 * `isAllowed` is a pure function -- no I/O, deterministic on its inputs --
 * so it is exhaustively tested against real, checked-in AP and Reuters
 * fixtures with no network at test time. `fetchRobots` is the only I/O in
 * the module, kept deliberately thin: fetch, classify the outcome, cache
 * successes for 24h.
 */

// The identity this system presents on the wire, imported directly from
// src/fetch/http.ts -- the module that actually sends it on every content
// fetch. Fix round 1, Finding 4: this used to be an independent literal
// (ROBOTS_USER_AGENT), justified at the time because http.ts was being
// actively rewritten by a concurrently-running task and importing it would
// have coupled this module to unsettled state. That file is now complete
// and stable, so the constraint that justified the duplication is gone --
// and the duplication itself was a live consent risk, not just untidiness:
// evaluating robots.txt rules against one identity while presenting a
// DIFFERENT one to the server means the gate's answer might not describe
// the request that's actually sent. Importing the single real constant
// (used below both as the fetch header and as PRODUCT_TOKEN's source)
// makes that drift structurally impossible instead of policed by hand.
import { USER_AGENT } from './http.ts';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Directive = 'allow' | 'disallow';

interface Rule {
  readonly type: Directive;
  /** Raw directive value from the file, e.g. "/api/v2/feed/" or "/*.rss" --
   * its character length (before wildcard expansion) is what "longest
   * match wins" measures. */
  readonly pattern: string;
  readonly regex: RegExp;
}

interface Group {
  /** User-agent product tokens this group applies to, as written in the
   * file. Comparisons lowercase both sides at match time. */
  readonly agents: string[];
  readonly rules: Rule[];
}

/** Escapes every regex metacharacter except `*`, which the caller expands separately. */
function escapeLiteral(segment: string): string {
  return segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles a robots.txt path pattern into a RegExp implementing the
 * standard matching rules (Google's documented behavior, mirrored by RFC
 * 9309):
 *  - the pattern always anchors at the START of the path -- robots.txt
 *    rules are prefix rules unless `$`-anchored;
 *  - `*` matches any run of characters, including none;
 *  - a trailing, unescaped `$` anchors the match to the END of the path too
 *    -- anywhere else in the pattern, `$` is just a literal character.
 *
 * Deliberately a TOTAL function: every string, however unusual, compiles to
 * *some* regex. There is no "unsupported syntax" branch that would force a
 * judgment call between silently dropping a rule (a swing toward ALLOW) or
 * guessing at one (a swing either way with no way to be confident which).
 * Making the matcher total removes that class of parser uncertainty rather
 * than resolving it case by case.
 */
function compilePattern(pattern: string): RegExp {
  const endAnchored = pattern.endsWith('$');
  const body = endAnchored ? pattern.slice(0, -1) : pattern;
  const source = '^' + body.split('*').map(escapeLiteral).join('.*') + (endAnchored ? '$' : '');
  return new RegExp(source);
}

/**
 * Removes a single leading UTF-8 BOM (U+FEFF), occasionally emitted by the
 * tools that generate or hand-edit a robots.txt file. Left in place it
 * would corrupt the FIRST field name on the first line (the raw text would
 * start with U+FEFF followed by "user-agent", which is not the same string
 * as plain "user-agent"), so no group ever starts, so every rule that
 * follows has nothing to attach to -- a whole-file fail-open, the worst
 * direction this module can fail in.
 *
 * Exported, and unit-tested directly against its own input/output, rather
 * than only indirectly through an `isAllowed` outcome (fix round 2, bundled
 * minor). That distinction is load-bearing here, not a style preference:
 * per-line `.trim()` inside `parseGroups` already strips a leading U+FEFF
 * as an incidental side effect of stripping whitespace generally (it's
 * part of the ECMAScript `WhiteSpace` grammar), and since BOM only ever
 * realistically appears at the very start of a file -- which always becomes
 * the start of the first split line -- that incidental coverage exactly
 * overlaps what this function targets. Concretely: no `isAllowed` input
 * exists for which calling this function differs from skipping it, because
 * `.trim()` on the first line always produces the identical result either
 * way (verified). A black-box test through `isAllowed` therefore CANNOT
 * distinguish "this function ran" from "it didn't, and `.trim()` covered
 * for it" -- it would only ever pin an outcome, not this specific
 * mechanism, which is exactly the gap fix round 2 flagged. Testing this
 * function directly is the only way to pin that the explicit strip itself
 * is present and correct, independent of whether `.trim()`'s incidental
 * coverage continues to overlap it.
 */
export function stripLeadingBom(text: string): string {
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}

/**
 * Splits a robots.txt body into User-agent groups.
 *
 * Group boundaries follow the same state machine every widely-deployed
 * robots.txt parser uses: a run of one or more consecutive `User-agent`
 * lines names the group (Reuters' allowlist leans on exactly this -- ~90
 * agent lines in a row share one rule set); the first `Allow`/`Disallow`
 * line after that run closes the agent list, so the next `User-agent` line
 * starts a NEW group rather than extending this one. Everything else --
 * `Sitemap`, `Crawl-delay`, comments, unknown extensions -- is inert: it
 * neither closes the current group nor attaches to one, so it can never
 * merge or split groups it has no business affecting. That is what makes
 * AP's and Reuters' trailing `Sitemap:`/`SITEMAP:` blocks safe to ignore
 * outright rather than something that has to be parsed correctly to skip.
 *
 * An empty-value `Allow`/`Disallow` (AP's opening bare `Disallow:`) still
 * closes the agent-listing run -- it IS a rule line, syntactically, even
 * though it contributes no matchable rule (see below) -- but is not pushed
 * into the group's rule list. Naively treating an empty pattern as an
 * ordinary prefix rule would be actively backwards: every path "starts
 * with" the empty string, so it would match everything at the shortest
 * possible length, only ever winning when nothing more specific applies --
 * and since it's a Disallow, that would flip AP's documented "allow
 * everything, then these exceptions" into "deny everything not otherwise
 * allowed". Dropping it instead and relying on isAllowed's own
 * nothing-matched-in-group default (allow) reproduces the correct meaning
 * with no special case needed at match time.
 *
 * A leading UTF-8 BOM (U+FEFF), occasionally emitted by the tools that
 * generate or hand-edit a robots.txt file, is stripped explicitly via
 * `stripLeadingBom` before anything else -- see that function's own doc
 * comment for why this has to be a separately, directly testable unit
 * rather than only an outcome asserted through `isAllowed`.
 */
function parseGroups(robotsTxt: string): Group[] {
  const text = stripLeadingBom(robotsTxt);

  const groups: Group[] = [];
  let current: Group | null = null;
  let inRules = false;

  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = (raw.split('#')[0] ?? '').trim();
    if (line === '') continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue; // not a "field: value" line at all -- nothing to interpret

    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (value === '') continue; // nameless agent -- nothing to attach rules to
      if (current && !inRules) {
        current.agents.push(value);
      } else {
        current = { agents: [value], rules: [] };
        groups.push(current);
        inRules = false;
      }
      continue;
    }

    if (field === 'allow' || field === 'disallow') {
      if (!current) continue; // a rule with no preceding User-agent -- nothing to attach to
      inRules = true; // closes the agent-listing run regardless of value, see doc comment
      if (value === '') continue; // e.g. AP's opening "Disallow:" -- see doc comment
      current.rules.push({ type: field, pattern: value, regex: compilePattern(value) });
      continue;
    }

    // Sitemap, Crawl-delay, Host, and any other extension: intentionally ignored.
  }

  return groups;
}

/**
 * Resolves which group governs `userAgent`: the most specific named match
 * wins, matched by case-insensitive product-token PREFIX (so a group for
 * "GPTBot" also matches a caller passing the fuller "GPTBot/1.1" -- the
 * standard robots.txt product-token semantics). If more than one group
 * names the same agent, their rules are combined (RFC 9309). Falls back to
 * the `*` group -- likewise combined across every `*` group in the file,
 * not just the first one found (fix round 1, Finding 2: a second, separate
 * `User-agent: *` block -- a realistic shape for a generated or
 * plugin-appended file -- was silently dropped by an earlier `.find()`,
 * even though the named-agent branch right above already unions correctly.
 * Rules present in the file being ignored is exactly the wrong failure
 * direction for a safety gate). Returns null if no group matches at all.
 */
function resolveGroup(groups: Group[], userAgent: string): Group | null {
  const needle = userAgent.toLowerCase();
  const named = groups.filter((g) =>
    g.agents.some((agent) => agent !== '*' && needle.startsWith(agent.toLowerCase())),
  );
  if (named.length > 0) {
    return { agents: [userAgent], rules: named.flatMap((g) => g.rules) };
  }
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  return wildcard.length > 0 ? { agents: ['*'], rules: wildcard.flatMap((g) => g.rules) } : null;
}

/**
 * Thrown by `isAllowed` when `path` names a host other than `origin` -- the
 * origin whose robots.txt is being evaluated -- whether directly (a full
 * URL for a different site) or indirectly (a protocol-relative reference
 * that resolves to a different host).
 *
 * Fix round 2, Finding 1a/1b: round 1's `normalizePath` accepted any
 * absolute URL and any protocol-relative reference with no check that
 * either named the SAME host as the `robotsTxt` being evaluated. A Reuters
 * article URL checked against AP's rules was silently evaluated against
 * AP's Disallow list -- the wrong file entirely -- and came back allowed,
 * because AP's rules simply never mention a Reuters path; Reuters' own
 * robots.txt explicitly denies it. Checking the wrong file is worse than
 * refusing to answer: a `path` that disagrees with `origin` about which
 * host it belongs to is a caller bug (the caller has mismatched a URL with
 * the wrong robots.txt), and this module cannot safely guess through it,
 * so it throws rather than silently returning either boolean.
 */
export class RobotsHostMismatchError extends Error {
  readonly expectedOrigin: string;
  readonly actualOrigin: string;

  constructor(expectedOrigin: string, path: string, actualOrigin: string) {
    super(
      `path "${path}" names origin ${actualOrigin}, not the expected ${expectedOrigin}; ` +
        `refusing to evaluate it against a robots.txt that may not govern it`,
    );
    this.name = 'RobotsHostMismatchError';
    this.expectedOrigin = expectedOrigin;
    this.actualOrigin = actualOrigin;
  }
}

/**
 * Normalizes `isAllowed`'s `path` argument to what robots.txt patterns are
 * actually written against: an absolute-path reference starting with `/`,
 * query string included, fragment excluded -- resolved against `origin`,
 * the origin whose robots.txt is being evaluated, and validated against it.
 *
 * Fix round 1, Finding 1 (CRITICAL) established that `path` must accept
 * more than an already-correct bare path: a full absolute URL, or a path
 * missing its leading `/`, both previously failed OPEN (silently allowed)
 * because "no rule matched" is this module's own documented default.
 * Fix round 2 found the round-1 fix itself incomplete in three ways, all
 * landing wrongly-allowed -- the one direction this module exists to
 * prevent -- and closes all three with ONE mechanism:
 *
 *  - **Finding 1a** -- a full URL naming a DIFFERENT host than `origin`
 *    (e.g. a Reuters article URL checked against AP's robots.txt) was
 *    silently accepted and evaluated against the wrong file's rules.
 *  - **Finding 1b** -- a protocol-relative reference (`//host/path`) isn't
 *    a valid absolute URL on its own (`new URL` throws for want of a
 *    scheme), so it fell to the "already a path" branch UNRESOLVED, and an
 *    `^/api/v2/feed/`-style pattern never matched a string that actually
 *    starts `//host/...`.
 *  - **Finding 1c** -- fragment-stripping only happened on the full-URL
 *    branch (via `url.hash` being separate from `pathname`/`search`), so a
 *    bare `/a#frag` kept its `#frag`, which could dodge a `$`-anchored rule
 *    that correctly denies plain `/a`.
 *
 * All three are artifacts of round 1's two-branch design (try an absolute
 * `new URL(path)`, otherwise treat `path` as already-a-path) never
 * resolving a protocol-relative reference at all, and never checking a
 * host either branch DID produce. The fix: resolve `path` against
 * `origin` -- normalized to its bare scheme+host+port, discarding any path
 * `origin` itself might carry, so relative references always resolve
 * against the root -- via the platform URL resolver (`new URL(path,
 * expectedOrigin)`), which handles a full URL, a protocol-relative
 * reference, and a plain path uniformly in one call and always strips the
 * fragment as a side effect of separating `.hash` from `.pathname`/
 * `.search`. Then require the resolved result's origin to equal the
 * expected one, throwing `RobotsHostMismatchError` otherwise.
 *
 * This also closes the trap a narrower fix for 1b alone would reopen:
 * resolving a protocol-relative reference against a THROWAWAY/placeholder
 * base (rather than the real expected origin) would make `//evil.test/x`
 * resolve to a real host and then get evaluated with no host check at all
 * -- reintroducing 1a through the back door. Resolving against the REAL
 * `origin`, and then validating the resolved origin against it, closes
 * both together: `//evil.test/x` resolves to `https://evil.test/x`, whose
 * origin visibly disagrees with the expected one, and throws exactly like
 * a full cross-host URL would.
 *
 * **What this still cannot do, unchanged from round 1:** if a caller
 * already stripped the query string before calling -- `new URL(u)
 * .pathname` is the single most natural way to do this -- no normalization
 * on this side can recover the missing information; `/search` and
 * `/search?q=ukraine` are different strings and only one of them matches
 * AP's `/search?q=*` rule. Callers MUST pass the full path *and* query
 * string (or a URL that carries both), never `.pathname` alone.
 */
function normalizePath(path: string, origin: string): string {
  const expectedOrigin = new URL(origin).origin;
  const resolved = new URL(path, expectedOrigin);
  if (resolved.origin !== expectedOrigin) {
    throw new RobotsHostMismatchError(expectedOrigin, path, resolved.origin);
  }
  return resolved.pathname + resolved.search;
}

/**
 * Pure decision function: does `robotsTxt` permit `userAgent` to fetch
 * `path` at `origin`? No I/O -- callers resolve the origin's robots.txt
 * (see `fetchRobots`) and pass its body in directly, which is what keeps
 * this exhaustively testable against real, checked-in fixtures.
 *
 * `path` accepts an absolute-path reference (`/api/v2/feed/x`, query string
 * included if there is one), a full absolute URL, or a protocol-relative
 * reference (`//host/path`) -- see `normalizePath` for exactly how each is
 * resolved, and most importantly that a caller must include the query
 * string somewhere in what it passes (AP's `/search?q=*` is a real
 * example): there is no way to recover a query the caller already
 * discarded, e.g. by passing `new URL(u).pathname` alone.
 *
 * `origin` is the origin whose robots.txt this call is evaluating (e.g.
 * `https://apnews.com`) -- **required, not optional.** If `path` names a
 * DIFFERENT host, directly as a full URL or indirectly as a
 * protocol-relative reference, this throws `RobotsHostMismatchError`
 * rather than silently answering for the wrong file (fix round 2, Finding
 * 1a/1b -- see `normalizePath`'s doc comment for the full reasoning and the
 * cross-host bug this closes). Required rather than defaulted: a caller
 * always knows which origin's robots.txt it fetched (`fetchRobots(origin)`
 * is origin-keyed) and which URL it's about to request, so stating both
 * here is not a new burden -- and making the check optional would have
 * reopened exactly the cross-host confusion this parameter exists to close,
 * the same "documented-only contract is precisely the kind a future caller
 * violates without failing loudly" trap that motivated normalizing `path`
 * defensively in the first place.
 *
 * **Group selection, and why "no group matches" resolves to ALLOW rather
 * than this module's usual deny-under-uncertainty default:** RFC 9309 and
 * every major crawler treat a robots.txt that never mentions an agent -- no
 * matching name, no `*` group, including a genuinely empty or all-comments
 * file -- as silence, not ambiguity: the operator was never asked to say
 * anything about us and didn't. That is a different situation from the one
 * this module DOES resolve toward deny (an unreachable robots.txt -- see
 * `fetchRobots`): there, the operator's answer exists and could not be
 * read; here, there plainly is no answer to read. Reuters is itself proof
 * the distinction is real and load-bearing: an operator that wants to
 * default-deny unnamed agents writes an explicit `User-agent: *` /
 * `Disallow: /` block, exactly as Reuters does. Treating silence as denial
 * anyway would make every tool no operator ever configured against
 * unreachable purely for being unrecognized -- not what "politeness"
 * (CLAUDE.md) is asking for, and a real cost given how many small sites'
 * robots.txt files only ever mention Googlebot.
 *
 * **Longest-match-wins:** among the resolved group's rules that match
 * `path`, the one with the longest raw pattern text wins (RFC 9309's
 * "highest number of octets"); a tie between an Allow and a Disallow of
 * equal length resolves to Allow. Reuters' `/plus/` case is exactly this: a
 * 6-character `Allow: /plus/` outranks the 1-character `Disallow: /`. A
 * group with no matching rule at all defaults to allowed -- the same
 * default that gives AP's bare opening `Disallow:` (parsed to no rule at
 * all -- see parseGroups) its documented "allow everything but the
 * following exceptions" meaning, with no extra special-casing needed here.
 */
export function isAllowed(robotsTxt: string, userAgent: string, path: string, origin: string): boolean {
  const normalizedPath = normalizePath(path, origin);
  const group = resolveGroup(parseGroups(robotsTxt), userAgent);
  if (!group) return true;

  let maxAllowLen = -1;
  let maxDisallowLen = -1;
  for (const rule of group.rules) {
    if (!rule.regex.test(normalizedPath)) continue;
    if (rule.type === 'allow') maxAllowLen = Math.max(maxAllowLen, rule.pattern.length);
    else maxDisallowLen = Math.max(maxDisallowLen, rule.pattern.length);
  }
  return maxDisallowLen <= maxAllowLen;
}

// ---------------------------------------------------------------------------
// Fetching + caching
// ---------------------------------------------------------------------------

/**
 * The bare product token -- the part of `USER_AGENT` before its first `/`,
 * by HTTP User-Agent convention (`product/version (comment)`) -- for
 * callers that need to evaluate `isAllowed`'s `userAgent` parameter as
 * "would OUR real identity be let through here?". Derived from `USER_AGENT`
 * rather than a separately hand-maintained literal so it cannot drift from
 * what actually gets sent (fix round 1, Finding 4). Currently `"watchfloor"`
 * -- pinned by a test, since a silently-corrupted token would degrade
 * PERMISSIVELY (it would stop matching a named block aimed at us and fall
 * through to the more open `*` group) rather than failing loudly.
 *
 * The non-null assertion on `[0]` (not a `?? USER_AGENT` fallback, which
 * fix round 2 correctly identified as dead code implying a guard that
 * could never run) states, rather than pretends to handle, the fact that
 * `String.prototype.split` always returns at least one element, so index 0
 * is never `undefined`.
 */
export const PRODUCT_TOKEN = USER_AGENT.split('/')[0]!;

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h, per the brief
const DEFAULT_TIMEOUT_MS = 10_000; // matches src/fetch/http.ts's own default (duplicated, not imported)

/**
 * M1 task 10, fix round 2 (reopened finding): how long a FAILED fetch
 * (5xx, timeout, transport failure) is remembered before the next call is
 * allowed to hit the network again. See `failureCache`'s doc comment for the
 * full incident this closes -- in short, a caller that retries on a fixed
 * tick (src/scheduler/run.ts) with no cache here retries the network on
 * EVERY call for the entire duration of an outage, unconditionally, with no
 * relationship to how long the outage has actually been going on.
 *
 * 15 minutes. Chosen to land in the middle of the reviewer's own defensible
 * 10-30 minute range: it bounds a 6-hour outage to roughly 24 real requests
 * total PER ORIGIN (not per source -- see `failureCache`), a two-order-of-
 * magnitude reduction from the 360 measured pre-fix (60s scheduler tick x
 * 360 ticks in 6h, every one a real request). Short enough that a host which
 * recovers mid-outage is noticed within about 15 minutes, not up to a full
 * day the way the 24h SUCCESS cache would if reused here unmodified.
 */
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 15 * 60 * 1000;

export interface FetchRobotsOptions {
  /**
   * Cache lifetime in ms. Defaults to 24h so a long-lived scheduler process
   * asks each host once a day, not once a poll (the brief's literal ask).
   * Overridable only because a real test cannot wait 24 hours to prove
   * expiry -- production callers should never need to pass this, the same
   * shape as `minIntervalMs` on `politeFetch` in src/fetch/http.ts.
   */
  ttlMs?: number;
  /** Whole-request deadline in ms. Default 10000. */
  timeoutMs?: number;
  /**
   * Negative-cache lifetime in ms for a FAILED fetch. Defaults to 15
   * minutes -- see `DEFAULT_NEGATIVE_CACHE_TTL_MS`'s own doc comment.
   * Overridable for the same reason `ttlMs` is: a real test cannot wait 15
   * minutes to prove expiry. Production callers should never need to pass
   * this.
   */
  negativeCacheTtlMs?: number;
}

/**
 * Thrown when an origin's robots.txt could not be determined: a 5xx, a
 * timeout, or a transport-level failure (DNS, connection refused, a
 * redirect that didn't resolve to a final response). NOT thrown for 4xx --
 * see `fetchRobots`'s doc comment for why those are treated as a definitive
 * "no robots.txt" instead.
 *
 * **Callers MUST treat a rejected `fetchRobots` as "deny" for the current
 * fetch cycle** -- skip the source and try again next time -- never fetch
 * anyway because the check itself failed. That is the deny-under-uncertainty
 * principle applied at the network layer: an unreadable answer is not
 * evidence of permission.
 */
export class RobotsUnavailableError extends Error {
  readonly origin: string;

  constructor(origin: string, reason: string, opts?: { cause?: unknown }) {
    super(
      `robots.txt for ${origin} could not be retrieved (${reason}); treat as fully ` +
        `disallowed for this cycle, never fetch anyway`,
      opts,
    );
    this.name = 'RobotsUnavailableError';
    this.origin = origin;
  }
}

interface CacheEntry {
  body: string;
  fetchedAt: number;
}

// Process-lifetime cache, one entry per origin. In-memory is deliberate: a
// scheduler process is expected to run for days, so this alone delivers the
// brief's "once a day, not once a poll" -- and a process restart asking
// again once is the conservative failure mode, not a gap that needs
// backfilling with persistence.
const cache = new Map<string, CacheEntry>();

interface FailureCacheEntry {
  reason: string;
  failedAt: number;
}

/**
 * M1 task 10, fix round 2 (reopened finding, CRITICAL to Task 11's live
 * run). A short, SEPARATE negative cache for a failed fetch -- 5xx, timeout,
 * or a transport-level failure -- keyed the same way as the success `cache`
 * above (one entry per origin).
 *
 * **The incident this closes.** The original version of this function
 * deliberately never cached a failure at all ("the very next call retries
 * the network" -- see the module's own now-corrected reasoning below). That
 * was fine in isolation, but combined with src/scheduler/run.ts's own
 * (correct) decision not to apply recordFailure/backoff to a
 * robots-unavailable outcome, there was NO mechanism anywhere in the system
 * bounding the retry rate during an outage: a source polled on a fixed
 * scheduler tick (60s) would retry this function on literally EVERY tick,
 * for the entire outage, with no relationship between elapsed outage time
 * and request count. Measured during review: 360 real requests over a
 * 6-hour outage for a single never-succeeded source, and -- because this
 * cache is origin-keyed, not source-keyed -- 30 requests for just 3 sources
 * sharing one down origin across 10 ticks, with zero deduplication between
 * them despite all asking the identical question ("what does this ONE
 * robots.txt say").
 *
 * **Why the fix belongs HERE, not in the scheduler.** A scheduler-side fix
 * (e.g. applying backoff to a robots-unavailable outcome) could bound the
 * rate per SOURCE, but has no visibility into which other sources share an
 * origin with the one currently failing -- it cannot deduplicate the
 * 3-sources-1-origin case at all. This cache already IS origin-keyed and
 * process-global (see `cache` above, same design), so fixing it here gets
 * cross-source deduplication for free, as a consequence of the existing
 * architecture rather than a new mechanism.
 *
 * **What is deliberately unchanged.** This does NOT undermine the
 * deny-under-uncertainty principle: a cached failure still throws
 * `RobotsUnavailableError` on every call within the window (see
 * `fetchRobots` below) -- it is never silently read as "no restrictions" the
 * way an actual 4xx is. It also does not touch the 4xx case at all: a 4xx is
 * a DEFINITIVE answer (no robots.txt exists), not the uncertainty this cache
 * exists to bound, and continues to populate only the success `cache` above,
 * exactly as before.
 */
const failureCache = new Map<string, FailureCacheEntry>();

function describeTransportFailure(err: unknown, timedOut: boolean, timeoutMs: number): string {
  if (timedOut) return `timed out after ${timeoutMs}ms`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fetches `origin`'s robots.txt (`GET {origin}/robots.txt`), with a 24h
 * cache so a long-lived scheduler process asks each host once a day rather
 * than once per poll. `origin`'s scheme+host+port (normalized by the
 * platform `URL` parser -- lowercased, default port stripped) is the cache
 * key, so `https://apnews.com` and `https://apnews.com/` share one entry.
 *
 * **Outcome by status, and why:**
 *  - **2xx** -- the body is returned, cached for `ttlMs`, and any prior
 *    negative-cache entry for this origin is cleared (see `failureCache`) --
 *    a fresh success is authoritative over a stale failure memory.
 *  - **4xx** (404, 401, 403, everything in between) -- treated as a
 *    definitive "no robots.txt exists", resolving to `''` (which
 *    `isAllowed` then reads as allow-all -- see its doc comment), and THAT
 *    result is cached too (also clearing any prior negative-cache entry).
 *    This mirrors documented real-world crawler behavior -- Google
 *    explicitly treats 401/403 the same as a plain 404 here -- because a
 *    4xx says the resource at this path isn't there for us to read, which
 *    is a clear signal, not an ambiguous one. It is not the site telling us
 *    access is restricted; robots.txt disallow rules are what tell us that,
 *    and there are none to read.
 *  - **5xx, a redirect that never resolves to a final response, or the
 *    request failing outright** (timeout, DNS, connection refused) -- this
 *    IS genuine uncertainty: the operator may have an opinion we simply
 *    couldn't read. Per the module's deny-under-uncertainty principle, this
 *    throws `RobotsUnavailableError` rather than resolving to either
 *    answer.
 *
 *    **Fix round 2 (reopened finding):** an EARLIER version of this
 *    function deliberately never cached this outcome at all ("an outage
 *    should not force a full day of denial... the very next call retries
 *    the network"). That reasoning covered the success cache's 24h TTL
 *    correctly, but missed that with NO time-boxing at all, a caller on a
 *    fixed retry tick (src/scheduler/run.ts's scheduler, which deliberately
 *    does not apply its own backoff to this outcome -- see that file's
 *    module doc comment) retries the network on every single call for the
 *    ENTIRE outage: measured at 360 real requests over a 6h outage for one
 *    source, with zero deduplication across sources sharing an origin. This
 *    now DOES cache for a short, separate `negativeCacheTtlMs` (15 minutes
 *    by default -- see `failureCache`'s doc comment for the full incident
 *    and reasoning) -- bounding the retry rate without reintroducing the
 *    thing the original reasoning correctly wanted to avoid (a full DAY of
 *    denial after a brief blip): a cached failure still throws
 *    `RobotsUnavailableError` on every call within the window, never
 *    silently reads as "allowed", and self-clears within 15 minutes of the
 *    last real attempt, not up to 24 hours. Unlike some crawlers' extended
 *    stale-cache fallback for a long-unreachable host, there is still no
 *    fallback-to-allow: with no persistent store, "unreachable" always
 *    means "deny, retry later" -- only how SOON "later" is has changed.
 */
export async function fetchRobots(origin: string, opts: FetchRobotsOptions = {}): Promise<string> {
  const {
    ttlMs = DEFAULT_TTL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    negativeCacheTtlMs = DEFAULT_NEGATIVE_CACHE_TTL_MS,
  } = opts;

  const target = new URL('/robots.txt', origin);
  const cacheKey = target.origin;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < ttlMs) {
    return cached.body;
  }

  // Fix round 2: consulted only once the (long-lived, 24h) success cache
  // above has nothing fresh to offer -- a fresh positive entry always wins,
  // so a negative entry can only ever be fresh here when the positive entry
  // is ALREADY stale or absent (see failureCache's doc comment for why the
  // two can never both be fresh at once). Rejecting here, before any network
  // call, is what actually bounds the retry rate and dedupes across every
  // caller sharing this origin.
  const recentFailure = failureCache.get(cacheKey);
  if (recentFailure && Date.now() - recentFailure.failedAt < negativeCacheTtlMs) {
    throw new RobotsUnavailableError(cacheKey, `${recentFailure.reason} (cached failure, not re-fetched yet)`);
  }

  // Covers the whole operation, connect through final byte: if this fires
  // while `response.text()` below is still awaiting the body, that read
  // rejects too, and the catch around it (fix round 1, Finding 3) sees
  // timeoutSignal.aborted -- same property src/fetch/http.ts's own
  // timeoutSignal relies on for its two timeout call sites.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(target, {
      headers: { 'User-Agent': USER_AGENT },
      signal: timeoutSignal,
      redirect: 'follow',
    });
  } catch (err) {
    const reason = describeTransportFailure(err, timeoutSignal.aborted, timeoutMs);
    failureCache.set(cacheKey, { reason, failedAt: Date.now() });
    throw new RobotsUnavailableError(cacheKey, reason, { cause: err });
  }

  if (response.ok) {
    // Fix round 1, Finding 3 (Important): this used to sit outside every
    // try/catch, so a failure specifically in THIS phase -- headers already
    // received (response.ok true), then the body stream stalls past
    // timeoutMs, or the connection resets mid-body -- escaped as a raw
    // DOMException/TypeError, not `RobotsUnavailableError`, contradicting
    // this function's own documented contract that callers can rely on
    // that type (and its `.origin`) for every unreachable-robots.txt case.
    // Reuses the same timeoutSignal and describeTransportFailure as the
    // fetch() catch above: the signal covers the whole operation (its doc
    // comment on construction says so), so a timeout firing mid-body-read
    // is `timeoutSignal.aborted` here exactly as it would be up there.
    let body: string;
    try {
      body = await response.text();
    } catch (err) {
      const reason = describeTransportFailure(err, timeoutSignal.aborted, timeoutMs);
      failureCache.set(cacheKey, { reason, failedAt: Date.now() });
      throw new RobotsUnavailableError(cacheKey, reason, { cause: err });
    }
    cache.set(cacheKey, { body, fetchedAt: Date.now() });
    failureCache.delete(cacheKey); // fix round 2: a fresh success is authoritative over any stale failure memory
    return body;
  }

  await response.body?.cancel().catch(() => {});

  if (response.status >= 400 && response.status < 500) {
    cache.set(cacheKey, { body: '', fetchedAt: Date.now() });
    failureCache.delete(cacheKey); // fix round 2: same as the 2xx case -- a definitive 4xx supersedes any prior failure memory
    return '';
  }

  const reason = `responded ${response.status} ${response.statusText}`;
  failureCache.set(cacheKey, { reason, failedAt: Date.now() });
  throw new RobotsUnavailableError(cacheKey, reason);
}
