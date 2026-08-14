import { describe, it, expect } from 'vitest';
import { deriveItemKey } from '../../src/domain/item.ts';
import {
  InvalidRepoError,
  MAX_EXCERPT_LENGTH,
  makeRepo,
  repoItemKey,
  toExcerpt,
  type RepoInput,
} from '../../src/domain/repo.ts';

// ---------------------------------------------------------------------------
// Fixtures
//
// `github/dmca` is the one real GitHub repository the archived first live
// corpus (attic/wf-m1-firstrun-2026-08-14.db, opened -readonly and never
// written to) actually touches: hn-algolia ingested
//
//   https://github.com/github/dmca/blob/master/2020/10/2020-10-23-RIAA.md
//   "YouTube-dl has received a DMCA takedown from RIAA"
//   item_key f2da2d0878a5f71602ddf4b30d6b405765e9c97a2dfc299388445ea48d29310f
//
// found with:
//   sqlite3 -readonly attic/wf-m1-firstrun-2026-08-14.db \
//     "select item_key, source_id, canonical_url from items
//      where canonical_url like '%github.com%'"
//
// which returns exactly ONE row. There is no real repo corpus to test against
// yet -- M4a Task 9's live run is the first one -- so identity and URL facts
// below are anchored on that real row, and repo METADATA (license, language,
// star counts) is explicitly illustrative rather than claimed as live truth.
// ---------------------------------------------------------------------------

const DMCA_DEEP_LINK = 'https://github.com/github/dmca/blob/master/2020/10/2020-10-23-RIAA.md';
const DMCA_DEEP_LINK_ITEM_KEY = 'f2da2d0878a5f71602ddf4b30d6b405765e9c97a2dfc299388445ea48d29310f';

function dmcaInput(overrides: Partial<RepoInput> = {}): RepoInput {
  return {
    githubId: 1_296_269,
    owner: 'github',
    name: 'dmca',
    description: 'Repository with text of DMCA takedown notices as received.',
    language: 'Ruby',
    licenseSpdxId: 'MIT',
    stars: 3_000,
    openIssuesAndPullRequests: 12,
    lastCommitAt: '2026-08-13T04:00:00.000Z',
    isFork: false,
    isArchived: false,
    readmeFirstParagraph: 'This repository contains the text of DMCA takedown notices.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The ~300-character excerpt cap (standing rule: this project stores links and
// short excerpts, never full text). A README is the first field in this project
// whose SOURCE is routinely tens of kilobytes, so the cap is not a formality
// here -- it is the only thing standing between `items.summary_raw` and a
// mirrored copy of someone else's documentation.
// ---------------------------------------------------------------------------

describe('toExcerpt', () => {
  it('returns null for null, so an absent excerpt has exactly one representation', () => {
    expect(toExcerpt(null)).toBeNull();
  });

  it('returns null for whitespace-only text -- a blank excerpt is an absent one', () => {
    expect(toExcerpt('   \n\n\t  ')).toBeNull();
  });

  it('leaves text at exactly the cap unchanged', () => {
    const exact = 'a'.repeat(MAX_EXCERPT_LENGTH);
    expect(toExcerpt(exact)).toBe(exact);
    expect(toExcerpt(exact)!.length).toBe(300);
  });

  it('truncates one character past the cap, at a word boundary, never mid-word', () => {
    // 299 'a's, a space, then a word that starts at index 300 -- so the naive
    // slice would cut the final word in half.
    const raw = `${'a'.repeat(299)} boundary`;
    const excerpt = toExcerpt(raw)!;
    expect(excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_LENGTH);
    expect(excerpt).toBe('a'.repeat(299));
  });

  it('hard-cuts a single pathologically long token rather than returning nothing', () => {
    const excerpt = toExcerpt('x'.repeat(5000))!;
    expect(excerpt.length).toBe(MAX_EXCERPT_LENGTH);
  });

  it('never leaves an orphaned UTF-16 high surrogate at the cut', () => {
    // A rocket emoji (U+1F680) is a surrogate PAIR: cutting at 300 code units
    // lands between its two halves. Node's UTF-8 encoder silently replaces a
    // lone high surrogate with U+FFFD, and SQLite TEXT storage goes through
    // exactly that encoding -- so an orphan here is real stored corruption,
    // not a cosmetic glitch (same hazard as src/normalize/item.ts's summary
    // truncation).
    const excerpt = toExcerpt(`${'x'.repeat(299)}\u{1F680}tail`)!;
    const lastCode = excerpt.charCodeAt(excerpt.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
    expect(excerpt).toBe('x'.repeat(299));
  });

  it('collapses newlines and runs of whitespace into single spaces before capping', () => {
    // A README paragraph arrives hard-wrapped. Stored as one line, the way
    // every other excerpt in this project is -- and the cap must be measured
    // AFTER collapsing, not before, or a hard-wrapped paragraph is capped on a
    // length that includes the wrapping.
    expect(toExcerpt('one\ntwo   three\n\tfour')).toBe('one two three four');
  });

  it('caps the collapsed length, not the raw length', () => {
    // 300 words of 'a' separated by DOUBLE spaces: 300 chars of content plus
    // 598 chars of whitespace raw, but exactly 599 collapsed... so build it
    // precisely: 150 'ab' tokens double-spaced collapses to 449 chars.
    const raw = Array.from({ length: 150 }, () => 'ab').join('  ');
    expect(raw.length).toBe(150 * 2 + 149 * 2);
    const excerpt = toExcerpt(raw)!;
    expect(excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_LENGTH);
    expect(excerpt.startsWith('ab ab ab')).toBe(true);
  });
});

describe('makeRepo', () => {
  it('derives fullName from owner and name', () => {
    expect(makeRepo(dmcaInput()).fullName).toBe('github/dmca');
  });

  it('derives htmlUrl from identity, so the URL can never disagree with owner/name', () => {
    expect(makeRepo(dmcaInput()).htmlUrl).toBe('https://github.com/github/dmca');
  });

  it('routes description through the excerpt cap', () => {
    const repo = makeRepo(dmcaInput({ description: `${'d'.repeat(400)}` }));
    expect(repo.description!.length).toBe(MAX_EXCERPT_LENGTH);
  });

  it('routes the README first paragraph through the excerpt cap', () => {
    const repo = makeRepo(dmcaInput({ readmeFirstParagraph: 'r'.repeat(9000) }));
    expect(repo.readmeExcerpt!.length).toBe(MAX_EXCERPT_LENGTH);
  });

  it('treats a README whose first paragraph is blank as having no excerpt at all', () => {
    // A README that is nothing but a title and a badge row leaves the
    // extractor with no prose. One representation for absent, never ''.
    expect(makeRepo(dmcaInput({ readmeFirstParagraph: '   \n  ' })).readmeExcerpt).toBeNull();
  });

  it('maps GitHub\'s NOASSERTION license to null rather than storing it as a license', () => {
    // GitHub's licensee returns spdx_id "NOASSERTION" when it detects a
    // LICENSE file it cannot identify (github.com/torvalds/linux is the
    // best-known case: displayed as "Other"). Stored verbatim it would render
    // as though "NOASSERTION" were a license name -- exactly the
    // plausible-but-wrong value this codebase rejects elsewhere.
    expect(makeRepo(dmcaInput({ licenseSpdxId: 'NOASSERTION' })).licenseSpdxId).toBeNull();
  });

  it('maps an unlicensed repo to null and keeps a real SPDX id intact', () => {
    expect(makeRepo(dmcaInput({ licenseSpdxId: null })).licenseSpdxId).toBeNull();
    expect(makeRepo(dmcaInput({ licenseSpdxId: 'Apache-2.0' })).licenseSpdxId).toBe('Apache-2.0');
  });

  it('maps an empty language to null -- GitHub reports no detected language as absent', () => {
    expect(makeRepo(dmcaInput({ language: '  ' })).language).toBeNull();
    expect(makeRepo(dmcaInput({ language: null })).language).toBeNull();
  });

  it('accepts a repo with no last commit at all rather than inventing a date', () => {
    expect(makeRepo(dmcaInput({ lastCommitAt: null })).lastCommitAt).toBeNull();
  });

  it('rejects a non-canonical lastCommitAt instead of coercing it', () => {
    expect(() => makeRepo(dmcaInput({ lastCommitAt: '2026-08-13T04:00:00Z' }))).toThrow();
  });

  it('rejects an owner or name that is empty, or that contains a slash', () => {
    expect(() => makeRepo(dmcaInput({ owner: '' }))).toThrow(InvalidRepoError);
    expect(() => makeRepo(dmcaInput({ name: '' }))).toThrow(InvalidRepoError);
    expect(() => makeRepo(dmcaInput({ owner: 'github/extra' }))).toThrow(InvalidRepoError);
    expect(() => makeRepo(dmcaInput({ name: 'dmca/extra' }))).toThrow(InvalidRepoError);
  });

  it('rejects negative or non-integer counts rather than storing a nonsense number', () => {
    expect(() => makeRepo(dmcaInput({ stars: -1 }))).toThrow(InvalidRepoError);
    expect(() => makeRepo(dmcaInput({ stars: 1.5 }))).toThrow(InvalidRepoError);
    expect(() => makeRepo(dmcaInput({ openIssuesAndPullRequests: -1 }))).toThrow(InvalidRepoError);
    expect(() => makeRepo(dmcaInput({ githubId: 0 }))).toThrow(InvalidRepoError);
  });
});

describe('repoItemKey', () => {
  it('is sha256 of the canonical repo URL -- the same identity the ingest path derives', () => {
    const repo = makeRepo(dmcaInput());
    expect(repoItemKey(repo)).toBe(deriveItemKey('https://github.com/github/dmca'));
  });

  it('does NOT match the item_key of a deep link into the same repo', () => {
    // The real archived-corpus row is a link to a FILE inside github/dmca, not
    // to the repo. item_key is sha256(canonical_url), so the two are different
    // items and always will be. Consequence, which Tasks 4 and 7 both depend
    // on: dismissing the HN story does not suppress the repo, and the
    // "already seen on HN" signal cannot be a bare item_key comparison.
    const repo = makeRepo(dmcaInput());
    expect(deriveItemKey(DMCA_DEEP_LINK)).toBe(DMCA_DEEP_LINK_ITEM_KEY);
    expect(repoItemKey(repo)).not.toBe(DMCA_DEEP_LINK_ITEM_KEY);
  });
});
