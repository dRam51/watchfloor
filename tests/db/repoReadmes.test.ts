import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { MAX_EXCERPT_LENGTH } from '../../src/domain/repo.ts';
import {
  cachedFirstParagraph,
  getRepoReadme,
  getRepoReadmes,
  isReadmeAnswered,
  recordRepoReadme,
} from '../../src/db/repoReadmes.ts';

const open: Array<ReturnType<typeof openDb>> = [];
function migratedDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}
afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

const T1 = '2026-08-14T12:00:00.000Z';
const T2 = '2026-08-15T12:00:00.000Z';
const T3 = '2026-08-16T12:00:00.000Z';

// ===========================================================================
// The three facts this table exists to keep apart. Collapsing any two of them
// re-creates the bug M4a task 11 was dispatched to close: a repo whose README
// was never READ looks exactly like a repo that HAS no README, and §4
// suppresses the second.
// ===========================================================================

describe('github_repo_readmes — a read README, a missing README, and an unread one are three facts', () => {
  it('stores a README that was read and yielded a paragraph', () => {
    const db = migratedDb();
    recordRepoReadme(db, {
      repoId: 101,
      fullName: 'acme/widget',
      observedAt: T1,
      outcome: 'present',
      firstParagraph: 'Widget is a thing that does widgets, quickly and well.',
      readmePath: 'README.md',
    });

    const record = getRepoReadme(db, 101);
    expect(record?.outcome).toBe('present');
    expect(record?.firstParagraph).toBe('Widget is a thing that does widgets, quickly and well.');
    expect(record?.readmePath).toBe('README.md');
    expect(record?.answeredAt).toBe(T1);
    expect(isReadmeAnswered(record)).toBe(true);
  });

  it('stores a README that genuinely does not exist as an ANSWER, not as a blank', () => {
    // GitHub's 404 from the readme endpoint IS the answer -- the search
    // response proved the repo existed moments ago.
    const db = migratedDb();
    recordRepoReadme(db, { repoId: 202, fullName: 'acme/empty', observedAt: T1, outcome: 'absent' });

    const record = getRepoReadme(db, 202);
    expect(record?.outcome).toBe('absent');
    expect(record?.firstParagraph).toBeNull();
    expect(isReadmeAnswered(record)).toBe(true);
  });

  it('keeps "the file exists but says nothing" apart from "there is no file"', () => {
    // octocat/Hello-World's README is the string `Hello World!`. Any
    // existence check passes it and there is still nothing to say about the
    // repo. §4 treats both as README-less; an operator asking "why is this
    // repo not in my lane" deserves to be told which one it was.
    const db = migratedDb();
    recordRepoReadme(db, {
      repoId: 303,
      fullName: 'octocat/Hello-World',
      observedAt: T1,
      outcome: 'no_prose',
      readmePath: 'README',
    });

    const record = getRepoReadme(db, 303);
    expect(record?.outcome).toBe('no_prose');
    expect(record?.firstParagraph).toBeNull();
    expect(record?.readmePath).toBe('README');
    expect(isReadmeAnswered(record)).toBe(true);
  });

  it('records a failed attempt WITHOUT answering the README question', () => {
    // The dangerous case. A 503 must not become "this repo has no README".
    const db = migratedDb();
    recordRepoReadme(db, {
      repoId: 404,
      fullName: 'acme/flaky',
      observedAt: T1,
      outcome: 'failed',
      failure: 'error',
      detail: 'HTTP 503',
    });

    const record = getRepoReadme(db, 404);
    expect(record?.outcome).toBeNull();
    expect(record?.answeredAt).toBeNull();
    expect(record?.attemptFailure).toBe('error');
    expect(record?.attemptDetail).toBe('HTTP 503');
    expect(record?.attemptedAt).toBe(T1);
    expect(isReadmeAnswered(record)).toBe(false);
  });

  it('distinguishes a repo never attempted (no row) from one attempted and failed (a row)', () => {
    const db = migratedDb();
    recordRepoReadme(db, {
      repoId: 404,
      fullName: 'acme/flaky',
      observedAt: T1,
      outcome: 'failed',
      failure: 'unreadable',
      detail: 'encoding',
    });

    expect(getRepoReadme(db, 999)).toBeNull(); // never attempted
    expect(getRepoReadme(db, 404)).not.toBeNull(); // attempted, unanswered
    // ...and neither is answered, which is what keeps §4 from suppressing them.
    expect(isReadmeAnswered(getRepoReadme(db, 999))).toBe(false);
    expect(isReadmeAnswered(getRepoReadme(db, 404))).toBe(false);
  });
});

// ===========================================================================
// The cache read -- the value EnrichOptions.cachedReadmeFirstParagraph must
// return. `undefined` means SEND THE REQUEST; anything else means skip it.
// ===========================================================================

describe('cachedFirstParagraph — skip only on an ANSWER', () => {
  it('returns the stored paragraph for a repo whose README was read', () => {
    const db = migratedDb();
    recordRepoReadme(db, {
      repoId: 101,
      fullName: 'acme/widget',
      observedAt: T1,
      outcome: 'present',
      firstParagraph: 'Widget is a thing that does widgets.',
    });
    expect(cachedFirstParagraph(getRepoReadme(db, 101))).toBe('Widget is a thing that does widgets.');
  });

  it('returns null -- a real answer, meaning no README -- for absent and no_prose', () => {
    const db = migratedDb();
    recordRepoReadme(db, { repoId: 202, fullName: 'a/b', observedAt: T1, outcome: 'absent' });
    recordRepoReadme(db, { repoId: 303, fullName: 'a/c', observedAt: T1, outcome: 'no_prose' });

    expect(cachedFirstParagraph(getRepoReadme(db, 202))).toBeNull();
    expect(cachedFirstParagraph(getRepoReadme(db, 303))).toBeNull();
  });

  it('returns undefined for a failure-only record, so the request IS sent next time', () => {
    // If this ever returned null, a transient 503 would suppress a good repo
    // permanently -- the exact failure mode this task exists to close.
    const db = migratedDb();
    recordRepoReadme(db, {
      repoId: 404,
      fullName: 'a/d',
      observedAt: T1,
      outcome: 'failed',
      failure: 'error',
      detail: 'HTTP 502',
    });
    expect(cachedFirstParagraph(getRepoReadme(db, 404))).toBeUndefined();
  });

  it('returns undefined for a repo with no record at all', () => {
    expect(cachedFirstParagraph(null)).toBeUndefined();
  });
});

// ===========================================================================
// Supersession -- what a second observation of the same repo may and may not do
// ===========================================================================

describe('recordRepoReadme — supersession', () => {
  it('a later answer replaces an earlier one', () => {
    const db = migratedDb();
    recordRepoReadme(db, { repoId: 101, fullName: 'a/b', observedAt: T1, outcome: 'present', firstParagraph: 'Old.' });
    const outcome = recordRepoReadme(db, {
      repoId: 101,
      fullName: 'a/b',
      observedAt: T2,
      outcome: 'present',
      firstParagraph: 'New and rewritten.',
    });

    expect(outcome.action).toBe('updated');
    expect(getRepoReadme(db, 101)?.firstParagraph).toBe('New and rewritten.');
    expect(getRepoReadme(db, 101)?.answeredAt).toBe(T2);
  });

  it('A FAILED ATTEMPT NEVER CLOBBERS AN EXISTING ANSWER', () => {
    // Without this, one 503 wipes the excerpt off a row and flips readmeKnown
    // to false -- the lane would report "README not yet read" for a repo whose
    // README it read yesterday.
    const db = migratedDb();
    recordRepoReadme(db, {
      repoId: 101,
      fullName: 'a/b',
      observedAt: T1,
      outcome: 'present',
      firstParagraph: 'Still the right description.',
    });
    recordRepoReadme(db, {
      repoId: 101,
      fullName: 'a/b',
      observedAt: T2,
      outcome: 'failed',
      failure: 'error',
      detail: 'HTTP 503',
    });

    const record = getRepoReadme(db, 101);
    expect(record?.outcome).toBe('present');
    expect(record?.firstParagraph).toBe('Still the right description.');
    expect(record?.answeredAt).toBe(T1); // the answer is from T1...
    expect(record?.attemptedAt).toBe(T2); // ...and the ATTEMPT clock still moved
    expect(record?.attemptFailure).toBe('error');
    expect(isReadmeAnswered(record)).toBe(true);
  });

  it('a fresh answer clears a previous failure', () => {
    const db = migratedDb();
    recordRepoReadme(db, { repoId: 101, fullName: 'a/b', observedAt: T1, outcome: 'failed', failure: 'error', detail: 'HTTP 503' });
    recordRepoReadme(db, { repoId: 101, fullName: 'a/b', observedAt: T2, outcome: 'absent' });

    const record = getRepoReadme(db, 101);
    expect(record?.outcome).toBe('absent');
    expect(record?.attemptFailure).toBeNull();
    expect(record?.attemptDetail).toBeNull();
  });

  it('an out-of-order observation is ignored rather than applied', () => {
    // A retry that lands after the poll it was retrying already succeeded.
    const db = migratedDb();
    recordRepoReadme(db, { repoId: 101, fullName: 'a/b', observedAt: T2, outcome: 'present', firstParagraph: 'Newer.' });
    const outcome = recordRepoReadme(db, { repoId: 101, fullName: 'a/b', observedAt: T1, outcome: 'present', firstParagraph: 'Older.' });

    expect(outcome.action).toBe('ignored');
    expect(getRepoReadme(db, 101)?.firstParagraph).toBe('Newer.');
    expect(getRepoReadme(db, 101)?.attemptedAt).toBe(T2);
  });

  it('keeps first_attempted_at across every later observation', () => {
    const db = migratedDb();
    recordRepoReadme(db, { repoId: 101, fullName: 'a/b', observedAt: T1, outcome: 'failed', failure: 'error', detail: 'x' });
    recordRepoReadme(db, { repoId: 101, fullName: 'a/b', observedAt: T2, outcome: 'present', firstParagraph: 'A description of it.' });
    recordRepoReadme(db, { repoId: 101, fullName: 'a/b', observedAt: T3, outcome: 'present', firstParagraph: 'A newer description.' });

    expect(getRepoReadme(db, 101)?.firstAttemptedAt).toBe(T1);
  });

  it('refreshes full_name, since a repo can be renamed under the same numeric id', () => {
    const db = migratedDb();
    recordRepoReadme(db, { repoId: 101, fullName: 'old/name', observedAt: T1, outcome: 'absent' });
    recordRepoReadme(db, { repoId: 101, fullName: 'new/name', observedAt: T2, outcome: 'absent' });

    expect(getRepoReadme(db, 101)?.fullName).toBe('new/name');
  });
});

// ===========================================================================
// Schema enforcement, bypassing the access layer entirely.
//
// The access layer is one writer. The sqlite3 CLI, a repair script and a
// future pass that forgets are others, and §4's suppression rule is only as
// safe as the weakest of them. Every rule below is therefore in the SCHEMA.
// ===========================================================================

/** Every column, in declaration order -- the raw write path a repair script has. */
const RAW_INSERT = `
  insert into github_repo_readmes
    (repo_id, full_name, outcome, first_paragraph, readme_path, answered_at,
     attempted_at, attempt_failure, attempt_detail, first_attempted_at)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

describe('schema enforcement, bypassing the access layer', () => {
  it('refuses to delete a README record', () => {
    const db = migratedDb();
    recordRepoReadme(db, { repoId: 101, fullName: 'a/b', observedAt: T1, outcome: 'absent' });
    expect(() => db.exec('delete from github_repo_readmes')).toThrow(/never deleted/i);
  });

  it('refuses to restate which repo a row belongs to, or when it was first attempted', () => {
    const db = migratedDb();
    recordRepoReadme(db, { repoId: 101, fullName: 'a/b', observedAt: T1, outcome: 'absent' });
    // attempted_at advances too, so the monotonicity guard cannot be what
    // catches this -- only the identity guard can.
    expect(() =>
      db.exec(`update github_repo_readmes set repo_id = 999, attempted_at = '${T2}', answered_at = '${T2}'`),
    ).toThrow(/immutable/i);
    expect(() =>
      db.exec(`update github_repo_readmes set first_attempted_at = '${T2}', attempted_at = '${T2}', answered_at = '${T2}'`),
    ).toThrow(/immutable/i);
  });

  it('refuses to move the attempt clock backwards', () => {
    const db = migratedDb();
    recordRepoReadme(db, { repoId: 101, fullName: 'a/b', observedAt: T2, outcome: 'absent' });
    expect(() =>
      db.exec(`update github_repo_readmes set attempted_at = '${T1}', answered_at = '${T1}'`),
    ).toThrow(/may only move forward/i);
  });

  it('refuses to restate a PAST answer with an older one', () => {
    const db = migratedDb();
    recordRepoReadme(db, { repoId: 101, fullName: 'a/b', observedAt: T2, outcome: 'absent' });
    // The attempt clock legitimately advances; only answered_at goes backwards.
    expect(() =>
      db.exec(
        `update github_repo_readmes set attempted_at = '${T3}', answered_at = '${T1}', attempt_failure = 'error'`,
      ),
    ).toThrow(/may only move forward|restate a past answer/i);
  });

  it('refuses to un-answer a repo whose README question was already answered', () => {
    const db = migratedDb();
    recordRepoReadme(db, { repoId: 101, fullName: 'a/b', observedAt: T1, outcome: 'present', firstParagraph: 'A description.' });
    expect(() =>
      db.exec(
        `update github_repo_readmes set outcome = null, first_paragraph = null, readme_path = null,
         answered_at = null, attempted_at = '${T2}', attempt_failure = 'error'`,
      ),
    ).toThrow(/may not become unanswered/i);
  });

  it("refuses a 'present' row with no paragraph -- the exact shape that would read as 'no README'", () => {
    const db = migratedDb();
    expect(() =>
      db.prepare(RAW_INSERT).run(101, 'a/b', 'present', null, 'README.md', T1, T1, null, null, T1),
    ).toThrow(/CHECK constraint failed/i);
  });

  it("refuses an 'absent' row that carries a paragraph", () => {
    const db = migratedDb();
    expect(() =>
      db.prepare(RAW_INSERT).run(101, 'a/b', 'absent', 'Some prose.', null, T1, T1, null, null, T1),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('refuses an outcome that is not one of the three answers', () => {
    const db = migratedDb();
    // 'error' is an ATTEMPT failure, not an answer. Letting it into `outcome`
    // is exactly how an unread README would start reading as an answered one.
    expect(() =>
      db.prepare(RAW_INSERT).run(101, 'a/b', 'error', null, null, T1, T1, null, null, T1),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('refuses an answer with no instant attached, and an instant with no answer', () => {
    const db = migratedDb();
    expect(() =>
      db.prepare(RAW_INSERT).run(101, 'a/b', 'absent', null, null, null, T1, null, null, T1),
    ).toThrow(/CHECK constraint failed/i);
    expect(() =>
      db.prepare(RAW_INSERT).run(102, 'a/c', null, null, null, T1, T1, 'error', 'x', T1),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('refuses a row claiming both a successful last attempt and a failure', () => {
    const db = migratedDb();
    // answered_at === attempted_at says "the last attempt IS the answer";
    // attempt_failure says it failed. Both cannot be true.
    expect(() =>
      db.prepare(RAW_INSERT).run(101, 'a/b', 'absent', null, null, T1, T1, 'error', 'boom', T1),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('refuses an answer that postdates the last attempt that could have produced it', () => {
    const db = migratedDb();
    expect(() =>
      db.prepare(RAW_INSERT).run(101, 'a/b', 'absent', null, null, T2, T1, null, null, T1),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('refuses a whole README in the paragraph column', () => {
    const db = migratedDb();
    expect(() =>
      db.prepare(RAW_INSERT).run(101, 'a/b', 'present', 'x'.repeat(301), null, T1, T1, null, null, T1),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('caps the paragraph at MAX_EXCERPT_LENGTH, the same number the column enforces', () => {
    // The migration cannot import MAX_EXCERPT_LENGTH, so the two agree by
    // assertion rather than by construction. Raising the cap in code fails
    // HERE, loudly, rather than failing writes at 3am.
    expect(MAX_EXCERPT_LENGTH).toBe(300);

    const db = migratedDb();
    // A raw README, uncapped, straight from a caller that forgot -- accepted
    // and capped, never rejected.
    recordRepoReadme(db, {
      repoId: 101,
      fullName: 'a/b',
      observedAt: T1,
      outcome: 'present',
      firstParagraph: `${'word '.repeat(400)}end`,
    });
    expect(getRepoReadme(db, 101)!.firstParagraph!.length).toBeLessThanOrEqual(MAX_EXCERPT_LENGTH);
  });

  it("rejects a 'present' observation whose paragraph collapses to nothing, rather than reclassifying it", () => {
    // Silently turning it into 'no_prose' would be a plausible wrong answer:
    // the caller believed it had read a paragraph. Loud beats plausible.
    const db = migratedDb();
    expect(() =>
      recordRepoReadme(db, {
        repoId: 101,
        fullName: 'a/b',
        observedAt: T1,
        outcome: 'present',
        firstParagraph: '   \n\t  ',
      }),
    ).toThrow(/no_prose/);
  });

  it('refuses a non-canonical timestamp on insert and on update', () => {
    const db = migratedDb();
    expect(() =>
      db.prepare(RAW_INSERT).run(101, 'a/b', 'absent', null, null, '2026-08-14T12:00:00Z', '2026-08-14T12:00:00Z', null, null, '2026-08-14T12:00:00Z'),
    ).toThrow(/canonical UTC/i);

    recordRepoReadme(db, { repoId: 202, fullName: 'a/c', observedAt: T1, outcome: 'absent' });
    expect(() =>
      db.exec("update github_repo_readmes set attempted_at = '2026-08-15T12:00:00Z', answered_at = '2026-08-15T12:00:00Z'"),
    ).toThrow(/canonical UTC/i);
  });

  it('refuses a readme_path on a repo that has no README file at all', () => {
    const db = migratedDb();
    expect(() =>
      db.prepare(RAW_INSERT).run(101, 'a/b', 'absent', null, 'README.md', T1, T1, null, null, T1),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('refuses a failure detail with no failure attached to it', () => {
    const db = migratedDb();
    expect(() =>
      db.prepare(RAW_INSERT).run(101, 'a/b', 'absent', null, null, T1, T1, null, 'why?', T1),
    ).toThrow(/CHECK constraint failed/i);
  });
});

describe('getRepoReadmes — the batch read the enrichment pass uses', () => {
  it('returns one entry per repo that has a record, keyed by repo id', () => {
    const db = migratedDb();
    recordRepoReadme(db, { repoId: 101, fullName: 'a/b', observedAt: T1, outcome: 'present', firstParagraph: 'One of them.' });
    recordRepoReadme(db, { repoId: 202, fullName: 'a/c', observedAt: T1, outcome: 'absent' });

    const byId = getRepoReadmes(db, [101, 202, 303]);
    expect(byId.size).toBe(2);
    expect(byId.get(101)?.firstParagraph).toBe('One of them.');
    expect(byId.get(202)?.outcome).toBe('absent');
    expect(byId.has(303)).toBe(false);
  });

  it('returns an empty map for an empty id list without touching the database', () => {
    const db = migratedDb();
    expect(getRepoReadmes(db, []).size).toBe(0);
  });

  it('reads back more repos than SQLite will bind in one statement', () => {
    // 359 repos are already in the live corpus and the candidate pool only
    // grows; a single `in (?, ?, ...)` has a hard parameter ceiling.
    const db = migratedDb();
    const ids = Array.from({ length: 1200 }, (_v, i) => i + 1);
    for (const id of ids) {
      recordRepoReadme(db, { repoId: id, fullName: `a/r${id}`, observedAt: T1, outcome: 'absent' });
    }
    expect(getRepoReadmes(db, ids).size).toBe(1200);
  });
});
