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
import { assertCanonicalTimestamp } from './item.ts';
import { getItemState } from './itemState.ts';

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
