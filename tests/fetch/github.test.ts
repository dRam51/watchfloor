import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { join } from 'node:path';
import { GitHubApiError, GitHubClient, GitHubRateLimitError, RATE_LIMITS } from '../../src/fetch/github.ts';
import { USER_AGENT } from '../../src/fetch/http.ts';

// Real local http servers, no mocks — the same pattern tests/fetch/http.test.ts
// established. The header sets these serve are REAL, captured from
// api.github.com; see tests/fixtures/github/captured-headers.json for what was
// observed and, importantly, which single entry was not.
const captured = JSON.parse(
  readFileSync(join(process.cwd(), 'tests', 'fixtures', 'github', 'captured-headers.json'), 'utf8'),
) as Record<string, Record<string, string>>;

const capturedBodies = JSON.parse(
  readFileSync(join(process.cwd(), 'tests', 'fixtures', 'github', 'captured-bodies.json'), 'utf8'),
) as { repo_body: Record<string, unknown>; rate_limit_body: Record<string, unknown> };

/** Strips the `_`-prefixed annotation keys so only real HTTP headers are sent. */
function headersOf(name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(captured[name]!).filter(([k]) => !k.startsWith('_')));
}

const openServers: Server[] = [];

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo from an ephemeral TCP listener');
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

describe('auth mode', () => {
  it('reports unauthenticated when no token is supplied', () => {
    const client = new GitHubClient({ baseUrl: 'http://127.0.0.1:1' });
    expect(client.mode).toBe('unauthenticated');
  });

  it('reports authenticated when a token is supplied', () => {
    const client = new GitHubClient({ token: 'ghp_example', baseUrl: 'http://127.0.0.1:1' });
    expect(client.mode).toBe('authenticated');
  });

  it('treats an empty or whitespace-only token as unauthenticated, not as a broken credential', () => {
    // A .env line left as `WF_GITHUB_TOKEN=` reads as '' rather than undefined.
    // Sending `Authorization: Bearer ` would 401 every request; falling back to
    // the real unauthenticated mode is both correct and the honest report.
    expect(new GitHubClient({ token: '', baseUrl: 'http://127.0.0.1:1' }).mode).toBe('unauthenticated');
    expect(new GitHubClient({ token: '   ', baseUrl: 'http://127.0.0.1:1' }).mode).toBe('unauthenticated');
  });

  it('publishes the documented ceiling for each mode so a caller can budget before spending', () => {
    // The failure this prevents: a poll that discovers it is on 60/hour by
    // exhausting it. These are readable without making a request.
    expect(RATE_LIMITS.unauthenticated).toEqual({ searchPerMinute: 10, corePerHour: 60 });
    expect(RATE_LIMITS.authenticated).toEqual({ searchPerMinute: 30, corePerHour: 5_000 });
  });

  it('reports the ceiling matching its own mode', () => {
    expect(new GitHubClient({ baseUrl: 'http://127.0.0.1:1' }).limits.corePerHour).toBe(60);
    expect(new GitHubClient({ token: 'ghp_example', baseUrl: 'http://127.0.0.1:1' }).limits.corePerHour).toBe(5_000);
  });
});

describe('request headers', () => {
  it('sends the project User-Agent and the versioned Accept header, and no Authorization when unauthenticated', async () => {
    let received: IncomingHttpHeaders = {};
    const baseUrl = await serve((req, res) => {
      received = req.headers;
      res.writeHead(200, { ...headersOf('repo_200'), 'content-type': 'application/json' });
      res.end('{}');
    });

    await new GitHubClient({ baseUrl }).request('/repos/a/b');

    expect(received['user-agent']).toBe(USER_AGENT);
    expect(received['accept']).toBe('application/vnd.github+json');
    expect(received['x-github-api-version']).toBe('2022-11-28');
    expect(received['authorization']).toBeUndefined();
  });

  it('sends the token as a Bearer credential when authenticated', async () => {
    let received: IncomingHttpHeaders = {};
    const baseUrl = await serve((req, res) => {
      received = req.headers;
      res.writeHead(200, { ...headersOf('repo_200'), 'content-type': 'application/json' });
      res.end('{}');
    });

    await new GitHubClient({ token: 'ghp_fixture_only', baseUrl }).request('/repos/a/b');

    expect(received['authorization']).toBe('Bearer ghp_fixture_only');
  });
});

describe('rate-limit headers', () => {
  it('surfaces limit, remaining, used, resource and reset from a real captured header set', async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200, { ...headersOf('repo_200'), 'content-type': 'application/json' });
      res.end(JSON.stringify(capturedBodies.repo_body));
    });

    const response = await new GitHubClient({ baseUrl }).request('/repos/a/b');

    expect(response.rateLimit).toEqual({
      resource: 'core',
      limit: 60,
      remaining: 59,
      used: 1,
      // 1786747836 is the epoch-seconds value GitHub actually sent.
      resetAt: new Date(1_786_747_836 * 1000),
    });
  });

  it('reports the search resource separately from core — they are different budgets', async () => {
    // Confirmed live: search says `resource: search, limit: 10` while core says
    // `resource: core, limit: 60` on the very same client. One global counter
    // would misreport both.
    const baseUrl = await serve((req, res) => {
      const set = req.url?.startsWith('/search') ? 'search_repositories_200' : 'repo_200';
      res.writeHead(200, { ...headersOf(set), 'content-type': 'application/json' });
      res.end('{}');
    });

    const client = new GitHubClient({ baseUrl });
    await client.request('/search/repositories?q=topic:mcp', { minIntervalMs: 0 });
    await client.request('/repos/a/b', { minIntervalMs: 0 });

    expect(client.budget('search')).toMatchObject({ resource: 'search', limit: 10, remaining: 9 });
    expect(client.budget('core')).toMatchObject({ resource: 'core', limit: 60, remaining: 59 });
  });

  it('reports no budget for a resource it has not yet observed', async () => {
    expect(new GitHubClient({ baseUrl: 'http://127.0.0.1:1' }).budget('core')).toBeNull();
  });

  it('tolerates a response with no rate-limit headers at all', async () => {
    // A proxy, a cache, or a future API change could strip them. Reporting null
    // is honest; inventing a zero would trip the exhaustion guard for no reason.
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });

    const response = await new GitHubClient({ baseUrl }).request('/repos/a/b');

    expect(response.rateLimit).toBeNull();
  });
});

describe('per-host spacing', () => {
  /**
   * ## Measured CLIENT-SIDE, and the distinction is the whole point
   *
   * These two tests used to time the gap between when the *server handler*
   * ran for each request, and assert it was >= the interval. That measures
   * the wrong window, and it was wrong on an idle machine, not merely flaky
   * under load:
   *
   *     server-arrival gap   : 292 ms   <- asserted >= 295
   *     client total elapsed : 302 ms
   *     arrival[0] - t0      :   9 ms   <- connection setup
   *
   * `#acquireSlot` spaces the moments the client *starts* each request. What
   * a server handler observes is `start + latency`, so the measured gap is
   * `interval + (latency_n - latency_n-1)` — and that correction term is
   * reliably NEGATIVE here, because the first request to a fresh local server
   * pays TCP connect and the second reuses a warm socket. The gap therefore
   * sits at roughly `interval - 9ms` by construction, and the assertion
   * passed only while socket setup happened to fit inside the 5 ms tolerance.
   *
   * Timing the client instead removes that term entirely. Total elapsed for
   * N serialized requests is `>= (N-1) * interval` no matter what latency
   * does, because latency can only push the finish *later*. **The failure
   * direction is now the safe one**: a loaded machine makes these pass more
   * easily rather than less, which is exactly the property a wall-clock
   * assertion needs to be worth keeping.
   *
   * The tolerance below is retained for timer coarseness only — `setTimeout`
   * may fire a fraction early — not for latency, which no longer enters.
   */
  const TIMER_TOLERANCE_MS = 5;

  it('spaces consecutive request starts by minIntervalMs', async () => {
    const starts: number[] = [];
    const baseUrl = await serve((_req, res) => {
      starts.push(Date.now());
      res.writeHead(200, { ...headersOf('repo_200'), 'content-type': 'application/json' });
      res.end('{}');
    });

    const client = new GitHubClient({ baseUrl });
    const began = Date.now();
    await client.request('/repos/a/b', { minIntervalMs: 300 });
    await client.request('/repos/c/d', { minIntervalMs: 300 });
    const elapsed = Date.now() - began;

    expect(starts).toHaveLength(2);
    // The first request is not delayed (the slot opens at 0), so the whole
    // 300 ms sits between them.
    expect(elapsed).toBeGreaterThanOrEqual(300 - TIMER_TOLERANCE_MS);
    // Latency-free corroboration that the gate ordered them at all: the
    // second request cannot have reached the server before the first.
    expect(starts[1]!).toBeGreaterThanOrEqual(starts[0]!);
  });

  it('serializes concurrent callers rather than letting them race past the gate', async () => {
    const starts: number[] = [];
    const baseUrl = await serve((_req, res) => {
      starts.push(Date.now());
      res.writeHead(200, { ...headersOf('repo_200'), 'content-type': 'application/json' });
      res.end('{}');
    });

    const client = new GitHubClient({ baseUrl });
    const began = Date.now();
    await Promise.all([
      client.request('/repos/a/b', { minIntervalMs: 300 }),
      client.request('/repos/c/d', { minIntervalMs: 300 }),
      client.request('/repos/e/f', { minIntervalMs: 300 }),
    ]);
    const elapsed = Date.now() - began;

    expect(starts).toHaveLength(3);
    // Three callers fired at once still cost two full intervals. Racing past
    // the gate is what this rules out, and it would show as a much smaller
    // elapsed rather than as a wrong count.
    expect(elapsed).toBeGreaterThanOrEqual(600 - TIMER_TOLERANCE_MS);
  });
});

describe('the token never escapes', () => {
  // This repository is PUBLIC and a leaked PAT is the owner's GitHub account.
  // The value below is not a real credential, but every assertion here would
  // hold identically for one.
  const TOKEN = 'ghp_thisMustNeverAppearInAnyOutput0123456789';

  /** Every string a thrown error can realistically reach a log through. */
  function surfacesOf(err: unknown): string[] {
    const e = err as Error & Record<string, unknown>;
    return [
      e.message,
      e.stack ?? '',
      String(e),
      // Own properties — a caller serializing the error's fields.
      JSON.stringify(Object.getOwnPropertyNames(e).map((k) => [k, e[k]])),
      // The shape a structured logger (pino, Fastify's own) would emit.
      JSON.stringify(e, Object.getOwnPropertyNames(e)),
      inspect(e, { depth: 8 }),
    ];
  }

  it('does not leak the token through an error thrown from a failed authenticated request', async () => {
    // A real 401 from a real server, with the token really sent on the wire.
    let sawAuthorization = '';
    const baseUrl = await serve((req, res) => {
      sawAuthorization = String(req.headers.authorization ?? '');
      res.writeHead(401, { ...headersOf('repo_200'), 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Bad credentials' }));
    });

    const client = new GitHubClient({ token: TOKEN, baseUrl });
    const err = await client.request('/repos/a/b').then(
      () => { throw new Error('expected the 401 to reject'); },
      (e: unknown) => e,
    );

    // The token really did go out — otherwise this test proves nothing.
    expect(sawAuthorization).toBe(`Bearer ${TOKEN}`);
    for (const surface of surfacesOf(err)) {
      expect(surface).not.toContain(TOKEN);
    }
  });

  it('does not leak the token when the transport fails and the cause carries the request', async () => {
    // Nothing is listening on this port, so undici builds the error itself.
    // Port 1 is privileged and never bound by a test server.
    const client = new GitHubClient({ token: TOKEN, baseUrl: 'http://127.0.0.1:1' });
    const err = await client.request('/repos/a/b', { minIntervalMs: 0 }).then(
      () => { throw new Error('expected the connection failure to reject'); },
      (e: unknown) => e,
    );

    for (const surface of surfacesOf(err)) {
      expect(surface).not.toContain(TOKEN);
    }
  });

  it('does not leak the token when the response body exceeds the byte ceiling', async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200, { ...headersOf('repo_200'), 'content-type': 'application/json' });
      res.end('x'.repeat(4096));
    });

    const client = new GitHubClient({ token: TOKEN, baseUrl });
    const err = await client.request('/repos/a/b', { maxBytes: 128 }).then(
      () => { throw new Error('expected the oversized body to reject'); },
      (e: unknown) => e,
    );

    for (const surface of surfacesOf(err)) {
      expect(surface).not.toContain(TOKEN);
    }
  });

  it('keeps the token off the client itself, so logging the client cannot leak it', async () => {
    // A `#private` field is invisible to JSON.stringify, util.inspect, and
    // Object.keys — which is why it is a #field and not a `private` one
    // (TypeScript's `private` is erased at runtime and would serialize).
    const client = new GitHubClient({ token: TOKEN, baseUrl: 'http://127.0.0.1:1' });

    expect(JSON.stringify(client)).not.toContain(TOKEN);
    expect(inspect(client, { depth: 8 })).not.toContain(TOKEN);
    expect(Object.getOwnPropertyNames(client)).toHaveLength(0);
  });

  it('still reports mode without revealing anything about the token value', () => {
    const client = new GitHubClient({ token: TOKEN, baseUrl: 'http://127.0.0.1:1' });
    expect(client.mode).toBe('authenticated');
    expect(JSON.stringify({ mode: client.mode, limits: client.limits })).not.toContain(TOKEN);
  });
});

describe('rate-limit exhaustion', () => {
  /** Serves the given status/headers and counts how many requests arrived. */
  async function countingServer(
    status: number,
    headers: Record<string, string>,
    body = '{}',
  ): Promise<{ baseUrl: string; hits: () => number }> {
    let hits = 0;
    const baseUrl = await serve((_req, res) => {
      hits += 1;
      res.writeHead(status, { ...headers, 'content-type': 'application/json' });
      res.end(body);
    });
    return { baseUrl, hits: () => hits };
  }

  it('throws GitHubRateLimitError on a 403 whose remaining is zero, carrying the reset instant', async () => {
    // The real captured unauthenticated GraphQL 403: limit 0, remaining 0.
    const { baseUrl } = await countingServer(
      403,
      headersOf('graphql_403'),
      JSON.stringify(captured.graphql_403!._body),
    );

    const err = await new GitHubClient({ baseUrl }).request('/graphql').then(
      () => { throw new Error('expected the 403 to reject'); },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GitHubRateLimitError);
    const rateErr = err as GitHubRateLimitError;
    expect(rateErr.status).toBe(403);
    expect(rateErr.retryable).toBe(true);
    expect(rateErr.spent).toBe(true);
    expect(rateErr.resetAt).toEqual(new Date(1_786_747_911 * 1000));
  });

  it('throws GitHubRateLimitError on a 429 and reports retry-after in milliseconds', async () => {
    const { baseUrl } = await countingServer(
      429,
      headersOf('secondary_limit_429'),
      JSON.stringify(captured.secondary_limit_429!._body),
    );

    const err = await new GitHubClient({ baseUrl }).request('/repos/a/b').then(
      () => { throw new Error('expected the 429 to reject'); },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GitHubRateLimitError);
    // A secondary limit reports retry-after while `remaining` is still 23 —
    // reading remaining alone would miss it entirely.
    expect((err as GitHubRateLimitError).retryAfterMs).toBe(60_000);
    expect((err as GitHubRateLimitError).rateLimit?.remaining).toBe(23);
  });

  it('leaves a 403 that is not a rate limit as an ordinary error', async () => {
    // GitHub uses 403 for permission failures too. Misreporting one as a rate
    // limit would make a scheduler wait for a reset that fixes nothing.
    const { baseUrl } = await countingServer(403, { ...headersOf('repo_200') });

    const err = await new GitHubClient({ baseUrl }).request('/repos/a/b').then(
      () => { throw new Error('expected the 403 to reject'); },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err).not.toBeInstanceOf(GitHubRateLimitError);
    expect((err as GitHubApiError).retryable).toBe(false);
  });

  it('refuses to send at all once the observed remaining hits zero, without touching the network', async () => {
    // The decision requirement 3 asks for: fail fast rather than send a
    // request that is already known to be refused.
    const future = Math.floor(Date.now() / 1000) + 3600;
    const { baseUrl, hits } = await countingServer(200, {
      'x-ratelimit-limit': '60',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-used': '60',
      'x-ratelimit-resource': 'core',
      'x-ratelimit-reset': String(future),
    });

    const client = new GitHubClient({ baseUrl });
    await client.request('/repos/a/b', { minIntervalMs: 0 });
    expect(hits()).toBe(1);

    const err = await client.request('/repos/c/d', { minIntervalMs: 0 }).then(
      () => { throw new Error('expected the exhausted budget to reject'); },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect((err as GitHubRateLimitError).spent).toBe(false);
    expect((err as GitHubRateLimitError).retryable).toBe(true);
    // The whole point: no second request was made.
    expect(hits()).toBe(1);
  });

  it('resumes once the reset instant has passed', async () => {
    const past = Math.floor(Date.now() / 1000) - 1;
    const { baseUrl, hits } = await countingServer(200, {
      'x-ratelimit-limit': '60',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-used': '60',
      'x-ratelimit-resource': 'core',
      'x-ratelimit-reset': String(past),
    });

    const client = new GitHubClient({ baseUrl });
    await client.request('/repos/a/b', { minIntervalMs: 0 });
    await client.request('/repos/c/d', { minIntervalMs: 0 });

    expect(hits()).toBe(2);
  });

  it('an exhausted search budget does not block a core request', async () => {
    // Separate budgets, separate gates. Blocking core because search ran out
    // would strand the enrichment path for a full minute for no reason.
    const future = Math.floor(Date.now() / 1000) + 3600;
    let hits = 0;
    const baseUrl = await serve((req, res) => {
      hits += 1;
      const exhausted = req.url?.startsWith('/search');
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-ratelimit-limit': exhausted ? '10' : '60',
        'x-ratelimit-remaining': exhausted ? '0' : '59',
        'x-ratelimit-resource': exhausted ? 'search' : 'core',
        'x-ratelimit-reset': String(future),
      });
      res.end('{}');
    });

    const client = new GitHubClient({ baseUrl });
    await client.request('/search/repositories?q=x', { minIntervalMs: 0 });

    await expect(client.request('/search/repositories?q=y', { minIntervalMs: 0 })).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
    await expect(client.request('/repos/a/b', { minIntervalMs: 0 })).resolves.toMatchObject({ status: 200 });
    expect(hits).toBe(2);
  });

  it('honours a reserve, stopping short of zero so a caller can keep headroom', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const { baseUrl, hits } = await countingServer(200, {
      'x-ratelimit-limit': '60',
      'x-ratelimit-remaining': '5',
      'x-ratelimit-resource': 'core',
      'x-ratelimit-reset': String(future),
    });

    const client = new GitHubClient({ baseUrl, reserve: 5 });
    await client.request('/repos/a/b', { minIntervalMs: 0 });

    await expect(client.request('/repos/c/d', { minIntervalMs: 0 })).rejects.toBeInstanceOf(GitHubRateLimitError);
    expect(hits()).toBe(1);
  });

  it('never sleeps waiting for a reset — it rejects immediately', async () => {
    // A poll that blocks for up to an hour inside a scheduler tick is worse
    // than one that fails and gets retried by the existing backoff.
    const future = Math.floor(Date.now() / 1000) + 3600;
    const { baseUrl } = await countingServer(200, {
      'x-ratelimit-limit': '60',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-resource': 'core',
      'x-ratelimit-reset': String(future),
    });

    const client = new GitHubClient({ baseUrl });
    await client.request('/repos/a/b', { minIntervalMs: 0 });

    const startedAt = Date.now();
    await expect(client.request('/repos/c/d', { minIntervalMs: 0 })).rejects.toBeInstanceOf(GitHubRateLimitError);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe('conditional requests', () => {
  it('sends If-None-Match and If-Modified-Since when prior state is supplied', async () => {
    let received: IncomingHttpHeaders = {};
    const baseUrl = await serve((req, res) => {
      received = req.headers;
      res.writeHead(200, { ...headersOf('repo_200'), 'content-type': 'application/json' });
      res.end('{}');
    });

    await new GitHubClient({ baseUrl }).request('/repos/a/b', {
      etag: captured.repo_200!.etag,
      lastModified: captured.repo_200!['last-modified'],
    });

    expect(received['if-none-match']).toBe(captured.repo_200!.etag);
    expect(received['if-modified-since']).toBe(captured.repo_200!['last-modified']);
  });

  it('sends no conditional headers when there is no prior state', async () => {
    let received: IncomingHttpHeaders = {};
    const baseUrl = await serve((req, res) => {
      received = req.headers;
      res.writeHead(200, { ...headersOf('repo_200'), 'content-type': 'application/json' });
      res.end('{}');
    });

    await new GitHubClient({ baseUrl }).request('/repos/a/b');

    expect(received['if-none-match']).toBeUndefined();
    expect(received['if-modified-since']).toBeUndefined();
  });

  it('resolves a 304 as notModified with a null body rather than throwing', async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(304, headersOf('repo_304'));
      res.end();
    });

    const response = await new GitHubClient({ baseUrl }).request('/repos/a/b', {
      etag: captured.repo_200!.etag,
    });

    expect(response.status).toBe(304);
    expect(response.notModified).toBe(true);
    expect(response.data).toBeNull();
    expect(response.etag).toBe(captured.repo_200!.etag);
  });

  it('records the budget a 304 consumed — GitHub documents 304s as exempt, but they were not', async () => {
    // The finding this pins, measured live 2026-08-14: replaying a valid ETag
    // four times unauthenticated drove x-ratelimit-used 1 -> 2 -> 3 -> 4.
    // repo_200 was captured at used=1, repo_304 at used=2, on consecutive
    // requests. Code that assumes a 304 is free will overrun the 60/hour
    // ceiling, so the client must record what the 304 actually reported.
    const baseUrl = await serve((_req, res) => {
      res.writeHead(304, headersOf('repo_304'));
      res.end();
    });

    const client = new GitHubClient({ baseUrl });
    const response = await client.request('/repos/a/b', { etag: captured.repo_200!.etag });

    expect(response.rateLimit).toMatchObject({ used: 2, remaining: 58 });
    expect(client.budget('core')).toMatchObject({ used: 2, remaining: 58 });
    // Strictly one lower than the 200 that preceded it — the 304 was billed.
    expect(Number(captured.repo_200!['x-ratelimit-remaining'])).toBe(59);
  });

  it('reports a null etag for the Search API, which sends none', async () => {
    // Not an oversight in the fixture: the Search API answers with
    // `cache-control: no-cache` and no validator at all, so there is nothing
    // to store and a later conditional request is impossible. Task 4's search
    // adapter must not expect to save budget this way.
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200, { ...headersOf('search_repositories_200'), 'content-type': 'application/json' });
      res.end('{}');
    });

    const response = await new GitHubClient({ baseUrl }).request('/search/repositories?q=topic:mcp');

    expect(response.etag).toBeNull();
    expect(response.lastModified).toBeNull();
    expect(captured.search_repositories_200!['cache-control']).toBe('no-cache');
  });
});

describe('response parsing', () => {
  it('returns the parsed JSON body for a 200', async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200, { ...headersOf('repo_200'), 'content-type': 'application/json' });
      res.end(JSON.stringify(capturedBodies.repo_body));
    });

    const response = await new GitHubClient({ baseUrl }).request<{ full_name: string; stargazers_count: number }>(
      '/repos/modelcontextprotocol/servers',
    );

    expect(response.data?.full_name).toBe('modelcontextprotocol/servers');
    expect(typeof response.data?.stargazers_count).toBe('number');
  });

  it('rejects a body that exceeds the byte ceiling instead of buffering it', async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200, { ...headersOf('repo_200'), 'content-type': 'application/json' });
      res.end('x'.repeat(64 * 1024));
    });

    await expect(new GitHubClient({ baseUrl }).request('/repos/a/b', { maxBytes: 1024 })).rejects.toThrow(
      /exceeded the 1024-byte ceiling/,
    );
  });

  it('classifies a 5xx as retryable and a 404 as permanent', async () => {
    const serverError = await serve((_req, res) => {
      res.writeHead(503, headersOf('repo_200'));
      res.end('{}');
    });
    const notFound = await serve((_req, res) => {
      res.writeHead(404, headersOf('repo_200'));
      res.end('{}');
    });

    /** Resolves to the thrown error, or fails loudly if the request succeeded. */
    async function errorFrom(baseUrl: string): Promise<GitHubApiError> {
      try {
        await new GitHubClient({ baseUrl }).request('/repos/a/b');
      } catch (e) {
        return e as GitHubApiError;
      }
      throw new Error(`expected ${baseUrl} to reject`);
    }

    expect((await errorFrom(serverError)).retryable).toBe(true);
    expect((await errorFrom(notFound)).retryable).toBe(false);
  });
});

describe('resource derivation from a full URL', () => {
  it('gates a search request passed as a full URL against the search budget, not core', async () => {
    // request() resolves its argument with `new URL(path, baseUrl)`, so a full
    // URL is a legitimate way to call it — and GitHub's own `link` header
    // pagination hands back exactly that. Deriving the resource from the raw
    // string means a paginated search URL would be gated against `core`,
    // whose budget is 6x larger, so the search budget would be overrun.
    const future = Math.floor(Date.now() / 1000) + 3600;
    let hits = 0;
    const baseUrl = await serve((_req, res) => {
      hits += 1;
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-ratelimit-limit': '10',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-resource': 'search',
        'x-ratelimit-reset': String(future),
      });
      res.end('{}');
    });

    const client = new GitHubClient({ baseUrl });
    await client.request('/search/repositories?q=x', { minIntervalMs: 0 });
    expect(client.budget('search')?.remaining).toBe(0);

    // The follow-up page, as GitHub's `link` header would give it: absolute.
    await expect(
      client.request(`${baseUrl}/search/repositories?q=x&page=2`, { minIntervalMs: 0 }),
    ).rejects.toBeInstanceOf(GitHubRateLimitError);
    expect(hits).toBe(1);
  });

  it('falls back to the search resource for a full URL when the header is absent', async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-ratelimit-limit': '10' });
      res.end('{}');
    });

    const response = await new GitHubClient({ baseUrl }).request(`${baseUrl}/search/repositories?q=x`);

    expect(response.rateLimit?.resource).toBe('search');
  });
});
