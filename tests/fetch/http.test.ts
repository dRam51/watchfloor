import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  politeFetch,
  PoliteFetchError,
  ResponseTooLargeError,
  FetchTimeoutError,
  UnsupportedCharsetError,
  USER_AGENT,
} from '../../src/fetch/http.ts';

type Handler = RequestListener;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer(handler: Handler): Promise<{ server: Server; baseUrl: string }> {
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

// Force keep-alive sockets closed immediately rather than letting
// server.close()'s callback wait on connections the client (fetch's
// undici pool) may be holding open for reuse. Nothing is deleted — the
// port is an OS-managed ephemeral resource reclaimed on its own; this
// just releases the in-process listener promptly between tests.
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeAllConnections();
  });
}

const openServers: Server[] = [];

/** Registers a server for automatic afterEach cleanup and returns its base URL. */
async function serve(handler: Handler): Promise<string> {
  const { server, baseUrl } = await startServer(handler);
  openServers.push(server);
  return baseUrl;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(closeServer));
});

describe('politeFetch', () => {
  it('sends a User-Agent naming the package version, with no URL or email in it, and it reaches the wire', async () => {
    let receivedUserAgent: string | undefined;
    const baseUrl = await serve((req, res) => {
      receivedUserAgent = req.headers['user-agent'];
      res.writeHead(200);
      res.end('ok');
    });

    const pkgVersion = (
      JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }
    ).version;

    await politeFetch(`${baseUrl}/`);

    // Ruling (fix round 1, Finding 1): no repo URL exists and none ever will
    // (the project never pushes), and the owner's email has no business
    // going to ~22 third-party operators for no benefit. No "+<url>" segment
    // at all — just a name, version, and a plain-language description.
    expect(USER_AGENT).toBe(`watchfloor/${pkgVersion} (self-hosted personal feed reader; single user)`);
    expect(USER_AGENT).not.toContain('http://');
    expect(USER_AGENT).not.toContain('https://');
    expect(USER_AGENT).not.toContain('@');
    expect(receivedUserAgent).toBe(USER_AGENT);
  });

  it('sends If-None-Match and If-Modified-Since when prior state is provided', async () => {
    let received: IncomingHttpHeaders = {};
    const baseUrl = await serve((req, res) => {
      received = req.headers;
      res.writeHead(200);
      res.end('ok');
    });

    await politeFetch(`${baseUrl}/`, {
      etag: '"abc123"',
      lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT',
    });

    expect(received['if-none-match']).toBe('"abc123"');
    expect(received['if-modified-since']).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
  });

  it('sends no conditional headers when no prior state is provided', async () => {
    let received: IncomingHttpHeaders = {};
    const baseUrl = await serve((req, res) => {
      received = req.headers;
      res.writeHead(200);
      res.end('ok');
    });

    await politeFetch(`${baseUrl}/`);

    expect(received['if-none-match']).toBeUndefined();
    expect(received['if-modified-since']).toBeUndefined();
  });

  it('returns notModified: true with a null body on 304, without throwing', async () => {
    const baseUrl = await serve((req, res) => {
      res.writeHead(304, { ETag: '"still-current"' });
      res.end();
    });

    const result = await politeFetch(`${baseUrl}/`, { etag: '"still-current"' });

    expect(result.status).toBe(304);
    expect(result.notModified).toBe(true);
    expect(result.body).toBeNull();
    expect(result.etag).toBe('"still-current"');
  });

  it('returns the body text and reports etag/lastModified from the response on 200', async () => {
    const baseUrl = await serve((req, res) => {
      res.writeHead(200, {
        ETag: '"fresh-etag"',
        'Last-Modified': 'Thu, 01 Jan 2026 00:00:00 GMT',
        // Explicit utf-8 declaration, not just an absent charset param -- a
        // real (if slightly different) code path through the charset check
        // than "no charset present at all".
        'Content-Type': 'application/rss+xml; charset=utf-8',
      });
      res.end('<rss><channel><title>test feed</title></channel></rss>');
    });

    const result = await politeFetch(`${baseUrl}/`);

    expect(result.status).toBe(200);
    expect(result.notModified).toBe(false);
    expect(result.body).toBe('<rss><channel><title>test feed</title></channel></rss>');
    expect(result.etag).toBe('"fresh-etag"');
    expect(result.lastModified).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
  });

  it('throws when the response declares a non-UTF-8 charset, instead of silently mangling the body', async () => {
    const baseUrl = await serve((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=ISO-8859-1' });
      // "Caf" + 0xE9 ('é' in ISO-8859-1). 0xE9 alone is not valid UTF-8, so a
      // naive UTF-8 decode mangles it into a replacement character -- the
      // silent-corruption case the reviewer reproduced.
      res.end(Buffer.from([0x43, 0x61, 0x66, 0xe9]));
    });

    try {
      await politeFetch(`${baseUrl}/`);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedCharsetError);
      expect((e as PoliteFetchError).retryable).toBe(false);
      expect((e as Error).message).toContain('iso-8859-1');
      // Fix round 2, bundled item: a real 2xx was in hand at the throw
      // point, so the status must be preserved, not discarded to null like
      // the transport-level errors (timeout, oversized body) that have no
      // real status to report.
      expect((e as PoliteFetchError).status).toBe(200);
    }
  });

  it('does not throw for us-ascii, a strict byte-identical subset of UTF-8 with no corruption risk', async () => {
    // Fix round 2: us-ascii (and its IANA-canonical alias) must NOT be
    // treated as unsupported -- every valid US-ASCII byte decodes
    // identically under UTF-8, unlike ISO-8859-1 above where bytes
    // 0x80-0xFF genuinely mean something different.
    const baseUrl = await serve((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=us-ascii' });
      res.end('plain ascii body');
    });

    const result = await politeFetch(`${baseUrl}/`);

    expect(result.body).toBe('plain ascii body');
    expect(result.notModified).toBe(false);
  });

  it('accepts a quoted charset="utf-8" declaration', async () => {
    const baseUrl = await serve((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset="utf-8"' });
      res.end('quoted charset ok');
    });

    const result = await politeFetch(`${baseUrl}/`);

    expect(result.body).toBe('quoted charset ok');
  });

  it('enforces the per-host minimum interval across concurrent calls to the same host', async () => {
    const arrivals: number[] = [];
    const baseUrl = await serve((req, res) => {
      arrivals.push(Date.now());
      res.writeHead(200);
      res.end('ok');
    });

    const minIntervalMs = 250;
    const testStart = Date.now();
    await Promise.all([
      politeFetch(`${baseUrl}/`, { minIntervalMs }),
      politeFetch(`${baseUrl}/`, { minIntervalMs }),
    ]);

    expect(arrivals).toHaveLength(2);
    const [first, second] = arrivals as [number, number];
    expect(first - testStart).toBeLessThan(100);
    expect(second - first).toBeGreaterThanOrEqual(minIntervalMs - 10);
    expect(second - first).toBeLessThan(minIntervalMs + 300);
  });

  it('does not rate-limit concurrent calls to different hosts against each other', async () => {
    const baseUrlA = await serve((req, res) => {
      res.writeHead(200);
      res.end('a');
    });
    const baseUrlB = await serve((req, res) => {
      res.writeHead(200);
      res.end('b');
    });

    const minIntervalMs = 300;
    const start = Date.now();
    await Promise.all([
      politeFetch(`${baseUrlA}/`, { minIntervalMs }),
      politeFetch(`${baseUrlB}/`, { minIntervalMs }),
    ]);

    expect(Date.now() - start).toBeLessThan(minIntervalMs);
  });

  it('aborts before buffering an oversized response, even without a declared Content-Length', async () => {
    const baseUrl = await serve((req, res) => {
      res.on('error', () => {
        // Client aborts mid-stream once the byte ceiling trips; that must
        // not crash the test process via an unhandled 'error' event.
      });
      res.writeHead(200, { 'Content-Type': 'text/plain' }); // no Content-Length -> chunked
      void (async () => {
        try {
          for (let i = 0; i < 25; i++) {
            if (res.destroyed) return;
            res.write('x'.repeat(100));
            await sleep(40);
          }
          if (!res.writableEnded) res.end();
        } catch {
          // client disconnected mid-stream; nothing left to do
        }
      })();
    });

    const start = Date.now();
    try {
      await politeFetch(`${baseUrl}/`, { maxBytes: 250 });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ResponseTooLargeError);
      expect((e as PoliteFetchError).retryable).toBe(false);
    }
    // 25 chunks * 40ms would be ~1000ms if it read to completion; a real
    // early abort lands well under that.
    expect(Date.now() - start).toBeLessThan(600);
  });

  it('classifies 429 as retryable', async () => {
    const baseUrl = await serve((req, res) => {
      res.writeHead(429, { 'Retry-After': '30' });
      res.end('slow down');
    });

    try {
      await politeFetch(`${baseUrl}/`);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PoliteFetchError);
      expect((e as PoliteFetchError).status).toBe(429);
      expect((e as PoliteFetchError).retryable).toBe(true);
    }
  });

  it('classifies a 5xx response as retryable', async () => {
    const baseUrl = await serve((req, res) => {
      res.writeHead(503);
      res.end('unavailable');
    });

    try {
      await politeFetch(`${baseUrl}/`);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PoliteFetchError);
      expect((e as PoliteFetchError).status).toBe(503);
      expect((e as PoliteFetchError).retryable).toBe(true);
    }
  });

  it('classifies an ordinary 4xx response as permanent', async () => {
    const baseUrl = await serve((req, res) => {
      res.writeHead(404);
      res.end('not found');
    });

    try {
      await politeFetch(`${baseUrl}/`);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PoliteFetchError);
      expect((e as PoliteFetchError).status).toBe(404);
      expect((e as PoliteFetchError).retryable).toBe(false);
    }
  });

  it('throws on a 302 with no Location header, rather than silently returning it as success', async () => {
    // fetch's redirect: 'follow' cannot follow a redirect status with no
    // Location to follow -- it returns the response as-is. A malformed
    // upstream server, not a quirk; reachable across ~22 real operators.
    const baseUrl = await serve((req, res) => {
      res.writeHead(302); // no Location
      res.end('moved, but nowhere to go');
    });

    try {
      await politeFetch(`${baseUrl}/`);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PoliteFetchError);
      expect((e as PoliteFetchError).status).toBe(302);
      expect((e as PoliteFetchError).retryable).toBe(false);
    }
  });

  it('throws on a 300 Multiple Choices even with a Location header, since 300 is never auto-followed', async () => {
    // 300 is not in the WHATWG Fetch spec's redirect-status set (301, 302,
    // 303, 307, 308 only) -- a Location header does not change that, so this
    // reaches politeFetch exactly as the server sent it.
    const baseUrl = await serve((req, res) => {
      res.writeHead(300, { Location: '/pick-one' });
      res.end('multiple choices');
    });

    try {
      await politeFetch(`${baseUrl}/`);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PoliteFetchError);
      expect((e as PoliteFetchError).status).toBe(300);
      expect((e as PoliteFetchError).retryable).toBe(false);
    }
  });

  it('times out a hanging response and classifies it as retryable', async () => {
    const baseUrl = await serve((req, res) => {
      res.on('error', () => {});
      // Never respond.
    });

    const start = Date.now();
    try {
      await politeFetch(`${baseUrl}/`, { timeoutMs: 150 });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FetchTimeoutError);
      expect((e as PoliteFetchError).retryable).toBe(true);
    }
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('times out a response that stalls mid-stream after partial data, and classifies it as retryable', async () => {
    // Distinct from the "never responds" case above: here fetch() resolves
    // (headers arrive, status is known) and only the body read stalls. That
    // exercises the second timeout call site, inside the body-reading catch
    // block, not the one around the initial fetch() call.
    const baseUrl = await serve((req, res) => {
      res.on('error', () => {});
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('first-chunk'); // then stall forever; never res.end()
    });

    const start = Date.now();
    try {
      await politeFetch(`${baseUrl}/`, { timeoutMs: 150 });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FetchTimeoutError);
      expect((e as PoliteFetchError).retryable).toBe(true);
    }
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('classifies a connection failure as retryable, distinct from a timeout', async () => {
    // The non-timeout branch of classifyTransportError: a genuine transport
    // failure (DNS, connection refused) rather than the deadline firing.
    // Start a real server so the URL's host/port are valid, then close it --
    // nothing is listening there anymore, so the connection is refused.
    const { server, baseUrl } = await startServer((req, res) => {
      res.writeHead(200);
      res.end('unreachable');
    });
    await closeServer(server);

    try {
      await politeFetch(`${baseUrl}/`);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PoliteFetchError);
      expect(e).not.toBeInstanceOf(FetchTimeoutError);
      expect((e as PoliteFetchError).status).toBeNull();
      expect((e as PoliteFetchError).retryable).toBe(true);
    }
  });
});
