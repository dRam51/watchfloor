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
 * Sent on every request so a feed operator can identify this project by
 * name and block it if they want to (§ politeness). Computed once from
 * package.json rather than a hardcoded literal, so it tracks version bumps
 * automatically.
 *
 * Deliberately carries no URL and no email (ruling, fix round 1, Finding 1
 * — see task-3-report.md). No repository URL exists — no git remote, no
 * package.json "repository"/"homepage"/"bugs" field, no README — and the
 * project's own rule against ever pushing means none ever will, so this
 * isn't a placeholder waiting to be filled in like the earlier `.invalid`
 * URL was; there is nothing to fill in. Putting the owner's personal email
 * here instead was considered and rejected: it would broadcast that
 * address to roughly two dozen third-party feed operators for no real
 * benefit at this request volume.
 */
export const USER_AGENT = `watchfloor/${packageJson.version} (self-hosted personal feed reader; single user)`;

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

/**
 * The response declared a charset other than UTF-8 (or a safe UTF-8
 * subset — see SAFE_CHARSETS) in its Content-Type. politeFetch always
 * decodes as UTF-8 (see readBodyWithCeiling) — silently decoding different
 * bytes as UTF-8 produces corrupted text (mojibake / replacement
 * characters) with nothing in FetchResult to say so happened. Thrown
 * instead of guessed-and-decoded, matching this codebase's existing rule
 * that a normalizer never guesses at a format it cannot validate (compare
 * InvalidTimestampError in src/domain/item.ts). Not retryable: the same
 * source will keep declaring the same charset moments later.
 *
 * `status` carries the real response status (always a genuine 2xx — this
 * only fires once the status-code gauntlet above has already passed) since
 * a real response was in hand at the throw point; unlike ResponseTooLargeError
 * and FetchTimeoutError, which have no real status to report, there's no
 * reason to discard this one to null (fix round 2, bundled item).
 */
export class UnsupportedCharsetError extends PoliteFetchError {
  constructor(url: string, charset: string, status: number) {
    super(`response from ${url} declared charset "${charset}"; only utf-8 is supported`, {
      status,
      retryable: false,
    });
    this.name = 'UnsupportedCharsetError';
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

const CHARSET_PATTERN = /charset\s*=\s*"?([^;"]+)"?/i;

/**
 * Charsets that are safe to decode as UTF-8 with zero corruption risk.
 * US-ASCII (and its IANA-canonical name, which appears occasionally in the
 * wild) is a strict, byte-identical subset of UTF-8 -- every valid
 * US-ASCII byte sequence decodes the same way under both. Fix round 2:
 * do NOT broaden this set any further. ISO-8859-1 and similar encodings
 * have bytes (0x80-0xFF) that mean something different under UTF-8, which
 * is exactly the corruption this check exists to catch -- they must keep
 * throwing.
 */
const SAFE_CHARSETS = new Set(['utf-8', 'utf8', 'us-ascii', 'ascii', 'ansi_x3.4-1968']);

/**
 * Returns the declared charset, lowercased, if Content-Type names one and
 * it isn't in SAFE_CHARSETS; returns null if there's no charset param at
 * all (e.g. most JSON responses, which RFC 8259 mandates as UTF-8 with no
 * param needed) or if the declared one is safe. No Content-Type at all
 * also reads as null — nothing declared to contradict the UTF-8 assumption.
 */
function detectUnsupportedCharset(response: Response): string | null {
  const contentType = response.headers.get('content-type');
  if (!contentType) return null;
  const match = CHARSET_PATTERN.exec(contentType);
  const raw = match?.[1];
  if (!raw) return null;
  const charset = raw.trim().toLowerCase();
  return SAFE_CHARSETS.has(charset) ? null : charset;
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
 * Resolves only for 2xx (body populated, notModified: false) and 304
 * (body: null, notModified: true). Throws for everything else: 429 and 5xx
 * as retryable; any other 4xx as permanent; any other 3xx (300-399 minus
 * 304) as permanent too — `redirect: 'follow'` resolves real redirects
 * internally, so one reaching here means the server sent a redirect status
 * `fetch` could not act on (no Location header, or a status like 300 that
 * is outside the spec's redirect set), which a retry does not fix; an
 * oversized body as ResponseTooLargeError (permanent); a declared non-UTF-8
 * charset as UnsupportedCharsetError (permanent); and a timeout as
 * FetchTimeoutError (retryable).
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

  if (response.status >= 300 && response.status < 400) {
    // Reaching here despite redirect: 'follow' means fetch could not
    // resolve this one itself: no Location header (e.g. a bare 302), or a
    // status like 300 that WHATWG Fetch never auto-follows regardless of
    // headers (only 301/302/303/307/308 are followed). Either way this is
    // exactly what the server sent, not a partially-processed redirect.
    await discardBody(response);
    throw new PoliteFetchError(
      `${url} responded ${response.status} ${response.statusText} (not a followable redirect)`,
      { status: response.status, retryable: false },
    );
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
    // Cheap header check before spending any streaming/decoding effort on a
    // body we're not going to trust the decode of.
    const declaredCharset = detectUnsupportedCharset(response);
    if (declaredCharset) {
      await discardBody(response);
      throw new UnsupportedCharsetError(url, declaredCharset, response.status);
    }

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
