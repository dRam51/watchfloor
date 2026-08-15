import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, type NewItem } from '../../src/domain/item.ts';
import { scoreItem, type MechanicalScoreConfig, type ScoreItemDeps } from '../../src/score/mechanical.ts';
import type { DecayConfig } from '../../src/score/decay.ts';
import type { OverridesConfig } from '../../src/score/overrides.ts';
import type { Source } from '../../src/sources/load.ts';
import { buildDailyNote, dailyNoteInstant, type DailyNoteDeps } from '../../src/vault/daily.ts';

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
