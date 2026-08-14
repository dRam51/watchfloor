/**
 * The GitHub repo domain type (§4, repos beat) and §4's suppression list as
 * testable predicates.
 *
 * This module owns a *shape* and a set of *predicates over that shape*. It
 * performs no HTTP (`src/fetch/github.ts`), no adapter routing
 * (`src/adapters/github.ts`), no snapshot storage (`src/db/repoSnapshots.ts`),
 * and — apart from one read against existing `item_state` — no database work
 * at all. It never writes anything, anywhere. That is load-bearing rather than
 * incidental; see "Suppression is a read-time predicate, never a stored
 * verdict" below.
 */

import type { Db } from '../db/connection.ts';
import { assertCanonicalTimestamp, deriveItemKey } from './item.ts';
import { getItemState } from './itemState.ts';
import { canonicalizeUrl } from '../normalize/url.ts';

// ---------------------------------------------------------------------------
// The excerpt cap
// ---------------------------------------------------------------------------

/**
 * The standing ~300-character excerpt cap. This project stores links and short
 * excerpts, never full text.
 *
 * A README is the first field in this codebase whose SOURCE text is routinely
 * tens of kilobytes, so the cap is doing real work here rather than tidying an
 * already-short string: `src/normalize/item.ts`'s equivalent cap on
 * `summary_raw` mostly trims feed descriptions that were already a paragraph
 * or two, whereas an uncapped README excerpt would mirror an entire project's
 * documentation into `items`.
 *
 * Numerically identical to `MAX_SUMMARY_LENGTH` in `src/normalize/item.ts`,
 * and deliberately duplicated rather than imported: that constant is private
 * to that module and this task does not own that file. If a future change
 * unifies them, unify the *truncation function* too — the two implementations
 * share the word-boundary and orphaned-surrogate rules below for the same
 * reasons, and a divergence between them would be silent.
 */
export const MAX_EXCERPT_LENGTH = 300;

// A UTF-16 high surrogate (the first unit of a two-unit surrogate pair, e.g.
// an emoji) never appears alone in well-formed text. Range from the Unicode
// standard; same constants and same reasoning as src/normalize/item.ts.
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

declare const excerptBrand: unique symbol;

/**
 * A string that has provably been through {@link toExcerpt}: whitespace
 * collapsed, trimmed, and capped at {@link MAX_EXCERPT_LENGTH}.
 *
 * ## Why this is a branded type and not just `string`
 * The task requires that the cap be enforced "in the type's construction, so
 * no caller can bypass it". A plain `readmeExcerpt: string | null` field does
 * not achieve that: any caller can build a `Repo` object literal — or, more
 * insidiously, spread an existing valid one (`{ ...repo, readmeExcerpt:
 * wholeReadme }`) — and TypeScript would accept it. Branding the *field type*
 * rather than the whole record closes both holes, because a raw `string` is
 * not assignable to `Excerpt` in either position.
 *
 * The brand is declared, never defined, so it exists only in the type system:
 * there is no runtime property, nothing to serialize, and `JSON.stringify`
 * sees a plain string. Every string operation still works, because `Excerpt`
 * *is* a `string` — Task 8 can render it directly.
 *
 * The escape hatch is an explicit `as Excerpt` cast, which is the point: it is
 * visible in review rather than silent.
 */
export type Excerpt = string & { readonly [excerptBrand]: true };

/**
 * Caps arbitrary text into a stored {@link Excerpt}, or `null` if there is no
 * text worth storing.
 *
 * Three transformations, in this order — the order matters:
 *
 * 1. **Collapse whitespace runs (including newlines) to single spaces.** A
 *    README paragraph arrives hard-wrapped at 72 or 80 columns; every other
 *    excerpt in this project is stored as one line, and a multi-line value
 *    would render as one line anyway.
 * 2. **Trim**, then treat an empty result as absent (`null`). A README
 *    consisting of nothing but a title and a badge row has no prose first
 *    paragraph, and this is what makes such a repo count as README-less under
 *    {@link intrinsicSuppressionReasons} rather than as one with an empty
 *    excerpt. One representation for "no excerpt", never `''`.
 * 3. **Cap at {@link MAX_EXCERPT_LENGTH}**, at a word boundary. Measured
 *    AFTER collapsing, not before: capping the raw text would spend the budget
 *    on the source's line wrapping.
 *
 * What this deliberately does NOT do is parse Markdown. "First paragraph of a
 * README" — skipping the title heading, badge rows, and HTML banners real
 * READMEs open with — is an *extraction* problem that belongs to Task 6's
 * enrichment pass, which is the code that knows what it fetched. This function
 * is the cap that whatever Task 6 extracts must pass through, and its blank →
 * `null` rule composes with any extractor: an extractor that finds no prose
 * yields a README-less repo automatically, with no second convention to agree
 * on.
 */
export function toExcerpt(raw: string | null | undefined): Excerpt | null {
  if (raw == null) return null;

  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  if (collapsed.length <= MAX_EXCERPT_LENGTH) return collapsed as Excerpt;

  const slice = collapsed.slice(0, MAX_EXCERPT_LENGTH);
  const lastSpace = slice.lastIndexOf(' ');
  // `> 0`, not `>= 0`: a space at index 0 as the only space would otherwise
  // truncate to an empty string. Falling back to the hard cut keeps at least
  // the leading content — returning nothing at all would be worse.
  let cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;

  // The slice cuts by UTF-16 code unit and can land inside a surrogate pair,
  // leaving a lone high surrogate as the final character. Node's UTF-8 encoder
  // silently replaces it with U+FFFD and SQLite TEXT storage goes through
  // exactly that encoding, so an orphan here is real stored corruption rather
  // than a cosmetic glitch. `charCodeAt` on an empty string returns NaN, which
  // safely fails both comparisons.
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= HIGH_SURROGATE_MIN && lastCode <= HIGH_SURROGATE_MAX) {
    cut = cut.slice(0, -1);
  }

  return cut.trimEnd() as Excerpt;
}

// ---------------------------------------------------------------------------
// The repo itself
// ---------------------------------------------------------------------------

export class InvalidRepoError extends Error {
  constructor(field: string, value: unknown, why: string) {
    super(`repo field ${field} = ${JSON.stringify(value)} is invalid: ${why}`);
    this.name = 'InvalidRepoError';
  }
}

/**
 * One GitHub repository as this project models it: §4's named enrichment
 * fields, plus the identity and the two suppression flags.
 *
 * Construct with {@link makeRepo} — never as an object literal. `description`
 * and `readmeExcerpt` are {@link Excerpt}, so a literal cannot supply them
 * without going through {@link toExcerpt} or an explicit, reviewable cast.
 *
 * ## Two identities, and why both are here
 * `githubId` is GitHub's own numeric repository id: stable across renames and
 * ownership transfers. `owner`/`name` (and therefore `fullName`, `htmlUrl`,
 * and {@link repoItemKey}) are not — renaming `old/thing` to `new/thing`
 * produces a different `item_key`, which under append-only storage means a new
 * item chain rather than a continuation of the old one, and a dismissal
 * recorded against the old name does not carry over. That is the same
 * permanent-identity hazard `src/normalize/url.ts` documents, arriving through
 * a new door; `githubId` is kept so a later milestone can detect a rename
 * (same id, different `fullName`) rather than having to infer it.
 *
 * ## `openIssuesAndPullRequests` is named the way it is on purpose
 * §4 asks for "open issue count", and the obvious REST field —
 * `open_issues_count` on the repository object — is documented by GitHub as
 * the number of open issues **and open pull requests**. A busy repo with 3
 * issues and 90 open PRs reports 93. Calling the field `openIssues` would make
 * every downstream reader (and every glance at the rendered row) quietly wrong
 * in a way nothing would ever flag. Task 8 must not label this bare "issues";
 * separating the two costs an extra search request per repo, which Task 6
 * should decide against the rate-limit budget rather than this module deciding
 * for it.
 */
export interface Repo {
  /** GitHub's numeric repository id. Stable across renames; see the doc comment. */
  githubId: number;
  owner: string;
  name: string;
  /** `${owner}/${name}` — derived, never supplied, so it cannot disagree. */
  fullName: string;
  /** `https://github.com/${fullName}`, canonicalized — derived, never supplied. */
  htmlUrl: string;
  /** GitHub's one-line repo description (§7's repo row). Capped like any excerpt. */
  description: Excerpt | null;
  /** GitHub's detected primary language, or `null` when it detects none. */
  language: string | null;
  /** SPDX id (`MIT`, `Apache-2.0`), or `null` — including for `NOASSERTION`. */
  licenseSpdxId: string | null;
  stars: number;
  /** See the doc comment: this counts open PRs too, because GitHub's field does. */
  openIssuesAndPullRequests: number;
  /** Canonical UTC timestamp, or `null` for a repo that has never been pushed to. */
  lastCommitAt: string | null;
  isFork: boolean;
  isArchived: boolean;
  /** First paragraph of the README, capped. `null` means no README worth the name. */
  readmeExcerpt: Excerpt | null;
}

/**
 * What a caller supplies to {@link makeRepo}: the same fields, but with plain
 * strings for the capped text (the cap is applied here, not by the caller) and
 * without the two derived identity fields.
 */
export interface RepoInput {
  githubId: number;
  owner: string;
  name: string;
  description: string | null;
  language: string | null;
  licenseSpdxId: string | null;
  stars: number;
  openIssuesAndPullRequests: number;
  lastCommitAt: string | null;
  isFork: boolean;
  isArchived: boolean;
  /**
   * The README's first paragraph as Task 6's enrichment pass extracted it —
   * raw, uncapped, possibly hard-wrapped. Blank or absent means the repo has
   * no README prose, which {@link intrinsicSuppressionReasons} treats as
   * README-less.
   */
  readmeFirstParagraph: string | null;
}

// GitHub reports this spdx_id when licensee finds a LICENSE file it cannot
// identify -- rendered as "Other" on the web UI. It is the ABSENCE of a known
// license, not a license, and storing the literal would render as one.
const NO_LICENSE_ASSERTION = 'NOASSERTION';

function requireIdentitySegment(field: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new InvalidRepoError(field, value, 'must not be empty');
  // A slash here would make `${owner}/${name}` ambiguous and would silently
  // point htmlUrl (and therefore item_key) at a different resource.
  if (/[\s/]/.test(trimmed)) {
    throw new InvalidRepoError(field, value, 'must not contain a slash or whitespace');
  }
  return trimmed;
}

function requireCount(field: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidRepoError(field, value, 'must be a non-negative safe integer');
  }
  return value;
}

function nullIfBlank(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The only sanctioned way to build a {@link Repo}. Validates, normalizes, and
 * caps — so every `Repo` in the system carries the same guarantees regardless
 * of which of Tasks 4, 6 or 9 constructed it.
 *
 * Rejects rather than coerces, for the reason `src/domain/item.ts` gives: a
 * loud failure is recoverable (skip the repo), a plausible-but-wrong stored
 * value is not.
 *
 * `htmlUrl` is DERIVED from `owner`/`name` rather than taken from GitHub's
 * `html_url`. GitHub's repo URL scheme is exactly `https://github.com/
 * {full_name}`, so this is not a guess; deriving it makes {@link repoItemKey}
 * a pure function of identity, which is what Tasks 4 and 7 need it to be. The
 * derived URL is passed through `canonicalizeUrl` — the same function the
 * ingest path applies — so the key computed here and the key `insertItem`
 * stores for the same repo are identical by construction rather than by
 * convention.
 */
export function makeRepo(input: RepoInput): Repo {
  const githubId = input.githubId;
  if (!Number.isSafeInteger(githubId) || githubId <= 0) {
    throw new InvalidRepoError('githubId', githubId, 'must be a positive safe integer');
  }

  const owner = requireIdentitySegment('owner', input.owner);
  const name = requireIdentitySegment('name', input.name);
  const fullName = `${owner}/${name}`;

  if (input.lastCommitAt !== null) assertCanonicalTimestamp('lastCommitAt', input.lastCommitAt);

  const license = nullIfBlank(input.licenseSpdxId);

  return {
    githubId,
    owner,
    name,
    fullName,
    htmlUrl: canonicalizeUrl(`https://github.com/${fullName}`),
    description: toExcerpt(input.description),
    language: nullIfBlank(input.language),
    licenseSpdxId: license === NO_LICENSE_ASSERTION ? null : license,
    stars: requireCount('stars', input.stars),
    openIssuesAndPullRequests: requireCount(
      'openIssuesAndPullRequests',
      input.openIssuesAndPullRequests,
    ),
    lastCommitAt: input.lastCommitAt,
    isFork: input.isFork,
    isArchived: input.isArchived,
    readmeExcerpt: toExcerpt(input.readmeFirstParagraph),
  };
}

/**
 * The `item_key` this repo has (or would have) as an ingested item:
 * `sha256(canonicalUrl)`, exactly as `src/domain/item.ts` derives it.
 *
 * This is what makes the dismissal check below a READ against the existing
 * mechanism rather than a second one. It is a pure function of `owner`/`name`,
 * so it can be computed before the repo has ever been ingested — which is the
 * point: Task 4 can ask "has this been dismissed?" before spending an
 * enrichment request on it.
 *
 * **It identifies the repo's own page and nothing else.** A link to a file,
 * issue, release, or PR inside the same repo canonicalizes to a different URL
 * and therefore a different key — verified in the test file against the one
 * real github.com row in the archived first-run corpus. Task 7's "already seen
 * on HN" signal consequently cannot be a bare `item_key` equality check; that
 * real row is a link INTO `github/dmca`, not to `github/dmca`.
 */
export function repoItemKey(repo: Repo): string {
  return deriveItemKey(repo.htmlUrl);
}
