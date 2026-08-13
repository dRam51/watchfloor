/**
 * Canonical URL derivation for item identity.
 *
 * `item_key` is `sha256(canonicalUrl)` and `items` is append-only (no UPDATE
 * or DELETE — trigger enforced). Whatever this function returns for a given
 * URL on first ingest permanently determines that article's identity across
 * its entire version history. If this function's output for an
 * already-ingested URL ever changes, the history silently splits into two
 * unrelated chains with no way to repair it.
 *
 * Two consequences that shape every rule below:
 *
 * - Every rule must be idempotent: `canonicalizeUrl(canonicalizeUrl(x)) ===
 *   canonicalizeUrl(x)` for all x. Enforced as a property test over the
 *   whole golden fixture set in tests/normalize/url.test.ts.
 * - Rules lean deliberately conservative. Stripping something that turns out
 *   to be meaningful merges two distinct articles into one identity, which
 *   cannot be undone. Leaving a junk parameter in merely risks a duplicate,
 *   which a later milestone's clustering can still catch. When a rule was
 *   arguable, it was left out — see task-2-report.md for the full list of
 *   what was considered and rejected.
 *
 * Deliberately NOT done here: network redirect resolution (e.g. unwrapping
 * `news.google.com/rss/articles/...` to the publisher URL). That requires a
 * network call and belongs on the fetch path (the Google News adapter), not
 * in this pure function.
 */

export class InvalidUrlError extends Error {
  constructor(raw: string, cause?: unknown) {
    super(`'${raw}' is not a valid absolute http(s) URL`);
    this.name = 'InvalidUrlError';
    if (cause !== undefined) this.cause = cause;
  }
}

// Exact tracking-param names to remove unconditionally, per the task brief.
// Deliberately NOT case-folded before matching: real campaign tooling emits
// these lowercase, and folding case would also catch a same-spelled-but-
// differently-cased param that might carry real meaning on some site (see
// task-2-report.md). Under-normalizing here is the safer default.
const TRACKING_PARAM_NAMES = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'source']);

// Prefix-matched tracking-param families.
const TRACKING_PARAM_PREFIXES = ['utm_', 'at_'];

function isTrackingParam(name: string): boolean {
  return (
    TRACKING_PARAM_NAMES.has(name) || TRACKING_PARAM_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

// Hosts (post-www-stripping) known to be HTTPS-only in practice, so rewriting
// an `http:` link for one of these to `https:` cannot merge two genuinely
// different resources — there is no meaningful distinct "http version" of
// these sites left to preserve. Deliberately a small, curated allowlist tied
// to the verified M1 source set (docs/superpowers/plans/2026-08-13-m1-ingest.md)
// rather than a broad guess: an unlisted host simply keeps whatever scheme it
// arrived with, which is always safe (never merges, at worst leaves a
// duplicate for M2 clustering to catch).
const KNOWN_HTTPS_HOSTS = new Set([
  'arxiv.org',
  'apnews.com',
  'federalregister.gov',
  'nvd.nist.gov',
  'cisa.gov',
  'krebsonsecurity.com',
  'bleepingcomputer.com',
  'owasp.org',
  'huggingface.co',
  'simonwillison.net',
  'latent.space',
  'deepmind.google',
  'npr.org',
  'pbs.org',
  'whitehouse.gov',
  'supremecourt.gov',
  'weather.gov',
  'news.google.com',
  'github.com',
  'substack.com',
]);

function isKnownHttpsHost(host: string): boolean {
  // Every *.substack.com subdomain is Substack's own infrastructure (HSTS
  // enforced platform-wide); a custom domain on top of Substack (e.g. a
  // publication's own apex domain) is not verified and is intentionally left
  // out — see task-2-report.md.
  return KNOWN_HTTPS_HOSTS.has(host) || host.endsWith('.substack.com');
}

/**
 * Derives the canonical form of an article URL. Pure and synchronous: no
 * network access, no redirect resolution. See module doc comment for why
 * this must be idempotent and conservative.
 *
 * Throws {@link InvalidUrlError} for anything that isn't a well-formed
 * absolute http(s) URL, rather than returning a best-effort guess — a
 * malformed value silently accepted here would become a permanent, wrong
 * item identity.
 */
export function canonicalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new InvalidUrlError(raw, cause);
  }

  // Only http(s) are valid article-link schemes for this project. `new URL`
  // happily parses mailto:, ftp:, javascript:, etc.; none of those are a
  // sensible basis for an item identity.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidUrlError(raw);
  }
  if (url.hostname === '') {
    throw new InvalidUrlError(raw);
  }

  // Scheme and host are already lowercased by the WHATWG URL parser itself;
  // no explicit step needed for that half of the "lowercase scheme and host"
  // requirement. Path case is left untouched — that's not part of the brief
  // and casing can be meaningful in a path segment.

  if (url.hostname.startsWith('www.') && url.hostname.length > 'www.'.length) {
    url.hostname = url.hostname.slice('www.'.length);
  }

  if (url.protocol === 'http:' && isKnownHttpsHost(url.hostname)) {
    url.protocol = 'https:';
  }

  // The fragment is never part of an article's identity.
  url.hash = '';

  // Snapshot keys before mutating: `.delete(name)` removes every pair with
  // that name in one call, so deleting while iterating a live key view could
  // skip entries.
  const params = url.searchParams;
  for (const name of [...params.keys()]) {
    if (isTrackingParam(name)) params.delete(name);
  }
  params.sort();
  url.search = params.toString();

  // Collapse ALL trailing slashes in one pass (not just one) and restore the
  // root as exactly '/'. Stripping only a single trailing slash would not be
  // idempotent: '/foo//' -> '/foo/' -> '/foo' are two different results from
  // two applications of a "strip one" rule, which would violate the
  // idempotence requirement above.
  const collapsedPath = url.pathname.replace(/\/+$/, '');
  url.pathname = collapsedPath === '' ? '/' : collapsedPath;

  return url.href;
}
