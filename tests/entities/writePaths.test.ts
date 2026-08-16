import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, deriveItemKey } from '../../src/domain/item.ts';
import { getItemEntities } from '../../src/domain/itemEntities.ts';
import { normalizeItem, type RawItem } from '../../src/normalize/item.ts';
import { loadEntityRulesFile } from '../../src/entities/rules.ts';
import { sweepEntities } from '../../src/entities/sweep.ts';
import type { Source } from '../../src/sources/load.ts';

/**
 * THERE ARE TWO WRITE PATHS INTO `item_entities`, and this file is the reason
 * that is safe.
 *
 * `normalizeItem` extracts at insert time so a new item never exists without
 * its entities; `sweepEntities` covers the 7,267 already-stored versions and
 * re-covers everything whenever `config/entities.yaml` changes. Two writers to
 * one table is the shape of bug this project has found repeatedly, so the
 * agreement is pinned rather than assumed -- over REAL corpus text, including
 * the long-summary case where the two paths could most plausibly diverge.
 */

const SHIPPED = loadEntityRulesFile(join(process.cwd(), 'config', 'entities.yaml'));
const FETCHED_AT = '2026-08-15T00:00:00.000Z';
const NOW = '2026-08-16T00:00:00.000Z';

const open: Db[] = [];
function migratedDb(): Db {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-ent2-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}
afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

function source(over: Partial<Source>): Source {
  return {
    id: 'cisa-kev',
    name: 'CISA KEV',
    type: 'json',
    url: 'https://example.test/feed',
    beats: ['cyber'],
    weight: 1.0,
    poll_interval: '1h',
    enabled: true,
    kind: 'advisory',
    enrichment: true,
    ...over,
  } as Source;
}

// Real rows, copied verbatim from data/wf.db.
const CASES: ReadonlyArray<{ label: string; raw: RawItem; src: Source }> = [
  {
    label: 'cisa-kev Cisco firewall -- CVE only in the URL',
    src: source({}),
    raw: {
      url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2026-20349',
      title:
        'Cisco Secure Firewall Adaptive Security Appliance (ASA) and Secure Firewall Threat Defense (FTD) Heap Inspection Vulnerability',
      summary:
        'Cisco Secure Firewall Adaptive Security Appliance (ASA) and Secure Firewall Threat Defense (FTD) contain a heap inspection vulnerability that could allow an unauthenticated, remote attacker to cause the device to reload unexpectedly, resulting in a denial of service (DoS) condition.',
      raw: {},
    },
  },
  {
    label: 'ap-news Apache helicopter -- the beat-scoped false positive',
    src: source({ id: 'ap-news', beats: ['usnews'], kind: 'news' }),
    raw: {
      url: 'https://apnews.com/article/army-texas-helicopter-crash-pilots-identified-e4f5d048',
      title: 'Army pauses Apache helicopter training missions after crash',
      raw: {},
    },
  },
  {
    label: 'nvd-cve Flowise -- id in title, summary and URL at once',
    src: source({ id: 'nvd-cve' }),
    raw: {
      url: 'https://nvd.nist.gov/vuln/detail/CVE-2026-73487',
      title: 'CVE-2026-73487',
      summary:
        'Flowise before 3.1.3 contains a regex-based Python code validator bypass in CSV and Airtable Agent nodes that allows unauthenticated attackers to inject malicious code via prompt injection.',
      raw: {},
    },
  },
  {
    label: 'a summary LONGER than the 300-character store cap',
    src: source({ id: 'the-hacker-news', beats: ['cyber'], kind: 'news' }),
    raw: {
      url: 'https://thehackernews.test/story',
      title: 'A long advisory',
      // The entity name sits past the cut on purpose: this is the one case
      // where reading the untruncated text at insert time would make the two
      // paths disagree, silently, and only on long items.
      summary: `${'filler word '.repeat(40)}and finally Fortinet is named here.`,
      raw: {},
    },
  },
];

describe('normalizeItem, the insert-time path', () => {
  it('still returns [] when no ruleset is passed -- every pre-task-16 caller is unaffected', () => {
    for (const { raw, src } of CASES) {
      expect(normalizeItem(raw, src, FETCHED_AT).entities).toEqual([]);
    }
  });

  it('extracts using THIS version beats, so the KEV row gets its vendor and its CVE', () => {
    const item = normalizeItem(CASES[0]!.raw, CASES[0]!.src, FETCHED_AT, SHIPPED);
    expect(item.entities).toEqual(['CVE-2026-20349', 'Cisco']);
  });

  it('does not attribute the software foundation to a usnews helicopter story', () => {
    expect(normalizeItem(CASES[1]!.raw, CASES[1]!.src, FETCHED_AT, SHIPPED).entities).toEqual([]);
  });
});

describe('the two write paths agree, over real text', () => {
  it('insert-time and sweep produce byte-identical entity sets for every case', () => {
    const inserted = migratedDb();
    const swept = migratedDb();

    for (const { raw, src } of CASES) {
      insertItem(inserted, normalizeItem(raw, src, FETCHED_AT, SHIPPED));
      // The sweep's database gets the SAME items with no entities at all --
      // exactly the state the live corpus was in.
      insertItem(swept, normalizeItem(raw, src, FETCHED_AT));
    }
    sweepEntities(swept, SHIPPED, { now: NOW });

    for (const { label, raw } of CASES) {
      const key = deriveItemKey(normalizeItem(raw, CASES[0]!.src, FETCHED_AT).canonicalUrl);
      expect(getItemEntities(swept, key), label).toEqual(getItemEntities(inserted, key));
    }
  });

  it('agrees on the over-long summary, because both read the TRUNCATED text', () => {
    // If insert-time extraction read the untruncated summary it would find
    // Fortinet and the sweep never could -- a divergence visible only on long
    // items and invisible to every short fixture.
    const { raw, src } = CASES[3]!;
    const item = normalizeItem(raw, src, FETCHED_AT, SHIPPED);
    expect(item.summaryRaw!.length).toBeLessThanOrEqual(300);
    expect(raw.summary!.length).toBeGreaterThan(300);

    const swept = migratedDb();
    insertItem(swept, normalizeItem(raw, src, FETCHED_AT));
    sweepEntities(swept, SHIPPED, { now: NOW });
    expect(getItemEntities(swept, deriveItemKey(item.canonicalUrl))).toEqual(item.entities);
  });

  it('a sweep over items that already have their entities writes nothing new', () => {
    const db = migratedDb();
    for (const { raw, src } of CASES) insertItem(db, normalizeItem(raw, src, FETCHED_AT, SHIPPED));
    const before = db.prepare('select item_id, entity from item_entities order by 1, 2').all();

    const report = sweepEntities(db, SHIPPED, { now: NOW });
    expect(report.scanned).toBe(CASES.length);
    expect(report.entitiesWritten).toBe(0);
    expect(db.prepare('select item_id, entity from item_entities order by 1, 2').all()).toEqual(before);
  });
});
