import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isAllowed,
  fetchRobots,
  RobotsUnavailableError,
  ROBOTS_USER_AGENT,
} from '../../src/fetch/robots.ts';

// ---------------------------------------------------------------------------
// Real, checked-in fixtures. Fetched live on 2026-08-13 (see task-5-report.md
// for the exact commands/headers) so the tests below are deterministic and
// need no network -- both files are read once, verbatim, off disk.
// Resolved from import.meta.dirname, not process.cwd(): whatever eventually
// runs the test suite may do so from any working directory.
// ---------------------------------------------------------------------------

function loadFixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '..', 'fixtures', 'robots', name), 'utf8');
}

const AP_ROBOTS_TXT = loadFixture('apnews.robots.txt');
const REUTERS_ROBOTS_TXT = loadFixture('reuters.robots.txt');

describe('isAllowed', () => {
  describe('AP (apnews.com) -- permissive-with-exceptions shape', () => {
    // Real shape (verified 2026-08-13): `User-Agent: *` opens with a bare,
    // empty `Disallow:` (allow everything), then a run of specific
    // exceptions including `/*.rss` and `/api/v2/feed/`, then `Sitemap:`
    // lines, then separate single-agent `Disallow: /` groups for named AI
    // crawlers (CCBot, GPTBot, anthropic-ai, ClaudeBot, and others).

    it('allows the declared news sitemap', () => {
      expect(isAllowed(AP_ROBOTS_TXT, 'watchfloor', '/news-sitemap-content.xml')).toBe(true);
    });

    it('denies an .rss path via the /*.rss wildcard', () => {
      expect(isAllowed(AP_ROBOTS_TXT, 'watchfloor', '/some-article.rss')).toBe(false);
    });

    it('denies the JSON feed API prefix', () => {
      expect(isAllowed(AP_ROBOTS_TXT, 'watchfloor', '/api/v2/feed/anything')).toBe(false);
    });

    it('allows an ordinary article path', () => {
      expect(isAllowed(AP_ROBOTS_TXT, 'watchfloor', '/article/whatever')).toBe(true);
    });

    it.each(['ClaudeBot', 'GPTBot', 'CCBot', 'anthropic-ai'])(
      'denies %s everything, via its own named group',
      (namedAgent) => {
        expect(isAllowed(AP_ROBOTS_TXT, namedAgent, '/')).toBe(false);
        expect(isAllowed(AP_ROBOTS_TXT, namedAgent, '/article/whatever')).toBe(false);
        expect(isAllowed(AP_ROBOTS_TXT, namedAgent, '/news-sitemap-content.xml')).toBe(false);
      },
    );

    it('denies ClaudeBot while leaving watchfloor unaffected on the identical path', () => {
      // These two files encode genuinely different rules for different
      // agents -- proving this on the SAME path is what would catch the
      // rules being conflated.
      expect(isAllowed(AP_ROBOTS_TXT, 'ClaudeBot', '/article/whatever')).toBe(false);
      expect(isAllowed(AP_ROBOTS_TXT, 'watchfloor', '/article/whatever')).toBe(true);
    });

    it('a Sitemap: directive does not grant any special access', () => {
      // AP's own declared sitemaps happen to all be independently allowed
      // already (none collide with its Disallow exceptions), so this checks
      // the inverse and more telling direction: naming a URL in `Sitemap:`
      // is not itself a grant -- an otherwise-disallowed path stays denied
      // even though it shares a host with declared sitemaps.
      expect(isAllowed(AP_ROBOTS_TXT, 'watchfloor', '/some-article.rss')).toBe(false);
    });
  });

  describe('Reuters (www.reuters.com) -- allowlist shape', () => {
    // Real shape (verified 2026-08-13): ~90 named agents (Googlebot,
    // Bingbot, Applebot, ...) share one group with a handful of specific
    // Disallow exceptions and NO explicit Allow -- they rely on the default
    // "nothing in the group matches -> allowed" rule for the rest of the
    // site. Separately, `User-agent: *` / `Allow: /plus/` / `Disallow: /`
    // is the catch-all every unnamed agent (including watchfloor) falls to.

    it('denies the root path', () => {
      expect(isAllowed(REUTERS_ROBOTS_TXT, 'watchfloor', '/')).toBe(false);
    });

    it('denies an arbitrary article path', () => {
      expect(isAllowed(REUTERS_ROBOTS_TXT, 'watchfloor', '/world/uk/example-story-2026-08-13/')).toBe(
        false,
      );
    });

    it('allows /plus/ paths -- the more specific Allow beats the broader Disallow', () => {
      expect(isAllowed(REUTERS_ROBOTS_TXT, 'watchfloor', '/plus/something')).toBe(true);
    });

    it('a Sitemap: directive does not rescue a path the matching group denies', () => {
      // Real sitemap URL straight from this fixture's own Sitemap: lines --
      // its path doesn't start with /plus/, so the * group's Disallow: /
      // still applies to watchfloor despite the operator listing it as a
      // sitemap for OTHER (allowlisted) crawlers to read.
      expect(
        isAllowed(REUTERS_ROBOTS_TXT, 'watchfloor', '/arc/outboundfeeds/sitemap-index/'),
      ).toBe(false);
    });

    it('allows an allowlisted agent (Googlebot) where watchfloor is denied the identical path', () => {
      const path = '/world/uk/example-story-2026-08-13/';
      expect(isAllowed(REUTERS_ROBOTS_TXT, 'Googlebot', path)).toBe(true);
      expect(isAllowed(REUTERS_ROBOTS_TXT, 'watchfloor', path)).toBe(false);
    });
  });

  describe('group selection and matching mechanics (synthetic fixtures)', () => {
    it('the longest matching pattern wins regardless of file order', () => {
      const txt = ['User-agent: *', 'Disallow: /downloads', 'Allow: /downloads/free'].join('\n');
      expect(isAllowed(txt, 'watchfloor', '/downloads/free/report.pdf')).toBe(true);
      expect(isAllowed(txt, 'watchfloor', '/downloads/paid/report.pdf')).toBe(false);
    });

    it('a tie in match length resolves to Allow', () => {
      const txt = ['User-agent: *', 'Disallow: /docs', 'Allow: /docs'].join('\n');
      expect(isAllowed(txt, 'watchfloor', '/docs')).toBe(true);
    });

    it('* matches any run of characters within a path', () => {
      const txt = ['User-agent: *', 'Disallow: /files/*/private'].join('\n');
      expect(isAllowed(txt, 'watchfloor', '/files/2026/private')).toBe(false);
      expect(isAllowed(txt, 'watchfloor', '/files/anything-at-all/private')).toBe(false);
      expect(isAllowed(txt, 'watchfloor', '/files/2026/public')).toBe(true);
    });

    it('$ anchors a pattern to the end of the path', () => {
      const txt = ['User-agent: *', 'Disallow: /file$'].join('\n');
      expect(isAllowed(txt, 'watchfloor', '/file')).toBe(false);
      expect(isAllowed(txt, 'watchfloor', '/filename')).toBe(true);
      expect(isAllowed(txt, 'watchfloor', '/file/nested')).toBe(true);
    });

    it('directive field names are matched case-insensitively', () => {
      const txt = ['USER-AGENT: *', 'DISALLOW: /private'].join('\n');
      expect(isAllowed(txt, 'watchfloor', '/private/data')).toBe(false);
      expect(isAllowed(txt, 'watchfloor', '/public')).toBe(true);
    });

    it('user-agent values are matched case-insensitively', () => {
      const txt = ['User-agent: GPTBot', 'Disallow: /'].join('\n');
      expect(isAllowed(txt, 'gptbot', '/anything')).toBe(false);
      expect(isAllowed(txt, 'GPTBOT', '/anything')).toBe(false);
      expect(isAllowed(txt, 'GptBot', '/anything')).toBe(false);
    });

    it('paths remain case-sensitive, unlike user-agents and directive names', () => {
      const txt = ['User-agent: *', 'Disallow: /Private'].join('\n');
      expect(isAllowed(txt, 'watchfloor', '/Private/data')).toBe(false);
      expect(isAllowed(txt, 'watchfloor', '/private/data')).toBe(true);
    });

    it('an unknown agent falls back to the * group', () => {
      const txt = ['User-agent: SomeOtherBot', 'Disallow: /x', '', 'User-agent: *', 'Disallow: /y'].join(
        '\n',
      );
      expect(isAllowed(txt, 'watchfloor', '/y/anything')).toBe(false);
      expect(isAllowed(txt, 'watchfloor', '/x/anything')).toBe(true);
    });

    it('no matching group at all (named agent only, no *) resolves to allow', () => {
      const txt = ['User-agent: Googlebot', 'Disallow: /'].join('\n');
      expect(isAllowed(txt, 'watchfloor', '/anything')).toBe(true);
    });

    it('an empty robots.txt resolves to allow', () => {
      expect(isAllowed('', 'watchfloor', '/anything')).toBe(true);
    });

    it('consecutive User-agent lines share one group and its rules', () => {
      const txt = ['User-agent: AgentA', 'User-agent: AgentB', 'Disallow: /shared'].join('\n');
      expect(isAllowed(txt, 'AgentA', '/shared/x')).toBe(false);
      expect(isAllowed(txt, 'AgentB', '/shared/x')).toBe(false);
      expect(isAllowed(txt, 'AgentA', '/other')).toBe(true);
    });

    it('a Sitemap line between two groups does not merge them', () => {
      const txt = [
        'User-agent: AgentA',
        'Disallow: /a',
        'Sitemap: https://example.com/sitemap.xml',
        'User-agent: AgentB',
        'Disallow: /b',
      ].join('\n');
      expect(isAllowed(txt, 'AgentA', '/a')).toBe(false);
      expect(isAllowed(txt, 'AgentA', '/b')).toBe(true);
      expect(isAllowed(txt, 'AgentB', '/b')).toBe(false);
      expect(isAllowed(txt, 'AgentB', '/a')).toBe(true);
    });

    it('a malformed line (no colon) is skipped rather than throwing', () => {
      const txt = ['User-agent: *', 'this is not a directive', 'Disallow: /private'].join('\n');
      expect(() => isAllowed(txt, 'watchfloor', '/private')).not.toThrow();
      expect(isAllowed(txt, 'watchfloor', '/private')).toBe(false);
      expect(isAllowed(txt, 'watchfloor', '/public')).toBe(true);
    });

    it('a rule line before any User-agent line is ignored', () => {
      const txt = ['Disallow: /orphan', 'User-agent: *', 'Disallow: /private'].join('\n');
      expect(isAllowed(txt, 'watchfloor', '/orphan')).toBe(true);
      expect(isAllowed(txt, 'watchfloor', '/private')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// fetchRobots: the only I/O in this module. Exercised against a real
// node:http server on an ephemeral port -- no mocks, no external network.
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer(handler: RequestListener): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected an AddressInfo from an ephemeral TCP listener');
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeAllConnections();
  });
}

const openServers: Server[] = [];

async function serve(handler: RequestListener): Promise<string> {
  const { server, baseUrl } = await startServer(handler);
  openServers.push(server);
  return baseUrl;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(closeServer));
});

describe('fetchRobots', () => {
  it('fetches and returns the robots.txt body on 200', async () => {
    const body = 'User-agent: *\nDisallow: /private\n';
    const baseUrl = await serve((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(body);
    });

    expect(await fetchRobots(baseUrl)).toBe(body);
  });

  it('sends an identifying User-Agent', async () => {
    let received: string | undefined;
    const baseUrl = await serve((req, res) => {
      received = req.headers['user-agent'];
      res.writeHead(200);
      res.end('User-agent: *\nDisallow:\n');
    });

    await fetchRobots(baseUrl);

    expect(received).toBe(ROBOTS_USER_AGENT);
    expect(ROBOTS_USER_AGENT.toLowerCase()).toContain('watchfloor');
  });

  it('requests /robots.txt at the given origin', async () => {
    let receivedPath: string | undefined;
    const baseUrl = await serve((req, res) => {
      receivedPath = req.url;
      res.writeHead(200);
      res.end('User-agent: *\nDisallow:\n');
    });

    await fetchRobots(baseUrl);

    expect(receivedPath).toBe('/robots.txt');
  });

  it('caches the result: a second call within the TTL does not hit the network again', async () => {
    let hitCount = 0;
    const baseUrl = await serve((req, res) => {
      hitCount++;
      res.writeHead(200);
      res.end('User-agent: *\nDisallow: /private\n');
    });

    const first = await fetchRobots(baseUrl);
    const second = await fetchRobots(baseUrl);

    expect(hitCount).toBe(1);
    expect(second).toBe(first);
  });

  it('re-fetches once the cache entry is older than ttlMs', async () => {
    let hitCount = 0;
    const baseUrl = await serve((req, res) => {
      hitCount++;
      res.writeHead(200);
      res.end(`User-agent: *\nDisallow: /v${hitCount}\n`);
    });

    await fetchRobots(baseUrl, { ttlMs: 50 });
    await sleep(80);
    await fetchRobots(baseUrl, { ttlMs: 50 });

    expect(hitCount).toBe(2);
  });

  it('caches per origin independently', async () => {
    let hitsA = 0;
    let hitsB = 0;
    const baseUrlA = await serve((req, res) => {
      hitsA++;
      res.writeHead(200);
      res.end('User-agent: *\nDisallow: /a\n');
    });
    const baseUrlB = await serve((req, res) => {
      hitsB++;
      res.writeHead(200);
      res.end('User-agent: *\nDisallow: /b\n');
    });

    await fetchRobots(baseUrlA);
    await fetchRobots(baseUrlB);
    await fetchRobots(baseUrlA);
    await fetchRobots(baseUrlB);

    expect(hitsA).toBe(1);
    expect(hitsB).toBe(1);
  });

  it('treats a 404 as "no robots.txt" -- an empty string meaning allow-all -- and caches it', async () => {
    let hitCount = 0;
    const baseUrl = await serve((req, res) => {
      hitCount++;
      res.writeHead(404);
      res.end('not found');
    });

    const body = await fetchRobots(baseUrl);
    expect(body).toBe('');
    expect(isAllowed(body, 'watchfloor', '/anything')).toBe(true);

    await fetchRobots(baseUrl);
    expect(hitCount).toBe(1);
  });

  it('treats 403 the same as 404 -- a 4xx is a definitive "no file", not uncertainty', async () => {
    const baseUrl = await serve((req, res) => {
      res.writeHead(403);
      res.end('forbidden');
    });

    expect(await fetchRobots(baseUrl)).toBe('');
  });

  it('rejects on 5xx and does NOT cache the failure, so the next call retries', async () => {
    let hitCount = 0;
    const baseUrl = await serve((req, res) => {
      hitCount++;
      res.writeHead(503);
      res.end('unavailable');
    });

    try {
      await fetchRobots(baseUrl);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RobotsUnavailableError);
    }
    expect(hitCount).toBe(1);

    try {
      await fetchRobots(baseUrl);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RobotsUnavailableError);
    }
    expect(hitCount).toBe(2);
  });

  it('rejects when the origin is unreachable (connection refused)', async () => {
    const { server, baseUrl } = await startServer((req, res) => {
      res.writeHead(200);
      res.end('');
    });
    await closeServer(server); // nothing is listening on baseUrl's port anymore

    try {
      await fetchRobots(baseUrl);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RobotsUnavailableError);
    }
  });

  it('rejects when the request times out', async () => {
    const baseUrl = await serve((req, res) => {
      res.on('error', () => {});
      // never respond
    });

    const start = Date.now();
    try {
      await fetchRobots(baseUrl, { timeoutMs: 150 });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RobotsUnavailableError);
    }
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('a rejected fetch carries the origin so a caller can log/record which source failed', async () => {
    const baseUrl = await serve((req, res) => {
      res.writeHead(503);
      res.end('unavailable');
    });

    try {
      await fetchRobots(baseUrl);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RobotsUnavailableError);
      expect((e as RobotsUnavailableError).origin).toBe(baseUrl);
    }
  });
});
