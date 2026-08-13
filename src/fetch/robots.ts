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
 */
function parseGroups(robotsTxt: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let inRules = false;

  for (const raw of robotsTxt.split(/\r\n|\r|\n/)) {
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
 * names the same agent, their rules are combined (RFC 9309; rare in
 * practice and absent from both real fixtures, but cheap to get right).
 * Falls back to the `*` group. Returns null if neither exists.
 */
function resolveGroup(groups: Group[], userAgent: string): Group | null {
  const needle = userAgent.toLowerCase();
  const named = groups.filter((g) =>
    g.agents.some((agent) => agent !== '*' && needle.startsWith(agent.toLowerCase())),
  );
  if (named.length > 0) {
    return { agents: [userAgent], rules: named.flatMap((g) => g.rules) };
  }
  return groups.find((g) => g.agents.includes('*')) ?? null;
}

/**
 * Pure decision function: does `robotsTxt` permit `userAgent` to fetch
 * `path`? No I/O -- callers resolve the origin's robots.txt (see
 * `fetchRobots`) and pass its body in directly, which is what keeps this
 * exhaustively testable against real, checked-in fixtures.
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
export function isAllowed(robotsTxt: string, userAgent: string, path: string): boolean {
  const group = resolveGroup(parseGroups(robotsTxt), userAgent);
  if (!group) return true;

  let maxAllowLen = -1;
  let maxDisallowLen = -1;
  for (const rule of group.rules) {
    if (!rule.regex.test(path)) continue;
    if (rule.type === 'allow') maxAllowLen = Math.max(maxAllowLen, rule.pattern.length);
    else maxDisallowLen = Math.max(maxDisallowLen, rule.pattern.length);
  }
  return maxDisallowLen <= maxAllowLen;
}

// ---------------------------------------------------------------------------
// Fetching + caching
// ---------------------------------------------------------------------------

/**
 * Sent on every robots.txt request so an operator can identify what asked.
 * Deliberately NOT imported from `src/fetch/http.ts`: that file is being
 * actively rewritten by a concurrently-running task as this one lands, and
 * importing it now would couple this module (and its tests) to that file's
 * unsettled state. An independent, undramatic string is the safer choice
 * here; unifying the two once http.ts is stable is a natural follow-up and
 * not this task's to make.
 */
export const ROBOTS_USER_AGENT =
  'watchfloor (robots.txt check; self-hosted personal feed reader, single user)';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h, per the brief
const DEFAULT_TIMEOUT_MS = 10_000; // matches src/fetch/http.ts's own default (duplicated, not imported)

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
 *  - **2xx** -- the body is returned and cached for `ttlMs`.
 *  - **4xx** (404, 401, 403, everything in between) -- treated as a
 *    definitive "no robots.txt exists", resolving to `''` (which
 *    `isAllowed` then reads as allow-all -- see its doc comment), and THAT
 *    result is cached too. This mirrors documented real-world crawler
 *    behavior -- Google explicitly treats 401/403 the same as a plain 404
 *    here -- because a 4xx says the resource at this path isn't there for
 *    us to read, which is a clear signal, not an ambiguous one. It is not
 *    the site telling us access is restricted; robots.txt disallow rules
 *    are what tell us that, and there are none to read.
 *  - **5xx, a redirect that never resolves to a final response, or the
 *    request failing outright** (timeout, DNS, connection refused) -- this
 *    IS genuine uncertainty: the operator may have an opinion we simply
 *    couldn't read. Per the module's deny-under-uncertainty principle, this
 *    throws `RobotsUnavailableError` rather than resolving to either
 *    answer, and is deliberately NOT cached -- an outage should not force a
 *    full day of denial once the host recovers; the very next call retries
 *    the network. Unlike some crawlers' extended stale-cache fallback for a
 *    long-unreachable host, there is no fallback-to-allow here: with no
 *    persistent store, "unreachable" always means "deny, retry later", with
 *    no time-boxed escape hatch. Revisit only if a real source spends an
 *    extended period unreachable in practice.
 */
export async function fetchRobots(origin: string, opts: FetchRobotsOptions = {}): Promise<string> {
  const { ttlMs = DEFAULT_TTL_MS, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  const target = new URL('/robots.txt', origin);
  const cacheKey = target.origin;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < ttlMs) {
    return cached.body;
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(target, {
      headers: { 'User-Agent': ROBOTS_USER_AGENT },
      signal: timeoutSignal,
      redirect: 'follow',
    });
  } catch (err) {
    throw new RobotsUnavailableError(
      cacheKey,
      describeTransportFailure(err, timeoutSignal.aborted, timeoutMs),
      { cause: err },
    );
  }

  if (response.ok) {
    const body = await response.text();
    cache.set(cacheKey, { body, fetchedAt: Date.now() });
    return body;
  }

  await response.body?.cancel().catch(() => {});

  if (response.status >= 400 && response.status < 500) {
    cache.set(cacheKey, { body: '', fetchedAt: Date.now() });
    return '';
  }

  throw new RobotsUnavailableError(cacheKey, `responded ${response.status} ${response.statusText}`);
}
