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

// Exact tracking-param names to remove unconditionally. Deliberately NOT
// case-folded before matching: real campaign tooling emits these lowercase,
// and folding case would also catch a same-spelled-but-differently-cased
// param that might carry real meaning on some site (see task-2-report.md).
// Under-normalizing here is the safer default.
//
// `ref` and `source` are deliberately NOT in this set (fix round 1, task-2-
// report.md "Ruling"), reversing the original implementation. The brief's
// literal must-list named them, but both are also used as real, meaningful
// application state on sites outside our source set — e.g. a GitHub
// blob/raw URL's `?ref=<branch>` — and this is reachable today, not just
// hypothetically: hn-algolia aggregates arbitrary third-party article URLs,
// the one source with no fixed domain shape. Under append-only storage,
// stripping a meaningful param merges two genuinely different articles into
// one identity permanently; leaving a true tracking param in only risks a
// duplicate that M2 clustering can still catch. The project's own "prefer
// under-normalizing" principle wins over the brief's literal text here.
const TRACKING_PARAM_NAMES = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid']);

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
//
// Every entry here must be a site's OWN primary/apex domain — not a
// third-party platform's customer-provided custom domain, even when that
// platform generally offers HTTPS. A platform's TLS behavior for a specific
// tenant's custom domain is a per-tenant setup detail that isn't verifiable
// in bulk; the site's own apex domain is a claim about that site's own
// direct infrastructure choice, which is. (Fix round 1, finding 2: this
// list originally included `latent.space`, which is in fact a Substack
// publication on a custom domain, not independently verified any
// differently than the deliberately-excluded `semianalysis.com` — removed
// for consistency. See isKnownHttpsHost below for the separate,
// differently-justified category of platform-*subdomain* rules.)
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
  'deepmind.google',
  'npr.org',
  'pbs.org',
  'whitehouse.gov',
  'supremecourt.gov',
  'weather.gov',
  'news.google.com',
  'github.com',
]);

function isKnownHttpsHost(host: string): boolean {
  // Platform-issued *subdomains* are a different, stronger claim than a
  // tenant's custom domain: the platform itself controls and uniformly
  // enforces HTTPS for every subdomain it hands out, so trusting any one of
  // them isn't a per-tenant guess.
  //
  // *.blogspot.com: Google's own Blogger support documentation states HTTPS
  // is on by default and the setting is hidden/non-optional for any blog
  // NOT on a custom domain (support.google.com/blogger/answer/6284029) —
  // added in fix round 1 to reconcile `project-zero`
  // (googleprojectzero.blogspot.com), one of the 22 verified M1 sources,
  // which had no entry despite fitting this exact category.
  //
  // *.substack.com: carried over from the original implementation on
  // general platform-operational grounds (Substack's own subdomains are
  // core infrastructure the service serves its own app assets over, and
  // every such URL encountered in practice is https) rather than an
  // equally explicit citation like Blogger's — flagged in task-2-report.md
  // as a weaker-cited claim than the blogspot.com one, kept rather than
  // dropped because it is still a platform-subdomain claim, not a
  // custom-domain guess.
  return (
    KNOWN_HTTPS_HOSTS.has(host) || host.endsWith('.blogspot.com') || host.endsWith('.substack.com')
  );
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
  //
  // No separate empty-hostname check follows this: per the WHATWG URL
  // Standard, an empty host is a hard parse error (and so `new URL` throws
  // above, never reaching here) for every special scheme except `file:` —
  // and http/https, just confirmed above, are never `file:`. Fix round 1
  // verified this by probing seven malformed shapes (task-2-report.md);
  // every one either threw during parsing or produced a non-empty hostname.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidUrlError(raw);
  }

  // Scheme and host are already lowercased by the WHATWG URL parser itself;
  // no explicit step needed for that half of the "lowercase scheme and host"
  // requirement. Path case is left untouched — that's not part of the brief
  // and casing can be meaningful in a path segment.

  // Collapse ALL leading www. repeats in one pass, not just one — mirrors
  // the trailing-slash collapse below, and for the same reason. Fix round 1,
  // finding 1: a single-pass `slice('www.'.length)` made
  // 'www.www.example.com' strip to 'www.example.com' on the first call and
  // to 'example.com' on a second, an idempotence violation caught only by
  // running the shipped module against a repeated-www input, not by the
  // original golden fixture (which had no such row). A second-order symptom
  // shared this root cause: on a known-https host, a single-pass strip could
  // leave a hostname like 'www.arxiv.org' that still doesn't match the
  // allowlist, delaying the http->https upgrade by one call too.
  const strippedHostname = url.hostname.replace(/^(www\.)+/, '');
  url.hostname = strippedHostname === '' ? url.hostname : strippedHostname;

  if (url.protocol === 'http:' && isKnownHttpsHost(url.hostname)) {
    url.protocol = 'https:';
  }

  // The fragment is never part of an article's identity.
  url.hash = '';

  // Snapshot keys before mutating: `.delete(name)` removes every pair with
  // that name in one call, so deleting while iterating a live key view could
  // skip entries.
  //
  // No explicit `url.search = params.toString()` follows: `url.searchParams`
  // is spec-defined as *live-linked* to `url`, so `.delete()` and `.sort()`
  // each already update `url.search`/`url.href` as they run (verified
  // empirically in fix round 1, task-2-report.md — including the
  // all-params-removed case producing no trailing `?`). The original
  // reassignment line was redundant, never incorrect.
  const params = url.searchParams;
  for (const name of [...params.keys()]) {
    if (isTrackingParam(name)) params.delete(name);
  }
  params.sort();

  // Collapse ALL trailing slashes in one pass (not just one) and restore the
  // root as exactly '/'. Stripping only a single trailing slash would not be
  // idempotent: '/foo//' -> '/foo/' -> '/foo' are two different results from
  // two applications of a "strip one" rule, which would violate the
  // idempotence requirement above.
  const collapsedPath = url.pathname.replace(/\/+$/, '');
  url.pathname = collapsedPath === '' ? '/' : collapsedPath;

  return url.href;
}
