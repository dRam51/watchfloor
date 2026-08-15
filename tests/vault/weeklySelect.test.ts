import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeDb, openDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, type Beat, type NewItem } from '../../src/domain/item.ts';
import { dismissItem, markItemRead } from '../../src/domain/itemState.ts';
import { loadSourcesFile, type Kind } from '../../src/sources/load.ts';
import { loadRankDepsFromConfigFiles } from '../../src/score/rank.ts';
import {
  DEFAULT_WEEKLY_LIMIT,
  WEEKLY_READING_KINDS,
  selectWeeklyReading,
  weeklyNoteInstant,
  type WeeklySelectionDeps,
} from '../../src/vault/weekly.ts';

/**
 * Which items belong in §8.1's weekly reading note.
 *
 * Four filters, and three of them are departures from a literal reading of
 * *"the week's top `read_score` items I haven't opened"*. Each is recorded
 * here rather than buried, because the M5 plan's RULING 1 is precedent for
 * exactly this shape of problem: a filter that selects the wrong population
 * is not fixed by being faithful to the sentence.
 *
 * ## 1. `read_score`, decayed — not `signal_score`
 *
 * Pinned below, because the two rank differently by design: `config/decay.yaml`
 * gives cyber a 6h signal half-life against a 336h read half-life, so a
 * fortnight-old explainer outranks a fresh advisory on the read profile and
 * loses to it on signal. Sorting a *weekly reading list* by signal produces
 * a list of this morning's breaking news.
 *
 * ## 2. `kind in (news, paper, blog)`
 *
 * THE FINDING THAT FORCED THIS. Ranked by decayed `read_score` over the live
 * corpus (5,937 items, `now` = 2026-08-15T22:00Z), **eighteen of the top
 * twenty items are bare CVE records** — `CVE-2026-21832`, `CVE-2026-73487`,
 * … — followed by four GitHub repository rows. Not one of them is a piece of
 * writing, and "what the piece argues" has no answer for `CVE-2026-21832`.
 *
 * That is not a scoring bug: `nvd-cve` is a weight-1.6 primary source and
 * cyber's read half-life is 336h, so recent CVEs genuinely score well on a
 * profile that rewards primary sources. It is a *population* mismatch, and
 * §8.1's own wording is the evidence — it says "the piece", four times.
 *
 * `kind` is the axis RULING 1 already chose for this class of question. The
 * bot's default is `news + advisory` (act on it); a reading list's is
 * `news + paper + blog` (read it) — advisories and aggregator rows are what
 * `signal_score` and the daily note's Flagged section are for. It is
 * source-level, stable, and configured, so retuning it is a config edit.
 *
 * **This needs the owner's ratification exactly as RULING 1 did.** It is
 * recorded in the task report rather than resolved silently.
 *
 * ## 3. Unread, and undismissed
 *
 * §8.1 says "I haven't opened". Dismissal is not in §8.1 at all, but §7's
 * "dismissed items never come back" is unambiguous and a reading list is
 * somewhere they would come back.
 *
 * ## 4. The limit counts BLURBABLE items
 *
 * Items we hold only a headline for still rank, and are still listed — in
 * their own section, without a blurb. They do not consume the limit, because
 * a week whose top twelve are all AP wire headlines would otherwise produce a
 * reading note with nothing to read.
 */

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

const NOW = '2026-08-15T22:00:00.000Z';

interface CorpusFixture {
  sourceId: string;
  title: string;
  url: string;
  publishedAt: string;
  summaryRaw: string | null;
  rawJson: string;
}

function corpus(name: string): CorpusFixture {
  return JSON.parse(
    readFileSync(join(process.cwd(), 'tests', 'fixtures', 'corpus', `${name}.json`), 'utf8'),
  ) as CorpusFixture;
}

/**
 * Real rows. Titles, URLs, excerpts and stored payloads are the bytes the live
 * corpus holds; only the scores are supplied by the test, because ranking is
 * `src/score/rank.ts`'s job and already has its own proof.
 */
function insertCorpusItem(
  db: ReturnType<typeof openDb>,
  name: string,
  overrides: Partial<NewItem> = {},
): { itemKey: string; itemId: string } {
  const fixture = corpus(name);
  const item = insertItem(db, {
    url: fixture.url,
    canonicalUrl: fixture.url,
    title: fixture.title,
    sourceId: fixture.sourceId,
    itemType: 'analysis',
    beats: ['ai'],
    entities: [],
    publishedAt: fixture.publishedAt,
    fetchedAt: '2026-08-14T18:38:50.262Z',
    summaryRaw: fixture.summaryRaw,
    rawJson: fixture.rawJson,
    ...overrides,
  } as NewItem);
  return { itemKey: item.item_key, itemId: item.item_id };
}

function score(
  db: ReturnType<typeof openDb>,
  itemId: string,
  beat: Beat,
  readScore: number,
  signalScore = 1,
): void {
  db.prepare(
    `insert into item_scores (score_id, item_id, beat, signal_score, read_score, scorer_version, computed_at)
     values (?,?,?,?,?,?,?)`,
  ).run(randomUUID(), itemId, beat, signalScore, readScore, 'test-v0', '2026-08-14T19:00:00.000Z');
}

function deps(readingKinds?: ReadonlySet<Kind>): WeeklySelectionDeps {
  const sources = loadSourcesFile(join(process.cwd(), 'config', 'sources.yaml'));
  return {
    rank: loadRankDepsFromConfigFiles(
      join(process.cwd(), 'config', 'decay.yaml'),
      join(process.cwd(), 'config', 'overrides.yaml'),
    ),
    sourceKinds: new Map(sources.map((source) => [source.id, source.kind ?? null])),
    ...(readingKinds ? { readingKinds } : {}),
  };
}

describe('selectWeeklyReading — the week', () => {
  it('files under the ISO week that `now` falls in, in WF_TZ', () => {
    const db = migratedDb();
    const selection = selectWeeklyReading(db, deps(), { now: NOW, tz: 'America/New_York' });
    expect(selection.week.label).toBe('2026-W33');
  });

  it('ranks as of the week itself, not as of the moment the job ran', () => {
    // The same reasoning the controller applied to `generatedAt`: `weekly/` is
    // rewritten every run, so everything in it must be a function of (corpus,
    // week, zone). A decayed `read_score` computed from the run's own clock
    // changes between Friday evening and Saturday morning, which would make
    // two renderings of one week's claim differ in their bytes.
    const db = migratedDb();
    const early = selectWeeklyReading(db, deps(), { now: '2026-08-14T13:00:00.000Z', tz: 'UTC' });
    const late = selectWeeklyReading(db, deps(), { now: NOW, tz: 'UTC' });
    expect(early.asOf).toBe(weeklyNoteInstant(early.week, 'UTC'));
    expect(late.asOf).toBe(early.asOf);
  });

  it('uses WF_TZ, not UTC, to decide which week `now` is in', () => {
    // 2026-08-17T02:00Z is Monday in UTC (week 34) and still Sunday evening
    // in New York (week 33). A Friday-evening job in a zone behind UTC would
    // otherwise write next week's file.
    const db = migratedDb();
    const late = '2026-08-17T02:00:00.000Z';
    expect(selectWeeklyReading(db, deps(), { now: late, tz: 'UTC' }).week.label).toBe('2026-W34');
    expect(
      selectWeeklyReading(db, deps(), { now: late, tz: 'America/New_York' }).week.label,
    ).toBe('2026-W33');
  });

  it('excludes an item published before the week', () => {
    const db = migratedDb();
    const older = insertCorpusItem(db, 'krebs-tracking', {
      publishedAt: '2026-08-03T12:00:00.000Z',
      beats: ['cyber'],
    });
    score(db, older.itemId, 'cyber', 9);

    const selection = selectWeeklyReading(db, deps(), { now: NOW, tz: 'UTC' });
    expect(selection.candidates).toHaveLength(0);
    expect(selection.excluded.outsideWeek).toBe(1);
  });
});

describe('selectWeeklyReading — what counts as a piece', () => {
  it('drops advisories and aggregator rows, which have nothing to argue', () => {
    const db = migratedDb();
    // A real CVE title from the live corpus's top-of-list, and a real repo row.
    const cve = insertItem(db, {
      url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-21832',
      canonicalUrl: 'https://nvd.nist.gov/vuln/detail/CVE-2026-21832',
      title: 'CVE-2026-21832',
      sourceId: 'nvd-cve',
      itemType: 'event',
      beats: ['cyber'],
      entities: [],
      publishedAt: '2026-08-13T10:00:00.000Z',
      fetchedAt: '2026-08-14T18:38:50.262Z',
      // The real NVD description for this real CVE id.
      summaryRaw:
        'HCL AION is affected by a vulnerability where indirect prompt injection can lead to ' +
        'HTML injection in rendered output. Injected markup may be displayed to users, ' +
        'potentially resulting in unintended behavior or security impact under certain conditions.',
      rawJson: '{}',
    });
    score(db, cve.item_id, 'cyber', 9.9);

    const repo = insertItem(db, {
      url: 'https://github.com/NVIDIA/SkillSpector',
      canonicalUrl: 'https://github.com/NVIDIA/SkillSpector',
      title: 'NVIDIA/SkillSpector',
      sourceId: 'github-topics',
      itemType: 'analysis',
      beats: ['repos'],
      entities: [],
      publishedAt: '2026-08-14T10:00:00.000Z',
      fetchedAt: '2026-08-14T18:38:50.262Z',
      summaryRaw: 'Inspect and score agent skills before you install them.',
      rawJson: '{}',
    });
    score(db, repo.item_id, 'repos', 9.8);

    const piece = insertCorpusItem(db, 'krebs-tracking', { beats: ['cyber'] });
    score(db, piece.itemId, 'cyber', 1);

    const selection = selectWeeklyReading(db, deps(), { now: NOW, tz: 'UTC' });
    expect(selection.candidates.map((c) => c.sourceId)).toEqual(['krebs']);
    expect(selection.excluded.wrongKind).toBe(2);
  });

  it('lets the reading kinds be widened without a code change', () => {
    const db = migratedDb();
    const cve = insertItem(db, {
      url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-21832',
      canonicalUrl: 'https://nvd.nist.gov/vuln/detail/CVE-2026-21832',
      title: 'CVE-2026-21832',
      sourceId: 'nvd-cve',
      itemType: 'event',
      beats: ['cyber'],
      entities: [],
      publishedAt: '2026-08-13T10:00:00.000Z',
      fetchedAt: '2026-08-14T18:38:50.262Z',
      // The real NVD description for this real CVE id.
      summaryRaw:
        'HCL AION is affected by a vulnerability where indirect prompt injection can lead to ' +
        'HTML injection in rendered output. Injected markup may be displayed to users, ' +
        'potentially resulting in unintended behavior or security impact under certain conditions.',
      rawJson: '{}',
    });
    score(db, cve.item_id, 'cyber', 9.9);

    const widened = new Set<Kind>([...WEEKLY_READING_KINDS, 'advisory']);
    const selection = selectWeeklyReading(db, deps(widened), { now: NOW, tz: 'UTC' });
    expect(selection.candidates.map((c) => c.sourceId)).toEqual(['nvd-cve']);
  });
});

describe('selectWeeklyReading — "I haven\'t opened"', () => {
  it('drops an item already read', () => {
    const db = migratedDb();
    const piece = insertCorpusItem(db, 'krebs-tracking', { beats: ['cyber'] });
    score(db, piece.itemId, 'cyber', 5);
    markItemRead(db, piece.itemKey, '2026-08-14T20:00:00.000Z');

    const selection = selectWeeklyReading(db, deps(), { now: NOW, tz: 'UTC' });
    expect(selection.candidates).toHaveLength(0);
    expect(selection.excluded.alreadyRead).toBe(1);
  });

  it('drops an item dismissed — §7s "dismissed items never come back"', () => {
    const db = migratedDb();
    const piece = insertCorpusItem(db, 'krebs-tracking', { beats: ['cyber'] });
    score(db, piece.itemId, 'cyber', 5);
    dismissItem(db, piece.itemKey, '2026-08-14T20:00:00.000Z');

    const selection = selectWeeklyReading(db, deps(), { now: NOW, tz: 'UTC' });
    expect(selection.candidates).toHaveLength(0);
    expect(selection.excluded.dismissed).toBe(1);
  });

  it('keeps an item that was saved but never opened', () => {
    const db = migratedDb();
    const piece = insertCorpusItem(db, 'krebs-tracking', { beats: ['cyber'] });
    score(db, piece.itemId, 'cyber', 5);
    // saved_at set, read_at still null: all eight flag combinations are legal
    // (src/domain/itemState.ts), and "saved for later" is precisely the state
    // a reading list should surface.
    db.prepare(
      'insert into item_state (item_key, read_at, saved_at, dismissed_at, updated_at) values (?,?,?,?,?)',
    ).run(piece.itemKey, null, '2026-08-14T20:00:00.000Z', null, '2026-08-14T20:00:00.000Z');

    const selection = selectWeeklyReading(db, deps(), { now: NOW, tz: 'UTC' });
    expect(selection.candidates).toHaveLength(1);
  });
});

describe('selectWeeklyReading — ordering and shape', () => {
  it('ranks by decayed read_score, descending', () => {
    const db = migratedDb();
    const a = insertCorpusItem(db, 'krebs-tracking', { beats: ['cyber'] });
    const b = insertCorpusItem(db, 'arxiv-car', { beats: ['ai'] });
    score(db, a.itemId, 'cyber', 2);
    score(db, b.itemId, 'ai', 6);

    const selection = selectWeeklyReading(db, deps(), { now: NOW, tz: 'UTC' });
    expect(selection.candidates.map((c) => c.sourceId)).toEqual(['arxiv-cs-ai', 'krebs']);
    expect(selection.candidates[0]!.readScore).toBeGreaterThan(selection.candidates[1]!.readScore);
  });

  it('lists a cross-listed item once, under its best-scoring beat', () => {
    // CLAUDE.md, four times over: an item belongs to several beats at once.
    // Ranking per beat and concatenating yields it twice.
    const db = migratedDb();
    const both = insertCorpusItem(db, 'hackernews-mcp', { beats: ['cyber', 'aisec'] });
    score(db, both.itemId, 'cyber', 3);
    score(db, both.itemId, 'aisec', 7);

    const selection = selectWeeklyReading(db, deps(), { now: NOW, tz: 'UTC' });
    expect(selection.candidates).toHaveLength(1);
    expect(selection.candidates[0]!.beat).toBe('aisec');
  });

  it('carries the evidence and read-time estimate for each candidate', () => {
    const db = migratedDb();
    const piece = insertCorpusItem(db, 'krebs-tracking', { beats: ['cyber'] });
    score(db, piece.itemId, 'cyber', 5);

    const [candidate] = selectWeeklyReading(db, deps(), { now: NOW, tz: 'UTC' }).candidates;
    expect(candidate!.evidence.level).toBe('body');
    expect(candidate!.readTime.minutes).toBeGreaterThan(5);
    expect(candidate!.url).toContain('krebsonsecurity.com');
  });
});

describe('selectWeeklyReading — the limit counts blurbable items', () => {
  it('does not let headline-only items consume the limit', () => {
    const db = migratedDb();
    // Six headline-only wire stories outranking one real piece: the live
    // corpus's usnews lane, in miniature.
    for (let i = 0; i < 6; i += 1) {
      const wire = insertItem(db, {
        url: `https://apnews.com/article/story-${i}`,
        canonicalUrl: `https://apnews.com/article/story-${i}`,
        title: `A wire headline number ${i}`,
        sourceId: 'ap-news',
        itemType: 'analysis',
        beats: ['usnews'],
        entities: [],
        publishedAt: '2026-08-14T12:00:00.000Z',
        fetchedAt: '2026-08-14T18:38:50.262Z',
        summaryRaw: null,
        rawJson: '{}',
      });
      score(db, wire.item_id, 'usnews', 9 - i * 0.1);
    }
    const piece = insertCorpusItem(db, 'krebs-tracking', { beats: ['cyber'] });
    score(db, piece.itemId, 'cyber', 1);

    const selection = selectWeeklyReading(db, deps(), { now: NOW, tz: 'UTC', limit: 2 });
    expect(selection.candidates).toHaveLength(1);
    expect(selection.candidates[0]!.sourceId).toBe('krebs');
    expect(selection.headlineOnly).toHaveLength(6);
    expect(selection.headlineOnly[0]!.title).toBe('A wire headline number 0');
  });

  it('stops at the limit, keeping the highest-scoring', () => {
    const db = migratedDb();
    const names = ['krebs-tracking', 'arxiv-car', 'hackernews-mcp', 'talos-jwr'] as const;
    names.forEach((name, index) => {
      const inserted = insertCorpusItem(db, name, { beats: ['ai'] });
      score(db, inserted.itemId, 'ai', 8 - index);
    });

    const selection = selectWeeklyReading(db, deps(), { now: NOW, tz: 'UTC', limit: 2 });
    expect(selection.candidates.map((c) => c.sourceId)).toEqual(['krebs', 'arxiv-cs-ai']);
  });

  it('has a default limit', () => {
    expect(DEFAULT_WEEKLY_LIMIT).toBeGreaterThan(0);
  });
});
