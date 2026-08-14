import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, type NewItem, type Item } from '../../src/domain/item.ts';
import { saveItem, dismissItem, markItemRead } from '../../src/domain/itemState.ts';
import { loadInterests, loadInterestsFile, type InterestProfile } from '../../src/interests/load.ts';
import {
  proposeInterestTerms,
  formatProposalReport,
  MIN_CLASS_SIZE,
  MIN_TERM_COUNT,
  MIN_Z_SCORE,
  type ProposalReport,
} from '../../src/interests/propose.ts';

// ---------------------------------------------------------------------------
// Temp-DB plumbing, mirroring every other backend test file's local
// migratedDb() helper (tests/domain/itemState.test.ts, tests/score/rank.test.ts, ...).
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

const NOW = '2026-08-14T00:00:00.000Z';

let seq = 0;
function baseItem(overrides: Partial<NewItem> = {}): NewItem {
  seq += 1;
  return {
    url: `https://example.test/item-${seq}`,
    canonicalUrl: `https://example.test/item-${seq}`,
    title: 'Untitled test item',
    sourceId: 'test-source',
    itemType: 'analysis',
    beats: ['ai'],
    entities: [],
    publishedAt: NOW,
    fetchedAt: NOW,
    summaryRaw: null,
    rawJson: '{}',
    ...overrides,
  };
}

function makeItem(db: Db, title: string, summaryRaw: string | null = null): Item {
  return insertItem(db, baseItem({ title, summaryRaw }));
}

/** A minimal, self-contained profile -- deliberately does NOT reuse the real
 * config/interests.yaml's terms, so tests can freely use words like "eval"
 * or "crypto" without tripping the "already in profile" exclusion whose
 * behavior is tested separately (against the REAL file) below. */
function testProfile(): InterestProfile {
  return loadInterests(`
boosts:
  - term: "unrelated placeholder boost"
    weight: 1.0
suppressions:
  - term: "unrelated placeholder suppress"
    weight: 1.0
`);
}

function makeBackground(db: Db, count: number, titleFn: (i: number) => string): Item[] {
  return Array.from({ length: count }, (_, i) => makeItem(db, titleFn(i)));
}

// ---------------------------------------------------------------------------
// Threshold constants -- guard against the thresholds themselves being
// quietly weakened (complements the behavioral tests below, which exercise
// the effect rather than the literal constant).
// ---------------------------------------------------------------------------
describe('threshold constants', () => {
  it('MIN_TERM_COUNT is at least 3 -- a two-occurrence term must never be enough evidence alone', () => {
    expect(MIN_TERM_COUNT).toBeGreaterThanOrEqual(3);
  });

  it('MIN_CLASS_SIZE is at least 5', () => {
    expect(MIN_CLASS_SIZE).toBeGreaterThanOrEqual(5);
  });

  it('MIN_Z_SCORE is at conventional 95%-two-tailed strength or stricter', () => {
    expect(MIN_Z_SCORE).toBeGreaterThanOrEqual(1.959);
  });
});

// ---------------------------------------------------------------------------
// "Not enough signal yet" -- the common path for weeks, per the task brief.
// ---------------------------------------------------------------------------
describe('insufficient signal', () => {
  it('zero saves and zero dismissals -- the actual current state -- produces no noise, just a clear message', () => {
    const db = migratedDb();
    makeItem(db, 'Some unrelated item in the corpus');

    const report = proposeInterestTerms(db, testProfile(), NOW);

    expect(report.boosts.status).toBe('insufficient-signal');
    expect(report.suppressions.status).toBe('insufficient-signal');
    expect(report.boosts.candidates).toEqual([]);
    expect(report.suppressions.candidates).toEqual([]);
    expect(report.boosts.message).toMatch(/not enough/i);
    expect(report.suppressions.message).toMatch(/not enough/i);
  });

  it('reports insufficient signal for boosts below MIN_CLASS_SIZE saves and says how many exist', () => {
    const db = migratedDb();
    const items = Array.from({ length: MIN_CLASS_SIZE - 1 }, (_, i) => makeItem(db, `Saved item ${i}`));
    for (const it of items) saveItem(db, it.item_key, NOW);

    const report = proposeInterestTerms(db, testProfile(), NOW);

    expect(report.boosts.status).toBe('insufficient-signal');
    expect(report.boosts.classSize).toBe(MIN_CLASS_SIZE - 1);
    expect(report.boosts.minRequired).toBe(MIN_CLASS_SIZE);
    expect(report.boosts.candidates).toEqual([]);
    expect(report.boosts.message).toContain(String(MIN_CLASS_SIZE - 1));
  });

  it('reports insufficient signal for suppressions below MIN_CLASS_SIZE dismissals', () => {
    const db = migratedDb();
    const items = Array.from({ length: 2 }, (_, i) => makeItem(db, `Dismissed item ${i}`));
    for (const it of items) dismissItem(db, it.item_key, NOW);

    const report = proposeInterestTerms(db, testProfile(), NOW);

    expect(report.suppressions.status).toBe('insufficient-signal');
    expect(report.suppressions.classSize).toBe(2);
    expect(report.suppressions.candidates).toEqual([]);
  });

  it('one direction can have enough signal while the other does not', () => {
    const db = migratedDb();
    const saved = Array.from({ length: MIN_CLASS_SIZE }, (_, i) => makeItem(db, `Saved about ollama local inference tools ${i}`));
    for (const it of saved) saveItem(db, it.item_key, NOW);
    // Only one dismissal -- below the gate.
    const dismissed = makeItem(db, 'A dismissed item');
    dismissItem(db, dismissed.item_key, NOW);

    const report = proposeInterestTerms(db, testProfile(), NOW);

    expect(report.boosts.status).toBe('ok');
    expect(report.suppressions.status).toBe('insufficient-signal');
  });
});

// ---------------------------------------------------------------------------
// The disproportionality measure itself.
// ---------------------------------------------------------------------------
describe('disproportionality', () => {
  it('proposes a boost candidate that is genuinely over-represented in saved items, with real evidence', () => {
    const db = migratedDb();
    const saved = [
      makeItem(db, 'Ollama ships local inference speedups'),
      makeItem(db, 'Running Ollama on a mini PC'),
      makeItem(db, 'Ollama adds new model support'),
      makeItem(db, 'A deep dive into Ollama internals'),
      makeItem(db, 'Weekly roundup with nothing special'),
    ];
    for (const it of saved) saveItem(db, it.item_key, NOW);
    makeBackground(db, 50, (i) => `Background story number ${i} about something else entirely`);

    const report = proposeInterestTerms(db, testProfile(), NOW);

    expect(report.boosts.status).toBe('ok');
    const match = report.boosts.candidates.find((c) => c.term === 'ollama');
    expect(match).toBeDefined();
    expect(match!.classCount).toBe(4);
    expect(match!.classTotal).toBe(5);
    expect(match!.otherCount).toBe(0);
    expect(match!.zScore).toBeGreaterThanOrEqual(MIN_Z_SCORE);
    expect(match!.exampleTitles.length).toBeGreaterThan(0);
    expect(match!.exampleTitles.length).toBeLessThanOrEqual(3);
    for (const title of match!.exampleTitles) {
      expect(title.toLowerCase()).toContain('ollama');
    }
  });

  it('never ranks a term highly on two occurrences, even when nothing else in the corpus contains it', () => {
    const db = migratedDb();
    const saved = [
      makeItem(db, 'A gizmoblarp appears here'),
      makeItem(db, 'Another gizmoblarp mention'),
      makeItem(db, 'Totally unrelated title one'),
      makeItem(db, 'Totally unrelated title two'),
      makeItem(db, 'Totally unrelated title three'),
    ];
    for (const it of saved) saveItem(db, it.item_key, NOW);
    makeBackground(db, 50, (i) => `Background story number ${i}`);

    const report = proposeInterestTerms(db, testProfile(), NOW);

    expect(report.boosts.candidates.some((c) => c.term === 'gizmoblarp')).toBe(false);
  });

  it('does not propose a term whose rate in saved is not actually different from the background rate', () => {
    const db = migratedDb();
    // "briefing" appears in 3/5 saved and 30/50 background -- same 60% rate.
    const saved = [
      makeItem(db, 'Morning briefing on markets'),
      makeItem(db, 'Briefing notes for the week'),
      makeItem(db, 'A special briefing document'),
      makeItem(db, 'Nothing to do with that word'),
      makeItem(db, 'Also nothing to do with that word'),
    ];
    for (const it of saved) saveItem(db, it.item_key, NOW);
    makeBackground(db, 50, (i) => (i < 30 ? `Background briefing item ${i}` : `Background other item ${i}`));

    const report = proposeInterestTerms(db, testProfile(), NOW);

    expect(report.boosts.status).toBe('ok');
    expect(report.boosts.candidates.some((c) => c.term === 'briefing')).toBe(false);
  });

  it('proposes a suppress candidate over-represented in dismissed items', () => {
    const db = migratedDb();
    const dismissed = [
      makeItem(db, 'Quarterly earnings throttling report'),
      makeItem(db, 'Throttling issues at the data center'),
      makeItem(db, 'New throttling policy announced'),
      makeItem(db, 'A throttling incident writeup'),
      makeItem(db, 'Unrelated dismissed item'),
    ];
    for (const it of dismissed) dismissItem(db, it.item_key, NOW);
    makeBackground(db, 50, (i) => `Background story number ${i}`);

    const report = proposeInterestTerms(db, testProfile(), NOW);

    expect(report.suppressions.status).toBe('ok');
    const match = report.suppressions.candidates.find((c) => c.term === 'throttling');
    expect(match).toBeDefined();
    expect(match!.classCount).toBe(4);
    expect(match!.otherCount).toBe(0);
  });

  it('filters out the preposition "against" -- verified live in real AP sports match-report headlines', () => {
    const db = migratedDb();
    const dismissed = [
      makeItem(db, 'Texans rookie Marlin Klein shines in NFL debut against Chargers'),
      makeItem(db, 'Brewers rally for 3 runs against Diaz in 9th inning to beat Dodgers 5-4'),
      makeItem(db, 'Steelers rookie Drew Allar impresses with 3 touchdowns in preseason win against Packers'),
      makeItem(db, 'Unrelated dismissed item one'),
      makeItem(db, 'Unrelated dismissed item two'),
    ];
    for (const it of dismissed) dismissItem(db, it.item_key, NOW);
    makeBackground(db, 50, (i) => `Background story number ${i}`);

    const report = proposeInterestTerms(db, testProfile(), NOW);

    expect(report.suppressions.candidates.some((c) => c.term === 'against')).toBe(false);
  });

  it('strips arXiv\'s machine-generated feed preamble so it is never mistaken for a topical signal, while the real abstract body stays fully searchable', () => {
    const db = migratedDb();
    // Real shape, verified against a VACUUM INTO scratch copy of data/wf.db:
    // arXiv's own Atom <summary> begins with this exact preamble on every
    // entry regardless of topic.
    const preamble = (n: number, abstract: string) => `arXiv:2608.${10000 + n}v1 Announce Type: new\nAbstract: ${abstract}`;
    const saved = [
      makeItem(db, 'PIPES: Securing Agent Perception', preamble(1, 'A provenance-aware defense for zephyrblorp attacks on tool-using agents.')),
      makeItem(db, 'Labels Are Not Endpoints', preamble(2, 'We study zephyrblorp resistance in MCP agent evaluation harnesses.')),
      makeItem(db, 'Beyond Handcrafted Security', preamble(3, 'A self-evolving defense against zephyrblorp attacks in LLM agents.')),
      makeItem(db, 'ATOBench', preamble(4, 'Autonomous penetration-testing agents and their limits.')),
      makeItem(db, 'InterSAGE', preamble(5, 'A protocol for an interoperable internet of agents.')),
    ];
    for (const it of saved) saveItem(db, it.item_key, NOW);
    // Background is MOSTLY non-arXiv (mirrors the real corpus, where arXiv
    // sources are a small minority of the whole corpus) -- so before
    // stripping, the preamble's own vocabulary genuinely IS disproportionate
    // between saved (100% arXiv) and background (10% arXiv), which is
    // exactly the false-positive shape the live scratch-copy run surfaced.
    for (let i = 0; i < 5; i++) makeItem(db, `Background arXiv paper ${i}`, preamble(100 + i, `Unrelated abstract content number ${i}.`));
    makeBackground(db, 45, (i) => `Non-arXiv background item ${i}`);

    const report = proposeInterestTerms(db, testProfile(), NOW);

    // The preamble's own vocabulary must never surface as a candidate.
    for (const term of ['arxiv', 'announce', 'type', 'announce type', 'abstract']) {
      expect(report.boosts.candidates.some((c) => c.term === term)).toBe(false);
    }
    // But real, topical content inside the abstract body -- appearing in
    // exactly 3 of the 5 saved items' actual prose, and nowhere in the
    // background -- still surfaces normally.
    expect(report.boosts.candidates.some((c) => c.term === 'zephyrblorp')).toBe(true);
  });

  it('filters out common English stopwords even when they look disproportionate', () => {
    const db = migratedDb();
    const saved = Array.from({ length: MIN_CLASS_SIZE }, (_, i) => makeItem(db, `the report ${i}`));
    for (const it of saved) saveItem(db, it.item_key, NOW);
    makeBackground(db, 50, (i) => `unrelated background item ${i}`);

    const report = proposeInterestTerms(db, testProfile(), NOW);

    expect(report.boosts.candidates.some((c) => c.term === 'the')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Existing profile terms are never re-proposed; matching reuses buildTermRegex.
// ---------------------------------------------------------------------------
describe('existing profile terms and matching correctness', () => {
  it('never re-proposes a term already in the REAL config/interests.yaml boosts list, in either direction', () => {
    const db = migratedDb();
    const realProfile = loadInterestsFile(join(process.cwd(), 'config', 'interests.yaml'));
    // "eval" is already a real boost term at weight 1.3 (config/interests.yaml).
    // "gizmoblarp" is not -- it also occurs 3x, so it is a live control: if
    // it were ALSO missing from the output, that would mean everything is
    // being suppressed rather than "eval" specifically being excluded.
    const saved = [
      makeItem(db, 'A new eval framework ships'),
      makeItem(db, 'How to eval your CI pipeline'),
      makeItem(db, 'Eval gizmoblarp results look promising'),
      makeItem(db, 'A gizmoblarp writeup appears'),
      makeItem(db, 'Another gizmoblarp mention today'),
    ];
    for (const it of saved) saveItem(db, it.item_key, NOW);
    makeBackground(db, 50, (i) => `Background story number ${i}`);

    const report = proposeInterestTerms(db, realProfile, NOW);

    expect(report.boosts.candidates.some((c) => c.term === 'eval')).toBe(false);
    // A genuinely new, non-profile term in the same titles still surfaces --
    // proves the exclusion is specific to "eval", not a blanket failure.
    expect(report.boosts.candidates.some((c) => c.term === 'gizmoblarp')).toBe(true);
  });

  it('never re-proposes a term already in the REAL config/interests.yaml suppressions list', () => {
    const db = migratedDb();
    const realProfile = loadInterestsFile(join(process.cwd(), 'config', 'interests.yaml'));
    // "NFL" is already a real suppress term (config/interests.yaml).
    const dismissed = [
      makeItem(db, 'NFL preseason news roundup'),
      makeItem(db, 'NFL trade rumors swirl'),
      makeItem(db, 'NFL coach speaks to reporters'),
      makeItem(db, 'NFL schedule released'),
      makeItem(db, 'Unrelated dismissed item'),
    ];
    for (const it of dismissed) dismissItem(db, it.item_key, NOW);
    makeBackground(db, 50, (i) => `Background story number ${i}`);

    const report = proposeInterestTerms(db, realProfile, NOW);

    expect(report.suppressions.candidates.some((c) => c.term === 'nfl')).toBe(false);
  });

  it('reuses buildTermRegex Unicode-aware whole-word matching -- does not count "eval" inside the Spanish word "evalúan"', () => {
    const db = migratedDb();
    // Deliberately a fresh, minimal profile (not the real file) so "eval" is
    // available to test as a NEW candidate rather than excluded as existing.
    const saved = [
      makeItem(db, 'Team ships new eval framework'),
      makeItem(db, 'How to eval your CI pipeline'),
      makeItem(db, 'Eval results look promising'),
      makeItem(db, 'Another eval writeup'),
      makeItem(db, 'Unrelated saved item'),
    ];
    for (const it of saved) saveItem(db, it.item_key, NOW);
    // The real M1 corpus example from config/interests.yaml's own header --
    // an ASCII \b regex would wrongly match "eval" inside "evalúan".
    const background = [makeItem(db, 'Bears evalúan 2 sitios para estadio en Indiana y podrían usar ambos')];
    background.push(...makeBackground(db, 49, (i) => `Background story number ${i}`));

    const report = proposeInterestTerms(db, testProfile(), NOW);

    const match = report.boosts.candidates.find((c) => c.term === 'eval');
    expect(match).toBeDefined();
    expect(match!.otherCount).toBe(0);
  });

  it('does not propose known-ambiguous terms documented in config/interests.yaml as tried-and-reverted (e.g. bare "crypto")', () => {
    const db = migratedDb();
    const dismissed = [
      makeItem(db, 'Crypto markets tumble again'),
      makeItem(db, 'A crypto scam warning'),
      makeItem(db, 'Crypto exchange outage'),
      makeItem(db, 'Crypto regulation news'),
      makeItem(db, 'Unrelated dismissed item'),
    ];
    for (const it of dismissed) dismissItem(db, it.item_key, NOW);
    makeBackground(db, 50, (i) => `Background story number ${i}`);

    const report = proposeInterestTerms(db, testProfile(), NOW);

    expect(report.suppressions.candidates.some((c) => c.term === 'crypto')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Honesty requirements: caveats, and the read_at weak-signal reporting.
// ---------------------------------------------------------------------------
describe('caveats and reporting', () => {
  it('always reports the echo-chamber risk and the ignoring-is-invisible blind spot, even with zero signal', () => {
    const db = migratedDb();
    const report = proposeInterestTerms(db, testProfile(), NOW);

    expect(report.caveats.some((c) => /echo/i.test(c))).toBe(true);
    expect(report.caveats.some((c) => /ignor/i.test(c))).toBe(true);
  });

  it('reads read_at but reports it only as weak-signal context, never uses it to drive a candidate', () => {
    const db = migratedDb();
    const item = makeItem(db, 'An item that was only read');
    markItemRead(db, item.item_key, NOW);

    const report = proposeInterestTerms(db, testProfile(), NOW);

    expect(report.readCount).toBe(1);
    expect(report.caveats.some((c) => /weak signal/i.test(c))).toBe(true);
  });

  it('omits the read caveat when nothing has been read', () => {
    const db = migratedDb();
    makeItem(db, 'An untouched item');

    const report = proposeInterestTerms(db, testProfile(), NOW);

    expect(report.readCount).toBe(0);
    expect(report.caveats.some((c) => /weak signal/i.test(c))).toBe(false);
  });

  it('tallies corpus size and per-class counts correctly', () => {
    const db = migratedDb();
    const items = Array.from({ length: 7 }, (_, i) => makeItem(db, `Item ${i}`));
    saveItem(db, items[0]!.item_key, NOW);
    saveItem(db, items[1]!.item_key, NOW);
    dismissItem(db, items[2]!.item_key, NOW);
    markItemRead(db, items[3]!.item_key, NOW);

    const report = proposeInterestTerms(db, testProfile(), NOW);

    expect(report.corpusSize).toBe(7);
    expect(report.savedCount).toBe(2);
    expect(report.dismissedCount).toBe(1);
    expect(report.readCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The mechanical proof: config/interests.yaml is never written to.
// ---------------------------------------------------------------------------
describe('never writes to config/interests.yaml', () => {
  it('is byte-identical after a full run, including heavy save/dismiss/read activity', () => {
    const configPath = join(process.cwd(), 'config', 'interests.yaml');
    const before = readFileSync(configPath);

    const db = migratedDb();
    const realProfile = loadInterestsFile(configPath);
    const items = Array.from({ length: 25 }, (_, i) => makeItem(db, `Ollama local inference item ${i} eval NFL crypto`));
    items.forEach((it, i) => {
      if (i % 3 === 0) saveItem(db, it.item_key, NOW);
      else if (i % 3 === 1) dismissItem(db, it.item_key, NOW);
      else markItemRead(db, it.item_key, NOW);
    });

    const report = proposeInterestTerms(db, realProfile, NOW);
    formatProposalReport(report);
    JSON.stringify(report);

    const after = readFileSync(configPath);
    expect(after.equals(before)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Output formatting -- a copy-pasteable YAML snippet per candidate.
// ---------------------------------------------------------------------------
describe('formatProposalReport', () => {
  it('includes the term, its evidence counts, and a copy-pasteable YAML snippet', () => {
    const db = migratedDb();
    const saved = [
      makeItem(db, 'Ollama ships local inference speedups'),
      makeItem(db, 'Running Ollama on a mini PC'),
      makeItem(db, 'Ollama adds new model support'),
      makeItem(db, 'A deep dive into Ollama internals'),
      makeItem(db, 'Weekly roundup with nothing special'),
    ];
    for (const it of saved) saveItem(db, it.item_key, NOW);
    makeBackground(db, 50, (i) => `Background story number ${i}`);

    const report: ProposalReport = proposeInterestTerms(db, testProfile(), NOW);
    const text = formatProposalReport(report);

    expect(text).toContain('ollama');
    expect(text).toContain('term:');
    expect(text).toContain('weight:');
  });

  it('says plainly when there is not enough signal, in both directions', () => {
    const report = proposeInterestTerms(migratedDb(), testProfile(), NOW);
    const text = formatProposalReport(report);
    expect(text.toLowerCase()).toContain('not enough');
  });
});
