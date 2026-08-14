import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, getCurrentItem, type NewItem } from '../../src/domain/item.ts';
import {
  parseOverridesConfig,
  loadOverridesConfig,
  OverrideConfigError,
  withinRecencyBound,
  extractJsonThreshold,
  evaluateOverrides,
  tryReadPortfolioFile,
  type OverridesConfig,
} from '../../src/score/overrides.ts';

// ---------------------------------------------------------------------------
// Temp-DB plumbing, mirroring tests/domain/itemFirstFetchedAt.test.ts and
// tests/score/decay.test.ts exactly (openDb -> runMigrations against the
// real db/migrations directory -> insertItem/getCurrentItem). Real
// temp-file SQLite, no mocks, per the task's global constraints.
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

const NOW = '2026-08-14T00:00:00.000Z';

function daysBefore(iso: string, days: number): string {
  return new Date(Date.parse(iso) - days * 86_400_000).toISOString();
}

// ---------------------------------------------------------------------------
// Fixture helpers -- real shapes, hand-copied with provenance, exactly like
// tests/domain/itemFirstFetchedAt.test.ts's kevItem(). attic/wf-m1-firstrun-
// 2026-08-14.db is read-only local evidence (gitignored, `*.db`; confirmed
// via `git check-ignore`) and is NEVER opened by this test file -- values
// below were extracted with the sqlite3 CLI during development and are
// copied in by hand, the same convention every M2 Wave-1 test file uses.
// ---------------------------------------------------------------------------

/**
 * A cisa-kev-shaped item. `dateAdded` drives BOTH `raw_json` (the field the
 * real adapter/normalizer pipeline reads) and `publishedAt` (hand-computed
 * as midnight UTC on that date, mirroring src/normalize/item.ts's documented
 * bare-calendar-date convention -- see that file's `parseDateOnly` doc
 * comment -- WITHOUT importing normalize/item.ts here: this module's own
 * dependency surface stays limited to domain/item.ts, matching overrides.ts
 * itself). Pass `publishedAt: null` explicitly to simulate the PRE-FIX (or
 * any still-unparseable) shape -- both are real, not hypothetical: the
 * archived corpus has 1,665 cisa-kev rows, every one null, because the fix
 * that parses `dateAdded` postdates that ingest.
 */
function kevItem(opts: { cveId: string; dateAdded: string; fetchedAt: string; publishedAt?: string | null }): NewItem {
  const publishedAt = opts.publishedAt === undefined ? `${opts.dateAdded}T00:00:00.000Z` : opts.publishedAt;
  return {
    url: `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=${opts.cveId}`,
    canonicalUrl: `https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=${opts.cveId}`,
    title: `${opts.cveId} Remote Code Execution Vulnerability`,
    sourceId: 'cisa-kev',
    itemType: 'event',
    beats: ['cyber'],
    entities: [],
    publishedAt,
    fetchedAt: opts.fetchedAt,
    summaryRaw: null,
    // Trimmed to the fields that matter (real shape: full sample pulled
    // 2026-08-14 from attic/wf-m1-firstrun-2026-08-14.db has requiredAction/
    // dueDate/notes/cwes too -- none of those are read by overrides.ts).
    rawJson: JSON.stringify({
      cveID: opts.cveId,
      vendorProject: 'Example',
      product: 'Example Product',
      vulnerabilityName: `${opts.cveId} Remote Code Execution Vulnerability`,
      dateAdded: opts.dateAdded,
      shortDescription: 'Example description.',
      knownRansomwareCampaignUse: 'Unknown',
    }),
  };
}

/**
 * An nvd-cve-shaped item. `cvssJson` is a caller-supplied fragment for the
 * `metrics` object, so different tests can exercise the v3.1/v3.0/v2-only
 * shapes real NVD entries take. `publishedAt` defaults to `null` because
 * that is the REAL, current, and (per src/normalize/item.ts's ISO8601_RE --
 * read, not modified, by this test) PERMANENT behavior: NVD's `published`
 * field has no UTC offset ("1988-10-01T04:00:00.000"), and normalizeItem
 * deliberately refuses to guess one rather than assume the host's local
 * zone. Confirmed directly against tests/fixtures/adapters/nvd-cve.json,
 * whose 5 real entries all carry exactly this offset-less shape.
 */
function nvdCveItem(opts: {
  cveId: string;
  metrics: unknown;
  publishedAtRaw?: string;
  fetchedAt: string;
  publishedAt?: string | null;
}): NewItem {
  return {
    url: `https://nvd.nist.gov/vuln/detail/${opts.cveId}`,
    canonicalUrl: `https://nvd.nist.gov/vuln/detail/${opts.cveId}`,
    title: opts.cveId,
    sourceId: 'nvd-cve',
    itemType: 'event',
    beats: ['cyber'],
    entities: [],
    publishedAt: opts.publishedAt === undefined ? null : opts.publishedAt,
    fetchedAt: opts.fetchedAt,
    summaryRaw: null,
    rawJson: JSON.stringify({
      cve: {
        id: opts.cveId,
        published: opts.publishedAtRaw ?? '2026-08-10T12:00:00.000',
        metrics: opts.metrics,
      },
    }),
  };
}

function insertAndFetch(db: ReturnType<typeof openDb>, item: NewItem) {
  insertItem(db, item);
  const current = getCurrentItem(db, deriveKeyOf(item));
  if (!current) throw new Error('test setup failure: item not found after insert');
  return current;
}

// Local re-derivation avoiding an import of domain/item.ts's private hash
// internals -- item_key is sha256(canonicalUrl), but getCurrentItem only
// needs *a* correct key, and re-deriving it via the exported deriveItemKey
// keeps this file honest about what it depends on.
import { deriveItemKey } from '../../src/domain/item.ts';
function deriveKeyOf(item: NewItem): string {
  return deriveItemKey(item.canonicalUrl);
}

// A minimal, hand-built config used by most behavioral tests below,
// independent of the real checked-in config/overrides.yaml (which gets its
// own golden-file tests further down). Two enabled "real" rules (one of
// each matchable kind) plus one of each disabled kind, so every code path
// has at least one config-driven exercise outside the shipped file.
function testConfig(): OverridesConfig {
  return {
    overrides: [
      {
        id: 'test-kev',
        label: 'Test KEV-like source',
        kind: 'source_match',
        source_id: 'cisa-kev',
        recency_bound_days: 30,
        applies_to: ['signal'],
        priority: 30,
        enabled: true,
      },
      {
        id: 'test-cvss',
        label: 'Test CVSS-threshold source',
        kind: 'source_json_threshold',
        source_id: 'nvd-cve',
        json_paths: ['cve.metrics.cvssMetricV31.0.cvssData.baseScore', 'cve.metrics.cvssMetricV30.0.cvssData.baseScore'],
        comparator: 'gte',
        threshold: 9.0,
        recency_bound_days: 30,
        applies_to: ['signal'],
        priority: 40,
        enabled: true,
      },
      {
        id: 'test-no-source',
        label: 'Test unreachable source',
        kind: 'source_match',
        source_id: 'nonexistent-source',
        recency_bound_days: 30,
        applies_to: ['signal'],
        priority: 10,
        enabled: false,
        note: 'no feed exists -- test fixture for the disabled state',
      },
      {
        id: 'test-portfolio',
        label: 'Test portfolio stub',
        kind: 'portfolio_stub',
        milestone: 'M4b',
        portfolio_path: 'config/portfolio.yaml',
        applies_to: ['signal'],
        priority: 50,
        enabled: false,
        note: 'M4b, not yet -- test fixture for the disabled state',
      },
    ],
  };
}

// ===========================================================================
// Group 1 -- config parsing/validation
// ===========================================================================
describe('parseOverridesConfig', () => {
  it('parses a minimal valid config', () => {
    const yamlText = `
overrides:
  - id: kev
    label: KEV
    kind: source_match
    source_id: cisa-kev
    recency_bound_days: 30
    applies_to: [signal]
    priority: 10
    enabled: true
`;
    const config = parseOverridesConfig(yamlText);
    expect(config.overrides).toHaveLength(1);
    expect(config.overrides[0]).toMatchObject({ id: 'kev', kind: 'source_match', source_id: 'cisa-kev' });
  });

  it('rejects unparseable YAML', () => {
    expect(() => parseOverridesConfig('overrides: [this is not: valid: yaml')).toThrow(OverrideConfigError);
  });

  it('rejects an unknown kind', () => {
    const yamlText = `
overrides:
  - id: x
    label: X
    kind: not_a_real_kind
    priority: 10
    applies_to: [signal]
    enabled: true
`;
    expect(() => parseOverridesConfig(yamlText)).toThrow(OverrideConfigError);
  });

  it('rejects a source_match rule missing recency_bound_days', () => {
    const yamlText = `
overrides:
  - id: kev
    label: KEV
    kind: source_match
    source_id: cisa-kev
    applies_to: [signal]
    priority: 10
    enabled: true
`;
    expect(() => parseOverridesConfig(yamlText)).toThrow(OverrideConfigError);
  });

  it('rejects a non-positive recency_bound_days', () => {
    const yamlText = `
overrides:
  - id: kev
    label: KEV
    kind: source_match
    source_id: cisa-kev
    recency_bound_days: 0
    applies_to: [signal]
    priority: 10
    enabled: true
`;
    expect(() => parseOverridesConfig(yamlText)).toThrow(OverrideConfigError);
  });

  it('rejects duplicate ids', () => {
    const yamlText = `
overrides:
  - id: dupe
    label: A
    kind: source_match
    source_id: a
    recency_bound_days: 30
    applies_to: [signal]
    priority: 10
    enabled: true
  - id: dupe
    label: B
    kind: source_match
    source_id: b
    recency_bound_days: 30
    applies_to: [signal]
    priority: 20
    enabled: true
`;
    expect(() => parseOverridesConfig(yamlText)).toThrow(OverrideConfigError);
    expect(() => parseOverridesConfig(yamlText)).toThrow(/duplicate/i);
  });

  it('rejects a disabled rule with no note explaining why', () => {
    const yamlText = `
overrides:
  - id: x
    label: X
    kind: source_match
    source_id: nowhere
    recency_bound_days: 30
    applies_to: [signal]
    priority: 10
    enabled: false
`;
    expect(() => parseOverridesConfig(yamlText)).toThrow(OverrideConfigError);
    expect(() => parseOverridesConfig(yamlText)).toThrow(/note/i);
  });

  it('accepts a disabled rule that has a note', () => {
    const yamlText = `
overrides:
  - id: x
    label: X
    kind: source_match
    source_id: nowhere
    recency_bound_days: 30
    applies_to: [signal]
    priority: 10
    enabled: false
    note: no feed exists
`;
    expect(() => parseOverridesConfig(yamlText)).not.toThrow();
  });

  it('rejects an absolute portfolio_path (zero-absolute-paths rule)', () => {
    const yamlText = `
overrides:
  - id: x
    label: X
    kind: portfolio_stub
    milestone: M4b
    portfolio_path: /etc/portfolio.yaml
    applies_to: [signal]
    priority: 10
    enabled: false
    note: M4b, not yet
`;
    expect(() => parseOverridesConfig(yamlText)).toThrow(OverrideConfigError);
  });

  it('rejects priority 0 (must be a positive integer)', () => {
    const yamlText = `
overrides:
  - id: x
    label: X
    kind: source_match
    source_id: a
    recency_bound_days: 30
    applies_to: [signal]
    priority: 0
    enabled: true
`;
    expect(() => parseOverridesConfig(yamlText)).toThrow(OverrideConfigError);
  });

  it('rejects an empty overrides list', () => {
    expect(() => parseOverridesConfig('overrides: []')).toThrow(OverrideConfigError);
  });
});

describe('loadOverridesConfig', () => {
  it('reads and parses a config file from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-test-'));
    const path = join(dir, 'overrides.yaml');
    writeFileSync(
      path,
      `
overrides:
  - id: kev
    label: KEV
    kind: source_match
    source_id: cisa-kev
    recency_bound_days: 30
    applies_to: [signal]
    priority: 10
    enabled: true
`,
      'utf8',
    );
    const config = loadOverridesConfig(path);
    expect(config.overrides).toHaveLength(1);
  });
});

// ===========================================================================
// Group 2 -- withinRecencyBound, the pure recency predicate (isolated)
// ===========================================================================
describe('withinRecencyBound (the recency-bound decision, isolated)', () => {
  it('is true at age 0 (publishedAt === now)', () => {
    expect(withinRecencyBound(NOW, NOW, 30)).toBe(true);
  });

  it('is true just inside the bound', () => {
    expect(withinRecencyBound(daysBefore(NOW, 29), NOW, 30)).toBe(true);
  });

  it('is true exactly at the bound (inclusive)', () => {
    expect(withinRecencyBound(daysBefore(NOW, 30), NOW, 30)).toBe(true);
  });

  it('is false just outside the bound', () => {
    expect(withinRecencyBound(daysBefore(NOW, 31), NOW, 30)).toBe(false);
  });

  // THE critical safety property. A recency-bounded override that fell back
  // to "assume fresh" on a null publishedAt would readmit exactly the
  // cold-start failure mode this bound exists to close: 100% of the real
  // 1,665-entry cisa-kev cold-start dump (attic/wf-m1-firstrun-2026-08-14.db)
  // had published_at NULL. Fail CLOSED, not open.
  it('is false when publishedAt is null, regardless of how generous the bound is (fail closed)', () => {
    expect(withinRecencyBound(null, NOW, 100_000)).toBe(false);
  });

  // Deliberate, mirroring src/score/decay.ts's future-dated clamp reasoning
  // (read, not modified, by this module): a future-dated item (clock skew,
  // a sitemap bug) has negative age, which trivially satisfies any positive
  // bound. Treated as "as fresh as possible", never rejected for being "too
  // fresh" -- there is no such thing here.
  it('is true when publishedAt is in the future relative to now', () => {
    const future = new Date(Date.parse(NOW) + 3_600_000).toISOString();
    expect(withinRecencyBound(future, NOW, 30)).toBe(true);
  });

  it('rejects a non-canonical now', () => {
    expect(() => withinRecencyBound(NOW, '2026-08-14', 30)).toThrow();
  });

  it('rejects a non-canonical publishedAt', () => {
    expect(() => withinRecencyBound('2026-08-14', NOW, 30)).toThrow();
  });
});

// ===========================================================================
// Group 3 -- extractJsonThreshold, the raw_json numeric-path reader (isolated)
// ===========================================================================
describe('extractJsonThreshold (isolated)', () => {
  it('extracts a nested numeric field via a dotted path with an array index', () => {
    const rawJson = JSON.stringify({ cve: { metrics: { cvssMetricV31: [{ cvssData: { baseScore: 9.8 } }] } } });
    expect(extractJsonThreshold(rawJson, ['cve.metrics.cvssMetricV31.0.cvssData.baseScore'])).toBe(9.8);
  });

  it('returns null when the path does not exist', () => {
    const rawJson = JSON.stringify({ cve: { metrics: {} } });
    expect(extractJsonThreshold(rawJson, ['cve.metrics.cvssMetricV31.0.cvssData.baseScore'])).toBeNull();
  });

  it('returns null when the value at the path is not a number', () => {
    const rawJson = JSON.stringify({ cve: { metrics: { cvssMetricV31: [{ cvssData: { baseScore: 'high' } }] } } });
    expect(extractJsonThreshold(rawJson, ['cve.metrics.cvssMetricV31.0.cvssData.baseScore'])).toBeNull();
  });

  it('tries fallback paths in order when the first is absent', () => {
    // Real shape: an older CVE rescored to v3.0 but never to v3.1.
    const rawJson = JSON.stringify({ cve: { metrics: { cvssMetricV30: [{ cvssData: { baseScore: 9.1 } }] } } });
    expect(
      extractJsonThreshold(rawJson, [
        'cve.metrics.cvssMetricV31.0.cvssData.baseScore',
        'cve.metrics.cvssMetricV30.0.cvssData.baseScore',
      ]),
    ).toBe(9.1);
  });

  it('returns null on malformed JSON rather than throwing', () => {
    expect(extractJsonThreshold('{not json', ['cve.metrics.cvssMetricV31.0.cvssData.baseScore'])).toBeNull();
  });

  // Real shape, hand-copied from tests/fixtures/adapters/nvd-cve.json
  // (CVE-1999-0095): a V2-ONLY entry with baseScore 10.0. This module's
  // config deliberately never lists a V2 fallback path (see config/
  // overrides.yaml's header) because CVSS v2 has no "Critical" band -- its
  // scale tops out at "High" for 7.0-10.0, so treating a V2 10.0 as
  // equivalent to a V3.x >=9.0 "Critical" would import a V3-only severity
  // concept onto a score that was never rated against it.
  it('a real V2-only NVD entry (CVE-1999-0095 shape) does not satisfy a V3-only path list', () => {
    const rawJson = JSON.stringify({
      cve: {
        id: 'CVE-1999-0095',
        metrics: {
          cvssMetricV2: [{ source: 'nvd@nist.gov', type: 'Primary', cvssData: { version: '2.0', baseScore: 10.0 }, baseSeverity: 'HIGH' }],
        },
      },
    });
    expect(
      extractJsonThreshold(rawJson, [
        'cve.metrics.cvssMetricV31.0.cvssData.baseScore',
        'cve.metrics.cvssMetricV30.0.cvssData.baseScore',
      ]),
    ).toBeNull();
  });
});

// ===========================================================================
// Group 4 -- evaluateOverrides: source_match (CISA KEV shape), via a real
// temp-file SQLite round trip (insertItem -> getCurrentItem), not a
// hand-typed object literal, to prove genuine integration.
// ===========================================================================
describe('evaluateOverrides -- source_match (cisa-kev)', () => {
  it('pins a recent real-shaped KEV item for the signal profile', () => {
    const db = migratedDb();
    const item = insertAndFetch(db, kevItem({ cveId: 'CVE-2026-90001', dateAdded: '2026-08-11', fetchedAt: NOW }));
    const result = evaluateOverrides(item, 'signal', NOW, testConfig());
    expect(result.pinned).toBe(true);
    expect(result.matches.map((m) => m.id)).toContain('test-kev');
  });

  // The task's central design question, answered and proven: overrides are
  // signal-only. A KEV entry is a terse catalog record (vendor/product/CVE
  // id/required action) -- it is exactly the kind of item §5.1 means by
  // "filings and rule changes rank high [on signal]; essays rank near
  // zero" -- so it must never force its way to the top of read_score, which
  // continues to reflect the item's own, unforced, explanatory value.
  it('does NOT pin the same item for the read profile', () => {
    const db = migratedDb();
    const item = insertAndFetch(db, kevItem({ cveId: 'CVE-2026-90002', dateAdded: '2026-08-11', fetchedAt: NOW }));
    const result = evaluateOverrides(item, 'read', NOW, testConfig());
    expect(result.pinned).toBe(false);
    expect(result.matches).toHaveLength(0);
  });

  // Real dateAdded from the archived corpus: 2021-11-03 is the single date
  // carrying 287 of the 1,665 cisa-kev entries -- CISA's catalog-launch
  // backfill. ~1,745 days old relative to NOW; must not pin under any
  // remotely reasonable bound.
  it('does NOT pin a KEV item added to the catalog in 2021 (the catalog-launch backfill date)', () => {
    const db = migratedDb();
    const item = insertAndFetch(db, kevItem({ cveId: 'CVE-2021-90003', dateAdded: '2021-11-03', fetchedAt: NOW }));
    const result = evaluateOverrides(item, 'signal', NOW, testConfig());
    expect(result.pinned).toBe(false);
  });

  // The pre-fix (and generally: "unparseable date") shape. Real: all 1,665
  // cisa-kev rows in attic/wf-m1-firstrun-2026-08-14.db have published_at
  // NULL. If this test ever fails, it means the null-published_at fallback
  // has been changed to admit an undated item -- exactly the change that
  // would reopen the cold-start hole this whole design closes.
  it('does NOT pin a KEV item with published_at null, even though sourceId matches and it was just fetched', () => {
    const db = migratedDb();
    const item = insertAndFetch(
      db,
      kevItem({ cveId: 'CVE-2026-90004', dateAdded: '2026-08-11', fetchedAt: NOW, publishedAt: null }),
    );
    const result = evaluateOverrides(item, 'signal', NOW, testConfig());
    expect(result.pinned).toBe(false);
  });

  it('does NOT pin an item from an unrelated source', () => {
    const db = migratedDb();
    const item = insertAndFetch(db, {
      ...kevItem({ cveId: 'CVE-2026-90005', dateAdded: '2026-08-11', fetchedAt: NOW }),
      sourceId: 'krebs',
      url: 'https://krebsonsecurity.com/example',
      canonicalUrl: 'https://krebsonsecurity.com/example',
    });
    const result = evaluateOverrides(item, 'signal', NOW, testConfig());
    expect(result.pinned).toBe(false);
  });

  it('does NOT pin when the matching rule is disabled, even for an otherwise-perfect match', () => {
    const db = migratedDb();
    const item = insertAndFetch(db, kevItem({ cveId: 'CVE-2026-90006', dateAdded: '2026-08-11', fetchedAt: NOW }));
    const config: OverridesConfig = {
      overrides: [{ ...testConfig().overrides[0]!, enabled: false, note: 'disabled for this test' }],
    };
    const result = evaluateOverrides(item, 'signal', NOW, config);
    expect(result.pinned).toBe(false);
  });
});

// ===========================================================================
// Group 5 -- evaluateOverrides: source_json_threshold (NVD CVE shape)
// ===========================================================================
describe('evaluateOverrides -- source_json_threshold (nvd-cve)', () => {
  const v31Critical = {
    cvssMetricV31: [{ source: 'nvd@nist.gov', type: 'Primary', cvssData: { version: '3.1', baseScore: 9.8, baseSeverity: 'CRITICAL' } }],
  };
  const v31High = {
    cvssMetricV31: [{ source: 'nvd@nist.gov', type: 'Primary', cvssData: { version: '3.1', baseScore: 8.8, baseSeverity: 'HIGH' } }],
  };

  it('pins when baseScore >= threshold and publishedAt is within bound (hypothetical: a valid, non-null publishedAt)', () => {
    const db = migratedDb();
    const item = insertAndFetch(
      db,
      nvdCveItem({ cveId: 'CVE-2026-91001', metrics: v31Critical, fetchedAt: NOW, publishedAt: daysBefore(NOW, 1) }),
    );
    const result = evaluateOverrides(item, 'signal', NOW, testConfig());
    expect(result.pinned).toBe(true);
    expect(result.matches.map((m) => m.id)).toContain('test-cvss');
  });

  it('does NOT pin when baseScore is below threshold', () => {
    const db = migratedDb();
    const item = insertAndFetch(
      db,
      nvdCveItem({ cveId: 'CVE-2026-91002', metrics: v31High, fetchedAt: NOW, publishedAt: daysBefore(NOW, 1) }),
    );
    const result = evaluateOverrides(item, 'signal', NOW, testConfig());
    expect(result.pinned).toBe(false);
  });

  it('does NOT pin when no CVSS metric is present at all', () => {
    const db = migratedDb();
    const item = insertAndFetch(
      db,
      nvdCveItem({ cveId: 'CVE-2026-91003', metrics: {}, fetchedAt: NOW, publishedAt: daysBefore(NOW, 1) }),
    );
    const result = evaluateOverrides(item, 'signal', NOW, testConfig());
    expect(result.pinned).toBe(false);
  });

  it('respects the recency bound the same way source_match does', () => {
    const db = migratedDb();
    const item = insertAndFetch(
      db,
      nvdCveItem({ cveId: 'CVE-2026-91004', metrics: v31Critical, fetchedAt: NOW, publishedAt: daysBefore(NOW, 31) }),
    );
    const result = evaluateOverrides(item, 'signal', NOW, testConfig());
    expect(result.pinned).toBe(false);
  });

  // THE documented, evidence-based finding: as normalized TODAY,
  // src/normalize/item.ts's ISO8601_RE rejects NVD's offset-less `published`
  // field ("1988-10-01T04:00:00.000", confirmed against the real
  // tests/fixtures/adapters/nvd-cve.json) unconditionally, so every real
  // nvd-cve item has published_at NULL. Combined with the fail-closed
  // decision (Group 2), this override CANNOT fire on real data today even
  // though its matcher is fully implemented and correct -- a third gap
  // alongside the two named-unreachable categories, discovered by tracing
  // the current normalizer rather than assumed. See the task report.
  it('does NOT pin a real-shaped nvd-cve item today, because published_at is (permanently, by normalizer design) null', () => {
    const db = migratedDb();
    const item = insertAndFetch(db, nvdCveItem({ cveId: 'CVE-2026-91005', metrics: v31Critical, fetchedAt: NOW }));
    expect(item.publishedAt).toBeNull();
    const result = evaluateOverrides(item, 'signal', NOW, testConfig());
    expect(result.pinned).toBe(false);
  });
});

// ===========================================================================
// Group 6 -- evaluateOverrides: portfolio_stub (M4b, no-op by design)
// ===========================================================================
describe('evaluateOverrides -- portfolio_stub (M4b no-op stub)', () => {
  it('never matches, even when enabled and a plausible fake-ticker portfolio file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-test-'));
    const portfolioPath = join(dir, 'portfolio.yaml');
    // Obviously-fake ticker, per the task's instruction: never a real one.
    writeFileSync(portfolioPath, 'holdings:\n  - ticker: ZZZZ-FAKE\n', 'utf8');

    const db = migratedDb();
    const item = insertAndFetch(db, kevItem({ cveId: 'CVE-2026-92001', dateAdded: '2026-08-11', fetchedAt: NOW }));
    const config: OverridesConfig = {
      overrides: [
        {
          id: 'test-portfolio-enabled',
          label: 'Test portfolio stub (enabled)',
          kind: 'portfolio_stub',
          milestone: 'M4b',
          portfolio_path: portfolioPath,
          applies_to: ['signal'],
          priority: 50,
          enabled: true,
        },
      ],
    };
    const result = evaluateOverrides(item, 'signal', NOW, config);
    expect(result.pinned).toBe(false);
  });

  it('is gated off by enabled: false, same as every other kind', () => {
    const db = migratedDb();
    const item = insertAndFetch(db, kevItem({ cveId: 'CVE-2026-92002', dateAdded: '2026-08-11', fetchedAt: NOW }));
    const result = evaluateOverrides(item, 'signal', NOW, testConfig()); // testConfig's portfolio rule is enabled: false
    expect(result.matches.map((m) => m.id)).not.toContain('test-portfolio');
  });
});

describe('tryReadPortfolioFile (the runtime-read plumbing for portfolio-linked categories)', () => {
  it('reads and parses a present, obviously-fake portfolio fixture without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-test-'));
    const path = join(dir, 'portfolio.yaml');
    writeFileSync(path, 'holdings:\n  - ticker: ZZZZ-FAKE\n  - ticker: NOTREAL\n', 'utf8');
    const parsed = tryReadPortfolioFile(path);
    expect(parsed).toEqual({ holdings: [{ ticker: 'ZZZZ-FAKE' }, { ticker: 'NOTREAL' }] });
  });

  // Must not throw: config/portfolio.yaml is gitignored (CLAUDE.md,
  // confirmed in .gitignore) and absent from a fresh clone by design --
  // "nothing in the codebase reads either file at build or test time, so a
  // clone is unaffected" is a standing invariant this function must uphold
  // the moment anything DOES start reading it.
  it('returns null for a missing file rather than throwing (fresh-clone simulation)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-test-'));
    const path = join(dir, 'does-not-exist.yaml');
    expect(tryReadPortfolioFile(path)).toBeNull();
  });
});

// ===========================================================================
// Group 7 -- multiple matches on one item: priority ordering
// ===========================================================================
describe('evaluateOverrides -- multiple matching rules on one item', () => {
  it('returns all matches sorted by priority ascending, with .priority set to the best (lowest) one', () => {
    const db = migratedDb();
    const item = insertAndFetch(db, kevItem({ cveId: 'CVE-2026-93001', dateAdded: '2026-08-11', fetchedAt: NOW }));
    const config: OverridesConfig = {
      overrides: [
        {
          id: 'low-priority-kev',
          label: 'Low priority',
          kind: 'source_match',
          source_id: 'cisa-kev',
          recency_bound_days: 30,
          applies_to: ['signal'],
          priority: 90,
          enabled: true,
        },
        {
          id: 'high-priority-kev',
          label: 'High priority',
          kind: 'source_match',
          source_id: 'cisa-kev',
          recency_bound_days: 30,
          applies_to: ['signal'],
          priority: 5,
          enabled: true,
        },
      ],
    };
    const result = evaluateOverrides(item, 'signal', NOW, config);
    expect(result.pinned).toBe(true);
    expect(result.matches.map((m) => m.id)).toEqual(['high-priority-kev', 'low-priority-kev']);
    expect(result.priority).toBe(5);
  });

  it('a non-pinned item has priority: null and an empty matches list', () => {
    const db = migratedDb();
    const item = insertAndFetch(db, {
      ...kevItem({ cveId: 'CVE-2026-93002', dateAdded: '2021-11-03', fetchedAt: NOW }),
    });
    const result = evaluateOverrides(item, 'signal', NOW, testConfig());
    expect(result.pinned).toBe(false);
    expect(result.priority).toBeNull();
    expect(result.matches).toEqual([]);
  });
});

// ===========================================================================
// Group 8 -- the real, checked-in config/overrides.yaml: golden-config tests
// ===========================================================================
describe('the real config/overrides.yaml', () => {
  const REAL_CONFIG_PATH = join(process.cwd(), 'config', 'overrides.yaml');

  it('loads without error', () => {
    expect(() => loadOverridesConfig(REAL_CONFIG_PATH)).not.toThrow();
  });

  it('represents exactly the six categories named in the spec', () => {
    const config = loadOverridesConfig(REAL_CONFIG_PATH);
    const ids = config.overrides.map((r) => r.id).sort();
    expect(ids).toEqual(
      [
        'cisa-kev-catalog',
        'cve-critical-cvss',
        'juniper-sirt-advisory',
        'nws-nhc-alerts',
        '8k-held-name',
        'earnings-within-5-sessions',
      ].sort(),
    );
  });

  it('enables exactly the two reachable categories (cisa-kev, nvd-cve)', () => {
    const config = loadOverridesConfig(REAL_CONFIG_PATH);
    const enabledIds = config.overrides.filter((r) => r.enabled).map((r) => r.id).sort();
    expect(enabledIds).toEqual(['cisa-kev-catalog', 'cve-critical-cvss'].sort());
  });

  it('every disabled rule documents why, in a note', () => {
    const config = loadOverridesConfig(REAL_CONFIG_PATH);
    for (const rule of config.overrides) {
      if (!rule.enabled) {
        expect(rule.note, `rule '${rule.id}' is disabled but has no note`).toBeTruthy();
        expect(rule.note!.length).toBeGreaterThan(0);
      }
    }
  });

  it('the two portfolio-linked categories carry no portfolio content -- shape only', () => {
    const yamlText = JSON.stringify(loadOverridesConfig(REAL_CONFIG_PATH));
    // Obviously-fake tokens that must never appear for real reasons (a real
    // ticker or holding), only ever as this exact negative assertion.
    expect(yamlText).not.toMatch(/portfolio_stub".*"tickers"/);
    const stubs = loadOverridesConfig(REAL_CONFIG_PATH).overrides.filter((r) => r.kind === 'portfolio_stub');
    expect(stubs).toHaveLength(2);
    for (const stub of stubs) {
      expect(stub.kind).toBe('portfolio_stub');
      if (stub.kind === 'portfolio_stub') {
        expect(stub.portfolio_path).toBe('config/portfolio.yaml');
        expect(stub.milestone).toBe('M4b');
      }
    }
  });

  it('every rule applies only to the signal profile (the two-score design decision)', () => {
    const config = loadOverridesConfig(REAL_CONFIG_PATH);
    for (const rule of config.overrides) {
      expect(rule.applies_to).toEqual(['signal']);
    }
  });

  it('all priorities are unique (a total order across categories)', () => {
    const config = loadOverridesConfig(REAL_CONFIG_PATH);
    const priorities = config.overrides.map((r) => r.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
  });
});

// ===========================================================================
// Group 9 -- the cold-start proof, using the real config and real archived-
// corpus dates (attic/wf-m1-firstrun-2026-08-14.db, read-only, never opened
// by this file). This operationalizes the numbers in the task report as an
// executable, regression-proof claim rather than a one-time manual count.
// ===========================================================================
describe('the cold-start problem, resolved and proven against real dates', () => {
  const REAL_CONFIG_PATH = join(process.cwd(), 'config', 'overrides.yaml');

  // Real dateAdded values sampled from attic/wf-m1-firstrun-2026-08-14.db
  // (`select json_extract(raw_json,'$.dateAdded'), count(*) from items
  // where source_id='cisa-kev' group by 1 order by 1`), spanning the full
  // spread that a cold start would otherwise dump unconditionally:
  //   2021-11-03 -- 287 real entries share this exact date (CISA's
  //                 catalog-launch backfill; the single largest spike in
  //                 the whole 1,665-row corpus)
  //   2022-03-03, 2024-01-08, 2025-10-06 -- representative mid-range dates
  //   2026-08-11, 2026-08-07 -- the most recent real dates in the corpus
  // Full distribution (this exact query, cumulative, against the real
  // corpus): total 1,665; <=7d: 4; <=30d: 23; <=90d: 73; <=365d: 266.
  it('a cold start of realistic real-dated KEV entries pins only the ones added in the last 30 days', () => {
    const db = migratedDb();
    const config = loadOverridesConfig(REAL_CONFIG_PATH);

    const oldDates = ['2021-11-03', '2022-03-03', '2024-01-08', '2025-10-06'];
    const recentDates = ['2026-08-11', '2026-08-07']; // 3 and 7 days before NOW

    const oldResults = oldDates.map((dateAdded, i) =>
      evaluateOverrides(
        insertAndFetch(db, kevItem({ cveId: `CVE-OLD-${i}`, dateAdded, fetchedAt: NOW })),
        'signal',
        NOW,
        config,
      ),
    );
    const recentResults = recentDates.map((dateAdded, i) =>
      evaluateOverrides(
        insertAndFetch(db, kevItem({ cveId: `CVE-RECENT-${i}`, dateAdded, fetchedAt: NOW })),
        'signal',
        NOW,
        config,
      ),
    );

    expect(oldResults.every((r) => r.pinned === false)).toBe(true);
    expect(recentResults.every((r) => r.pinned === true)).toBe(true);
  });

  // The scale claim itself, stated as an assertion: if every one of the
  // real corpus's 1,665 cisa-kev entries were replayed through today's
  // override config on a cold start, only the 23 added within 30 days of
  // NOW would pin -- not 1,665. This test doesn't replay all 1,665 rows
  // (slow, and the shape is already proven above); it fixes the CLAIM as a
  // number so a future change to config/overrides.yaml's recency_bound_days
  // shows up as a reviewable, explained diff here rather than a silent
  // ranking change.
  it('the shipped recency_bound_days is 30 for cisa-kev-catalog (23 of 1,665 real entries would qualify)', () => {
    const config = loadOverridesConfig(REAL_CONFIG_PATH);
    const kevRule = config.overrides.find((r) => r.id === 'cisa-kev-catalog');
    expect(kevRule?.kind).toBe('source_match');
    if (kevRule?.kind === 'source_match') {
      expect(kevRule.recency_bound_days).toBe(30);
    }
  });
});
