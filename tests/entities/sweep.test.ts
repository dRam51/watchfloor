import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, deriveItemKey, type NewItem } from '../../src/domain/item.ts';
import { getItemEntities } from '../../src/domain/itemEntities.ts';
import { loadEntityRules, loadEntityRulesFile, rulesetVersion } from '../../src/entities/rules.ts';
import { extractEntities } from '../../src/entities/extract.ts';
import { sweepEntities, entityExtractionCoverage, DEFAULT_SWEEP_LIMIT } from '../../src/entities/sweep.ts';

const SHIPPED = loadEntityRulesFile(join(process.cwd(), 'config', 'entities.yaml'));
const NOW = '2026-08-16T00:00:00.000Z';

const open: Db[] = [];
function migratedDb(): Db {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-ent-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}
afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

// ---------------------------------------------------------------------------
// Real rows, copied verbatim from data/wf.db. Entities are never invented here
// -- they are whatever the shipped ruleset actually produces from real text.
// ---------------------------------------------------------------------------

function item(over: Partial<NewItem> & { url: string; title: string }): NewItem {
  return {
    canonicalUrl: over.canonicalUrl ?? over.url,
    author: null,
    sourceId: 'cisa-kev',
    itemType: 'event',
    beats: ['cyber'],
    entities: [],
    publishedAt: null,
    fetchedAt: '2026-08-15T00:00:00.000Z',
    summaryRaw: null,
    rawJson: '{}',
    ...over,
  } as NewItem;
}

const KEV = item({
  url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2026-20349',
  canonicalUrl: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2026-20349',
  title:
    'Cisco Secure Firewall Adaptive Security Appliance (ASA) and Secure Firewall Threat Defense (FTD) Heap Inspection Vulnerability',
  summaryRaw:
    'Cisco Secure Firewall Adaptive Security Appliance (ASA) and Secure Firewall Threat Defense (FTD) contain a heap inspection vulnerability that could allow an unauthenticated, remote attacker to cause the device to reload unexpectedly.',
});

const AP_HELICOPTER = item({
  url: 'https://apnews.com/article/army-texas-helicopter-crash-pilots-identified-e4f5d048',
  title: 'Army pauses Apache helicopter training missions after crash',
  sourceId: 'ap-news',
  itemType: 'analysis',
  beats: ['usnews'],
});

const HF = item({
  url: 'https://huggingface.co/blog/nvidia/magpie-tts-multilingual-voice-agents',
  title:
    'Build Low-Latency Multilingual Voice Agents: Open Weights & Full Deployment Control with NVIDIA Magpie TTS',
  sourceId: 'huggingface-blog',
  itemType: 'analysis',
  beats: ['ai'],
});

describe('the backfill sweep', () => {
  it('writes entities for items that already exist, without touching items', () => {
    const db = migratedDb();
    insertItem(db, KEV);
    const before = db.prepare('select * from items').all();

    const report = sweepEntities(db, SHIPPED, { now: NOW });

    expect(report.scanned).toBe(1);
    expect(report.entitiesWritten).toBe(2);
    expect(getItemEntities(db, deriveItemKey(KEV.canonicalUrl))).toEqual(['CVE-2026-20349', 'Cisco']);
    // items is append-only and this proves the backfill respects it: not one
    // row changed, and no new version was appended either.
    expect(db.prepare('select * from items').all()).toEqual(before);
  });

  it('is idempotent -- a second sweep at the same ruleset scans nothing', () => {
    const db = migratedDb();
    insertItem(db, KEV);
    expect(sweepEntities(db, SHIPPED, { now: NOW }).scanned).toBe(1);

    const second = sweepEntities(db, SHIPPED, { now: NOW });
    expect(second.scanned).toBe(0);
    expect(second.entitiesWritten).toBe(0);
    expect(db.prepare('select count(*) as c from item_entities').get()).toEqual({ c: 2 });
  });

  it('records a ledger row even for an item that matched NOTHING', () => {
    // The whole reason 0010 exists: zero rows in item_entities is the same
    // shape for "scanned, nothing matched" and "never scanned", so without
    // this the sweep would rescan the same barren item forever.
    const db = migratedDb();
    insertItem(db, item({ url: 'https://e.test/weather', title: 'Local weather remains mild', beats: ['usnews'] }));

    const first = sweepEntities(db, SHIPPED, { now: NOW });
    expect(first.scanned).toBe(1);
    expect(first.entitiesWritten).toBe(0);
    expect(sweepEntities(db, SHIPPED, { now: NOW }).scanned).toBe(0);

    const ledger = db.prepare('select entity_count from item_entity_extractions').all();
    expect(ledger).toEqual([{ entity_count: 0 }]);
  });

  it('re-opens EVERY item when the ruleset changes, which is what makes a config edit reach the corpus', () => {
    const db = migratedDb();
    insertItem(db, KEV);

    const narrow = loadEntityRules('patterns: []\nentities:\n  - { name: Cisco, type: org, aliases: [Cisco] }\n');
    expect(sweepEntities(db, narrow, { now: NOW }).entitiesWritten).toBe(1);
    expect(getItemEntities(db, deriveItemKey(KEV.canonicalUrl))).toEqual(['Cisco']);

    // Enabling the CVE pattern is a config edit. Without a versioned ledger it
    // would apply only to items ingested afterwards.
    const wider = loadEntityRules('patterns: [cve]\nentities:\n  - { name: Cisco, type: org, aliases: [Cisco] }\n');
    const again = sweepEntities(db, wider, { now: NOW });
    expect(again.scanned).toBe(1);
    expect(again.entitiesWritten).toBe(1);
    expect(getItemEntities(db, deriveItemKey(KEV.canonicalUrl))).toEqual(['CVE-2026-20349', 'Cisco']);

    // Two ledger rows, one per ruleset -- the history stays readable.
    expect(
      db.prepare('select ruleset_version, entity_count from item_entity_extractions order by ruleset_version').all(),
    ).toHaveLength(2);
  });

  it('never rewrites an entity row it already wrote', () => {
    const db = migratedDb();
    insertItem(db, KEV);
    sweepEntities(db, loadEntityRules('patterns: []\nentities:\n  - { name: Cisco, type: org, aliases: [Cisco] }\n'), {
      now: NOW,
    });
    sweepEntities(db, SHIPPED, { now: NOW });
    expect(db.prepare('select count(*) as c from item_entities').get()).toEqual({ c: 2 });
  });

  it('scopes the gazetteer by THIS version beats, not the item_key union', () => {
    // Cross-listed items are two rows with one key. Extraction must be a pure
    // function of the row, so both paths provably agree; getItemEntities is
    // what recovers the union at read time.
    const db = migratedDb();
    const url = 'https://arxiv.org/abs/2608.11274';
    insertItem(db, item({ url, title: 'Apache Tomcat and agent safety', sourceId: 'arxiv-cs-ai', beats: ['ai'] }));
    insertItem(db, item({ url, title: 'Apache Tomcat and agent safety', sourceId: 'arxiv-cs-cr', beats: ['usnews'] }));

    sweepEntities(db, SHIPPED, { now: NOW });

    const rows = db
      .prepare(
        `select i.source_id as s, e.entity as e from item_entities e
         join items i on i.item_id = e.item_id order by s, e`,
      )
      .all();
    // ai is in Apache's beat scope; usnews is not.
    expect(rows).toEqual([{ s: 'arxiv-cs-ai', e: 'Apache Software Foundation' }]);
    // ...and the union read path still sees it from either version.
    expect(getItemEntities(db, deriveItemKey(url))).toEqual(['Apache Software Foundation']);
  });
});

describe('the sweep and the insert path produce IDENTICAL results', () => {
  it('agrees with extractEntities row for row over real corpus text', () => {
    // The consistency this pins is what allows two write paths at all: both
    // call the same pure function over the same inputs.
    const db = migratedDb();
    for (const row of [KEV, AP_HELICOPTER, HF]) insertItem(db, row);
    sweepEntities(db, SHIPPED, { now: NOW });

    for (const row of [KEV, AP_HELICOPTER, HF]) {
      const expected = extractEntities(
        { title: row.title, summaryRaw: row.summaryRaw, canonicalUrl: row.canonicalUrl, beats: row.beats },
        SHIPPED,
      );
      expect(getItemEntities(db, deriveItemKey(row.canonicalUrl)), row.title).toEqual(expected);
    }
  });
});

describe('bounding and reporting', () => {
  it('caps work per run and reports what is left, newest first', () => {
    const db = migratedDb();
    for (let i = 0; i < 5; i++) {
      insertItem(db, item({ url: `https://e.test/${i}`, title: `Cisco advisory ${i}`, fetchedAt: `2026-08-1${i}T00:00:00.000Z` }));
    }
    const report = sweepEntities(db, SHIPPED, { now: NOW, limit: 2 });
    expect(report.scanned).toBe(2);
    expect(report.remaining).toBe(3);
    // Newest first: a partial backfill should cover what a reader is looking at.
    const done = db
      .prepare('select i.fetched_at as f from item_entity_extractions x join items i on i.item_id = x.item_id order by f desc')
      .all();
    expect(done).toEqual([{ f: '2026-08-14T00:00:00.000Z' }, { f: '2026-08-13T00:00:00.000Z' }]);
  });

  it('converges: repeated bounded runs finish the corpus', () => {
    const db = migratedDb();
    for (let i = 0; i < 5; i++) insertItem(db, item({ url: `https://e.test/${i}`, title: `Cisco advisory ${i}` }));
    let guard = 0;
    while (sweepEntities(db, SHIPPED, { now: NOW, limit: 2 }).remaining > 0) {
      if (++guard > 10) throw new Error('sweep did not converge');
    }
    expect(entityExtractionCoverage(db, SHIPPED).remaining).toBe(0);
  });

  it('breaks down what it wrote by entity TYPE, which is why the config carries one', () => {
    const db = migratedDb();
    insertItem(db, KEV);
    const report = sweepEntities(db, SHIPPED, { now: NOW });
    expect(report.byType).toEqual({ org: 1, product: 0, concept: 0, identifier: 1 });
  });

  it('reports stored entities the CURRENT ruleset could no longer produce', () => {
    // The sweep only ever inserts (CLAUDE.md's never-delete rule), so removing
    // a term from config leaves its rows behind. That divergence is REPORTED
    // rather than left to be discovered by someone reading a stale note.
    const db = migratedDb();
    insertItem(db, KEV);
    sweepEntities(db, SHIPPED, { now: NOW });

    const withoutCisco = loadEntityRules('patterns: [cve]\nentities:\n  - { name: Zyxel, type: org, aliases: [Zyxel] }\n');
    const after = sweepEntities(db, withoutCisco, { now: NOW });
    expect(after.orphaned).toEqual(['Cisco']);
    // A pattern-produced identifier is never orphaned while its pattern is on.
    expect(after.orphaned).not.toContain('CVE-2026-20349');
  });

  it('has a default limit, so a caller that forgets one cannot stall a poll cycle', () => {
    expect(DEFAULT_SWEEP_LIMIT).toBeGreaterThan(0);
    const db = migratedDb();
    insertItem(db, KEV);
    expect(sweepEntities(db, SHIPPED, { now: NOW }).limit).toBe(DEFAULT_SWEEP_LIMIT);
  });

  it('carries the ruleset version it ran under, so a log line is diagnosable', () => {
    const db = migratedDb();
    expect(sweepEntities(db, SHIPPED, { now: NOW }).rulesetVersion).toBe(rulesetVersion(SHIPPED));
  });
});

describe('the ledger refuses what CLAUDE.md refuses', () => {
  it('rejects UPDATE and DELETE', () => {
    const db = migratedDb();
    insertItem(db, KEV);
    sweepEntities(db, SHIPPED, { now: NOW });
    expect(() => db.exec("update item_entity_extractions set entity_count = 99")).toThrow(/ledger/);
    expect(() => db.exec('delete from item_entity_extractions')).toThrow(/append-only/);
  });

  it('rejects a non-canonical extracted_at at the storage layer', () => {
    const db = migratedDb();
    insertItem(db, KEV);
    const itemId = (db.prepare('select item_id as i from items').get() as { i: string }).i;
    expect(() =>
      db
        .prepare('insert into item_entity_extractions (item_id, ruleset_version, extracted_at, entity_count) values (?, ?, ?, 0)')
        .run(itemId, 'v', '2026-08-16'),
    ).toThrow(/canonical UTC timestamp/);
  });
});
