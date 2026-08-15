import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, type NewItem } from '../../src/domain/item.ts';
import { scoreItem, type MechanicalScoreConfig, type ScoreItemDeps } from '../../src/score/mechanical.ts';
import type { DecayConfig } from '../../src/score/decay.ts';
import type { OverridesConfig } from '../../src/score/overrides.ts';
import type { Source } from '../../src/sources/load.ts';
import { openVaultSession } from '../../src/vault/session.ts';
import {
  buildDailyNote,
  dailyNoteInstant,
  writeDailyNote,
  type DailyNoteDeps,
} from '../../src/vault/daily.ts';
import { createFixtureVault, digestTree, listTree } from './fixture.ts';

/**
 * The daily note (M5 task 5).
 *
 * §8.1: *"Idempotent overwrite, not append."* M5 acceptance sharpens that into
 * a property: delete the whole `watchfloor/` tree, re-run sync, and `daily/`
 * must reproduce **exactly**. So the note has to be a pure function of (corpus
 * state, date, config) — which starts with the instant the note is computed
 * against being derived from the date, never read from a clock.
 */

// ---------------------------------------------------------------------------
// Temp-DB plumbing, mirroring tests/score/rank.test.ts exactly. Real
// migrations, real SQLite, no mocks.
// ---------------------------------------------------------------------------

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

const DATE = '2026-08-15';
const TZ = 'America/Toronto';
/** The instant DATE ends in TZ. Every fixture timestamp is stated relative to it. */
const AS_OF = '2026-08-16T03:59:59.999Z';
/** Exactly 24 hours before AS_OF — one half-life under the test decay config. */
const ONE_HALF_LIFE_BEFORE = '2026-08-15T03:59:59.999Z';

function source(overrides: Partial<Source> & Pick<Source, 'id'>): Source {
  return {
    name: overrides.id,
    type: 'rss',
    url: `https://example.test/${overrides.id}`,
    beats: ['cyber'],
    weight: 1,
    poll_interval: '1h',
    enabled: true,
    enrichment: true,
    ...overrides,
  } as Source;
}

function baseItem(overrides: Partial<NewItem> = {}): NewItem {
  return {
    url: 'https://example.test/a',
    canonicalUrl: 'https://example.test/a',
    title: 'A title',
    sourceId: 'cisa-kev',
    itemType: 'analysis',
    beats: ['cyber'],
    entities: [],
    publishedAt: ONE_HALF_LIFE_BEFORE,
    fetchedAt: ONE_HALF_LIFE_BEFORE,
    summaryRaw: null,
    rawJson: '{}',
    ...overrides,
  };
}

/** Round, hand-checkable weights — the same convention tests/score/rank.test.ts uses. */
function testScoreConfig(): MechanicalScoreConfig {
  return {
    scorer_version: 'test-v0',
    source: { min_weight: 0, max_weight: 10, signal_weight: 4, read_weight: 2 },
    cluster: { saturation_size: 4, signal_weight: 4, read_weight: 1 },
    interest: { boost_gain: 1, suppress_gain: 1, multiplier_floor: 0, multiplier_ceiling: 5 },
    high_on_both: { signal_threshold: 5, read_threshold: 2 },
    portfolio: { portfolio_path: 'config/portfolio.yaml' },
  };
}

const SOURCES: Source[] = [
  source({ id: 'cisa-kev', beats: ['cyber'], weight: 2.0, kind: 'advisory' }),
  source({ id: 'ap-news', beats: ['usnews'], weight: 1.8, kind: 'news' }),
  source({ id: 'krebs', beats: ['cyber'], weight: 1.4, kind: 'blog' }),
];

function scoreDeps(sources: Source[] = SOURCES): ScoreItemDeps {
  return { sources, interestProfile: { boosts: [], suppressions: [] }, config: testScoreConfig() };
}

/** Every beat on one 24-hour signal half-life, so a decayed score is exactly half. */
function testDecayConfig(): DecayConfig {
  const pair = { signal_half_life_hours: 24, read_half_life_hours: 168 };
  return {
    beats: { ai: pair, cyber: pair, aisec: pair, repos: pair, usnews: pair },
    markets_item_types: { event: pair, analysis: pair, press: pair },
  };
}

/** One DISABLED rule: the real Zod schema rejects an empty `overrides` array. */
function noOverridesConfig(): OverridesConfig {
  return {
    overrides: [
      {
        id: 'disabled-placeholder',
        label: 'disabled placeholder',
        kind: 'source_match',
        source_id: 'nonexistent-source',
        recency_bound_days: 1,
        applies_to: ['signal'],
        priority: 1,
        enabled: false,
        note: 'test fixture: intentionally disabled so nothing this module does ever fires it',
      },
    ],
  };
}

function deps(overrides: Partial<DailyNoteDeps> = {}): DailyNoteDeps {
  return {
    tz: TZ,
    decayConfig: testDecayConfig(),
    overridesConfig: noOverridesConfig(),
    sources: SOURCES,
    interests: { boosts: [], suppressions: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// dailyNoteInstant
// ---------------------------------------------------------------------------

describe('dailyNoteInstant — the note`s `now`, derived from its date', () => {
  it('is the last millisecond of the calendar day in the configured zone', () => {
    // 2026-08-15 in Toronto is UTC-4, so the day ends at 03:59:59.999Z on the 16th.
    expect(dailyNoteInstant(DATE, TZ)).toBe(AS_OF);
  });

  it('is UTC-identical for a UTC zone', () => {
    expect(dailyNoteInstant('2026-08-15', 'UTC')).toBe('2026-08-15T23:59:59.999Z');
  });

  it('reads the zone from its argument, never the host', () => {
    expect(dailyNoteInstant('2026-08-15', 'Asia/Tokyo')).toBe('2026-08-15T14:59:59.999Z');
  });
});

// ---------------------------------------------------------------------------
// The whole note, byte for byte
// ---------------------------------------------------------------------------

describe('buildDailyNote — the file, in full', () => {
  it('renders one cyber item into the complete note', () => {
    const db = migratedDb();
    const item = insertItem(
      db,
      baseItem({
        url: 'https://example.test/kev/a',
        canonicalUrl: 'https://example.test/kev/a',
        title: 'CVE-2026-1234 added to the KEV catalog',
      }),
    );
    scoreItem(db, item.item_key, ONE_HALF_LIFE_BEFORE, scoreDeps());

    const note = buildDailyNote(db, DATE, deps());

    expect(note.relPath).toBe('daily/2026-08-15.md');
    expect(note.asOf).toBe(AS_OF);
    // signal: source component (2.0-0)/(10-0) = 0.2, x4 = 0.8; cluster size 1
    // contributes log2(1) = 0; no interest match, so multiplier 1. Published
    // exactly one 24h half-life before AS_OF, so the decayed value is 0.400.
    expect(note.content).toBe(
      [
        '---',
        'watchfloor: managed',
        'watchfloor_tier: fully-managed',
        'watchfloor_generated_at: 2026-08-16T03:59:59.999Z',
        'date: 2026-08-15',
        'timezone: America/Toronto',
        'top_per_beat: 5',
        'count_flagged: 0',
        'count_ai: 0',
        'count_cyber: 1',
        'count_aisec: 0',
        'count_repos: 0',
        'count_markets: 0',
        'count_usnews: 0',
        'market_ribbon: not_configured',
        'market_ribbon_detail: "no markets source is configured (M4b), so there is no ribbon to snapshot — an absent data source, not a flat market"',
        '---',
        '',
        '# Watchfloor — 2026-08-15',
        '',
        '> Corpus as of 2026-08-16T03:59:59.999Z — the end of 2026-08-15 in America/Toronto.',
        '> Rewritten in place on every run. Same corpus, same bytes: nothing here reads a clock.',
        '',
        '## Flagged',
        '',
        'Nothing is pinned by a hard override as of this instant.',
        '',
        '## ai',
        '',
        'No source is configured for this beat — an absent data source, not a quiet day.',
        '',
        '## cyber',
        '',
        '1 ranked · 0 flagged · top 1 by signal.',
        '',
        '- [CVE-2026-1234 added to the KEV catalog](https://example.test/kev/a) — cisa-kev (trust 2.0) · single source · 24h old · signal 0.400',
        '',
        '## aisec',
        '',
        'No source is configured for this beat — an absent data source, not a quiet day.',
        '',
        '## repos',
        '',
        'No source is configured for this beat — an absent data source, not a quiet day.',
        '',
        '## markets',
        '',
        'No source is configured for this beat — an absent data source, not a quiet day.',
        '',
        '## usnews',
        '',
        'No scored item as of this instant.',
        '',
      ].join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// Reproducibility — the M5 acceptance property
// ---------------------------------------------------------------------------

/**
 * A vault whose sync root does NOT exist: the state M5 acceptance produces by
 * deleting the whole `watchfloor/` tree.
 *
 * Built fresh rather than by deleting one — CLAUDE.md's never-delete rule
 * applies to test code too, and a directory that was never created is
 * indistinguishable, to the code under test, from one that was removed. The
 * anchor carries a sibling file because the mount guard refuses an empty
 * parent: an empty parent is the signature of a shadow tree.
 */
function bareVault(): string {
  const anchor = mkdtempSync(join(tmpdir(), 'wf-bare-vault-'));
  writeFileSync(join(anchor, 'VAULT-INDEX.md'), '# Vault index\n');
  return join(anchor, 'Watchfloor');
}

function corpusWithOneItem() {
  const db = migratedDb();
  const item = insertItem(
    db,
    baseItem({
      url: 'https://example.test/kev/a',
      canonicalUrl: 'https://example.test/kev/a',
      title: 'CVE-2026-1234 added to the KEV catalog',
    }),
  );
  scoreItem(db, item.item_key, ONE_HALF_LIFE_BEFORE, scoreDeps());
  return db;
}

describe('idempotent overwrite — the same corpus rewrites the same bytes', () => {
  it('writes byte-identical content twice, and the second write is not a creation', () => {
    const db = corpusWithOneItem();
    const vault = createFixtureVault();
    const session = openVaultSession(vault.root);

    const first = writeDailyNote(session, db, DATE, deps());
    const afterFirst = readFileSync(join(vault.root, first.relPath), 'utf8');

    const second = writeDailyNote(session, db, DATE, deps());
    const afterSecond = readFileSync(join(vault.root, second.relPath), 'utf8');

    expect(afterSecond).toBe(afterFirst);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false); // overwrite, never append
    expect(afterSecond.split('# Watchfloor').length - 1).toBe(1); // and definitely not appended
  });

  it('reproduces the same bytes into a vault whose watchfloor/ tree does not exist', () => {
    const db = corpusWithOneItem();

    const populated = createFixtureVault();
    const written = writeDailyNote(openVaultSession(populated.root), db, DATE, deps());
    const fromPopulated = readFileSync(join(populated.root, written.relPath), 'utf8');

    // The acceptance case: no root, no daily/, nothing.
    const root = bareVault();
    const rebuilt = writeDailyNote(openVaultSession(root), db, DATE, deps());
    expect(readFileSync(join(root, rebuilt.relPath), 'utf8')).toBe(fromPopulated);
  });

  it('contains no timestamp other than the note`s own as-of instant', () => {
    // The direct test that no wall clock leaked in: a `new Date().toISOString()`
    // anywhere in the note would show up here as a second, different instant.
    const note = buildDailyNote(corpusWithOneItem(), DATE, deps());
    const stamps = [...note.content.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g)].map((m) => m[0]);
    expect(stamps.length).toBeGreaterThan(0);
    expect([...new Set(stamps)]).toEqual([AS_OF]);
  });

  it('touches nothing else in the vault', () => {
    const db = corpusWithOneItem();
    const vault = createFixtureVault();
    const before = digestTree(vault.anchor);

    const written = writeDailyNote(openVaultSession(vault.root), db, DATE, deps());

    const after = digestTree(vault.anchor);
    const added = listTree(vault.anchor).filter((p) => !before.has(p));
    expect(added).toEqual([join('Watchfloor', written.relPath)]);
    for (const [path, digest] of before) expect(after.get(path)).toBe(digest);
  });
});

// ---------------------------------------------------------------------------
// Point in time
// ---------------------------------------------------------------------------

describe('the candidate set is bounded by the note`s instant', () => {
  it('excludes an item first fetched after the day ended', () => {
    const db = migratedDb();
    const kept = insertItem(db, baseItem({ title: 'Known that day' }));
    const later = insertItem(
      db,
      baseItem({
        url: 'https://example.test/tomorrow',
        canonicalUrl: 'https://example.test/tomorrow',
        title: 'Ingested the next morning',
        publishedAt: '2026-08-16T12:00:00.000Z',
        fetchedAt: '2026-08-16T12:00:00.000Z',
      }),
    );
    scoreItem(db, kept.item_key, ONE_HALF_LIFE_BEFORE, scoreDeps());
    scoreItem(db, later.item_key, '2026-08-16T12:00:00.000Z', scoreDeps());

    const note = buildDailyNote(db, DATE, deps());
    expect(note.content).toContain('Known that day');
    expect(note.content).not.toContain('Ingested the next morning');
    expect(note.sections.find((s) => s.beat === 'cyber')!.ranked).toBe(1);
  });

  it('shows the version that existed that day, not the one that replaced it', () => {
    // `items` is append-only and a title really does change under a URL that
    // does not -- task 3 found ten such keys in the live corpus, one of which
    // REVERSED its claim ("Wall Street holds near its record" -> "slips back
    // from its record"). Reading the current version would put tomorrow's
    // headline in yesterday's note.
    const db = migratedDb();
    const url = 'https://example.test/kev/revised';
    const v1 = insertItem(db, baseItem({ url, canonicalUrl: url, title: 'First wording' }));
    insertItem(
      db,
      baseItem({
        url,
        canonicalUrl: url,
        title: 'Revised the next morning',
        fetchedAt: '2026-08-16T12:00:00.000Z',
      }),
    );
    scoreItem(db, v1.item_key, ONE_HALF_LIFE_BEFORE, scoreDeps());

    const note = buildDailyNote(db, DATE, deps());
    expect(note.content).toContain('First wording');
    expect(note.content).not.toContain('Revised the next morning');
  });
});

// ---------------------------------------------------------------------------
// Flagged — pinning is a separate axis from score
// ---------------------------------------------------------------------------

/** Two enabled rules at different priorities, both recency-bounded like the real config. */
function pinningOverridesConfig(): OverridesConfig {
  return {
    overrides: [
      {
        id: 'cisa-kev-addition',
        label: 'CISA KEV addition',
        kind: 'source_match',
        source_id: 'cisa-kev',
        recency_bound_days: 30,
        applies_to: ['signal'],
        priority: 1,
        enabled: true,
      },
      {
        id: 'ap-wire-alert',
        label: 'AP wire alert',
        kind: 'source_match',
        source_id: 'ap-news',
        recency_bound_days: 30,
        applies_to: ['signal'],
        priority: 3,
        enabled: true,
      },
    ],
  };
}

/** 29 days before AS_OF: inside the 30-day bound, and decayed to nothing. */
const TWENTY_NINE_DAYS_BEFORE = '2026-07-18T03:59:59.999Z';
const ONE_HOUR_BEFORE = '2026-08-16T02:59:59.999Z';

function pinnedCorpus() {
  const db = migratedDb();
  const stale = insertItem(
    db,
    baseItem({
      url: 'https://example.test/kev/old',
      canonicalUrl: 'https://example.test/kev/old',
      title: 'CVE-2026-0001, still unpatched',
      publishedAt: TWENTY_NINE_DAYS_BEFORE,
      fetchedAt: TWENTY_NINE_DAYS_BEFORE,
    }),
  );
  const fresh = insertItem(
    db,
    baseItem({
      url: 'https://example.test/ap/wire',
      canonicalUrl: 'https://example.test/ap/wire',
      title: 'Wire alert',
      sourceId: 'ap-news',
      beats: ['usnews'],
      publishedAt: ONE_HOUR_BEFORE,
      fetchedAt: ONE_HOUR_BEFORE,
    }),
  );
  scoreItem(db, stale.item_key, TWENTY_NINE_DAYS_BEFORE, scoreDeps());
  scoreItem(db, fresh.item_key, ONE_HOUR_BEFORE, scoreDeps());
  return { db, stale, fresh };
}

describe('Flagged — ordered by override priority, never by score', () => {
  it('leads with a pin whose decayed signal rounds to 0.000, ahead of a higher-scoring pin', () => {
    const { db, stale, fresh } = pinnedCorpus();
    const note = buildDailyNote(db, DATE, deps({ overridesConfig: pinningOverridesConfig() }));

    expect(note.flagged.map((e) => e.itemKey)).toEqual([stale.item_key, fresh.item_key]);
    // The trap this ordering exists to avoid: by score, these are the other way round.
    expect(note.flagged[0]!.signalScore).toBeLessThan(note.flagged[1]!.signalScore);

    const lines = note.content.split('\n').filter((l) => l.startsWith('- ['));
    expect(lines[0]).toBe(
      '- [CVE-2026-0001, still unpatched](https://example.test/kev/old) — **CISA KEV addition** (priority 1) · cyber · cisa-kev (trust 2.0) · single source · 29d old · signal 0.000',
    );
    expect(lines[1]).toContain('**AP wire alert** (priority 3)');
  });

  it('hoists pinned items out of their beat`s top N rather than printing them twice', () => {
    const { db, stale } = pinnedCorpus();
    const unpinned = insertItem(
      db,
      baseItem({
        url: 'https://example.test/krebs/a',
        canonicalUrl: 'https://example.test/krebs/a',
        title: 'A Krebs piece',
        sourceId: 'krebs',
      }),
    );
    scoreItem(db, unpinned.item_key, ONE_HALF_LIFE_BEFORE, scoreDeps());

    const note = buildDailyNote(db, DATE, deps({ overridesConfig: pinningOverridesConfig() }));
    const cyber = note.sections.find((s) => s.beat === 'cyber')!;

    expect(cyber.ranked).toBe(2);
    expect(cyber.flagged).toBe(1);
    expect(cyber.shown.map((e) => e.itemKey)).toEqual([unpinned.item_key]);
    expect(note.content).toContain('2 ranked · 1 flagged · top 1 by signal.');
    // Exactly once in the whole note, and it is in Flagged.
    expect(note.content.split('CVE-2026-0001').length - 1).toBe(1);
    expect(stale.item_key).toBeTruthy();
  });

  it('says so when every one of a beat`s ranked items was hoisted', () => {
    const { db } = pinnedCorpus();
    const note = buildDailyNote(db, DATE, deps({ overridesConfig: pinningOverridesConfig() }));
    expect(note.content).toContain(
      '1 ranked · 1 flagged · every ranked item is pinned and appears in Flagged above.',
    );
  });

  it('reports the total when the flagged cap truncates, rather than truncating silently', () => {
    const { db } = pinnedCorpus();
    const note = buildDailyNote(
      db,
      DATE,
      deps({ overridesConfig: pinningOverridesConfig(), flaggedLimit: 1 }),
    );
    expect(note.flaggedTotal).toBe(2);
    expect(note.flagged).toHaveLength(1);
    expect(note.content).toContain('2 pinned by a hard override; showing the 1 highest-priority.');
  });

  it('pins a cross-listed item once, naming every beat it carries', () => {
    const db = migratedDb();
    const url = 'https://arxiv.org/abs/2608.11274';
    const first = insertItem(
      db,
      baseItem({ url, canonicalUrl: url, title: 'Cross-listed paper', beats: ['aisec'] }),
    );
    insertItem(db, baseItem({ url, canonicalUrl: url, title: 'Cross-listed paper', beats: ['ai'] }));
    scoreItem(db, first.item_key, ONE_HALF_LIFE_BEFORE, scoreDeps());

    const sources = [...SOURCES, source({ id: 'cisa-kev', beats: ['ai', 'aisec', 'cyber'], weight: 2.0 })];
    const note = buildDailyNote(
      db,
      DATE,
      deps({ overridesConfig: pinningOverridesConfig(), sources }),
    );

    expect(note.flagged).toHaveLength(1);
    expect(note.flagged[0]!.beats).toEqual(['ai', 'aisec']);
    expect(note.content.split('Cross-listed paper').length - 1).toBe(1);
    expect(note.content).toContain('(priority 1) · ai/aisec ·');
  });
});

// ---------------------------------------------------------------------------
// The one-line why
// ---------------------------------------------------------------------------

describe('the one-line why — ranking evidence, assembled from stored facts', () => {
  function oneItemNote(item: Partial<NewItem>, extra: Partial<DailyNoteDeps> = {}) {
    const db = migratedDb();
    const inserted = insertItem(db, baseItem(item));
    scoreItem(db, inserted.item_key, ONE_HALF_LIFE_BEFORE, scoreDeps());
    const note = buildDailyNote(db, DATE, deps(extra));
    return note.content.split('\n').find((l) => l.startsWith('- ['))!;
  }

  it('says when an item is undated, and dates it from when we first saw it', () => {
    expect(oneItemNote({ publishedAt: null })).toContain('undated, first seen 24h ago');
  });

  it('names the interest terms that matched', () => {
    const line = oneItemNote(
      { title: 'A prompt injection in a Kubernetes operator' },
      {
        interests: {
          boosts: [
            { term: 'prompt injection', weight: 1 },
            { term: 'kubernetes', weight: 1 },
          ],
          suppressions: [],
        },
      },
    );
    expect(line).toContain('matches "prompt injection", "kubernetes"');
  });

  it('names a suppression too — a suppressed item can still be a beat`s best', () => {
    const line = oneItemNote(
      { title: 'Phillies beat Twins 7-1' },
      { interests: { boosts: [], suppressions: [{ term: 'phillies', weight: 1 }] } },
    );
    expect(line).toContain('suppressed by "phillies"');
  });

  it('keeps a multi-line title on one line and escapes what would end the link', () => {
    const line = oneItemNote({ title: 'A [bracketed]\n  headline' });
    expect(line.startsWith('- [A \\[bracketed\\] headline](')).toBe(true);
  });

  it('percent-encodes only what would break the link target', () => {
    const url = 'https://example.test/a (b)/c';
    expect(oneItemNote({ url, canonicalUrl: url })).toContain('(https://example.test/a%20%28b%29/c)');
  });

  it('says so rather than guessing when the source has since left config', () => {
    // The real shape: the item was scored while the source existed, then the
    // source was removed from config/sources.yaml. `items` is append-only, so
    // the row outlives its source and the note has no weight to quote.
    const db = migratedDb();
    const retired = source({ id: 'retired-feed', beats: ['cyber'], weight: 1.1 });
    const item = insertItem(db, baseItem({ sourceId: 'retired-feed' }));
    scoreItem(db, item.item_key, ONE_HALF_LIFE_BEFORE, scoreDeps([...SOURCES, retired]));

    const note = buildDailyNote(db, DATE, deps());
    expect(note.content).toContain('retired-feed (trust unknown)');
  });
});

// ---------------------------------------------------------------------------
// Absent data sources say they are absent
// ---------------------------------------------------------------------------

describe('an absent data source is never rendered as a quiet one', () => {
  it('distinguishes a beat whose sources are all disabled from one with none', () => {
    const sources = [
      source({ id: 'cisa-kev', beats: ['cyber'], weight: 2.0 }),
      source({ id: 'arxiv-cs-ai', beats: ['ai'], weight: 0.9, enabled: false }),
    ];
    const note = buildDailyNote(migratedDb(), DATE, deps({ sources }));
    expect(note.content).toContain(
      'Every source configured for this beat is disabled — an absent data source, not a quiet day.',
    );
    expect(note.sections.find((s) => s.beat === 'ai')!.coverage).toBe('all_sources_disabled');
    expect(note.sections.find((s) => s.beat === 'markets')!.coverage).toBe('no_source');
  });

  it('reports the market ribbon as not configured, never as a number', () => {
    const note = buildDailyNote(migratedDb(), DATE, deps());
    expect(note.content).toContain('market_ribbon: not_configured');
    expect(note.content).toContain('an absent data source, not a flat market');
    expect(note.content).not.toMatch(/market_ribbon:\s*(0|\{\}|\[\]|""|null)/);
  });

  it('still reports not_configured once a markets SOURCE exists, because the ribbon itself is M4b', () => {
    const sources = [...SOURCES, source({ id: 'sec-edgar', beats: ['markets'], weight: 2.0 })];
    const note = buildDailyNote(migratedDb(), DATE, deps({ sources }));
    expect(note.content).toContain('market_ribbon: not_configured');
    expect(note.content).toContain('the §7 market ribbon itself is M4b and does not exist yet');
    expect(note.content).toContain('No scored item as of this instant.');
  });
});

// ---------------------------------------------------------------------------
// The tier guarantee, inherited from task 4
// ---------------------------------------------------------------------------

describe('a hand-authored note sitting at the daily note`s own path', () => {
  it('is refused, not overwritten', () => {
    const db = corpusWithOneItem();
    const vault = createFixtureVault();
    const path = join(vault.root, 'daily', `${DATE}.md`);
    const mine = '# My own note\n\nI put this here by hand.\n';
    writeFileSync(path, mine);

    expect(() => writeDailyNote(openVaultSession(vault.root), db, DATE, deps())).toThrowError(
      /not_managed/,
    );
    expect(readFileSync(path, 'utf8')).toBe(mine);
  });
});

// ---------------------------------------------------------------------------
// Ordering is total, and host-independent
// ---------------------------------------------------------------------------

describe('two items with the same decayed score', () => {
  it('order by item_key descending, not by a locale-dependent title collation', () => {
    // Ties on score are not rare -- the M2 acceptance run had every
    // single-source AP item at exactly 3.13. `localeCompare` would order these
    // two by whatever ICU the host ships, so the same corpus could produce a
    // different note on the deployment target than on this laptop.
    // The two slugs are chosen so the orders genuinely DISAGREE: `alpha`
    // digests to d415…, `omega` to e810…, so item_key descending is
    // [omega, alpha] while any alphabetical title collation is [alpha, omega].
    // A pair whose orders happened to coincide would pass either way, which is
    // how the first version of this test failed to catch the injected defect.
    const db = migratedDb();
    const keys = ['alpha', 'omega'].map((slug) => {
      const item = insertItem(
        db,
        baseItem({
          url: `https://example.test/kev/${slug}`,
          canonicalUrl: `https://example.test/kev/${slug}`,
          title: `${slug} advisory`,
        }),
      );
      scoreItem(db, item.item_key, ONE_HALF_LIFE_BEFORE, scoreDeps());
      return item.item_key;
    });

    const cyber = buildDailyNote(db, DATE, deps()).sections.find((s) => s.beat === 'cyber')!;
    expect(cyber.shown.map((e) => e.signalScore)).toEqual([0.4, 0.4]);
    expect(cyber.shown.map((e) => e.itemKey)).toEqual([...keys].sort().reverse());
  });
});
