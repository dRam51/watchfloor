import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { getCurrentItem, insertItem, type NewItem } from '../../src/domain/item.ts';
import {
  WATCHFLOOR_BEGIN_MARKER,
  WATCHFLOOR_END_MARKER,
} from '../../src/vault/frontmatter.ts';
import { openVaultSession } from '../../src/vault/session.ts';
import {
  entityFileName,
  entityNoteRelPath,
  EntityNameError,
  planEntityNotes,
  renderEntityBlock,
  syncEntityNotes,
} from '../../src/vault/entities.ts';
import {
  createFixtureVault,
  digestTree,
  listTree,
  HAND_AUTHORED_ENTITY_PATH,
  HAND_AUTHORED_ENTITY_TEXT,
  HAND_AUTHORED_NOTES,
} from './fixture.ts';

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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function blockFor(db: ReturnType<typeof openDb>, entity: string, options = {}) {
  const note = planEntityNotes(db, options).notes.find((n) => n.entity === entity);
  if (!note) throw new Error(`no planned note for ${JSON.stringify(entity)}`);
  return renderEntityBlock(note);
}

describe('renderEntityBlock', () => {
  it('states how many items mention the entity, in the corpus, without a clock', () => {
    const db = migratedDb();
    insertItem(db, arsAnthropic());
    expect(blockFor(db, AI_ONLY_ENTITY)).toContain('1 item in the Watchfloor corpus mentions');

    insertItem(db, arxivAiVersion());
    expect(blockFor(db, AI_ONLY_ENTITY)).toContain('2 items in the Watchfloor corpus mention');
  });

  it('renders an item as a dated link with its beats and its sources', () => {
    const db = migratedDb();
    insertItem(db, arxivCrVersion());
    insertItem(db, arxivAiVersion());

    expect(blockFor(db, SHARED_ENTITY)).toContain(
      `- 2026-08-14 — [${ARXIV_TITLE}](<${ARXIV_URL}>) — ai, aisec — arxiv-cs-ai, arxiv-cs-cr`,
    );
  });

  it('says when a date is a first-seen time rather than a publication date', () => {
    // 1,715 of the archived corpus's 3,325 items have no published_at. A note
    // that prints a fetch time as if it were a publication date is asserting
    // something the corpus does not know.
    const db = migratedDb();
    insertItem(db, kevUndated());

    expect(blockFor(db, 'Microsoft')).toContain('- 2026-08-14 (first seen) — [Microsoft Windows');
  });

  it('escapes the brackets in a real title, so the link survives', () => {
    // `latent-space` really does publish titles shaped `[AINews] ...`. Rendered
    // raw inside `[...](...)` the link text terminates early and the line comes
    // out as broken markdown.
    const db = migratedDb();
    insertItem(
      db,
      arsAnthropic({
        url: 'https://www.latent.space/p/ainews-how-to-steal-a-reasoning-trace',
        canonicalUrl: 'https://latent.space/p/ainews-how-to-steal-a-reasoning-trace',
        title: '[AINews] How to steal a Reasoning Trace',
      }),
    );

    const block = blockFor(db, AI_ONLY_ENTITY);
    expect(block).toContain('[\\[AINews\\] How to steal a Reasoning Trace](<https://www.latent.space/');
  });

  it('neutralises a title that tries to close the managed block', () => {
    // No real title contains a comment marker -- `select count(*) from items
    // where title like '%<!--%' or title like '%-->%'` is 0 against all 7,267.
    // But a feed's title is attacker-controllable text that ends up inside the
    // owner's note, and closing the block early would put generated content
    // BELOW the end marker, where the next run would not replace it. That is
    // the one way this module could permanently corrupt a hand-edited note.
    const db = migratedDb();
    insertItem(db, arsAnthropic({ title: `Ship it ${WATCHFLOOR_END_MARKER} and then some` }));

    const block = blockFor(db, AI_ONLY_ENTITY);
    expect(block).not.toContain(WATCHFLOOR_END_MARKER);
    expect(block).not.toContain(WATCHFLOOR_BEGIN_MARKER);
    // Not dropped, either: the item is still listed, with the marker defused.
    expect(block).toContain('Ship it &lt;!-- watchfloor:end --&gt; and then some');
  });

  it('says how many items it did not list rather than silently truncating', () => {
    const db = migratedDb();
    for (let i = 0; i < 4; i++) {
      insertItem(
        db,
        arsAnthropic({
          url: `https://example.test/${i}`,
          canonicalUrl: `https://example.test/${i}`,
          publishedAt: `2026-08-0${i + 1}T00:00:00.000Z`,
        }),
      );
    }

    expect(blockFor(db, AI_ONLY_ENTITY, { maxItems: 2 })).toContain('2 further items not listed');
  });

  it('links related entities as wikilinks, so Obsidian draws the graph', () => {
    const db = migratedDb();
    insertItem(db, arxivCrVersion());
    insertItem(db, arxivAiVersion());

    const block = blockFor(db, AI_ONLY_ENTITY);
    expect(block).toContain(`- [[${CR_ONLY_ENTITY}]] — 1 shared item`);
    expect(block).toContain(`- [[${SHARED_ENTITY}]] — 1 shared item`);
  });

  it('omits the related section entirely when nothing is related', () => {
    const db = migratedDb();
    insertItem(db, arsAnthropic());

    expect(blockFor(db, AI_ONLY_ENTITY)).not.toContain('Related entities');
  });
});

// ---------------------------------------------------------------------------
// Syncing — the tier §8.1 says "getting this wrong is the failure that makes
// me stop trusting the integration"
// ---------------------------------------------------------------------------

function syncedVault(db: ReturnType<typeof openDb>, options = {}) {
  const { anchor, root } = createFixtureVault();
  const session = openVaultSession(root, options);
  const result = syncEntityNotes(session, db, options);
  return { anchor, root, result };
}

function readNote(root: string, relPath: string): string {
  return readFileSync(join(root, relPath), 'utf8');
}

describe('syncEntityNotes — writes only where §8.1 allows', () => {
  it('writes one note per entity, inside entities/', () => {
    const db = migratedDb();
    insertItem(db, arsAnthropic());
    insertItem(db, kevUndated());

    const { root, result } = syncedVault(db);
    expect(result.written.map((w) => w.relPath).sort()).toEqual([
      'entities/Anthropic.md',
      'entities/Microsoft.md',
    ]);
    expect(readNote(root, 'entities/Microsoft.md')).toContain('watchfloor: managed');
  });

  it('leaves the owner\'s twelve hand-authored notes byte-identical, hostile entity included', () => {
    // `../../Architecture` is the case the whole name layer exists for: if it
    // were sanitised to `Architecture`, this assertion is what would fail.
    const db = migratedDb();
    insertItem(db, arsAnthropic({ entities: [AI_ONLY_ENTITY, '../../Architecture'] }));

    const { anchor, root } = createFixtureVault();
    const before = digestTree(anchor);
    const session = openVaultSession(root);
    syncEntityNotes(session, db);
    const after = digestTree(anchor);

    for (const [name] of HAND_AUTHORED_NOTES) {
      const key = join('Watchfloor', name);
      expect(after.get(key), `${name} must still exist`).toBeDefined();
      expect(after.get(key), `${name} must be byte-identical`).toBe(before.get(key));
    }
    // Nothing new appeared anywhere in the vault -- the fixture already has a
    // hand-authored entities/Anthropic.md, so this run appends to that one file
    // and creates none.
    expect([...after.keys()].filter((p) => !before.has(p))).toEqual([]);
    const changed = [...after].filter(([p, d]) => before.get(p) !== d).map(([p]) => p);
    expect(changed).toEqual([join('Watchfloor', 'entities', 'Anthropic.md')]);
  });

  it('reports a refused name instead of writing something plausible', () => {
    const db = migratedDb();
    insertItem(db, arsAnthropic({ entities: ['../../Architecture'] }));

    const { result } = syncedVault(db);
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ entity: '../../Architecture', reason: 'separator' }),
    ]);
  });
});

describe('syncEntityNotes — the hand-edited note survives, which is the whole tier', () => {
  it('appends to a marker-less hand-authored note, keeping its prose as a strict prefix', () => {
    const db = migratedDb();
    insertItem(db, arsAnthropic());

    const { root } = syncedVault(db);
    const after = readNote(root, HAND_AUTHORED_ENTITY_PATH);
    expect(after.startsWith(HAND_AUTHORED_ENTITY_TEXT)).toBe(true);
    expect(after).toContain(WATCHFLOOR_BEGIN_MARKER);
  });

  it('preserves prose the owner writes ABOVE and BELOW the block, byte for byte', () => {
    const db = migratedDb();
    insertItem(db, arsAnthropic());

    const { root } = syncedVault(db);
    const path = join(root, HAND_AUTHORED_ENTITY_PATH);

    // The owner edits: a paragraph above the block and a section below it.
    const prologue = `${HAND_AUTHORED_ENTITY_TEXT}\nWhat I actually think: the RSP is the interesting artifact.\n\n`;
    const epilogue = '\n\n## My open questions\n\n- Does the block ordering match the dashboard?\n';
    const withBlock = readFileSync(path, 'utf8');
    const blockStart = withBlock.indexOf(WATCHFLOOR_BEGIN_MARKER);
    const blockEnd = withBlock.indexOf(WATCHFLOOR_END_MARKER) + WATCHFLOOR_END_MARKER.length;
    writeFileSync(path, `${prologue}${withBlock.slice(blockStart, blockEnd)}${epilogue}`);

    // The corpus moves on, so the block genuinely has to change.
    insertItem(
      db,
      arsAnthropic({
        url: 'https://example.test/new',
        canonicalUrl: 'https://example.test/new',
        title: 'A second Anthropic story',
      }),
    );
    const session = openVaultSession(root);
    syncEntityNotes(session, db);

    const after = readFileSync(path, 'utf8');
    expect(after.startsWith(prologue)).toBe(true);
    expect(after.endsWith(epilogue)).toBe(true);
    expect(after).toContain('A second Anthropic story');
  });

  it('refuses a note whose block is malformed, and leaves it exactly as it was', () => {
    const db = migratedDb();
    insertItem(db, arsAnthropic());

    const { root } = createFixtureVault();
    const path = join(root, HAND_AUTHORED_ENTITY_PATH);
    const malformed = `${HAND_AUTHORED_ENTITY_TEXT}\n${WATCHFLOOR_BEGIN_MARKER}\nmine\n${WATCHFLOOR_BEGIN_MARKER}\n${WATCHFLOOR_END_MARKER}\n`;
    writeFileSync(path, malformed);

    const session = openVaultSession(root);
    const result = syncEntityNotes(session, db);

    expect(readFileSync(path, 'utf8')).toBe(malformed);
    expect(result.skipped).toEqual([
      expect.objectContaining({ entity: AI_ONLY_ENTITY, reason: 'malformed_block' }),
    ]);
  });

  it('skips one oversized note and still writes the others', () => {
    // Task 4's per-file cap deliberately does not latch: "refusing the run's
    // other forty notes because of one turns a bad note into an outage." A
    // 300 KiB hand-written note is what makes that reachable.
    const db = migratedDb();
    insertItem(db, arsAnthropic());
    insertItem(db, kevUndated());

    const { root } = createFixtureVault();
    writeFileSync(join(root, HAND_AUTHORED_ENTITY_PATH), 'x'.repeat(300 * 1024));

    const session = openVaultSession(root);
    const result = syncEntityNotes(session, db);

    expect(result.written.map((w) => w.relPath)).toEqual(['entities/Microsoft.md']);
    expect(result.skipped).toEqual([
      expect.objectContaining({ entity: AI_ONLY_ENTITY, reason: 'too_large' }),
    ]);
  });
});

describe('syncEntityNotes — idempotence, which is what M5 acceptance measures', () => {
  it('produces byte-identical files when run twice over the same corpus', () => {
    const db = migratedDb();
    insertItem(db, arxivCrVersion());
    insertItem(db, arxivAiVersion());
    insertItem(db, arsAnthropic());
    insertItem(db, kevUndated());

    const { root } = syncedVault(db);
    const first = digestTree(join(root, 'entities'));

    const session = openVaultSession(root);
    syncEntityNotes(session, db);

    expect(digestTree(join(root, 'entities'))).toEqual(first);
  });

  it('rebuilds an identical entities/ tree in a vault that never had one', () => {
    // The M5 acceptance test deletes the whole `watchfloor/` tree and re-runs
    // sync. Nothing here deletes anything (CLAUDE.md), so the equivalent is
    // built the other way round: two vaults, one corpus, one generatedAt.
    const db = migratedDb();
    insertItem(db, arxivCrVersion());
    insertItem(db, arxivAiVersion());
    insertItem(db, kevUndated());

    const a = syncedVault(db);
    const b = syncedVault(db);

    expect(digestTree(join(b.root, 'entities'))).toEqual(digestTree(join(a.root, 'entities')));
  });

  it('every wikilink it writes resolves to a note it wrote', () => {
    const db = migratedDb();
    insertItem(db, arxivCrVersion());
    insertItem(db, arxivAiVersion());
    insertItem(db, arsAnthropic());

    const { root } = syncedVault(db);
    const present = new Set(listTree(join(root, 'entities')));
    const links: string[] = [];
    for (const file of present) {
      const text = readFileSync(join(root, 'entities', file), 'utf8');
      for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) links.push(`${match[1]}.md`);
    }

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(present.has(link), `${link} must exist`).toBe(true);
  });
});

describe('syncEntityNotes — the files-per-run cap', () => {
  it('stops at the cap and says so, rather than continuing past it', () => {
    const db = migratedDb();
    insertItem(db, arsAnthropic({ entities: ['Anthropic', 'Microsoft', 'OpenAI'] }));

    const { result } = syncedVault(db, { maxFilesPerRun: 2 });
    expect(result.written).toHaveLength(2);
    expect(result.stopped).toBe('files_per_run');
  });
});

// ---------------------------------------------------------------------------
// The as-of instant — CONTROLLER RULING, 2026-08-15
// ---------------------------------------------------------------------------

/** The canonical shape `assertCanonicalTimestamp` enforces, matched anywhere. */
const CANONICAL_TIMESTAMP_ANYWHERE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

describe('the note as-of instant is derived from the corpus, not from a clock', () => {
  it('is the newest fetched_at across every version of every item carrying the entity', () => {
    const db = migratedDb();
    insertItem(db, arsAnthropic());
    insertItem(db, arxivAiVersion());

    // arsAnthropic was fetched at 23:40 on the 14th, the arXiv pair at 18:38.
    expect(noteFor(db, AI_ONLY_ENTITY).asOf).toBe('2026-08-14T23:40:53.122Z');
  });

  it('advances when a re-poll appends a version, so it tracks the corpus and nothing else', () => {
    const db = migratedDb();
    insertItem(db, kevUndated());
    expect(noteFor(db, 'Microsoft').asOf).toBe(KEV_FIRST_FETCHED_AT);

    insertItem(db, kevUndated({ fetchedAt: KEV_REPOLL_FETCHED_AT }));
    expect(noteFor(db, 'Microsoft').asOf).toBe(KEV_REPOLL_FETCHED_AT);
  });

  it('is a canonical timestamp, and the same one for the same corpus read twice', () => {
    const db = migratedDb();
    insertItem(db, arsAnthropic());

    const asOf = noteFor(db, AI_ONLY_ENTITY).asOf;
    // Asserted against the shape as well as against itself: `undefined ===
    // undefined` would satisfy the second half on its own.
    expect(asOf).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(noteFor(db, AI_ONLY_ENTITY).asOf).toBe(asOf);
  });

  it('every canonical timestamp inside the block equals the block own as-of instant', () => {
    // The controller's test, mirrored from task 5. It catches a stray
    // `new Date()` anywhere in the render path, including one added later by
    // somebody else. This block renders date slices rather than instants, so
    // the match set is empty today -- which is exactly the shape of assertion
    // M4a's post-mortem warns about, hence the non-vacuity check below.
    const db = migratedDb();
    insertItem(db, arxivCrVersion());
    insertItem(db, arxivAiVersion());
    insertItem(db, kevUndated());

    const note = noteFor(db, AI_ONLY_ENTITY);
    for (const found of renderEntityBlock(note).match(CANONICAL_TIMESTAMP_ANYWHERE) ?? []) {
      expect(found).toBe(note.asOf);
    }

    // The matcher itself works: it finds the instant this corpus really holds.
    expect(`generated ${note.asOf} ok`.match(CANONICAL_TIMESTAMP_ANYWHERE)).toEqual([note.asOf]);
  });

  it('stamps the created note with the corpus instant, not with the hour the sync ran', () => {
    const db = migratedDb();
    insertItem(db, kevUndated());

    const { root } = syncedVault(db);
    expect(readNote(root, 'entities/Microsoft.md')).toContain(
      `watchfloor_generated_at: ${KEV_FIRST_FETCHED_AT}`,
    );
  });
});
