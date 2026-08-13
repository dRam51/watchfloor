import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isAllowed,
  fetchRobots,
  stripLeadingBom,
  RobotsUnavailableError,
  RobotsHostMismatchError,
  PRODUCT_TOKEN,
} from '../../src/fetch/robots.ts';
// Fix round 1, Finding 4: import the real USER_AGENT directly from http.ts
// (now stable, so the earlier "don't couple to an in-flight file" constraint
// no longer applies) rather than a robots.ts-local literal, so this test
// pins fetchRobots against the identity actually sent, not a copy of it.
import { USER_AGENT } from '../../src/fetch/http.ts';

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

// Fix round 2: isAllowed now requires the origin whose robots.txt is being
// evaluated, so it can refuse to check a path against the wrong file (see
// RobotsHostMismatchError). These match the real hosts each fixture was
// fetched from; EXAMPLE_ORIGIN is an arbitrary placeholder used only by the
// synthetic-fixture tests below, none of which test cross-origin behaviour.
const AP_ORIGIN = 'https://apnews.com';
const REUTERS_ORIGIN = 'https://www.reuters.com';
const EXAMPLE_ORIGIN = 'https://example.com';

describe('isAllowed', () => {
  describe('AP (apnews.com) -- permissive-with-exceptions shape', () => {
    // Real shape (verified 2026-08-13): `User-Agent: *` opens with a bare,
    // empty `Disallow:` (allow everything), then a run of specific
    // exceptions including `/*.rss` and `/api/v2/feed/`, then `Sitemap:`
    // lines, then separate single-agent `Disallow: /` groups for named AI
    // crawlers (CCBot, GPTBot, anthropic-ai, ClaudeBot, and others).

    it('allows the declared news sitemap', () => {
      expect(isAllowed(AP_ROBOTS_TXT, PRODUCT_TOKEN, '/news-sitemap-content.xml', AP_ORIGIN)).toBe(true);
    });

    it('denies an .rss path via the /*.rss wildcard', () => {
      expect(isAllowed(AP_ROBOTS_TXT, PRODUCT_TOKEN, '/some-article.rss', AP_ORIGIN)).toBe(false);
    });

    it('denies the JSON feed API prefix', () => {
      expect(isAllowed(AP_ROBOTS_TXT, PRODUCT_TOKEN, '/api/v2/feed/anything', AP_ORIGIN)).toBe(false);
    });

    it('allows an ordinary article path', () => {
      expect(isAllowed(AP_ROBOTS_TXT, PRODUCT_TOKEN, '/article/whatever', AP_ORIGIN)).toBe(true);
    });

    it.each(['ClaudeBot', 'GPTBot', 'CCBot', 'anthropic-ai'])(
      'denies %s everything, via its own named group',
      (namedAgent) => {
        expect(isAllowed(AP_ROBOTS_TXT, namedAgent, '/', AP_ORIGIN)).toBe(false);
        expect(isAllowed(AP_ROBOTS_TXT, namedAgent, '/article/whatever', AP_ORIGIN)).toBe(false);
        expect(isAllowed(AP_ROBOTS_TXT, namedAgent, '/news-sitemap-content.xml', AP_ORIGIN)).toBe(false);
      },
    );

    it('denies ClaudeBot while leaving watchfloor unaffected on the identical path', () => {
      // These two files encode genuinely different rules for different
      // agents -- proving this on the SAME path is what would catch the
      // rules being conflated.
      expect(isAllowed(AP_ROBOTS_TXT, 'ClaudeBot', '/article/whatever', AP_ORIGIN)).toBe(false);
      expect(isAllowed(AP_ROBOTS_TXT, PRODUCT_TOKEN, '/article/whatever', AP_ORIGIN)).toBe(true);
    });

    // Fix round 1, bundled minor: the previous test here ("a Sitemap:
    // directive does not grant any special access") was a byte-identical
    // duplicate of "denies an .rss path via the /*.rss wildcard" above --
    // same fixture, same agent, same path, same expectation -- and touched
    // no Sitemap URL at all, so it could not have caught a Sitemap line
    // being mis-parsed as a grant. Deleted rather than patched: the
    // Reuters test below ("a Sitemap: directive does not rescue...") is the
    // real version of this assertion, built from an actual Sitemap: URL in
    // that fixture, and AP has no naturally-denied sitemap path to build an
    // equivalent from (see that test's comment).
  });

  describe('Reuters (www.reuters.com) -- allowlist shape', () => {
    // Real shape (verified 2026-08-13): ~90 named agents (Googlebot,
    // Bingbot, Applebot, ...) share one group with a handful of specific
    // Disallow exceptions and NO explicit Allow -- they rely on the default
    // "nothing in the group matches -> allowed" rule for the rest of the
    // site. Separately, `User-agent: *` / `Allow: /plus/` / `Disallow: /`
    // is the catch-all every unnamed agent (including watchfloor) falls to.

    it('denies the root path', () => {
      expect(isAllowed(REUTERS_ROBOTS_TXT, PRODUCT_TOKEN, '/', REUTERS_ORIGIN)).toBe(false);
    });

    it('denies an arbitrary article path', () => {
      expect(
        isAllowed(REUTERS_ROBOTS_TXT, PRODUCT_TOKEN, '/world/uk/example-story-2026-08-13/', REUTERS_ORIGIN),
      ).toBe(false);
    });

    it('allows /plus/ paths -- the more specific Allow beats the broader Disallow', () => {
      expect(isAllowed(REUTERS_ROBOTS_TXT, PRODUCT_TOKEN, '/plus/something', REUTERS_ORIGIN)).toBe(true);
    });

    it('a Sitemap: directive does not rescue a path the matching group denies', () => {
      // Real sitemap URL straight from this fixture's own Sitemap: lines --
      // its path doesn't start with /plus/, so the * group's Disallow: /
      // still applies to watchfloor despite the operator listing it as a
      // sitemap for OTHER (allowlisted) crawlers to read.
      expect(
        isAllowed(REUTERS_ROBOTS_TXT, PRODUCT_TOKEN, '/arc/outboundfeeds/sitemap-index/', REUTERS_ORIGIN),
      ).toBe(false);
    });

    it('allows an allowlisted agent (Googlebot) where watchfloor is denied the identical path', () => {
      const path = '/world/uk/example-story-2026-08-13/';
      expect(isAllowed(REUTERS_ROBOTS_TXT, 'Googlebot', path, REUTERS_ORIGIN)).toBe(true);
      expect(isAllowed(REUTERS_ROBOTS_TXT, PRODUCT_TOKEN, path, REUTERS_ORIGIN)).toBe(false);
    });
  });

  describe('origin validation -- path must never be checked against the wrong host (fix round 2, Finding 1a/1b/1c)', () => {
    // Round 1 added support for a full URL and a bare relative path in
    // `path`, but validated neither against which host the `robotsTxt`
    // being checked actually belongs to, and stripped the fragment only on
    // the full-URL branch. All three gaps landed wrongly-ALLOWED -- the one
    // direction this module exists to prevent -- and are closed together by
    // resolving `path` against the required `origin` argument and
    // validating the resolved host against it (see normalizePath's doc
    // comment for the full mechanism).

    it('Finding 1a: throws rather than silently checking a path against the WRONG host\'s robots.txt', () => {
      // Ground truth, for contrast (also proven independently above):
      // Reuters denies this path under its OWN robots.txt.
      expect(
        isAllowed(REUTERS_ROBOTS_TXT, PRODUCT_TOKEN, '/world/uk/example-story-2026-08-13/', REUTERS_ORIGIN),
      ).toBe(false);

      // The bug: the IDENTICAL Reuters URL, checked against AP's robots.txt
      // (the wrong file for this URL), used to come back allowed -- AP's
      // rules simply never mention a Reuters path, so "no rule matched"
      // silently defaulted to allow, overriding what Reuters itself says.
      // Checking the wrong file must never produce ANY answer -- right or
      // wrong -- it must fail loudly instead of guessing.
      expect(() =>
        isAllowed(
          AP_ROBOTS_TXT,
          PRODUCT_TOKEN,
          'https://www.reuters.com/world/uk/example-story-2026-08-13/',
          AP_ORIGIN,
        ),
      ).toThrow(RobotsHostMismatchError);
    });

    it('Finding 1b: a protocol-relative reference to the SAME host resolves and is correctly denied', () => {
      expect(isAllowed(AP_ROBOTS_TXT, PRODUCT_TOKEN, '//apnews.com/api/v2/feed/x', AP_ORIGIN)).toBe(false);
    });

    it('the trap named in fix round 2: a protocol-relative reference to a DIFFERENT host still throws, not just a full URL', () => {
      // Resolving //evil.test/x against a THROWAWAY/placeholder base would
      // silently produce a real, wrong-host URL with no check at all --
      // reintroducing Finding 1a through the back door. Resolving against
      // the REAL expected origin, then validating the resolved origin
      // against it, closes both 1a and 1b together.
      expect(() => isAllowed(AP_ROBOTS_TXT, PRODUCT_TOKEN, '//evil.test/x', AP_ORIGIN)).toThrow(
        RobotsHostMismatchError,
      );
    });

    it('Finding 1c: the fragment is stripped uniformly, including on the plain-path branch', () => {
      const txt = ['User-agent: *', 'Disallow: /a$'].join('\n');
      expect(isAllowed(txt, PRODUCT_TOKEN, '/a', EXAMPLE_ORIGIN)).toBe(false);
      // Previously true (wrongly allowed): the $-anchor correctly denies
      // exactly "/a", but the plain-path branch used to pass "/a#frag"
      // through unmodified, and "/a#frag" does not match ^/a$.
      expect(isAllowed(txt, PRODUCT_TOKEN, '/a#frag', EXAMPLE_ORIGIN)).toBe(false);
    });

    it('the thrown error names both the expected and the actual (mismatched) origin', () => {
      try {
        isAllowed(AP_ROBOTS_TXT, PRODUCT_TOKEN, 'https://www.reuters.com/x', AP_ORIGIN);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(RobotsHostMismatchError);
        expect((e as RobotsHostMismatchError).expectedOrigin).toBe('https://apnews.com');
        expect((e as RobotsHostMismatchError).actualOrigin).toBe('https://www.reuters.com');
      }
    });
  });

  describe('group selection and matching mechanics (synthetic fixtures)', () => {
    it('the longest matching pattern wins regardless of file order', () => {
      const txt = ['User-agent: *', 'Disallow: /downloads', 'Allow: /downloads/free'].join('\n');
      expect(isAllowed(txt, PRODUCT_TOKEN, '/downloads/free/report.pdf', EXAMPLE_ORIGIN)).toBe(true);
      expect(isAllowed(txt, PRODUCT_TOKEN, '/downloads/paid/report.pdf', EXAMPLE_ORIGIN)).toBe(false);
    });

    it('the longest matching pattern still wins when the shorter, denying rule comes LAST in the file', () => {
      // Fix round 1, bundled minor: the test above puts Disallow before
      // Allow, and Allow also happens to be both the longer AND the last
      // rule in the file -- so a buggy "last rule in the file wins"
      // implementation would pass it too, for the wrong reason. Reversing
      // the order here (Allow first, Disallow last) while keeping Allow the
      // longer pattern isolates "file order" from "pattern length": only an
      // implementation that genuinely compares lengths gets this right.
      const txt = ['User-agent: *', 'Allow: /downloads/free', 'Disallow: /downloads'].join('\n');
      expect(isAllowed(txt, PRODUCT_TOKEN, '/downloads/free/report.pdf', EXAMPLE_ORIGIN)).toBe(true);
      expect(isAllowed(txt, PRODUCT_TOKEN, '/downloads/paid/report.pdf', EXAMPLE_ORIGIN)).toBe(false);
    });

    it('a tie in match length resolves to Allow', () => {
      const txt = ['User-agent: *', 'Disallow: /docs', 'Allow: /docs'].join('\n');
      expect(isAllowed(txt, PRODUCT_TOKEN, '/docs', EXAMPLE_ORIGIN)).toBe(true);
    });

    it('* matches any run of characters within a path', () => {
      const txt = ['User-agent: *', 'Disallow: /files/*/private'].join('\n');
      expect(isAllowed(txt, PRODUCT_TOKEN, '/files/2026/private', EXAMPLE_ORIGIN)).toBe(false);
      expect(isAllowed(txt, PRODUCT_TOKEN, '/files/anything-at-all/private', EXAMPLE_ORIGIN)).toBe(false);
      expect(isAllowed(txt, PRODUCT_TOKEN, '/files/2026/public', EXAMPLE_ORIGIN)).toBe(true);
    });

    it('$ anchors a pattern to the end of the path', () => {
      const txt = ['User-agent: *', 'Disallow: /file$'].join('\n');
      expect(isAllowed(txt, PRODUCT_TOKEN, '/file', EXAMPLE_ORIGIN)).toBe(false);
      expect(isAllowed(txt, PRODUCT_TOKEN, '/filename', EXAMPLE_ORIGIN)).toBe(true);
      expect(isAllowed(txt, PRODUCT_TOKEN, '/file/nested', EXAMPLE_ORIGIN)).toBe(true);
    });

    it('directive field names are matched case-insensitively', () => {
      const txt = ['USER-AGENT: *', 'DISALLOW: /private'].join('\n');
      expect(isAllowed(txt, PRODUCT_TOKEN, '/private/data', EXAMPLE_ORIGIN)).toBe(false);
      expect(isAllowed(txt, PRODUCT_TOKEN, '/public', EXAMPLE_ORIGIN)).toBe(true);
    });

    it('user-agent values are matched case-insensitively', () => {
      const txt = ['User-agent: GPTBot', 'Disallow: /'].join('\n');
      expect(isAllowed(txt, 'gptbot', '/anything', EXAMPLE_ORIGIN)).toBe(false);
      expect(isAllowed(txt, 'GPTBOT', '/anything', EXAMPLE_ORIGIN)).toBe(false);
      expect(isAllowed(txt, 'GptBot', '/anything', EXAMPLE_ORIGIN)).toBe(false);
    });

    it('paths remain case-sensitive, unlike user-agents and directive names', () => {
      const txt = ['User-agent: *', 'Disallow: /Private'].join('\n');
      expect(isAllowed(txt, PRODUCT_TOKEN, '/Private/data', EXAMPLE_ORIGIN)).toBe(false);
      expect(isAllowed(txt, PRODUCT_TOKEN, '/private/data', EXAMPLE_ORIGIN)).toBe(true);
    });

    it('an unknown agent falls back to the * group', () => {
      const txt = ['User-agent: SomeOtherBot', 'Disallow: /x', '', 'User-agent: *', 'Disallow: /y'].join(
        '\n',
      );
      expect(isAllowed(txt, PRODUCT_TOKEN, '/y/anything', EXAMPLE_ORIGIN)).toBe(false);
      expect(isAllowed(txt, PRODUCT_TOKEN, '/x/anything', EXAMPLE_ORIGIN)).toBe(true);
    });

    it('no matching group at all (named agent only, no *) resolves to allow', () => {
      const txt = ['User-agent: Googlebot', 'Disallow: /'].join('\n');
      expect(isAllowed(txt, PRODUCT_TOKEN, '/anything', EXAMPLE_ORIGIN)).toBe(true);
    });

    it('an empty robots.txt resolves to allow', () => {
      expect(isAllowed('', PRODUCT_TOKEN, '/anything', EXAMPLE_ORIGIN)).toBe(true);
    });

    it('consecutive User-agent lines share one group and its rules', () => {
      const txt = ['User-agent: AgentA', 'User-agent: AgentB', 'Disallow: /shared'].join('\n');
      expect(isAllowed(txt, 'AgentA', '/shared/x', EXAMPLE_ORIGIN)).toBe(false);
      expect(isAllowed(txt, 'AgentB', '/shared/x', EXAMPLE_ORIGIN)).toBe(false);
      expect(isAllowed(txt, 'AgentA', '/other', EXAMPLE_ORIGIN)).toBe(true);
    });

    it('a Sitemap line between two groups does not merge them', () => {
      const txt = [
        'User-agent: AgentA',
        'Disallow: /a',
        'Sitemap: https://example.com/sitemap.xml',
        'User-agent: AgentB',
        'Disallow: /b',
      ].join('\n');
      expect(isAllowed(txt, 'AgentA', '/a', EXAMPLE_ORIGIN)).toBe(false);
      expect(isAllowed(txt, 'AgentA', '/b', EXAMPLE_ORIGIN)).toBe(true);
      expect(isAllowed(txt, 'AgentB', '/b', EXAMPLE_ORIGIN)).toBe(false);
      expect(isAllowed(txt, 'AgentB', '/a', EXAMPLE_ORIGIN)).toBe(true);
    });

    it('a malformed line (no colon) is skipped rather than throwing', () => {
      const txt = ['User-agent: *', 'this is not a directive', 'Disallow: /private'].join('\n');
      expect(() => isAllowed(txt, PRODUCT_TOKEN, '/private', EXAMPLE_ORIGIN)).not.toThrow();
      expect(isAllowed(txt, PRODUCT_TOKEN, '/private', EXAMPLE_ORIGIN)).toBe(false);
      expect(isAllowed(txt, PRODUCT_TOKEN, '/public', EXAMPLE_ORIGIN)).toBe(true);
    });

    it('a rule line before any User-agent line is ignored', () => {
      const txt = ['Disallow: /orphan', 'User-agent: *', 'Disallow: /private'].join('\n');
      expect(isAllowed(txt, PRODUCT_TOKEN, '/orphan', EXAMPLE_ORIGIN)).toBe(true);
      expect(isAllowed(txt, PRODUCT_TOKEN, '/private', EXAMPLE_ORIGIN)).toBe(false);
    });

    it('combines rules from multiple separate * groups rather than using only the first', () => {
      // Fix round 1, Finding 2 (Important): resolveGroup's named-agent
      // branch unions every matching group's rules (flatMap), but the
      // wildcard fallback used .find() -- first match only -- so a SECOND
      // "User-agent: *" block's rules were silently dropped. Duplicate `*`
      // blocks are a realistic shape (generated files, plugin-appended
      // rules), and the failure direction is exactly the wrong one for a
      // safety gate: a real Disallow present in the file was being ignored.
      const txt = ['User-agent: *', 'Disallow: /a', '', 'User-agent: *', 'Disallow: /b'].join('\n');
      expect(isAllowed(txt, PRODUCT_TOKEN, '/a', EXAMPLE_ORIGIN)).toBe(false);
      expect(isAllowed(txt, PRODUCT_TOKEN, '/b', EXAMPLE_ORIGIN)).toBe(false);
    });

    it('a leading BOM does not corrupt the first field and silently drop every rule (integration-level check)', () => {
      // Fix round 1, bundled minor: a leading U+FEFF (byte-order mark),
      // occasionally emitted by the tools that generate or hand-edit a
      // robots.txt, would otherwise corrupt the FIRST field name on the
      // first line, so no group ever gets started, so every following rule
      // has nothing to attach to: parseGroups silently returns zero groups
      // and isAllowed allows everything, a whole-file fail-open.
      //
      // This is an INTEGRATION-level regression guard, not a pin on the
      // explicit-strip mechanism itself -- fix round 2 established that no
      // isAllowed-level input can distinguish "the explicit strip ran" from
      // "it didn't, and .trim() covered for it anyway", since per-line
      // trim() already produces the identical result. The direct,
      // mechanism-level test is stripLeadingBom's own describe block below.
      const txt = '\uFEFF' + 'User-agent: *\nDisallow: /private\n';
      expect(isAllowed(txt, PRODUCT_TOKEN, '/private', EXAMPLE_ORIGIN)).toBe(false);
      expect(isAllowed(txt, PRODUCT_TOKEN, '/public', EXAMPLE_ORIGIN)).toBe(true);
    });
  });

  describe("the path argument's contract (fix round 1, Finding 1, CRITICAL)", () => {
    // isAllowed's doc comment previously explained group selection and
    // longest-match at length but never said what `path` must contain.
    // Because "no matching rule" defaults to ALLOW (per this module's own
    // documented default), every one of these shapes failed OPEN: the
    // gate silently approved paths AP's own file explicitly disallows.
    // Verified against AP's real fixture, whose /*_ptid=*, /*?prx_t=*,
    // /search?q=*, /*?jw_start and /*&jw_start rules all depend on the
    // query string being present.

    it('matches against the query string when the caller includes it', () => {
      expect(isAllowed(AP_ROBOTS_TXT, PRODUCT_TOKEN, '/search?q=ukraine', AP_ORIGIN)).toBe(false);
    });

    it('a bare pathname with no query is correctly allowed -- not a bug: isAllowed cannot recover a query the caller never gave it', () => {
      // Contrast with the case above: /search alone (no query at all) has
      // no matching Disallow rule -- only /search?q=* does -- so `true`
      // here is correct both before and after this fix. What the fix
      // guarantees is that a caller who DOES pass the query gets the right
      // answer; a caller who strips it first (e.g. `new URL(u).pathname`)
      // is a caller-side information loss no gate can recover from, which
      // is exactly why the contract has to be stated, not just patched
      // around.
      expect(isAllowed(AP_ROBOTS_TXT, PRODUCT_TOKEN, '/search', AP_ORIGIN)).toBe(true);
    });

    it('still matches a wildcard-prefixed query pattern', () => {
      expect(isAllowed(AP_ROBOTS_TXT, PRODUCT_TOKEN, '/article/x?prx_t=a', AP_ORIGIN)).toBe(false);
    });

    it('accepts a full absolute URL, normalizing to pathname + search', () => {
      expect(
        isAllowed(AP_ROBOTS_TXT, PRODUCT_TOKEN, 'https://apnews.com/some-article.rss', AP_ORIGIN),
      ).toBe(false);
    });

    it('accepts a path missing its leading slash', () => {
      expect(isAllowed(AP_ROBOTS_TXT, PRODUCT_TOKEN, 'some-article.rss', AP_ORIGIN)).toBe(false);
    });

    it('a full URL carries its query string through normalization too', () => {
      expect(
        isAllowed(AP_ROBOTS_TXT, PRODUCT_TOKEN, 'https://apnews.com/search?q=ukraine', AP_ORIGIN),
      ).toBe(false);
    });

    it('a full URL drops its fragment, which robots.txt patterns never see', () => {
      expect(
        isAllowed(AP_ROBOTS_TXT, PRODUCT_TOKEN, 'https://apnews.com/article/whatever#section', AP_ORIGIN),
      ).toBe(true);
    });
  });
});

describe('stripLeadingBom (exported so this can be pinned directly -- see its doc comment for why isAllowed alone cannot)', () => {
  it('removes a single leading BOM', () => {
    expect(stripLeadingBom('\uFEFFUser-agent: *')).toBe('User-agent: *');
  });

  it('leaves a string with no leading BOM unchanged', () => {
    expect(stripLeadingBom('User-agent: *')).toBe('User-agent: *');
  });

  it('removes only ONE leading BOM, not a repeated one', () => {
    expect(stripLeadingBom('\uFEFF\uFEFFUser-agent: *')).toBe('\uFEFFUser-agent: *');
  });

  it('does nothing to a BOM that is not at the very start of the string', () => {
    expect(stripLeadingBom('User-agent: *\uFEFF')).toBe('User-agent: *\uFEFF');
  });
});

describe('PRODUCT_TOKEN', () => {
  // Fix round 2, bundled minor: PRODUCT_TOKEN was used dozens of times
  // across this file and asserted on zero of them -- correct today only
  // because nobody had checked. If USER_AGENT's `product/version (...)`
  // shape ever changed such that the product name moved off the leading
  // position, this would degrade PERMISSIVELY, not loudly: a corrupted
  // token stops matching a named block aimed at us and falls through to
  // the more open `*` group, rather than throwing or visibly failing. It
  // needs its own pin, independent of every test that merely uses it.

  it('is exactly "watchfloor"', () => {
    expect(PRODUCT_TOKEN).toBe('watchfloor');
  });

  it('contains no whitespace or parentheses -- i.e. is actually the bare token, not a slice of the descriptive comment', () => {
    expect(PRODUCT_TOKEN).toMatch(/^\S+$/);
    expect(PRODUCT_TOKEN).not.toMatch(/[()]/);
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

  it('sends the same identity http.ts uses for real content fetches (fix round 1, Finding 4)', async () => {
    let received: string | undefined;
    const baseUrl = await serve((req, res) => {
      received = req.headers['user-agent'];
      res.writeHead(200);
      res.end('User-agent: *\nDisallow:\n');
    });

    await fetchRobots(baseUrl);

    // Not just "some identifying string" -- the SAME constant politeFetch
    // sends, so a robots.txt group written for our real identity governs
    // the request that identity actually makes.
    expect(received).toBe(USER_AGENT);
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
    expect(isAllowed(body, PRODUCT_TOKEN, '/anything', baseUrl)).toBe(true);

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

  it('rejects when the request times out before headers ever arrive', async () => {
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

  it('rejects as RobotsUnavailableError when the body stalls AFTER headers arrive', async () => {
    // Fix round 1, Finding 3 (Important): response.text() sat outside the
    // try/catch around fetch(), so this phase -- headers already received
    // (response.ok is true), then the body stream stalls or the socket
    // resets -- escaped as a raw, unclassified DOMException/TypeError:
    // not `instanceof RobotsUnavailableError`, no `.origin`, contradicting
    // this module's own documented contract that callers can rely on
    // exactly that type to know a robots.txt check failed. The test above
    // (headers never sent at all) exercises only the fetch()-level catch
    // and passed throughout -- it cannot detect this, which is exactly why
    // it was uncaught: distinct code path, same shape as the two-timeout-
    // sites pattern in src/fetch/http.ts's own test suite.
    const baseUrl = await serve((req, res) => {
      res.on('error', () => {});
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('User-agent: *\n'); // headers + partial body sent, then stall -- never res.end()
    });

    try {
      await fetchRobots(baseUrl, { timeoutMs: 150 });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RobotsUnavailableError);
      expect((e as RobotsUnavailableError).origin).toBe(baseUrl);
    }
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
