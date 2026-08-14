import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem } from '../../src/domain/item.ts';
import { recordStarSnapshots } from '../../src/ingest/starSnapshots.ts';
import { getStarSnapshots, resolveRepoId } from '../../src/db/repoSnapshots.ts';
import type { Source } from '../../src/sources/load.ts';

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

// Pinned explicitly, never inherited from the host -- the same discipline
// tests/db/repoSnapshots.test.ts holds itself to, and the property under test
// as much as the test's own hygiene.
const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';

function searchSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'github-topics',
    name: 'GitHub Topic Search',
    type: 'github_search',
    url: 'https://api.github.com/search/repositories',
    beats: ['repos'],
    weight: 1.0,
    poll_interval: '13m',
    enabled: true,
    enrichment: true,
    filters: { topics: ['llm'] },
    ...overrides,
  } as Source;
}

function rssSource(): Source {
  return {
    id: 'krebs',
    name: 'Krebs',
    type: 'rss',
    url: 'https://krebsonsecurity.com/feed/',
    beats: ['cyber'],
    weight: 1.0,
    poll_interval: '1h',
    enabled: true,
    enrichment: true,
  } as Source;
}

let seq = 0;
/**
 * Note `itemKey` is NOT a parameter: `insertItem` derives it as
 * sha256(canonicalUrl), so the url IS the identity. That is exactly the
 * property the rename test below depends on -- two urls for one repo give two
 * keys, and only GitHub's numeric id unifies them.
 */
function insertRepoItem(
  db: ReturnType<typeof openDb>,
  opts: { sourceId?: string; fetchedAt: string; rawJson: string; url?: string },
): string {
  seq += 1;
  const url = opts.url ?? `https://github.com/acme/repo-${seq}`;
  insertItem(db, {
    url,
    canonicalUrl: url,
    title: `repo ${seq}`,
    sourceId: opts.sourceId ?? 'github-topics',
    itemType: 'analysis',
    beats: ['repos'],
    entities: [],
    publishedAt: opts.fetchedAt,
    fetchedAt: opts.fetchedAt,
    summaryRaw: null,
    rawJson: opts.rawJson,
  });
  return url;
}

function keyFor(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

function repoJson(id: number, stars: number, fullName = 'acme/widget'): string {
  return JSON.stringify({ id, stargazers_count: stars, full_name: fullName });
}

describe('recordStarSnapshots', () => {
  it('records one snapshot per repo from a github_search source', () => {
    const db = migratedDb();
    insertRepoItem(db, { fetchedAt: '2026-08-14T16:00:00.000Z', rawJson: repoJson(101, 400, 'acme/one') });
    insertRepoItem(db, { fetchedAt: '2026-08-14T16:00:00.000Z', rawJson: repoJson(202, 40, 'acme/two') });

    const sweep = recordStarSnapshots(db, [searchSource()], '2026-08-14T16:00:00.000Z', NY);

    expect(sweep).toEqual({ examined: 2, inserted: 2, updated: 0, ignored: 0, unusable: 0 });
    expect(getStarSnapshots(db, 101).map((s) => s.stars)).toEqual([400]);
    expect(getStarSnapshots(db, 202).map((s) => s.stars)).toEqual([40]);
  });

  it('ignores sources that are not github_search -- an RSS item has no stargazers_count and must not be probed', () => {
    const db = migratedDb();
    insertRepoItem(db, { sourceId: 'krebs', fetchedAt: '2026-08-14T16:00:00.000Z', rawJson: repoJson(101, 400) });

    const sweep = recordStarSnapshots(db, [rssSource()], '2026-08-14T16:00:00.000Z', NY);

    expect(sweep.examined).toBe(0);
    expect(getStarSnapshots(db, 101)).toEqual([]);
  });

  it('keys on GitHub numeric id, so a rename continues one history instead of starting a second', () => {
    // Task 2's identity decision, exercised end to end: same repo id, new
    // owner/name and therefore a new item_key (item_key follows the URL).
    const db = migratedDb();
    const oldUrl = insertRepoItem(db, { fetchedAt: '2026-08-13T16:00:00.000Z', rawJson: repoJson(101, 40, 'old/name'), url: 'https://github.com/old/name' });
    recordStarSnapshots(db, [searchSource()], '2026-08-13T16:00:00.000Z', NY);

    const newUrl = insertRepoItem(db, { fetchedAt: '2026-08-14T16:00:00.000Z', rawJson: repoJson(101, 400, 'new/name'), url: 'https://github.com/new/name' });
    recordStarSnapshots(db, [searchSource()], '2026-08-14T16:00:00.000Z', NY);

    // ONE history of two readings, not two histories of one.
    expect(getStarSnapshots(db, 101).map((s) => s.stars)).toEqual([40, 400]);
    expect(keyFor(oldUrl)).not.toBe(keyFor(newUrl)); // two identities...
    expect(resolveRepoId(db, keyFor(oldUrl))).toBe(101); // ...one repo
    expect(resolveRepoId(db, keyFor(newUrl))).toBe(101);
  });

  it('takes the latest version of a re-polled item_key, not an arbitrary one', () => {
    // Append-only storage: one key, several versions. The current star count
    // is the newest one's.
    const db = migratedDb();
    // Same url -> same derived item_key -> two VERSIONS of one item.
    const url = 'https://github.com/acme/repolled';
    insertRepoItem(db, { fetchedAt: '2026-08-13T16:00:00.000Z', rawJson: repoJson(101, 40), url });
    insertRepoItem(db, { fetchedAt: '2026-08-14T16:00:00.000Z', rawJson: repoJson(101, 400), url });

    const sweep = recordStarSnapshots(db, [searchSource()], '2026-08-14T16:00:00.000Z', NY);

    expect(sweep.examined).toBe(1);
    expect(getStarSnapshots(db, 101).map((s) => s.stars)).toEqual([400]);
  });

  it('is idempotent within a day -- a second sweep updates rather than duplicating', () => {
    // The property task 2's primary key exists to guarantee, proven through
    // this caller: a double poll must not inflate velocity's denominator.
    const db = migratedDb();
    insertRepoItem(db, { fetchedAt: '2026-08-14T16:00:00.000Z', rawJson: repoJson(101, 400) });

    const first = recordStarSnapshots(db, [searchSource()], '2026-08-14T16:00:00.000Z', NY);
    const second = recordStarSnapshots(db, [searchSource()], '2026-08-14T18:00:00.000Z', NY);

    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);
    expect(getStarSnapshots(db, 101)).toHaveLength(1);
  });

  it('counts an unusable row instead of recording a false zero-star reading', () => {
    // The failure that would matter: a missing stargazers_count recorded as 0
    // is not "unknown", it is a reading -- and a false one that would surface
    // the next day as a catastrophic negative velocity.
    const db = migratedDb();
    insertRepoItem(db, { fetchedAt: '2026-08-14T16:00:00.000Z', rawJson: JSON.stringify({ id: 101, full_name: 'acme/widget' }) });
    insertRepoItem(db, { fetchedAt: '2026-08-14T16:00:00.000Z', rawJson: 'not json at all' });
    insertRepoItem(db, { fetchedAt: '2026-08-14T16:00:00.000Z', rawJson: JSON.stringify({ id: 0, stargazers_count: 5, full_name: 'a/b' }) });

    const sweep = recordStarSnapshots(db, [searchSource()], '2026-08-14T16:00:00.000Z', NY);

    expect(sweep).toEqual({ examined: 3, inserted: 0, updated: 0, ignored: 0, unusable: 3 });
    expect(getStarSnapshots(db, 101)).toEqual([]);
  });

  it('buckets by the calendar day in the GIVEN zone, not UTC and not the host', () => {
    // 02:30 UTC on the 15th is 22:30 on the 14th in New York, and 11:30 on the
    // 15th in Tokyo. A UTC-only implementation gets Tokyo right by accident
    // and New York wrong.
    const db = migratedDb();
    insertRepoItem(db, { fetchedAt: '2026-08-15T02:30:00.000Z', rawJson: repoJson(101, 400) });
    insertRepoItem(db, { fetchedAt: '2026-08-15T02:30:00.000Z', rawJson: repoJson(202, 400) });

    recordStarSnapshots(db, [searchSource()], '2026-08-15T02:30:00.000Z', NY);
    expect(getStarSnapshots(db, 101).map((s) => s.snapshotDay)).toEqual(['2026-08-14']);

    recordStarSnapshots(db, [searchSource({ id: 'github-topics' })], '2026-08-15T02:30:00.000Z', TOKYO);
    expect(getStarSnapshots(db, 202).map((s) => s.snapshotDay)).toContain('2026-08-15');
  });

  it('returns an all-zero sweep when no github_search source is configured', () => {
    const db = migratedDb();
    expect(recordStarSnapshots(db, [rssSource()], '2026-08-14T16:00:00.000Z', NY)).toEqual({
      examined: 0,
      inserted: 0,
      updated: 0,
      ignored: 0,
      unusable: 0,
    });
  });
});
