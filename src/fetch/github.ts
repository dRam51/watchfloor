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
}

export class GitHubClient {
  /** Never read by anything that formats output. See the module doc comment. */
  readonly #token: string | null;
  readonly #baseUrl: string;

  constructor(opts: GitHubClientOptions = {}) {
    const token = opts.token?.trim();
    this.#token = token ? token : null;
    this.#baseUrl = opts.baseUrl ?? 'https://api.github.com';
  }

  /** Which mode this client is in. Safe to log — never includes the token. */
  get mode(): GitHubAuthMode {
    return this.#token === null ? 'unauthenticated' : 'authenticated';
  }

  /** The published ceiling for this client's mode. */
  get limits(): (typeof RATE_LIMITS)[GitHubAuthMode] {
    return RATE_LIMITS[this.mode];
  }
}
