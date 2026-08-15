import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { getCurrentItem, insertItem, type NewItem } from '../../src/domain/item.ts';
import {
  entityFileName,
  entityNoteRelPath,
  EntityNameError,
  planEntityNotes,
} from '../../src/vault/entities.ts';

/**
 * An entity name becomes a FILENAME. That is the whole hazard of this task.
 *
 * `src/vault/paths.ts` refuses `..`, dot-prefixed segments, backslashes and
 * anything outside the four areas — but every one of those refusals happens
 * *after* somebody has built a path string. If the entity `../../Architecture`
 * were turned into `entities/../../Architecture.md`, the path layer catches it;
 * if it were *sanitised* into `entities/Architecture.md`, the path layer sees a
 * perfectly ordinary request and the sync writes a managed block into a note
 * whose name matches one of the owner's twelve hand-authored files.
 *
 * So this module refuses rather than sanitises, and these tests are written
 * against the refusal.
 */

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof EntityNameError) return err.reason;
    return `threw ${(err as Error).name}: ${(err as Error).message}`;
  }
  return 'did not throw';
}

const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const DEL = String.fromCharCode(127);

describe('entityFileName — names that are safe', () => {
  it.each([
    ['Anthropic', 'Anthropic.md'],
    ['OpenAI', 'OpenAI.md'],
    ['CVE-2014-4148', 'CVE-2014-4148.md'],
    ['Model Context Protocol', 'Model Context Protocol.md'],
    ['GPT-4.1', 'GPT-4.1.md'],
    ['S&P 500', 'S&P 500.md'],
    ["Moody's", "Moody's.md"],
  ])('accepts %o', (entity, expected) => {
    expect(entityFileName(entity)).toBe(expected);
  });

  it('emits the composed (NFC) spelling, so one entity is one filename', () => {
    // macOS compares filenames normalisation-insensitively and Linux does not.
    // Emitting a single normal form means the two hosts agree about which file
    // an entity maps to. Same reasoning as `isContainedIn`'s NFC comparison in
    // src/vault/paths.ts, applied to the name we CREATE rather than compare.
    const decomposed = `Cafe${String.fromCharCode(0x301)}`;
    const composed = 'Café';
    expect(decomposed.normalize('NFC')).toBe(composed);
    expect(entityFileName(decomposed)).toBe(`${composed}.md`);
    expect(entityFileName(composed)).toBe(`${composed}.md`);
  });

  it('puts every note in the entities area and nowhere else', () => {
    expect(entityNoteRelPath('Anthropic')).toBe('entities/Anthropic.md');
  });
});

describe('entityFileName — the hostile names', () => {
  it.each([
    // The task brief's own example. Refused, never resolved to `Architecture`.
    ['../../Architecture', 'separator'],
    ['..', 'dot_leading'],
    ['.', 'dot_leading'],
    ['daily/2026-08-15', 'separator'],
    ['a/b', 'separator'],
    ['..\\..\\Architecture', 'separator'],
    ['.obsidian', 'dot_leading'],
    ['.hidden', 'dot_leading'],
    ['', 'empty'],
    ['   ', 'empty'],
    [' Anthropic', 'whitespace_edge'],
    ['Anthropic ', 'whitespace_edge'],
    // macOS's Finder swaps `:` and `/`; Windows forbids the whole set below.
    ['01 Tech Projects: Watchfloor', 'reserved_char'],
    ['AC/DC', 'separator'],
    ['C*A', 'reserved_char'],
    ['Who?', 'reserved_char'],
    ['<script>', 'reserved_char'],
    ['say "hi"', 'reserved_char'],
    // Obsidian's own wikilink syntax. A related-entity link is rendered as
    // [[Name]], and every one of these breaks that link or aliases it.
    ['NVDA|AAPL', 'reserved_char'],
    ['#StopRansomware', 'reserved_char'],
    ['Block^ref', 'reserved_char'],
    ['[AINews]', 'reserved_char'],
    // Windows device names. Obsidian runs on Windows and this vault syncs.
    ['NUL', 'device_name'],
    ['con', 'device_name'],
    ['COM1', 'device_name'],
    ['LPT9', 'device_name'],
  ])('refuses %o with reason %s', (entity, reason) => {
    expect(reasonOf(() => entityFileName(entity))).toBe(reason);
  });

  it.each([
    ['NUL byte', NUL],
    ['tab', TAB],
    ['carriage return', CR],
    ['DEL', DEL],
  ])('refuses a name containing a %s', (_label, char) => {
    expect(reasonOf(() => entityFileName(`Anthro${char}pic`))).toBe('control_char');
  });

  it('refuses a trailing newline as edge whitespace, before it reaches the filesystem', () => {
    expect(reasonOf(() => entityFileName(`Anthropic${LF}`))).toBe('whitespace_edge');
  });

  it('refuses a name too long for the ATOMIC WRITE, not merely for the filesystem', () => {
    // Measured on this machine, in a real temp directory: a 243-byte name
    // writes fine, but `src/vault/session.ts` writes through a temp file named
    // `.watchfloor-tmp-<name>.<pid>.<n>` — 24+ bytes more — and that fails with
    // ENAMETOOLONG at 267. A cap of 255 would therefore refuse nothing and
    // still crash mid-sync. Everything must fit with the prefix on.
    expect(reasonOf(() => entityFileName('a'.repeat(198)))).toBe('too_long');
    expect(entityFileName('a'.repeat(190))).toBe(`${'a'.repeat(190)}.md`);
  });

  it('measures length in BYTES, not code units', () => {
    // NAME_MAX is 255 bytes. 190 CJK characters are 570 bytes and would pass a
    // `.length` check while failing at `open`.
    expect(reasonOf(() => entityFileName('漢'.repeat(190)))).toBe('too_long');
  });
});

// ---------------------------------------------------------------------------
// REAL items, SYNTHETIC entity attributions -- and the distinction is the whole
// point of this comment.
//
// The items below are copied verbatim from the live corpus (`data/wf.db`, via
// `VACUUM INTO` a scratch copy -- never opened by this test) and from the
// archived first ingest (`attic/wf-m1-firstrun-2026-08-14.db`, opened
// -readonly). ARXIV_* is the ONE genuinely cross-listed item_key in the live
// corpus:
//
//   select item_key, group_concat(distinct source_id), count(distinct source_id)
//   from items group by item_key having count(distinct source_id) > 1
//
// returns exactly one row -- arxiv-cs-cr + arxiv-cs-ai, one canonical_url, one
// shared fetched_at, cs-cr at rowid 2572 and cs-ai at 2691. That ordering is
// load-bearing: `getCurrentItem`'s `order by fetched_at desc, rowid desc` picks
// cs-ai, so anything attributed only to the cs-cr version is exactly what a
// single-version read drops.
//
// The ENTITY values are invented, because `select count(*) from item_entities`
// against the live corpus returns **0** -- 7,267 items, 5,937 keys, no entity
// extractor in the tree (src/normalize/item.ts writes `entities: []`). There is
// no real entity data to mine and none can be manufactured honestly. What is
// pinned here is the structural read path; when an extractor lands, these
// fixtures should be replaced with mined values. Same convention, same caveat,
// as tests/domain/itemEntities.test.ts.
// ---------------------------------------------------------------------------

const REAL_MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');
const openDbs: Array<ReturnType<typeof openDb>> = [];

function migratedDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-vault-entities-')), 'wf.db'));
  openDbs.push(db);
  runMigrations(db, REAL_MIGRATIONS_DIR);
  return db;
}

afterEach(() => {
  while (openDbs.length) closeDb(openDbs.pop()!);
});

const ARXIV_URL = 'https://arxiv.org/abs/2608.11392';
const ARXIV_TITLE = 'AI Guardrail Survival under Single-Cycle Agentic Self-Summarization';
const ARXIV_PUBLISHED_AT = '2026-08-14T04:00:00.000Z';
const ARXIV_FETCHED_AT = '2026-08-14T18:38:50.262Z';

/** Attributed ONLY to the cs.CR version -- the one the tie-break discards. */
const CR_ONLY_ENTITY = 'Model Context Protocol';
/** Attributed ONLY to the cs.AI version -- the tie-break winner. */
const AI_ONLY_ENTITY = 'Anthropic';
/** Attributed to both, so the union must deduplicate rather than concatenate. */
const SHARED_ENTITY = 'OpenAI';

function arxivCrVersion(): NewItem {
  return {
    url: ARXIV_URL,
    canonicalUrl: ARXIV_URL,
    title: ARXIV_TITLE,
    sourceId: 'arxiv-cs-cr',
    itemType: 'analysis',
    beats: ['aisec'],
    entities: [CR_ONLY_ENTITY, SHARED_ENTITY],
    publishedAt: ARXIV_PUBLISHED_AT,
    fetchedAt: ARXIV_FETCHED_AT,
    summaryRaw: null,
    rawJson: '{}',
  };
}

function arxivAiVersion(): NewItem {
  return {
    ...arxivCrVersion(),
    sourceId: 'arxiv-cs-ai',
    beats: ['ai'],
    entities: [AI_ONLY_ENTITY, SHARED_ENTITY],
  };
}

/** Real row, ars-technica-ai, single version, genuinely about Anthropic. */
function arsAnthropic(overrides: Partial<NewItem> = {}): NewItem {
  return {
    url: 'https://arstechnica.com/ai/2026/08/anthropic-confirms-plans-to-build-an-in-house-silicon-team/',
    canonicalUrl:
      'https://arstechnica.com/ai/2026/08/anthropic-confirms-plans-to-build-an-in-house-silicon-team',
    title: 'Anthropic will design its own hardware to power Claude',
    sourceId: 'ars-technica-ai',
    itemType: 'analysis',
    beats: ['ai'],
    entities: [AI_ONLY_ENTITY],
    publishedAt: '2026-08-06T20:03:44.000Z',
    fetchedAt: '2026-08-14T23:40:53.122Z',
    summaryRaw: null,
    rawJson: '{}',
    ...overrides,
  };
}

/**
 * Real row from the ARCHIVED first ingest: `published_at` is null, which 1,715
 * of that corpus's 3,325 items are. The live corpus has none today, so this is
 * the only honest source for the undated case.
 */
const KEV_FIRST_FETCHED_AT = '2026-08-14T03:47:10.404Z';
const KEV_REPOLL_FETCHED_AT = '2026-08-15T03:47:10.404Z';

function kevUndated(overrides: Partial<NewItem> = {}): NewItem {
  return {
    url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2026-68820',
    canonicalUrl:
      'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2026-68820',
    title: 'Microsoft Windows Ancillary Function Driver for WinSock Use-After-Free Vulnerability',
    sourceId: 'cisa-kev',
    itemType: 'event',
    beats: ['cyber'],
    entities: ['Microsoft'],
    publishedAt: null,
    fetchedAt: KEV_FIRST_FETCHED_AT,
    summaryRaw: null,
    rawJson: '{}',
    ...overrides,
  };
}

function noteFor(db: ReturnType<typeof openDb>, entity: string) {
  const note = planEntityNotes(db).notes.find((n) => n.entity === entity);
  if (!note) throw new Error(`no planned note for ${JSON.stringify(entity)}`);
  return note;
}

describe('planEntityNotes — the read path is getItemEntities, not the current version', () => {
  it('includes an item whose entity only the DISCARDED version attributed', () => {
    const db = migratedDb();
    const cr = insertItem(db, arxivCrVersion());
    insertItem(db, arxivAiVersion());

    // The negative control first: the single-version read really does drop it,
    // so this test is not passing for free.
    expect(getCurrentItem(db, cr.item_key)?.entities).not.toContain(CR_ONLY_ENTITY);

    expect(noteFor(db, CR_ONLY_ENTITY).items.map((i) => i.itemKey)).toEqual([cr.item_key]);
  });

  it('unions the beats of every version, so a cross-listed paper shows both', () => {
    const db = migratedDb();
    insertItem(db, arxivCrVersion());
    insertItem(db, arxivAiVersion());

    expect(noteFor(db, SHARED_ENTITY).items[0]?.beats).toEqual(['ai', 'aisec']);
  });

  it('unions the sources of every version, so a cross-listing is visible as one', () => {
    const db = migratedDb();
    insertItem(db, arxivCrVersion());
    insertItem(db, arxivAiVersion());

    expect(noteFor(db, SHARED_ENTITY).items[0]?.sourceIds).toEqual(['arxiv-cs-ai', 'arxiv-cs-cr']);
  });

  it('lists an item once, not once per version that attributed the entity', () => {
    const db = migratedDb();
    insertItem(db, arxivCrVersion());
    insertItem(db, arxivAiVersion());

    const note = noteFor(db, SHARED_ENTITY);
    expect(note.items).toHaveLength(1);
    expect(note.totalItems).toBe(1);
  });
});

describe('planEntityNotes — an undated item is dated by FIRST-seen, never by the newest version', () => {
  it('uses the first fetched_at and says the date is not a publication date', () => {
    const db = migratedDb();
    insertItem(db, kevUndated());

    const item = noteFor(db, 'Microsoft').items[0];
    expect(item?.at).toBe(KEV_FIRST_FETCHED_AT);
    expect(item?.dated).toBe(false);
  });

  it('does not move when the source re-delivers the identical entry', () => {
    // cisa-kev re-dumps its entire 1,665-entry catalog whenever anything in it
    // changes, so a re-poll appends a new version with a fresh fetched_at and
    // nothing else new. Reading the current version's fetched_at would reset
    // this item's apparent age on every poll -- the defect
    // src/domain/itemFirstFetchedAt.ts exists to fix -- and would also make the
    // note churn, breaking idempotency for a corpus that did not change.
    const db = migratedDb();
    insertItem(db, kevUndated());
    const before = noteFor(db, 'Microsoft').items[0]?.at;

    insertItem(db, kevUndated({ fetchedAt: KEV_REPOLL_FETCHED_AT }));

    expect(noteFor(db, 'Microsoft').items[0]?.at).toBe(before);
    expect(noteFor(db, 'Microsoft').items[0]?.at).toBe(KEV_FIRST_FETCHED_AT);
  });

  it('uses published_at, and says so, when the item has one', () => {
    const db = migratedDb();
    insertItem(db, arsAnthropic());

    const item = noteFor(db, AI_ONLY_ENTITY).items[0];
    expect(item?.at).toBe('2026-08-06T20:03:44.000Z');
    expect(item?.dated).toBe(true);
  });
});

describe('planEntityNotes — ordering, counts and caps', () => {
  it('orders newest first', () => {
    const db = migratedDb();
    insertItem(db, arsAnthropic());
    insertItem(db, arxivAiVersion());

    expect(noteFor(db, AI_ONLY_ENTITY).items.map((i) => i.at)).toEqual([
      ARXIV_PUBLISHED_AT,
      '2026-08-06T20:03:44.000Z',
    ]);
  });

  it('breaks a tie on item_key, so the order cannot depend on insertion luck', () => {
    const db = migratedDb();
    const sameInstant = '2026-08-10T00:00:00.000Z';
    const a = insertItem(
      db,
      arsAnthropic({ url: 'https://example.test/b', canonicalUrl: 'https://example.test/b', publishedAt: sameInstant }),
    );
    const b = insertItem(
      db,
      arsAnthropic({ url: 'https://example.test/a', canonicalUrl: 'https://example.test/a', publishedAt: sameInstant }),
    );

    const expected = [a.item_key, b.item_key].sort();
    expect(noteFor(db, AI_ONLY_ENTITY).items.map((i) => i.itemKey)).toEqual(expected);
  });

  it('caps the listed items while still counting them all', () => {
    const db = migratedDb();
    for (let i = 0; i < 5; i++) {
      insertItem(
        db,
        arsAnthropic({
          url: `https://example.test/${i}`,
          canonicalUrl: `https://example.test/${i}`,
          publishedAt: `2026-08-0${i + 1}T00:00:00.000Z`,
        }),
      );
    }

    const note = planEntityNotes(db, { maxItems: 2 }).notes.find((n) => n.entity === AI_ONLY_ENTITY);
    expect(note?.items).toHaveLength(2);
    expect(note?.totalItems).toBe(5);
  });
});

describe('planEntityNotes — related entities', () => {
  it('counts entities sharing an item and excludes the entity itself', () => {
    const db = migratedDb();
    insertItem(db, arxivCrVersion());
    insertItem(db, arxivAiVersion());
    insertItem(db, arsAnthropic());

    // Anthropic appears on both items; OpenAI and Model Context Protocol are
    // on the arXiv paper only -- and the two arXiv entities are only visible
    // to each other because getItemEntities unions the two versions.
    expect(noteFor(db, AI_ONLY_ENTITY).related).toEqual([
      { entity: CR_ONLY_ENTITY, sharedItems: 1 },
      { entity: SHARED_ENTITY, sharedItems: 1 },
    ]);
    expect(noteFor(db, AI_ONLY_ENTITY).related.map((r) => r.entity)).not.toContain(AI_ONLY_ENTITY);
  });

  it('orders by shared items, then by name', () => {
    const db = migratedDb();
    insertItem(db, arxivCrVersion());
    insertItem(db, arxivAiVersion());
    insertItem(db, arsAnthropic({ entities: [AI_ONLY_ENTITY, SHARED_ENTITY] }));

    expect(noteFor(db, AI_ONLY_ENTITY).related).toEqual([
      { entity: SHARED_ENTITY, sharedItems: 2 },
      { entity: CR_ONLY_ENTITY, sharedItems: 1 },
    ]);
  });

  it('never links to an entity that gets no note', () => {
    // A related list is rendered as [[wikilinks]]. Linking to a name this
    // module refuses to write would produce a dangling link in the owner's
    // graph for a note that can never exist.
    const db = migratedDb();
    insertItem(db, arsAnthropic({ entities: [AI_ONLY_ENTITY, '../../Architecture'] }));

    expect(noteFor(db, AI_ONLY_ENTITY).related).toEqual([]);
  });
});

describe('planEntityNotes — names it refuses to write, reported rather than dropped', () => {
  it('skips an unsafe name and says why', () => {
    const db = migratedDb();
    insertItem(db, arsAnthropic({ entities: ['../../Architecture'] }));

    const plan = planEntityNotes(db);
    expect(plan.notes).toEqual([]);
    expect(plan.skipped).toEqual([
      expect.objectContaining({ entity: '../../Architecture', reason: 'separator' }),
    ]);
  });

  it('skips BOTH spellings when two entities differ only by case', () => {
    // macOS is case-insensitive: `OpenAI` and `openai` are one file there and
    // two on Linux. Writing either would mean the two entities take turns
    // overwriting each other's block on every run -- on one host only.
    const db = migratedDb();
    insertItem(db, arsAnthropic({ entities: ['OpenAI'] }));
    insertItem(
      db,
      arsAnthropic({
        url: 'https://example.test/lower',
        canonicalUrl: 'https://example.test/lower',
        entities: ['openai'],
      }),
    );

    const plan = planEntityNotes(db);
    expect(plan.notes.map((n) => n.entity)).toEqual([]);
    expect(plan.skipped.map((s) => [s.entity, s.reason]).sort()).toEqual([
      ['OpenAI', 'case_collision'],
      ['openai', 'case_collision'],
    ]);
  });

  it('merges the NFD and NFC spellings of one name into one note', () => {
    // Two byte sequences, one Unicode string. Unlike a case difference this is
    // not ambiguous -- they ARE the same entity -- so merging is correct and
    // refusing would be wrong.
    const db = migratedDb();
    const decomposed = `Cafe${String.fromCharCode(0x301)}`;
    const composed = 'Café';
    expect(decomposed).not.toBe(composed);

    insertItem(db, arsAnthropic({ entities: [decomposed] }));
    insertItem(
      db,
      arsAnthropic({
        url: 'https://example.test/two',
        canonicalUrl: 'https://example.test/two',
        entities: [composed],
      }),
    );

    const plan = planEntityNotes(db);
    expect(plan.notes.map((n) => n.entity)).toEqual([composed]);
    expect(plan.notes[0]?.totalItems).toBe(2);
    expect(plan.notes[0]?.relPath).toBe(`entities/${composed}.md`);
  });
});

describe('planEntityNotes — the state the live corpus is actually in', () => {
  it('plans nothing at all when no item carries an entity', () => {
    // This is not an edge case, it is production: `select count(*) from
    // item_entities` against data/wf.db returns 0 across 7,267 items, because
    // no entity extractor exists. `entities/` will be EMPTY at M5 acceptance
    // until one does, and the acceptance criterion "the tree reproduces
    // identically" would pass vacuously. Recorded here so the emptiness is a
    // tested fact rather than a surprise.
    const db = migratedDb();
    insertItem(db, arsAnthropic({ entities: [] }));
    insertItem(db, kevUndated({ entities: [] }));

    expect(planEntityNotes(db)).toEqual({ notes: [], skipped: [] });
  });
});
