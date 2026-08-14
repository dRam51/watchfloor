/**
 * GitHub REST API client (M4a task 1).
 *
 * Built ON TOP OF the project's politeness layer's conventions -- same
 * `USER_AGENT`, same conditional-request shape, same per-host spacing
 * discipline -- rather than replacing it. See `politeFetch` in ./http.ts.
 *
 * ## Why REST and not GraphQL
 *
 * The M4a plan left this open ("GraphQL fetches more per request... but is
 * harder to cache and to fixture"). It is settled here as REST, and one of
 * the four reasons is decisive on its own:
 *
 *  1. **GraphQL has a budget of ZERO without a PAT.** Verified live
 *     2026-08-14: an unauthenticated POST to /graphql returns 403 with
 *     `x-ratelimit-limit: 0`, `x-ratelimit-resource: graphql` -- not
 *     exhaustion, an allowance that never existed. Requirement 1 of this
 *     task makes the PAT OPTIONAL and unauthenticated a real supported
 *     mode. GraphQL cannot serve that mode at all, so choosing it would
 *     mean the client does not work without the token. That ends the
 *     argument by itself; the rest are corroborating.
 *  2. **Conditional requests only exist on REST.** GraphQL is one POST to
 *     one endpoint; there is no per-resource ETag to revalidate against.
 *     Core REST returns both `etag` and `last-modified` (verified live),
 *     which is what lets this client reuse the etag/lastModified state
 *     the project already stores per source.
 *  3. **Fixturing.** A REST response is a JSON document addressed by URL --
 *     capture it, replay it from a real local server, done (which is what
 *     tests/fixtures/github/ holds). A GraphQL response is only meaningful
 *     paired with the exact query text that produced it, so every query
 *     edit invalidates every fixture.
 *  4. **The point-cost model is opaque.** GraphQL's 5,000/hr is 5,000
 *     *points*, computed from the connection sizes a query requests, and
 *     is not knowable before sending. REST's budget is one request = one
 *     unit, which is the only model this client can honestly report to a
 *     caller before spending anything.
 *
 * The one thing GraphQL would genuinely buy -- fewer round trips for the
 * per-repo enrichment in task 6 -- is a real cost, and it is recorded in
 * the task report rather than papered over. If a PAT later becomes
 * mandatory rather than optional, reason 1 disappears and this decision is
 * worth revisiting for the enrichment path specifically.
 *
 * ## The token
 *
 * Held in a private field, sent only as an `Authorization` header, and
 * never placed in a message, a URL, a log line, or any thrown error. Same
 * standard `src/api/auth.ts` holds `WF_API_TOKEN` to, and for a stronger
 * reason: this repository is PUBLIC, and a leaked PAT is the owner's
 * GitHub account. `tests/fetch/github.test.ts` pins this by failing an
 * authenticated request against a real local server and asserting the
 * token appears nowhere in the error's message, stack, own properties, or
 * JSON serialization.
 */

import { PoliteFetchError, USER_AGENT } from './http.ts';

/**
 * ## Why this does not call `politeFetch` directly
 *
 * It reuses `USER_AGENT` and the `PoliteFetchError` taxonomy from ./http.ts
 * -- so a caller's existing retryable/permanent handling works unchanged --
 * but performs its own `fetch`, for three reasons that are properties of
 * `politeFetch`'s signature, not preferences:
 *
 *  - it accepts no extra REQUEST headers, and this client must send
 *    `Accept`, `X-GitHub-Api-Version`, and (when authenticated) an
 *    `Authorization` header;
 *  - it exposes only `etag`/`lastModified` from the RESPONSE, and every
 *    `x-ratelimit-*` header -- the entire point of requirement 3 -- would be
 *    discarded;
 *  - it THROWS on 403 and 429 with no access to the response body or
 *    headers, which is exactly where GitHub puts the rate-limit signal that
 *    has to be read rather than retried past.
 *
 * Widening `politeFetch` to cover all three was the alternative and was not
 * taken: src/fetch/http.ts is outside this task's file ownership, and
 * every one of ~20 existing feed sources routes through it. This is a
 * deliberate, documented duplication of roughly thirty lines of transport
 * handling. **If http.ts's timeout, byte-ceiling, or host-spacing behavior
 * changes, this file does not inherit it.**
 */

/** Whole-request deadline. Matches src/fetch/http.ts's own default. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Streaming byte ceiling. Lower than http.ts's 5 MiB because a GitHub API
 * response is bounded by `per_page` (max 100): the largest plausible one is
 * a 100-item search page at roughly 1 KB of JSON per repo. 2 MiB is ~20x
 * that and still firmly rejects a pathological response.
 */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Per-host minimum spacing between request starts, matching the project's
 * politeness default. Never the binding constraint in practice -- 60
 * core requests per hour is one per 60s unauthenticated, and 30 search
 * requests per minute is one per 2s authenticated -- so this is a floor
 * that the rate-limit budget below is normally stricter than.
 *
 * Deliberately a SEPARATE gate from `politeFetch`'s: that one's `hostSlot`
 * map is module-private and unexported, so it cannot be shared without
 * editing http.ts. Consequence, stated rather than hidden: a GitHub
 * request and an RSS poll to the same host would not space against each
 * other. No configured source shares api.github.com, so this is currently
 * theoretical -- but it stops being theoretical if one ever does.
 */
const DEFAULT_MIN_INTERVAL_MS = 2_000;

/** The REST API version this client pins. Sent on every request. */
const API_VERSION = '2022-11-28';

/**
 * GitHub's published ceilings, by mode. Readable WITHOUT making a request,
 * which is the whole point: the failure this exists to prevent is a poll
 * that discovers it is on a 60/hour budget by exhausting it.
 *
 * These are documentation, not measurements -- the live `x-ratelimit-limit`
 * header is the authority at runtime (and is what `budget()` reports). Both
 * unauthenticated figures were confirmed live 2026-08-14: `limit: 60`
 * / `resource: core` and `limit: 10` / `resource: search`.
 */
export const RATE_LIMITS = {
  unauthenticated: { searchPerMinute: 10, corePerHour: 60 },
  authenticated: { searchPerMinute: 30, corePerHour: 5_000 },
} as const;

export type GitHubAuthMode = keyof typeof RATE_LIMITS;

/**
 * One resource's budget as GitHub last reported it. Every field is
 * nullable because a proxy or a future API change can omit any of them,
 * and reporting `null` is honest where inventing a `0` would trip the
 * exhaustion guard for no reason.
 *
 * `resource` is GitHub's own `x-ratelimit-resource` -- `core`, `search`,
 * `graphql`, and others. These are SEPARATE budgets, confirmed live: one
 * client saw `resource: core, limit: 60` and `resource: search, limit: 10`
 * within seconds of each other. A single global counter would misreport
 * both.
 */
export interface GitHubRateLimit {
  resource: string;
  limit: number | null;
  remaining: number | null;
  used: number | null;
  /** Parsed from `x-ratelimit-reset`, which GitHub sends as epoch SECONDS. */
  resetAt: Date | null;
}

export interface GitHubResponse<T = unknown> {
  status: number;
  /** Parsed JSON, or null on a 304 (which by definition carries no body). */
  data: T | null;
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
  rateLimit: GitHubRateLimit | null;
  mode: GitHubAuthMode;
}

export interface GitHubRequestOptions {
  /** Prior ETag — sent as If-None-Match. See `request` for the 304 caveat. */
  etag?: string;
  /** Prior Last-Modified — sent as If-Modified-Since. */
  lastModified?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Overridable only so tests need not wait 2s per request. */
  minIntervalMs?: number;
}

export interface GitHubClientOptions {
  /**
   * The PAT, or undefined/empty for unauthenticated mode. Optional by
   * design -- unauthenticated is a real supported mode, not a degraded
   * error state. An empty or whitespace-only value (a `.env` line left as
   * `WF_GITHUB_TOKEN=`) is treated as absent rather than as a credential,
   * since sending `Authorization: Bearer ` would 401 every request.
   */
  token?: string;
  /** API origin. Overridable so tests can point at a real local server. */
  baseUrl?: string;
  /**
   * Stop sending while `remaining` is at or below this, rather than at
   * zero. Default 0 — spend the whole budget, never overdraw it. Raise it
   * to hold headroom back for a higher-priority call (e.g. leave room for
   * the enrichment path after a search page).
   */
  reserve?: number;
}

/** Reads a header as a base-10 integer, or null when absent/unparseable. */
function intHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * Builds a GitHubRateLimit from a response, or null when the response
 * carried no `x-ratelimit-*` headers at all.
 *
 * `resource` falls back to a path-derived guess when the header is absent,
 * because `budget()` has to key the observation by something -- GitHub
 * always sends it in practice (observed on every live response, including
 * a 404 and a 403), so this fallback is defensive rather than routine.
 */
/**
 * Which rate-limit resource a path belongs to, derived from the resolved
 * URL's PATHNAME rather than the raw argument.
 *
 * The distinction is load-bearing, not pedantry: `request` accepts a full
 * URL as well as a bare path, and GitHub's own `link` header hands back
 * absolute URLs for pagination. Matching on the raw string would classify
 * `https://api.github.com/search/repositories?page=2` as `core` — whose
 * budget is 6x larger unauthenticated — so a paginated search would be
 * gated against the wrong, more permissive budget and overrun the real one.
 */
function resourceForPath(path: string, baseUrl: string): string {
  const { pathname } = new URL(path, baseUrl);
  return pathname.startsWith('/search') ? 'search' : 'core';
}

function readRateLimit(headers: Headers, fallbackResource: string): GitHubRateLimit | null {
  const limit = intHeader(headers, 'x-ratelimit-limit');
  const remaining = intHeader(headers, 'x-ratelimit-remaining');
  const used = intHeader(headers, 'x-ratelimit-used');
  const resetSeconds = intHeader(headers, 'x-ratelimit-reset');
  const resource = headers.get('x-ratelimit-resource');

  if (limit === null && remaining === null && used === null && resetSeconds === null && resource === null) {
    return null;
  }

  return {
    resource: resource ?? fallbackResource,
    limit,
    remaining,
    used,
    // GitHub sends epoch SECONDS; Date wants milliseconds.
    resetAt: resetSeconds === null ? null : new Date(resetSeconds * 1000),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GitHubClient {
  /** Never read by anything that formats output. See the module doc comment. */
  readonly #token: string | null;
  readonly #baseUrl: string;
  /** Last observed budget per `x-ratelimit-resource`. */
  readonly #budgets = new Map<string, GitHubRateLimit>();
  readonly #reserve: number;
  /** Gates when the next request to this client's host may start. */
  #hostSlot: Promise<number> = Promise.resolve(0);

  constructor(opts: GitHubClientOptions = {}) {
    const token = opts.token?.trim();
    this.#token = token ? token : null;
    this.#baseUrl = opts.baseUrl ?? 'https://api.github.com';
    this.#reserve = opts.reserve ?? 0;
  }

  /** Which mode this client is in. Safe to log — never includes the token. */
  get mode(): GitHubAuthMode {
    return this.#token === null ? 'unauthenticated' : 'authenticated';
  }

  /** The published ceiling for this client's mode. */
  get limits(): (typeof RATE_LIMITS)[GitHubAuthMode] {
    return RATE_LIMITS[this.mode];
  }

  /**
   * The most recently observed budget for one resource (`core`, `search`,
   * …), or null if this client has not yet seen a response for it. A
   * caller deciding whether it can afford a poll reads this; combined with
   * `mode` and `limits` above, it never has to learn its ceiling by
   * hitting it.
   */
  budget(resource: string): GitHubRateLimit | null {
    return this.#budgets.get(resource) ?? null;
  }

  async #acquireSlot(minIntervalMs: number): Promise<void> {
    const slot = this.#hostSlot.then(async (previousStart) => {
      const wait = previousStart + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      return Date.now();
    });
    // Replaced synchronously, before awaiting, so a concurrent caller
    // chains onto THIS slot rather than the one it replaced — the same
    // shape politeFetch's hostSlot map uses.
    this.#hostSlot = slot;
    await slot;
  }

  /**
   * Performs one GET against `path` (an API path such as
   * `/repos/owner/name`, or a full URL on this client's base).
   *
   * Resolves for 2xx and 304. Throws `GitHubApiError` (a `PoliteFetchError`
   * subclass, so existing retry classification applies) for everything
   * else.
   *
   * **The 304 caveat, measured rather than assumed.** GitHub documents a
   * 304 as exempt from the rate limit. That was NOT observed on the
   * unauthenticated path: replaying a valid ETag four times drove
   * `x-ratelimit-used` 1 → 2 → 3 → 4. A conditional request still saves
   * the whole response body, so it remains worth sending — but it does not
   * buy budget in the mode that has the 60/hour ceiling, and code must not
   * be written as though it does. See tests/fixtures/github/captured-headers.json.
   */
  async request<T = unknown>(path: string, opts: GitHubRequestOptions = {}): Promise<GitHubResponse<T>> {
    const {
      etag,
      lastModified,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxBytes = DEFAULT_MAX_BYTES,
      minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
    } = opts;

    const url = new URL(path, this.#baseUrl).toString();
    const resource = resourceForPath(path, this.#baseUrl);

    this.#assertBudget(path, resource);

    await this.#acquireSlot(minIntervalMs);

    const headers = new Headers({
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
    });
    if (this.#token !== null) headers.set('Authorization', `Bearer ${this.#token}`);
    if (etag) headers.set('If-None-Match', etag);
    if (lastModified) headers.set('If-Modified-Since', lastModified);

    const timeoutSignal = AbortSignal.timeout(timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, { headers, signal: timeoutSignal, redirect: 'follow' });
    } catch (err) {
      if (timeoutSignal.aborted) {
        throw new GitHubApiError(`request to ${path} timed out after ${timeoutMs}ms`, {
          status: null,
          retryable: true,
          rateLimit: null,
        });
      }
      // `err` is a transport failure (DNS, refused, reset). It is built by
      // undici from the URL and never contains a request header, so the
      // token cannot reach this message — the URL carries no credential.
      const message = err instanceof Error ? err.message : String(err);
      throw new GitHubApiError(`request to ${path} failed: ${message}`, {
        status: null,
        retryable: true,
        rateLimit: null,
        cause: err,
      });
    }

    const rateLimit = readRateLimit(response.headers, resource);
    if (rateLimit !== null) this.#budgets.set(rateLimit.resource, rateLimit);

    if (response.status === 304) {
      await response.body?.cancel().catch(() => {});
      return {
        status: 304,
        data: null,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        notModified: true,
        rateLimit,
        mode: this.mode,
      };
    }

    if (response.status >= 400) {
      throw await this.#buildError(response, path, rateLimit);
    }

    const body = await readBodyWithCeiling(response, maxBytes, path);
    return {
      status: response.status,
      data: JSON.parse(body) as T,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      notModified: false,
      rateLimit,
      mode: this.mode,
    };
  }

  /**
   * ## What this client does as `remaining` approaches zero
   *
   * **It refuses to send, immediately, and never sleeps.** Requirement 3
   * asks for this choice to be made and documented, so:
   *
   * *Why refuse rather than send anyway.* A request sent against a spent
   * budget is not free — GitHub still counts it (`x-ratelimit-used` keeps
   * climbing past `limit`), and sustained overdraft is what escalates a
   * primary limit into a secondary block that outlasts the reset. Refusing
   * locally is strictly cheaper than being refused remotely.
   *
   * *Why not sleep until the reset.* The reset can be up to an hour away
   * unauthenticated. Blocking a scheduler tick for an hour would stall
   * every OTHER source behind it, converting one exhausted budget into a
   * whole-system stall. Rejecting with `retryable: true` instead hands the
   * decision to `src/scheduler/run.ts`'s existing backoff, which already
   * knows how to defer one source without holding up the rest. This is the
   * same reasoning the zero-dollar rule applies to paid paths: a hard
   * refusal, never a silent deferred retry.
   *
   * *Why the gate is per RESOURCE.* `core` and `search` are separate
   * budgets. An exhausted search budget must not block a core request; the
   * reverse strands the enrichment path for a full minute for no reason.
   *
   * *Why it clears optimistically at `resetAt`.* Once the reset instant has
   * passed the budget has refilled, so the recorded zero is stale. The
   * client tries again rather than waiting for a fresh observation it can
   * only get by trying. A missing `resetAt` is treated as "cannot prove it
   * refilled" and keeps refusing until a real response updates it.
   */
  #assertBudget(path: string, resource: string): void {
    const budget = this.#budgets.get(resource);
    if (!budget || budget.remaining === null) return;
    if (budget.remaining > this.#reserve) return;
    if (budget.resetAt !== null && Date.now() >= budget.resetAt.getTime()) return;

    throw new GitHubRateLimitError(
      `refusing to request ${path}: the ${resource} budget is spent ` +
        `(${budget.remaining} remaining, reserve ${this.#reserve})`,
      { status: null, rateLimit: budget, resetAt: budget.resetAt, retryAfterMs: null, spent: false },
    );
  }

  async #buildError(response: Response, path: string, rateLimit: GitHubRateLimit | null): Promise<GitHubApiError> {
    await response.body?.cancel().catch(() => {});

    // GitHub signals a rate limit two different ways, and reading only one
    // misses the other. A PRIMARY limit is a 403 (or 429) with
    // `x-ratelimit-remaining: 0`. A SECONDARY limit is a 403/429 carrying
    // `retry-after` while `remaining` is still healthy — the captured
    // fixture has remaining 23 — so a remaining-only check would classify
    // it as an ordinary permission failure and retry straight into it.
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    const isRateLimited =
      response.status === 429 ||
      (response.status === 403 && (rateLimit?.remaining === 0 || retryAfterMs !== null));

    if (isRateLimited) {
      return new GitHubRateLimitError(`${path} responded ${response.status} ${response.statusText}`, {
        status: response.status,
        rateLimit,
        resetAt: rateLimit?.resetAt ?? null,
        retryAfterMs,
        spent: true,
      });
    }

    // A 403 that is NOT a rate limit is a permission failure — retrying it
    // after a reset fixes nothing, so it must not be marked retryable.
    const retryable = response.status >= 500;
    return new GitHubApiError(`${path} responded ${response.status} ${response.statusText}`, {
      status: response.status,
      retryable,
      rateLimit,
    });
  }
}

/**
 * `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110). GitHub
 * sends seconds, but the header is defined as both and a proxy may rewrite
 * it, so both are accepted. Returns milliseconds, or null when absent or
 * unparseable.
 */
function parseRetryAfter(raw: string | null): number | null {
  if (raw === null) return null;
  const seconds = Number.parseInt(raw.trim(), 10);
  if (Number.isFinite(seconds) && String(seconds) === raw.trim()) return seconds * 1000;
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

/**
 * Any non-2xx, non-304 outcome. Extends `PoliteFetchError` so a caller's
 * existing `retryable` handling (src/scheduler/run.ts's backoff) applies
 * with no changes.
 *
 * **The message is constructed from the request PATH and the response
 * status only.** It never includes request headers, so the token cannot
 * reach it — pinned by a test that fails a real authenticated request and
 * asserts the token appears in neither the message, the stack, the own
 * properties, nor the JSON serialization.
 */
export class GitHubApiError extends PoliteFetchError {
  readonly rateLimit: GitHubRateLimit | null;

  constructor(
    message: string,
    opts: { status: number | null; retryable: boolean; rateLimit: GitHubRateLimit | null; cause?: unknown },
  ) {
    super(message, { status: opts.status, retryable: opts.retryable, cause: opts.cause });
    this.name = 'GitHubApiError';
    this.rateLimit = opts.rateLimit;
  }
}

/**
 * A rate limit, either observed in a response (`spent: true` — the request
 * was made and refused) or predicted before sending (`spent: false` — this
 * client refused it locally against a budget it already knew was gone).
 *
 * That distinction is the useful one for a caller: `spent: true` means a
 * request was consumed, `spent: false` means none was. Always `retryable`,
 * since a rate limit is by definition temporary — but see `#assertBudget`
 * for why this client never does the waiting itself.
 */
export class GitHubRateLimitError extends GitHubApiError {
  /** When the budget refills, from `x-ratelimit-reset`. */
  readonly resetAt: Date | null;
  /** From `retry-after`, in ms. Present on secondary limits, not primary ones. */
  readonly retryAfterMs: number | null;
  /** Whether a request was actually sent (and therefore counted). */
  readonly spent: boolean;

  constructor(
    message: string,
    opts: {
      status: number | null;
      rateLimit: GitHubRateLimit | null;
      resetAt: Date | null;
      retryAfterMs: number | null;
      spent: boolean;
    },
  ) {
    super(message, { status: opts.status, retryable: true, rateLimit: opts.rateLimit });
    this.name = 'GitHubRateLimitError';
    this.resetAt = opts.resetAt;
    this.retryAfterMs = opts.retryAfterMs;
    this.spent = opts.spent;
  }
}

/**
 * Streams the body, aborting the moment `maxBytes` is crossed so a
 * pathological response is never fully buffered. Mirrors
 * `readBodyWithCeiling` in src/fetch/http.ts, which is not exported.
 */
async function readBodyWithCeiling(response: Response, maxBytes: number, path: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new GitHubApiError(`response from ${path} exceeded the ${maxBytes}-byte ceiling`, {
        status: null,
        retryable: false,
        rateLimit: null,
      });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
