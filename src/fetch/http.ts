import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Resolved relative to this module, not process.cwd(): whatever eventually
// runs the scheduler (§12) may launch it from any working directory. This
// file lives at src/fetch/http.ts, so two levels up is the repo root — same
// pattern src/bin/api.ts uses for config/sources.yaml and db/migrations.
const repoRoot = join(import.meta.dirname, '..', '..');
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  version: string;
};

/**
 * Contact string for the User-Agent's "+<repo url>" segment.
 *
 * No canonical repository URL exists anywhere in this checkout yet: `git
 * remote -v` is empty, package.json has no "repository" or "homepage"
 * field, and there is no README. A guessed github.com/<owner>/watchfloor
 * URL was deliberately NOT used — guessing risks pointing at a real,
 * unrelated repository, which is worse than an inert placeholder for a
 * header whose entire purpose is honest identification. `.invalid` is the
 * RFC 2606 reserved TLD for exactly this situation: guaranteed to never
 * resolve, so it cannot be mistaken for a working link by an operator who
 * clicks it. Flagged in task-3-report.md — replace with the real
 * repository URL once one exists.
 */
const CONTACT_URL = 'https://watchfloor.invalid/source';

/**
 * Sent on every request so a feed operator can identify this project and
 * block or contact it if they want (§ politeness). Computed once from
 * package.json rather than a hardcoded literal, so it tracks version bumps
 * automatically.
 */
export const USER_AGENT = `watchfloor/${packageJson.version} (+${CONTACT_URL}; personal research dashboard)`;

/** Whole-request deadline (connect + headers + body). */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Streaming byte ceiling. Google Project Zero's feed returned 13 MB during
 * source verification because it is unpaginated (docs/superpowers/plans);
 * the largest legitimate feed observed was cisa-kev at 1.5 MB. 5 MB gives
 * >3x headroom over every known-good feed while still firmly rejecting a
 * pathological one, well before it reaches double digits of MB.
 */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** Per-host minimum spacing between request starts, per the brief. */
const DEFAULT_MIN_INTERVAL_MS = 2_000;

export interface FetchResult {
  status: number;
  body: string | null;
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
}

export interface PoliteFetchOptions {
  /** Prior ETag, if any — sent as If-None-Match. */
  etag?: string;
  /** Prior Last-Modified, if any — sent as If-Modified-Since. */
  lastModified?: string;
  /** Whole-request deadline in ms. Default 10000. */
  timeoutMs?: number;
  /** Streaming byte ceiling. Default 5 MiB. */
  maxBytes?: number;
  /**
   * Minimum spacing enforced between request *starts* to the same host,
   * across concurrent callers. Not in the brief's literal opts list — the
   * brief names a fixed default (2s) but gives no way to reach it, and this
   * is a legitimate per-call tuning knob besides (some hosts may warrant
   * more courtesy than others), not only a test convenience. Always
   * defaults to 2000ms.
   */
  minIntervalMs?: number;
}

/**
 * Base error for any politeFetch failure that isn't a 2xx or a 304.
 * `status` is the HTTP status when one was received, or null for a
 * transport-level failure (timeout, DNS, connection refused, oversized
 * body). `retryable` is the classification a scheduler's backoff should
 * key off: true for conditions that may clear on their own, false for
 * conditions a retry cannot fix.
 */
export class PoliteFetchError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, opts: { status: number | null; retryable: boolean; cause?: unknown }) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'PoliteFetchError';
    this.status = opts.status;
    this.retryable = opts.retryable;
  }
}

/**
 * The response body exceeded `maxBytes`. Deliberately never retryable: an
 * unpaginated feed is the same size a moment later, so retrying wastes a
 * request for the same failure. The fix is at the config level (a query
 * param, a smaller page size), not a backoff-and-retry.
 */
export class ResponseTooLargeError extends PoliteFetchError {
  constructor(url: string, maxBytes: number) {
    super(`response from ${url} exceeded the ${maxBytes}-byte ceiling`, {
      status: null,
      retryable: false,
    });
    this.name = 'ResponseTooLargeError';
  }
}

/** No complete response within timeoutMs. Retryable: likely transient host slowness. */
export class FetchTimeoutError extends PoliteFetchError {
  constructor(url: string, timeoutMs: number) {
    super(`request to ${url} timed out after ${timeoutMs}ms`, { status: null, retryable: true });
    this.name = 'FetchTimeoutError';
  }
}

// One promise chain per host, gating when the NEXT request to that host may
// start. A call for a given host chains onto the previous call's slot
// rather than reading a shared "last start" timestamp directly, so
// concurrent callers for the same host queue up without a race; calls to
// different hosts key to different map entries and never wait on each
// other. Each link resolves to the timestamp its own turn actually started,
// which is what the next link measures its wait from, so spacing tracks
// real start times rather than a schedule that can drift under load.
const hostSlot = new Map<string, Promise<number>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireHostSlot(host: string, minIntervalMs: number): Promise<void> {
  const previousStart = hostSlot.get(host) ?? Promise.resolve(0);
  const thisSlot = previousStart.then(async (prevStart) => {
    const wait = prevStart + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    return Date.now();
  });
  // Replace the map entry synchronously (before awaiting) so a second
  // concurrent caller chains onto *this* slot rather than the one it
  // replaced.
  hostSlot.set(host, thisSlot);
  await thisSlot;
}

/**
 * Reads a Response body while enforcing maxBytes against the actual bytes
 * received, not a declared Content-Length — a hostile or misconfigured
 * server can lie about or omit that header, so it is checked here only
 * implicitly (a false declaration cannot suppress this count). Aborts the
 * underlying stream via reader.cancel() the instant the ceiling is
 * crossed, so a pathological feed never gets fully buffered into memory.
 */
async function readBodyWithCeiling(response: Response, maxBytes: number, url: string): Promise<string> {
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
      throw new ResponseTooLargeError(url, maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Best-effort drain of a response we intentionally never read (304s, error statuses). */
async function discardBody(response: Response): Promise<void> {
  if (!response.body) return;
  await response.body.cancel().catch(() => {});
}

function classifyTransportError(
  err: unknown,
  url: string,
  timeoutMs: number,
  timeoutSignal: AbortSignal,
): PoliteFetchError {
  if (timeoutSignal.aborted) return new FetchTimeoutError(url, timeoutMs);
  const message = err instanceof Error ? err.message : String(err);
  return new PoliteFetchError(`request to ${url} failed: ${message}`, {
    status: null,
    retryable: true,
    cause: err,
  });
}

/**
 * Fetch `url` politely: conditional revalidation (If-None-Match /
 * If-Modified-Since) when prior state is supplied, an honest User-Agent,
 * a per-host minimum spacing enforced across concurrent callers, a byte
 * ceiling enforced while streaming, and retryable/permanent classification
 * of any non-2xx/304 outcome via a thrown PoliteFetchError.
 *
 * Resolves for 2xx (body populated, notModified: false) and 304
 * (body: null, notModified: true). Throws for everything else: 429 and 5xx
 * as retryable, other 4xx as permanent, an oversized body as
 * ResponseTooLargeError (permanent), and a timeout as FetchTimeoutError
 * (retryable).
 */
export async function politeFetch(url: string, opts: PoliteFetchOptions = {}): Promise<FetchResult> {
  const {
    etag,
    lastModified,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  } = opts;

  const host = new URL(url).host;
  await acquireHostSlot(host, minIntervalMs);

  const headers = new Headers({ 'User-Agent': USER_AGENT });
  if (etag) headers.set('If-None-Match', etag);
  if (lastModified) headers.set('If-Modified-Since', lastModified);

  // Covers the whole operation, connect through final byte: if this fires
  // while readBodyWithCeiling is still awaiting reader.read(), that read
  // rejects too, and classifyTransportError below sees timeoutSignal.aborted.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: timeoutSignal, redirect: 'follow' });
  } catch (err) {
    throw classifyTransportError(err, url, timeoutMs, timeoutSignal);
  }

  if (response.status === 304) {
    await discardBody(response);
    return {
      status: 304,
      body: null,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      notModified: true,
    };
  }

  if (response.status === 429 || response.status >= 500) {
    await discardBody(response);
    throw new PoliteFetchError(`${url} responded ${response.status} ${response.statusText}`, {
      status: response.status,
      retryable: true,
    });
  }

  if (response.status >= 400) {
    await discardBody(response);
    throw new PoliteFetchError(`${url} responded ${response.status} ${response.statusText}`, {
      status: response.status,
      retryable: false,
    });
  }

  try {
    const body = await readBodyWithCeiling(response, maxBytes, url);
    return {
      status: response.status,
      body,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      notModified: false,
    };
  } catch (err) {
    if (err instanceof PoliteFetchError) throw err;
    throw classifyTransportError(err, url, timeoutMs, timeoutSignal);
  }
}
