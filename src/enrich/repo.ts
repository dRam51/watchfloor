/**
 * Repo enrichment (§4, repos beat): "enrich with language, license, last commit
 * date, open issue count, README first paragraph".
 *
 * ## Only one of those five costs anything
 *
 * GitHub's `search/repositories` response already carries `language`,
 * `license.spdx_id`, `pushed_at`, `open_issues_count`, `stargazers_count`,
 * `fork`, `archived`, `owner` and `id`. Task 4's adapter gets four of §4's five
 * enrichment fields for **zero** extra requests. This module therefore does not
 * re-fetch the repository object; it takes the search response's facts as input
 * ({@link RepoFacts}) and adds the one field that is not in it.
 *
 * The README needs `GET /repos/{owner}/{repo}/readme` — one Core request per
 * repo, and Core is **60 requests/hour unauthenticated**. So the interesting
 * part of this module is not the loop, it is the policy governing the loop.
 *
 * ## The budget policy, and why the README is still worth buying
 *
 * The README pays for itself because it is doing two jobs at once:
 *
 *  1. It is the only §4 enrichment field that describes the project in the
 *     project's own words. GitHub's one-line `description` is frequently empty
 *     (octocat/octocat.github.io's is `null`) or a slogan.
 *  2. It is the **input to one of §4's four suppression rules.** Skip the
 *     README entirely and `hasNoReadme` becomes unevaluable, so a quarter of
 *     the suppression list silently stops being enforced and the lane fills up
 *     with empty repositories. That is not a degradation of enrichment; it is a
 *     hole in the filter.
 *
 * But it cannot be bought for every candidate. Nine configured topics at up to
 * 100 search results each is up to 900 repos; at 60 Core requests/hour that is
 * fifteen hours of budget for one poll, and it would consume every other Core
 * request the system might want. **The loop must be bounded no matter what, so
 * the only real question is where the bound comes from.** Four rules:
 *
 *  - **Ranked top-N.** §4 ranks the lane by star velocity, so only repos that
 *    could plausibly appear near the top of it need a README. Callers pass
 *    candidates in their own priority order and this module takes a bounded
 *    prefix ({@link README_FETCH_LIMITS}, overridable per call). A repo that
 *    will not be shown does not need its README read.
 *  - **Free suppression first.** `fork` and `archived` are in the search
 *    response, and a dismissal is a local database read. All three are checked
 *    *before* the request, so no budget is ever spent on a repo §4 already
 *    excludes.
 *  - **Cache-and-skip, meaning DO NOT SEND.** A README changes far more slowly
 *    than the poll cadence, so a repo enriched yesterday needs nothing today.
 *    Crucially this is *not* implemented as a conditional request: task 1
 *    measured that replaying a valid ETag unauthenticated still drove
 *    `x-ratelimit-used` 1 → 2 → 3 → 4, so revalidating N READMEs costs exactly
 *    what refetching N READMEs costs. The saving only exists if the request is
 *    never sent, which is why the hook is
 *    {@link EnrichOptions.cachedReadmeFirstParagraph} and not an ETag.
 *  - **Live budget floor.** Before every request the client's last observed
 *    `core` budget is consulted, and enrichment stops while `remaining` is
 *    still above a caller-set reserve. Enrichment is the *least* urgent Core
 *    consumer; it must never be the reason something else cannot run.
 *
 * **It is not authenticated-only.** A PAT raises the cap (60 → 5,000/hour is
 * 83×) but unauthenticated stays a real supported mode with a much smaller N,
 * for the same reason task 1 chose REST over GraphQL: the token is the owner's
 * to create, and a lane that does nothing without it is a lane that does
 * nothing on day one. `EnrichmentReport.mode` says which mode ran, so the
 * degradation is visible rather than silent.
 *
 * ## The distinction this whole module rests on: unknown ≠ absent
 *
 * `Repo.readmeExcerpt === null` — which `hasNoReadme` suppresses on — means
 * "no README worth the name". A repo whose README was **never fetched** (over
 * the cap, out of budget, a 503) produces exactly the same `null`, and
 * suppressing on it would silently delete good repos from the lane whenever the
 * hourly budget ran short. So every result carries a {@link ReadmeOutcome} and
 * a `readmeKnown` flag:
 *
 *     Honour `no_readme` only when `readmeKnown` is true.
 *     When it is false the repo's README status is UNKNOWN — defer it to the
 *     next poll, never suppress it.
 *
 * This is the same shape as M4a's insufficient-velocity-history contract, and
 * it is here for the same reason: a plausible wrong answer is worse than a
 * loud absent one.
 *
 * ## No Markdown dependency
 *
 * Deliberate, and not merely to avoid a dependency. A CommonMark parser would
 * tell us where the blocks are, which is the easy half; it would then hand back
 * "a paragraph containing six images" and leave the actual question — which
 * block is *prose* — exactly where it started. The heuristic below is the work
 * either way, and it has to run over raw text regardless because real READMEs
 * are a mix of Markdown, raw HTML and (see `scikit-learn`) reStructuredText.
 */

import {
  MAX_EXCERPT_LENGTH,
  isArchived,
  isFork,
  makeRepo,
  type Repo,
  type RepoInput,
} from '../domain/repo.ts';
import { lastCommitAgeMs } from '../domain/repo.ts';
import {
  GitHubApiError,
  GitHubRateLimitError,
  type GitHubAuthMode,
  type GitHubClient,
} from '../fetch/github.ts';

// ---------------------------------------------------------------------------
// What counts as "the first paragraph"
// ---------------------------------------------------------------------------

/**
 * The floor a candidate must clear to count as prose, in words that contain at
 * least one letter.
 *
 * **Four, because four is what the real corpus demanded.** `ggml-org/llama.cpp`
 * opens with a title, a raw `<img>`, a centred `<div>`, and then its entire
 * description: `<b>LLM inference in C/C++</b>` — four words, 22 characters, and
 * the only prose above the fold. Any stricter floor discards it and falls
 * through to `## Quick start`'s "A few options to get llama.cpp installed on
 * your machine:", which is worse. Any looser floor starts accepting badge
 * captions.
 */
export const MIN_PROSE_WORDS = 4;

/** The character floor, set by the same measurement. See {@link MIN_PROSE_WORDS}. */
export const MIN_PROSE_CHARS = 20;

/**
 * A candidate whose text is (almost) entirely inside links is a label, not
 * prose — reject at this ratio regardless of how many links there are. This is
 * what removes a sponsor blurb wrapped in a single `<a>`, which no
 * link-*counting* rule catches.
 */
const WHOLLY_LINKED_RATIO = 0.9;

/**
 * A candidate with two or more links and this much of its text inside them is a
 * navigation or badge row (`Docs | Discord | Blog`). Prose that merely *cites*
 * links sits far below it: "Built on [MCP](…) and designed for local inference"
 * is 0.07.
 */
const LINK_ROW_RATIO = 0.6;

/**
 * How much of a README is examined. A first paragraph past 64 KiB is not a
 * first paragraph, and bounding the scan is what keeps a pathological document
 * (a 4 MiB generated file) from becoming a pathological scan.
 */
const MAX_SCAN_CHARS = 64 * 1024;

/** Companion bound to {@link MAX_SCAN_CHARS}: stop after this many blocks. */
const MAX_BLOCKS = 200;

/**
 * Hard ceiling on the returned paragraph, expressed as a multiple of the
 * standing excerpt cap rather than as a fresh magic number.
 *
 * `makeRepo` caps what is *stored*; this caps what is even *returned*, so no
 * caller can route a wall of text somewhere the excerpt cap does not apply.
 * Four times the cap leaves the word-boundary trim in `toExcerpt` plenty of
 * room while keeping the value obviously an excerpt.
 */
const MAX_EXTRACTED_CHARS = 4 * MAX_EXCERPT_LENGTH;

const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const FENCE = /^ {0,3}(```|~~~)/;

/**
 * Elements dropped **with their contents**.
 *
 * `h1`–`h6` because an HTML heading is a heading exactly as `#` is — this is
 * what moves `langchain-ai/langchain` past `<h3>The agent engineering
 * platform.</h3>` to its real opening paragraph. `sub`/`sup`/`small` because
 * they are fine print by convention and never the description;
 * `sindresorhus/awesome` opens with `<sub>Check out my macOS app</sub>`, which
 * clears every length floor and is not remotely what the repo is.
 */
const DROP_ELEMENTS = /<(script|style|svg|h[1-6]|sub|sup|small)\b[^>]*>[\s\S]{0,20000}?<\/\1\s*>/gi;

/** Void and media tags: they carry no text, so they are simply removed. */
const DROP_TAGS = /<(?:img|source|br|hr|picture|\/picture|input|meta|col|wbr)\b[^>]*\/?>/gi;

/** Tags that end one candidate and begin the next. */
const SEGMENT_TAG =
  /^<\/?(?:p|div|li|td|tr|table|thead|tbody|blockquote|section|center|details|summary|h[1-6])\b/i;

const ANY_TAG = /<[^>]*>/g;

/**
 * Block openings that are structurally not a paragraph. Each is matched against
 * the block's FIRST line.
 */
const STRUCTURAL_OPENINGS: ReadonlyArray<readonly [name: string, re: RegExp]> = [
  ['atx-heading', /^ {0,3}#{1,6}(\s|$)/],
  ['list', /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/],
  ['blockquote', /^ {0,3}>/],
  // `[label]: https://…` — a link reference definition, not text.
  ['reference-definition', /^ {0,3}\[[^\]]{1,200}\]:\s/],
  // reStructuredText comments and directives: `.. |Codecov| image:: …`. Real:
  // scikit-learn's README.rst opens with roughly forty of them.
  ['rst-directive', /^\.\.(\s|$)/],
  ['indented-code', /^( {4}|\t)/],
];

/** `---`, `***`, `___`: a thematic break. */
const THEMATIC_BREAK = /^ {0,3}([-*_])( *\1){2,} *$/;

/**
 * A run of one punctuation character: a setext heading underline (`===`) or an
 * RST section underline (`~~~`, `^^^`, `+++`). Matched per line, so a two-line
 * block whose second line is one of these is a heading — which is how
 * `octocat/git-consortium`'s `git-consortium\n==============` is skipped.
 */
const UNDERLINE = /^ {0,3}(["'+*#=^~-])\1{2,} *$/;

/** A GitHub-flavoured table's delimiter row. */
const TABLE_DELIMITER = /^ {0,3}\|?[ :|-]+\|[ :|-]*$/;

const ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ['&nbsp;', ' '],
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&mdash;', '—'],
  ['&ndash;', '–'],
  ['&hellip;', '…'],
];

/**
 * Splits a README into blank-line-separated blocks, having first removed the
 * things that are not text at all.
 *
 * Fenced code blocks are consumed **statefully, line by line**, rather than
 * being filtered out after splitting. A fence routinely contains a blank line
 * (`run-llama/llama_index`'s opening Python example does), so splitting first
 * would tear one fence into two blocks and offer the second half up as prose.
 */
function toBlocks(readme: string): string[] {
  let text = readme.slice(0, MAX_SCAN_CHARS).replace(/\r\n/g, '\n');
  if (text.startsWith('﻿')) text = text.slice(1);
  text = text.replace(HTML_COMMENT, '');

  // YAML front matter, which some generated READMEs carry.
  if (text.startsWith('---\n')) {
    const end = /\n---[ \t]*\n/.exec(text.slice(4));
    if (end !== null) text = text.slice(4 + end.index + end[0].length);
  }

  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  const flush = (): void => {
    if (current.length > 0) blocks.push(current.join('\n'));
    current = [];
  };

  for (const line of text.split('\n')) {
    const fenceMatch = FENCE.exec(line);
    if (fence === null && fenceMatch !== null) {
      fence = fenceMatch[1]!;
      flush();
      continue;
    }
    if (fence !== null) {
      if (fenceMatch !== null && fenceMatch[1] === fence) fence = null;
      continue;
    }
    if (line.trim() === '') flush();
    else current.push(line);
  }
  flush();
  return blocks;
}

/** Why this block cannot be a paragraph, or null if it might be one. */
function structuralReason(block: string): string | null {
  const lines = block.split('\n');
  const first = lines[0]!;
  for (const [name, re] of STRUCTURAL_OPENINGS) {
    if (re.test(first)) return name;
  }
  if (THEMATIC_BREAK.test(first)) return 'thematic-break';
  if (lines.every((line) => UNDERLINE.test(line))) return 'underline';
  if (lines.length >= 2 && UNDERLINE.test(lines[1]!)) return 'setext-heading';
  if (lines.length >= 2 && first.includes('|') && TABLE_DELIMITER.test(lines[1]!)) return 'table';
  return null;
}

/** One candidate paragraph, plus how much of it came from inside an `<a>`. */
interface Segment {
  text: string;
  anchorChars: number;
  anchorCount: number;
}

/**
 * Splits one block into candidate paragraphs at HTML block boundaries, tracking
 * anchor nesting across the split.
 *
 * **Both halves are load-bearing, and each was forced by a real README.**
 *
 * *Segmentation*: `netbox-community/netbox` puts its logo, tagline, six badges
 * and a five-link nav row in a single `<div align="center">` with no blank line
 * anywhere in it. Blank-line splitting alone returns that entire banner as one
 * "paragraph"; segmenting at `<p>`/`</div>` boundaries isolates the tagline.
 *
 * *Anchor depth carried across segments*: `sindresorhus/awesome`'s sponsor
 * blurbs are `<a href="…"><div><picture>…</picture></div><b>Fast remote
 * container builds…</b></a>` — the text is inside an anchor, but a `<div>`
 * boundary sits between the `<a>` and the text. Per-segment anchor detection
 * loses that, and the sponsor's tagline becomes the description of a curated
 * awesome list. Depth is therefore a property of the walk, not of the segment.
 */
function toSegments(block: string): Segment[] {
  if (!block.includes('<')) return [{ text: block, anchorChars: 0, anchorCount: 0 }];

  const stripped = block.replace(DROP_ELEMENTS, ' ').replace(DROP_TAGS, ' ');

  const segments: Segment[] = [];
  let parts: string[] = [];
  let anchorChars = 0;
  let anchorCount = 0;
  let depth = 0;
  let cursor = 0;

  const flush = (): void => {
    if (parts.length > 0) segments.push({ text: parts.join(''), anchorChars, anchorCount });
    parts = [];
    anchorChars = 0;
    anchorCount = 0;
  };

  const take = (chunk: string): void => {
    if (chunk === '') return;
    parts.push(chunk);
    if (depth > 0) anchorChars += chunk.replace(/\s+/g, ' ').trim().length;
  };

  ANY_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANY_TAG.exec(stripped)) !== null) {
    take(stripped.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const tag = match[0];
    if (/^<a\b/i.test(tag)) {
      depth += 1;
      if (depth === 1) anchorCount += 1;
    } else if (/^<\/a\b/i.test(tag)) {
      depth = Math.max(0, depth - 1);
    } else if (SEGMENT_TAG.test(tag)) {
      flush();
    }
  }
  take(stripped.slice(cursor));
  flush();
  return segments;
}

/** A segment reduced to plain text, with what was link label accounted for. */
interface Analysed {
  text: string;
  linkChars: number;
  linkCount: number;
}

/**
 * Strips inline markup down to readable text, keeping a running total of how
 * much of the result was a link label.
 *
 * Images and bare URLs are removed **entirely** rather than reduced to their alt
 * text: a badge row's alt text ("Build", "PyPI - Downloads", "License") reads as
 * plausible words and would clear every length floor. `run-llama/llama_index`
 * opens with 3,952 characters of exactly that, including a shields.io badge
 * whose image URL embeds a base64 `data:` URI.
 *
 * RST `|substitutions|` are removed on the same grounds — scikit-learn's second
 * block is `|GitHubActions| |Codecov| |CircleCI| |Nightly wheels| …`, which is
 * nine "words" of badge.
 */
function analyse(segment: string): Analysed {
  let text = segment;
  const linkTexts: string[] = [];

  const keep = (_all: string, label: string): string => {
    const collapsed = label.replace(/\s+/g, ' ').trim();
    linkTexts.push(collapsed);
    return collapsed;
  };

  text = text.replace(/!\[[^\]]{0,300}\]\([^)]{0,2000}\)/g, ' '); // markdown image
  text = text.replace(/\|[^|\n]{1,80}\|/g, ' '); // rst substitution
  text = text.replace(/\[([^\]]{0,300})\]\([^)]{0,2000}\)/g, keep); // inline link
  text = text.replace(/\[([^\]]{0,300})\]\[[^\]]{0,200}\]/g, keep); // reference link
  text = text.replace(/`([^`\n]{0,300}?)\s<[^>]{0,500}>`__?/g, keep); // rst link
  text = text.replace(/<a\b[^>]*>([\s\S]{0,2000}?)<\/a\s*>/gi, keep); // html anchor
  text = text.replace(/<https?:\/\/[^>\s]{0,2000}>/g, ' '); // autolink
  text = text.replace(/(?<!\w)https?:\/\/\S+/g, ' '); // bare url
  text = text.replace(ANY_TAG, ' '); // any tag left over

  for (const [entity, char] of ENTITIES) text = text.split(entity).join(char);
  text = text.replace(/&#\d{1,6};/g, ' ');

  text = text.replace(/`/g, '');
  text = text.replace(/\*\*|__|~~/g, '');
  // Single `*`/`_` only where they wrap a word, so snake_case survives intact.
  text = text.replace(/(?<![\w\\])[*_](?=\S)/g, '');
  text = text.replace(/(?<=\S)[*_](?!\w)/g, '');

  return {
    text: text.replace(/\s+/g, ' ').trim(),
    linkChars: linkTexts.reduce((total, label) => total + label.length, 0),
    linkCount: linkTexts.length,
  };
}

/** The prose test. Returns the text, or null if this candidate is not prose. */
function asProse(segment: Segment): string | null {
  const { text, linkChars, linkCount } = analyse(segment.text);
  const totalLinkChars = linkChars + segment.anchorChars;
  const totalLinks = linkCount + segment.anchorCount + (segment.anchorChars > 0 ? 1 : 0);

  if (text.length < MIN_PROSE_CHARS) return null;
  const words = text.split(' ').filter((word) => /[A-Za-z]/.test(word));
  if (words.length < MIN_PROSE_WORDS) return null;

  const ratio = totalLinkChars / text.length;
  if (totalLinks >= 1 && ratio >= WHOLLY_LINKED_RATIO) return null;
  if (totalLinks >= 2 && ratio > LINK_ROW_RATIO) return null;
  if (/^https?:\/\/\S+$/.test(text)) return null;

  return text;
}

/**
 * §4's "README first paragraph": the first block of a README that a human would
 * read as a sentence about the project.
 *
 * **The literal first line is almost never the answer.** Of sixteen real
 * READMEs captured live for this task, the first line was a usable paragraph in
 * one. The rest opened with an ATX title, a centred logo, a `<picture>` element,
 * an HTML comment, a row of shields.io badges, an RST directive block, or a
 * `> [!IMPORTANT]` callout.
 *
 * So a paragraph here is defined by exclusion, in this order:
 *
 *  1. HTML comments, YAML front matter and fenced code blocks are removed.
 *  2. Blocks opening as a heading (ATX, setext, or `<h1>`–`<h6>`), list,
 *     blockquote, table, thematic break, indented code, link-reference
 *     definition, or RST directive are skipped whole.
 *  3. What is left is segmented at HTML block boundaries, because real banners
 *     put a whole header inside one `<div>` with no blank lines.
 *  4. A segment is prose if, once images/badges/tags/emphasis are stripped, it
 *     has at least {@link MIN_PROSE_WORDS} words and {@link MIN_PROSE_CHARS}
 *     characters and is not mostly link label.
 *
 * Returns `null` when no block qualifies — which is a real and common answer,
 * not a failure. `octocat/Hello-World`'s README is the string `Hello World!`:
 * the file exists, so any existence check passes it, and there is still nothing
 * to say about the repo. `toExcerpt`'s blank → `null` rule then makes such a
 * repo README-less under §4, which is what it is to a reader.
 *
 * ## What it deliberately does not do
 *
 * A bullet list is never the answer, even when a README goes straight from
 * title to feature list. §7's repo row wants one legible line, a list renders
 * as a run-on, and GitHub's own `description` already covers the one-liner
 * case. Likewise a `> [!NOTE]` callout is skipped: it is an aside about the
 * project, not a description of it.
 */
export function extractReadmeFirstParagraph(readme: string): string | null {
  const blocks = toBlocks(readme);
  const limit = Math.min(blocks.length, MAX_BLOCKS);

  for (let i = 0; i < limit; i += 1) {
    const block = blocks[i]!;
    if (structuralReason(block) !== null) continue;
    for (const segment of toSegments(block)) {
      if (segment.text.trim() === '') continue;
      const prose = asProse(segment);
      if (prose === null) continue;
      if (prose.length <= MAX_EXTRACTED_CHARS) return prose;
      return prose.slice(0, MAX_EXTRACTED_CHARS).replace(/\s+\S*$/, '');
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The one request
// ---------------------------------------------------------------------------

/**
 * Every way the README question can come out.
 *
 * The three that ANSWER it (`fetched`, `cached`, `absent`) are separated from
 * the four that do not by {@link isReadmeKnown}. See the module doc: a caller
 * may only honour §4's `no_readme` suppression on the first three.
 */
export type ReadmeOutcome =
  | { kind: 'fetched'; path: string | null; firstParagraph: string | null }
  | { kind: 'cached'; firstParagraph: string | null }
  /** A 404 from the readme endpoint: the repo exists and has no README. */
  | { kind: 'absent' }
  /** A README that exists but could not be read — over 1 MB, or malformed. */
  | { kind: 'unreadable'; why: 'encoding' | 'malformed' }
  | { kind: 'skipped'; why: ReadmeSkipReason }
  | { kind: 'error'; status: number | null; message: string };

export type ReadmeSkipReason =
  /** The core budget ran out (or the reserve was reached) before this repo. */
  | 'budget'
  /** Past this run's top-N cap. */
  | 'over-limit'
  /** The owner already dismissed it — see `isRepoDismissed`. */
  | 'dismissed'
  /** Already suppressed by a free rule (fork/archived); the request is pointless. */
  | 'suppressed';

/**
 * Whether this outcome actually decided whether the repo has a README.
 *
 * `false` means UNKNOWN. A caller must not read a `null` `readmeExcerpt` as
 * "no README" in that case — defer the repo to the next poll instead. Note
 * `unreadable` is false: a README over GitHub's 1 MB inline ceiling exists, and
 * we simply have not read it.
 */
export function isReadmeKnown(outcome: ReadmeOutcome): boolean {
  return outcome.kind === 'fetched' || outcome.kind === 'cached' || outcome.kind === 'absent';
}

/**
 * The endpoint that resolves casing and extension for us.
 *
 * Task 3 flagged why this matters: probing for a literal `README.md` misses
 * `README.rst` (scikit-learn), `README` with no extension at all
 * (octocat/Hello-World), and `readme.md` (sindresorhus/awesome) — all three of
 * which are in this task's fixtures because all three are real. A false "no
 * README" silently suppresses a good repo, so the resolution has to be
 * GitHub's rather than a guess of ours.
 */
export function readmePath(owner: string, name: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/readme`;
}

/** GitHub's readme response. Only the fields this module reads are declared. */
interface ReadmeResponse {
  name?: unknown;
  path?: unknown;
  content?: unknown;
  encoding?: unknown;
}

export interface FetchReadmeOptions {
  /** Passed straight through to the client. Overridable so tests need not wait. */
  minIntervalMs?: number;
}

/**
 * Fetches and extracts one repo's README first paragraph. No policy: this is
 * the request itself, and {@link enrichRepos} decides whether to make it.
 *
 * **Sends no conditional request headers.** Task 1 measured a 304 still billing
 * the unauthenticated budget, so an `If-None-Match` here would cost a full
 * request to learn nothing had changed. Caching therefore happens one level up
 * by not calling this at all.
 *
 * Never throws for an HTTP outcome — a failed README must not fail a poll.
 * Every failure becomes a {@link ReadmeOutcome} the caller can reason about,
 * and a rate limit becomes `skipped: 'budget'` so the caller can stop early.
 */
export async function fetchReadme(
  client: GitHubClient,
  owner: string,
  name: string,
  opts: FetchReadmeOptions = {},
): Promise<ReadmeOutcome> {
  let response;
  try {
    response = await client.request<ReadmeResponse>(readmePath(owner, name), {
      minIntervalMs: opts.minIntervalMs,
    });
  } catch (err) {
    if (err instanceof GitHubRateLimitError) return { kind: 'skipped', why: 'budget' };
    if (err instanceof GitHubApiError) {
      // 404 is the answer, not a failure: the search response proved the repo
      // existed moments ago, so a 404 from ITS readme endpoint means the repo
      // has no README. Verified live against octocat/octocat.github.io, which
      // has 1,145 stars and no README.
      if (err.status === 404) return { kind: 'absent' };
      return { kind: 'error', status: err.status, message: err.message };
    }
    throw err;
  }

  const body = response.data;
  if (body === null || typeof body !== 'object') return { kind: 'unreadable', why: 'malformed' };

  // GitHub answers 200 with `encoding: "none"` and an empty body for a file
  // over 1 MB. Reading that as "no README" would suppress a repo on the
  // strength of a README that exists and is merely large.
  if (body.encoding !== undefined && body.encoding !== 'base64') {
    return { kind: 'unreadable', why: 'encoding' };
  }
  if (typeof body.content !== 'string') return { kind: 'unreadable', why: 'malformed' };

  // GitHub wraps its base64 at 60 columns; Buffer ignores the newlines.
  const markdown = Buffer.from(body.content, 'base64').toString('utf8');
  return {
    kind: 'fetched',
    path: typeof body.path === 'string' ? body.path : null,
    firstParagraph: extractReadmeFirstParagraph(markdown),
  };
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

/**
 * Default per-run README request caps, by auth mode.
 *
 * **8 unauthenticated**, against a 60/hour Core ceiling: an hourly poll then
 * spends 13% of the budget and leaves 52 requests for everything else, and 8
 * enriched repos is roughly what fills the visible top of a lane before
 * scrolling. **50 authenticated**, against 5,000/hour: 1% of the budget, and
 * deep enough to enrich a lane the owner can scroll on a phone.
 *
 * Both are defaults, not limits — {@link EnrichOptions.maxReadmeFetches}
 * overrides, and the live budget floor overrides both.
 */
export const README_FETCH_LIMITS: Readonly<Record<GitHubAuthMode, number>> = {
  unauthenticated: 8,
  authenticated: 50,
};

/**
 * What the search response already told us about a repo: every §4 enrichment
 * field except the README.
 */
export type RepoFacts = Omit<RepoInput, 'readmeFirstParagraph'>;

export interface EnrichedRepo {
  repo: Repo;
  readme: ReadmeOutcome;
  /**
   * `isReadmeKnown(readme)`, denormalized because this is the flag callers
   * must check and it should not be easy to forget. §4's `no_readme`
   * suppression may only be honoured when this is true.
   */
  readmeKnown: boolean;
  /** Age of the last push at the injected `now`, or null if never pushed. */
  lastCommitAgeMs: number | null;
}

export interface EnrichOptions {
  /** Canonical UTC timestamp. Injected, never `Date.now()` — see `lastCommitAgeMs`. */
  now: string;
  /** Overrides {@link README_FETCH_LIMITS} for this run. */
  maxReadmeFetches?: number;
  /**
   * Core requests to leave unspent. Enrichment is the least urgent Core
   * consumer in the system and must never be why something else cannot run.
   */
  reserve?: number;
  /**
   * A previously stored first paragraph, or `undefined` when there is none.
   *
   * This is cache-and-skip: returning a string means **no request is sent**.
   * It is a callback rather than a lookup this module performs itself because
   * this module owns no storage and reads no database — the same stance
   * `src/domain/repo.ts` takes.
   */
  cachedReadmeFirstParagraph?: (facts: RepoFacts) => string | null | undefined;
  /**
   * Whether the owner already dismissed this repo. Injected for the same
   * reason: wire it to `isRepoDismissed(db, repo)`. Its only job here is to
   * save a request, never to enforce — `src/api/routes/feed.ts` is the
   * enforcement point for dismissal and stays so.
   */
  isDismissed?: (repo: Repo) => boolean;
  minIntervalMs?: number;
}

export interface EnrichmentReport {
  mode: GitHubAuthMode;
  /** The effective top-N cap this run applied. */
  limit: number;
  reserve: number;
  /** README requests actually sent. */
  requested: number;
  fetched: number;
  cached: number;
  absent: number;
  unreadable: number;
  errors: number;
  skipped: Record<ReadmeSkipReason, number>;
  /** Core budget remaining when the run ended, or null if never observed. */
  coreRemaining: number | null;
}

export interface EnrichmentResult {
  /** One entry per candidate, in the order supplied. */
  repos: EnrichedRepo[];
  report: EnrichmentReport;
}

/**
 * Enriches a priority-ordered list of candidates, spending at most one Core
 * request each and stopping early rather than overrunning the budget.
 *
 * Candidates come back **in the order supplied**, one entry each, including the
 * ones no request was spent on — a caller ranking a lane needs the whole list,
 * not the surviving subset. See the module doc for the policy and for why
 * `readmeKnown` must be consulted before suppressing on `no_readme`.
 *
 * `makeRepo` is allowed to throw here: a candidate with a malformed owner, a
 * negative star count or a non-canonical timestamp is a data or programming
 * error, and this project rejects rather than coerces (`src/domain/item.ts`).
 * An HTTP failure, by contrast, is expected and is never allowed to fail the
 * run.
 */
export async function enrichRepos(
  client: GitHubClient,
  candidates: readonly RepoFacts[],
  opts: EnrichOptions,
): Promise<EnrichmentResult> {
  const reserve = opts.reserve ?? 0;
  const limit = opts.maxReadmeFetches ?? README_FETCH_LIMITS[client.mode];

  const report: EnrichmentReport = {
    mode: client.mode,
    limit,
    reserve,
    requested: 0,
    fetched: 0,
    cached: 0,
    absent: 0,
    unreadable: 0,
    errors: 0,
    skipped: { budget: 0, 'over-limit': 0, dismissed: 0, suppressed: 0 },
    coreRemaining: null,
  };

  const repos: EnrichedRepo[] = [];
  let budgetExhausted = false;

  for (const facts of candidates) {
    // Built first with no README so the free predicates can run against a real
    // Repo rather than against a second, parallel notion of "fork". Rebuilt
    // below once the README is known — never spread, because `Excerpt`'s brand
    // exists precisely to stop `{ ...repo, readmeExcerpt: x }`.
    const probe = makeRepo({ ...facts, readmeFirstParagraph: null });

    const outcome = await resolveReadme(probe, facts);
    if (outcome.kind === 'skipped' && outcome.why === 'budget') budgetExhausted = true;

    const firstParagraph =
      outcome.kind === 'fetched' || outcome.kind === 'cached' ? outcome.firstParagraph : null;

    repos.push({
      repo: makeRepo({ ...facts, readmeFirstParagraph: firstParagraph }),
      readme: outcome,
      readmeKnown: isReadmeKnown(outcome),
      lastCommitAgeMs: lastCommitAgeMs(probe, opts.now),
    });
  }

  report.coreRemaining = client.budget('core')?.remaining ?? null;
  return { repos, report };

  /** The policy, per candidate. Order is cheapest-refusal-first throughout. */
  async function resolveReadme(probe: Repo, facts: RepoFacts): Promise<ReadmeOutcome> {
    // Free, from the search response. §4 suppresses these anyway, so a request
    // would buy nothing.
    if (isFork(probe) || isArchived(probe)) {
      report.skipped.suppressed += 1;
      return { kind: 'skipped', why: 'suppressed' };
    }

    // A local database read, so still free relative to the rate limit.
    if (opts.isDismissed?.(probe) === true) {
      report.skipped.dismissed += 1;
      return { kind: 'skipped', why: 'dismissed' };
    }

    // Cache-and-skip: a stored paragraph means no request at all. Not an ETag
    // — task 1 measured that a 304 still bills the budget.
    const cached = opts.cachedReadmeFirstParagraph?.(facts);
    if (cached !== undefined) {
      report.cached += 1;
      return { kind: 'cached', firstParagraph: cached };
    }

    if (report.requested >= limit) {
      report.skipped['over-limit'] += 1;
      return { kind: 'skipped', why: 'over-limit' };
    }

    // Once the budget is gone it stays gone for this run: re-checking would
    // pass the moment a stale `resetAt` elapsed mid-loop and enrich half a
    // lane inconsistently.
    if (budgetExhausted || !canAffordOne()) {
      report.skipped.budget += 1;
      return { kind: 'skipped', why: 'budget' };
    }

    report.requested += 1;
    const outcome = await fetchReadme(client, probe.owner, probe.name, {
      minIntervalMs: opts.minIntervalMs,
    });
    if (outcome.kind === 'fetched') report.fetched += 1;
    else if (outcome.kind === 'absent') report.absent += 1;
    else if (outcome.kind === 'unreadable') report.unreadable += 1;
    else if (outcome.kind === 'error') report.errors += 1;
    else if (outcome.kind === 'skipped') {
      // The client refused it locally: no request was made after all.
      report.requested -= 1;
      report.skipped[outcome.why] += 1;
    }
    return outcome;
  }

  /**
   * Whether the last observed `core` budget leaves room above the reserve.
   * A budget never observed (`null`) is not evidence of exhaustion, so the
   * first request of a fresh client always goes out and teaches us the real
   * number.
   */
  function canAffordOne(): boolean {
    const budget = client.budget('core');
    if (budget === null || budget.remaining === null) return true;
    if (budget.remaining > reserve) return true;
    // Past the reset instant the recorded figure is stale; the client itself
    // clears optimistically for the same reason.
    return budget.resetAt !== null && Date.now() >= budget.resetAt.getTime();
  }
}
