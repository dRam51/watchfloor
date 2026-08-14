import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { InvalidTimestampError, deriveItemKey } from '../../src/domain/item.ts';
import { dismissItem, markItemRead, saveItem } from '../../src/domain/itemState.ts';
import {
  InvalidRepoError,
  MAX_EXCERPT_LENGTH,
  makeRepo,
  hasNoReadme,
  intrinsicSuppressionReasons,
  isArchived,
  isFork,
  isRepoDismissed,
  isSuppressed,
  lastCommitAgeMs,
  repoItemKey,
  suppressionReasons,
  toExcerpt,
  type Repo,
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
    expect(() => makeRepo(dmcaInput({ lastCommitAt: '2026-08-13T04:00:00Z' }))).toThrow(
      InvalidTimestampError,
    );
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

// ---------------------------------------------------------------------------
// §4: "Suppress: forks, archived repos, repos with no README, anything I've
// already dismissed." Three of the four are properties of the repo itself.
// ---------------------------------------------------------------------------

describe('the three intrinsic suppression predicates', () => {
  it('isFork is true for a fork and false otherwise', () => {
    expect(isFork(makeRepo(dmcaInput({ isFork: true })))).toBe(true);
    expect(isFork(makeRepo(dmcaInput({ isFork: false })))).toBe(false);
  });

  it('isArchived is true for an archived repo and false otherwise', () => {
    expect(isArchived(makeRepo(dmcaInput({ isArchived: true })))).toBe(true);
    expect(isArchived(makeRepo(dmcaInput({ isArchived: false })))).toBe(false);
  });

  it('hasNoReadme is true when there is no README at all', () => {
    expect(hasNoReadme(makeRepo(dmcaInput({ readmeFirstParagraph: null })))).toBe(true);
  });

  it('hasNoReadme is true for a README with no prose -- a title and badges only', () => {
    // Real and common: `# projectname` followed by a row of shields.io badges,
    // from which an extractor recovers no paragraph. Treated as README-less
    // rather than as a repo with an empty excerpt.
    expect(hasNoReadme(makeRepo(dmcaInput({ readmeFirstParagraph: '  \n\n ' })))).toBe(true);
  });

  it('hasNoReadme is false when a first paragraph survived extraction', () => {
    expect(hasNoReadme(makeRepo(dmcaInput()))).toBe(false);
  });
});

describe('intrinsicSuppressionReasons', () => {
  it('is empty for a repo that breaks none of the three rules', () => {
    expect(intrinsicSuppressionReasons(makeRepo(dmcaInput()))).toEqual([]);
  });

  it('reports every rule the repo breaks, in a deterministic order', () => {
    const repo = makeRepo(
      dmcaInput({ isFork: true, isArchived: true, readmeFirstParagraph: null }),
    );
    expect(intrinsicSuppressionReasons(repo)).toEqual(['fork', 'archived', 'no_readme']);
  });

  it('reports exactly the rule broken when only one is', () => {
    expect(intrinsicSuppressionReasons(makeRepo(dmcaInput({ isArchived: true })))).toEqual([
      'archived',
    ]);
  });

  it('never reports dismissal -- that is not a property of the repo', () => {
    // Dismissal is the reader's own history, and needs a database. Keeping it
    // out of the pure function is what lets Tasks 4 and 6 apply the cheap
    // rules with no db handle at all.
    const repo = makeRepo(dmcaInput({ isFork: true, isArchived: true, readmeFirstParagraph: null }));
    expect(intrinsicSuppressionReasons(repo)).not.toContain('dismissed');
  });
});

// ---------------------------------------------------------------------------
// The fourth rule: "anything I've already dismissed".
//
// This is a READ against the existing item_state mechanism (src/domain/
// itemState.ts, db/migrations/0001_init.sql), never a second one -- so these
// tests dismiss through the real `dismissItem` and read back through the repo
// predicate, on a real temp-file SQLite database. No mocks, no in-memory
// shortcut, no fixture table.
// ---------------------------------------------------------------------------

const open: Db[] = [];

function migratedDb(): Db {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

const NOW = '2026-08-14T12:00:00.000Z';

describe('isRepoDismissed', () => {
  it('is false for a repo with no item_state row at all', () => {
    expect(isRepoDismissed(migratedDb(), makeRepo(dmcaInput()))).toBe(false);
  });

  it('is true once the repo has been dismissed through the existing mechanism', () => {
    const db = migratedDb();
    const repo = makeRepo(dmcaInput());
    dismissItem(db, repoItemKey(repo), NOW);
    expect(isRepoDismissed(db, repo)).toBe(true);
  });

  it('answers before the repo has ever been ingested -- item_state needs no items row', () => {
    // The whole point of the pre-ingest check: Task 4 can ask "already
    // dismissed?" before spending a rate-limited enrichment request. That only
    // works because item_state is keyed on item_key with no foreign key to
    // items (0001_init.sql), so a dismissal can exist with no item behind it.
    const db = migratedDb();
    const repo = makeRepo(dmcaInput());
    dismissItem(db, repoItemKey(repo), NOW);

    expect(db.prepare('select count(*) as n from items').get()).toEqual({ n: 0 });
    expect(isRepoDismissed(db, repo)).toBe(true);
  });

  it('is false for a repo that was read or saved but never dismissed', () => {
    const db = migratedDb();
    const repo = makeRepo(dmcaInput());
    markItemRead(db, repoItemKey(repo), NOW);
    saveItem(db, repoItemKey(repo), NOW);
    expect(isRepoDismissed(db, repo)).toBe(false);
  });

  it('does not leak a dismissal from one repo to another', () => {
    const db = migratedDb();
    const dismissed = makeRepo(dmcaInput());
    const other = makeRepo(dmcaInput({ owner: 'openai', name: 'whisper', githubId: 2 }));
    dismissItem(db, repoItemKey(dismissed), NOW);

    expect(isRepoDismissed(db, dismissed)).toBe(true);
    expect(isRepoDismissed(db, other)).toBe(false);
  });

  it('is NOT triggered by dismissing an HN story that links INTO the repo', () => {
    // The one real github.com row in the archived first-run corpus is a link
    // to a file inside github/dmca, ingested by hn-algolia. It has its own
    // canonical_url and therefore its own item_key, so dismissing the story
    // says nothing about the repo. This is a real limitation to carry forward,
    // not a bug: Task 7's "things I haven't already seen on HN" signal has to
    // match on something other than item_key equality.
    const db = migratedDb();
    const repo = makeRepo(dmcaInput());
    dismissItem(db, DMCA_DEEP_LINK_ITEM_KEY, NOW);
    expect(isRepoDismissed(db, repo)).toBe(false);
  });
});

describe('suppressionReasons', () => {
  it('is empty for a clean, undismissed repo', () => {
    expect(suppressionReasons(migratedDb(), makeRepo(dmcaInput()))).toEqual([]);
  });

  it('appends dismissal to the intrinsic reasons, in a deterministic order', () => {
    const db = migratedDb();
    const repo = makeRepo(dmcaInput({ isFork: true, readmeFirstParagraph: null }));
    dismissItem(db, repoItemKey(repo), NOW);
    expect(suppressionReasons(db, repo)).toEqual(['fork', 'no_readme', 'dismissed']);
  });

  it('reports dismissal alone for an otherwise perfectly good repo', () => {
    const db = migratedDb();
    const repo = makeRepo(dmcaInput());
    dismissItem(db, repoItemKey(repo), NOW);
    expect(suppressionReasons(db, repo)).toEqual(['dismissed']);
  });
});

describe('isSuppressed', () => {
  it('is false for a repo that breaks no rule', () => {
    expect(isSuppressed(migratedDb(), makeRepo(dmcaInput()))).toBe(false);
  });

  it('is true if any single rule is broken', () => {
    const db = migratedDb();
    expect(isSuppressed(db, makeRepo(dmcaInput({ isFork: true })))).toBe(true);
    expect(isSuppressed(db, makeRepo(dmcaInput({ isArchived: true })))).toBe(true);
    expect(isSuppressed(db, makeRepo(dmcaInput({ readmeFirstParagraph: null })))).toBe(true);
  });
});

describe('this module never writes', () => {
  it('leaves item_state and the dismissal signal log untouched when every predicate runs', () => {
    // "Suppression is a read-time predicate, never a stored verdict" is the
    // argument for suppressing rather than de-ranking README-less repos. It
    // only holds if this module genuinely writes nothing, so assert it against
    // the database rather than trusting the doc comment.
    const db = migratedDb();
    const repo = makeRepo(dmcaInput({ isFork: true, isArchived: true, readmeFirstParagraph: null }));

    const before = db.prepare('select count(*) as n from item_state').get();
    const signalsBefore = db.prepare('select count(*) as n from interest_dismissal_signals').get();

    isRepoDismissed(db, repo);
    suppressionReasons(db, repo);
    isSuppressed(db, repo);
    intrinsicSuppressionReasons(repo);

    expect(db.prepare('select count(*) as n from item_state').get()).toEqual(before);
    expect(db.prepare('select count(*) as n from interest_dismissal_signals').get()).toEqual(
      signalsBefore,
    );
    expect(before).toEqual({ n: 0 });
  });

  it('contains no SQL write statement anywhere in its source', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'domain', 'repo.ts'), 'utf8');
    expect(source).not.toMatch(/insert\s+into|update\s+\w+\s+set|delete\s+from/i);
  });
});

// ---------------------------------------------------------------------------
// §7: the repo row shows "last-commit age". `now` is injected, never read from
// the wall clock -- matching every other domain and scoring module.
// ---------------------------------------------------------------------------

describe('lastCommitAgeMs', () => {
  it('is the elapsed milliseconds between the last commit and the injected now', () => {
    const repo = makeRepo(dmcaInput({ lastCommitAt: '2026-08-14T00:00:00.000Z' }));
    expect(lastCommitAgeMs(repo, '2026-08-14T06:00:00.000Z')).toBe(6 * 60 * 60 * 1000);
  });

  it('is null -- not zero -- for a repo that has never been pushed to', () => {
    // A confident zero would render as "committed just now", which is the
    // opposite of the truth. Same contract Task 5's velocity module owes for
    // insufficient history.
    expect(lastCommitAgeMs(makeRepo(dmcaInput({ lastCommitAt: null })), NOW)).toBeNull();
  });

  it('is exactly zero when the last commit is the injected instant', () => {
    expect(lastCommitAgeMs(makeRepo(dmcaInput({ lastCommitAt: NOW })), NOW)).toBe(0);
  });

  it('returns a negative age rather than clamping when the commit postdates now', () => {
    // GitHub's timestamps come from GitHub's clock and `now` from ours, so a
    // commit a few seconds in "the future" is real and observable. Clamping to
    // zero would hide a genuine clock problem; the sign is the caller's to
    // render (Task 8 should show "just now", not "-3h").
    const repo = makeRepo(dmcaInput({ lastCommitAt: '2026-08-14T12:00:05.000Z' }));
    expect(lastCommitAgeMs(repo, NOW)).toBe(-5000);
  });

  it('rejects a non-canonical now instead of coercing it', () => {
    expect(() => lastCommitAgeMs(makeRepo(dmcaInput()), '2026-08-14T12:00:00Z')).toThrow(
      InvalidTimestampError,
    );
  });

  it('never reads the wall clock', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'domain', 'repo.ts'), 'utf8');
    expect(source).not.toMatch(/Date\.now\(\)|new Date\(\s*\)/);
  });
});

describe('the cap cannot be bypassed', () => {
  it('rejects an uncapped string in the excerpt fields, including via a spread', () => {
    // These two `@ts-expect-error` directives ARE the assertion, and they are
    // checked by `npm run typecheck` (tsc -p tsconfig.test.json), not by
    // vitest -- esbuild strips types without checking them. If the Excerpt
    // brand were ever relaxed to a plain `string`, both directives would
    // become unused and tsc would fail with TS2578, so this cannot rot into a
    // silent no-op.
    //
    // The spread case is the one a plain interface would miss: the caller
    // already holds a valid Repo, so every other field typechecks.
    const base = makeRepo(dmcaInput());

    // @ts-expect-error a raw string is not an Excerpt -- the cap is not optional
    const spread: Repo = { ...base, readmeExcerpt: 'r'.repeat(9000) };
    // @ts-expect-error same for the description field
    const alsoSpread: Repo = { ...base, description: 'd'.repeat(9000) };

    // Runtime half: TypeScript refused, but nothing stops a JS caller, so
    // record what such an object actually is -- an over-cap value that only
    // the type system was ever going to catch.
    expect(spread.readmeExcerpt!.length).toBe(9000);
    expect(alsoSpread.description!.length).toBe(9000);
    expect(base.readmeExcerpt!.length).toBeLessThanOrEqual(MAX_EXCERPT_LENGTH);
  });
});
