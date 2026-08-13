import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  politeFetch,
  PoliteFetchError,
  ResponseTooLargeError,
  FetchTimeoutError,
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
  it('sends an honest User-Agent naming the package version, and it reaches the wire', async () => {
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

    // Shape required by the brief: watchfloor/<version> (+<repo url>; personal research dashboard)
    expect(USER_AGENT.startsWith(`watchfloor/${pkgVersion} (+`)).toBe(true);
    expect(USER_AGENT.endsWith('; personal research dashboard)')).toBe(true);
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
        'Content-Type': 'application/rss+xml',
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
});
