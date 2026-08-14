import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { join } from 'node:path';
import { GitHubClient, RATE_LIMITS } from '../../src/fetch/github.ts';
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
  it('spaces consecutive request starts by minIntervalMs', async () => {
    const starts: number[] = [];
    const baseUrl = await serve((_req, res) => {
      starts.push(Date.now());
      res.writeHead(200, { ...headersOf('repo_200'), 'content-type': 'application/json' });
      res.end('{}');
    });

    const client = new GitHubClient({ baseUrl });
    await client.request('/repos/a/b', { minIntervalMs: 300 });
    await client.request('/repos/c/d', { minIntervalMs: 300 });

    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(295);
  });

  it('serializes concurrent callers rather than letting them race past the gate', async () => {
    const starts: number[] = [];
    const baseUrl = await serve((_req, res) => {
      starts.push(Date.now());
      res.writeHead(200, { ...headersOf('repo_200'), 'content-type': 'application/json' });
      res.end('{}');
    });

    const client = new GitHubClient({ baseUrl });
    await Promise.all([
      client.request('/repos/a/b', { minIntervalMs: 300 }),
      client.request('/repos/c/d', { minIntervalMs: 300 }),
      client.request('/repos/e/f', { minIntervalMs: 300 }),
    ]);

    expect(starts).toHaveLength(3);
    expect(starts[2]! - starts[0]!).toBeGreaterThanOrEqual(590);
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
