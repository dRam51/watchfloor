import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeDb, openDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, type Beat, type NewItem } from '../../src/domain/item.ts';
import { loadSourcesFile } from '../../src/sources/load.ts';
import { loadRankDepsFromConfigFiles } from '../../src/score/rank.ts';
import { loadInterestsFile } from '../../src/interests/load.ts';
import { createOllamaBackend } from '../../src/enrich/llm/ollama.ts';
import type { LlmConfig } from '../../src/enrich/llm/config.ts';
import { openVaultSession } from '../../src/vault/session.ts';
import {
  loadVaultSyncDeps,
  resolveVaultTarget,
  runVaultSync,
  type VaultSyncDeps,
} from '../../src/vault/sync.ts';
import {
  createFixtureVault,
  digestTree,
  listTree,
  HAND_AUTHORED_IN_MANAGED_PATH,
  HAND_AUTHORED_NOTES,
} from './fixture.ts';
import { WIN32K_GROUP } from './corpus.ts';

/**
 * The composition that turns four note writers into a run (M5 task 15).
 *
 * **No mocks.** Real temp-file SQLite carrying real corpus rows, a real
 * fixture vault carrying the owner's twelve real hand-authored filenames, and
 * — for the weekly note's blurbs — a real TCP address with nothing listening
 * on it. That last one is not a stand-in for Ollama being down; it *is* Ollama
 * being down, which is the configuration on any host without the daemon
 * running and the one this pass has to survive.
 *
 * The vault under test is always a `mkdtemp` directory. `WF_VAULT_ROOT` is
 * never read from the real environment here: every call takes an explicit env
 * object, so no test can reach the owner's twelve real notes even by accident.
 */

const TZ = 'UTC';
const NOW = '2026-08-15T14:00:00.000Z'; // Saturday, ISO week 2026-W33

const openDbs: Array<ReturnType<typeof openDb>> = [];
afterEach(() => {
  while (openDbs.length) closeDb(openDbs.pop()!);
});

function migratedDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  openDbs.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}

/** An address nothing is listening on — Ollama not running, honestly. */
async function deadAddress(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected AddressInfo');
  const url = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return url;
}

function llmConfig(baseUrl: string): LlmConfig {
  return {
    backend: 'ollama',
    limits: { timeoutMs: 2000, maxPromptChars: 24000, maxResponseBytes: 1048576, maxOutputTokens: 512 },
    ollama: { baseUrl, model: 'llama3.2', temperature: 0, keepAlive: '5m' },
  };
}

function deps(db: ReturnType<typeof openDb>, baseUrl: string, tz = TZ): VaultSyncDeps {
  const root = process.cwd();
  const sources = loadSourcesFile(join(root, 'config', 'sources.yaml'));
  const rank = loadRankDepsFromConfigFiles(
    join(root, 'config', 'decay.yaml'),
    join(root, 'config', 'overrides.yaml'),
  );
  return {
    db,
    tz,
    daily: {
      tz,
      decayConfig: rank.decayConfig,
      overridesConfig: rank.overridesConfig,
      sources,
      interests: loadInterestsFile(join(root, 'config', 'interests.yaml')),
    },
    weekly: {
      rank,
      sourceKinds: new Map(sources.map((s) => [s.id, s.kind ?? null])),
      enrichment: {
        db,
        backend: createOllamaBackend(llmConfig(baseUrl)),
        defaults: { maxOutputTokens: 512, temperature: 0 },
        policy: { ceiling: { dailyTokens: 250000, unmeteredCallTokens: 6500 }, cache: { version: 1 } },
        tz,
      },
    },
  };
}

/** Two real KEV rows, scored, so the daily note has something to rank. */
function seed(db: ReturnType<typeof openDb>): void {
  for (const row of WIN32K_GROUP.slice(0, 2)) {
    const item: NewItem = {
      url: row.canonicalUrl,
      canonicalUrl: row.canonicalUrl,
      title: row.title,
      sourceId: row.sourceId,
      itemType: 'event',
      beats: [...row.beats] as Beat[],
      entities: [],
      publishedAt: row.publishedAt,
      fetchedAt: '2026-08-14T18:38:50.262Z',
      summaryRaw: row.summaryRaw,
      rawJson: '{}',
    };
    const inserted = insertItem(db, item);
    db.prepare(
      `insert into item_scores (score_id, item_id, beat, signal_score, read_score, scorer_version, computed_at)
       values (?,?,?,?,?,?,?)`,
    ).run(randomUUID(), inserted.item_id, 'cyber', 0.5, 0.4, 'test-v0', '2026-08-14T19:00:00.000Z');
  }
}

describe('resolveVaultTarget — three states, and only one of them is an error', () => {
  it('reports not_configured when WF_VAULT_ROOT is unset — the shipped configuration', () => {
    expect(resolveVaultTarget({}).status).toBe('not_configured');
  });

  it('reports not_configured for a blank value, never a path relative to the repo', () => {
    // An empty string would resolve against the process working directory,
    // which is this repository — a sync that "succeeded" into ./daily/.
    expect(resolveVaultTarget({ WF_VAULT_ROOT: '   ' }).status).toBe('not_configured');
  });

  it('reports ready for a mounted vault, without creating anything', () => {
    const vault = createFixtureVault();
    const before = listTree(vault.anchor);
    const target = resolveVaultTarget({ WF_VAULT_ROOT: vault.root });
    expect(target.status).toBe('ready');
    expect(listTree(vault.anchor)).toEqual(before);
  });

  it('reports unmounted with a reason AND a remedy, and creates no shadow tree', () => {
    const parent = mkdtempSync(join(tmpdir(), 'wf-gone-'));
    const root = join(parent, 'not-mounted', 'watchfloor');
    const target = resolveVaultTarget({ WF_VAULT_ROOT: root });
    if (target.status !== 'unmounted') throw new Error(`expected unmounted, got ${target.status}`);
    expect(target.refusal.reason).toBe('anchor_missing');
    // A refusal with no remedy gets routed around, so the remedy is asserted.
    expect(target.refusal.remedy.length).toBeGreaterThan(20);
    // The failure this whole guard exists for: mkdir -p would have "worked".
    expect(existsSync(join(parent, 'not-mounted'))).toBe(false);
  });
});

describe('runVaultSync — the run, against a real vault and a real corpus', () => {
  it('writes all three managed areas and reports what it wrote', async () => {
    const db = migratedDb();
    seed(db);
    const vault = createFixtureVault();
    const session = openVaultSession(vault.root);

    const report = await runVaultSync(session, deps(db, await deadAddress()), { now: NOW });

    expect(report.date).toBe('2026-08-15');
    expect(report.week.label).toBe('2026-W33');
    expect(report.daily?.relPath).toBe('daily/2026-08-15.md');
    expect(report.weekly?.relPath).toBe('weekly/2026-W33.md');
    expect(existsSync(join(vault.root, 'daily', '2026-08-15.md'))).toBe(true);
    expect(existsSync(join(vault.root, 'weekly', '2026-W33.md'))).toBe(true);
    expect(report.refusals).toEqual([]);
  });

  it('leaves every hand-authored note byte-identical', async () => {
    const db = migratedDb();
    seed(db);
    const vault = createFixtureVault();
    const before = digestTree(vault.anchor);

    await runVaultSync(openVaultSession(vault.root), deps(db, await deadAddress()), { now: NOW });

    const after = digestTree(vault.anchor);
    for (const [name] of HAND_AUTHORED_NOTES) {
      const key = join('Watchfloor', name);
      expect(after.get(key), name).toBe(before.get(key));
    }
    // Including the one a human dropped inside a FULLY-MANAGED directory.
    const scratch = join('Watchfloor', HAND_AUTHORED_IN_MANAGED_PATH);
    expect(after.get(scratch)).toBe(before.get(scratch));
  });

  it('never writes outside the sync root', async () => {
    const db = migratedDb();
    seed(db);
    const vault = createFixtureVault();
    const before = listTree(vault.anchor).filter((p) => !p.startsWith('Watchfloor'));

    await runVaultSync(openVaultSession(vault.root), deps(db, await deadAddress()), { now: NOW });

    expect(listTree(vault.anchor).filter((p) => !p.startsWith('Watchfloor'))).toEqual(before);
  });

  it('writes only what it was asked for', async () => {
    const db = migratedDb();
    seed(db);
    const vault = createFixtureVault();

    const report = await runVaultSync(openVaultSession(vault.root), deps(db, await deadAddress()), {
      now: NOW,
      work: { daily: true, weekly: false, entities: false },
    });

    expect(report.daily).not.toBeNull();
    expect(report.weekly).toBeNull();
    expect(report.entities).toBeNull();
    expect(report.attempted).toEqual({ daily: true, weekly: false, entities: false });
    expect(existsSync(join(vault.root, 'weekly'))).toBe(false);
  });

  it('collects a per-area refusal instead of abandoning the run', async () => {
    // A hand-authored note sitting where today's daily note goes. §8.1: never
    // modify a file lacking Watchfloor frontmatter — so `daily/` is refused,
    // and the weekly note must still be written.
    const db = migratedDb();
    seed(db);
    const vault = createFixtureVault();
    const session = openVaultSession(vault.root);
    writeFileSync(join(vault.root, 'daily', '2026-08-15.md'), '# Mine\n\nHand written.\n');

    const report = await runVaultSync(session, deps(db, await deadAddress()), { now: NOW });

    expect(report.daily).toBeNull();
    expect(report.refusals.map((r) => `${r.area}/${r.reason}`)).toEqual(['daily/not_managed']);
    expect(report.weekly).not.toBeNull();
    // Untouched, which is the rule that matters.
    expect(readFileSync(join(vault.root, 'daily', '2026-08-15.md'), 'utf8')).toBe(
      '# Mine\n\nHand written.\n',
    );
  });

  it('derives the day and the week from WF_TZ, never the host zone', async () => {
    const db = migratedDb();
    seed(db);
    const vault = createFixtureVault();
    // 02:00 UTC on Sunday the 16th is 22:00 Saturday the 15th in New York, and
    // still ISO week 33 there. A host-zone read would file both notes wrong.
    const report = await runVaultSync(
      openVaultSession(vault.root),
      deps(db, await deadAddress(), 'America/New_York'),
      { now: '2026-08-16T02:00:00.000Z' },
    );
    expect(report.date).toBe('2026-08-15');
    expect(report.daily?.relPath).toBe('daily/2026-08-15.md');
  });

  it('produces a weekly note even with no model reachable', async () => {
    // §8.1's artifact is the week's reading, and a week where Ollama was down
    // is still a week with reading in it.
    const db = migratedDb();
    seed(db);
    const vault = createFixtureVault();
    const report = await runVaultSync(openVaultSession(vault.root), deps(db, await deadAddress()), {
      now: NOW,
    });
    expect(report.weekly?.write.created).toBe(true);
    expect(report.weekly?.blurbs.generated).toBe(0);
  });

  it('reports entities honestly when item_entities is empty', async () => {
    // Nothing populates `item_entities` (M5 task 7's finding: 0 rows across
    // 7,267 live items). The run must say "nothing to write", not fail.
    const db = migratedDb();
    seed(db);
    const vault = createFixtureVault();
    const report = await runVaultSync(openVaultSession(vault.root), deps(db, await deadAddress()), {
      now: NOW,
    });
    expect(report.entities).not.toBeNull();
    expect(report.entities?.written).toEqual([]);
    expect(report.entities?.stopped).toBeNull();
  });
});

describe('loadVaultSyncDeps — one composition, so two entrypoints cannot drift', () => {
  it('builds every dependency from the repo config files', () => {
    const db = migratedDb();
    const built = loadVaultSyncDeps({ repoRoot: process.cwd(), db, tz: 'America/New_York' });

    // The zone is threaded to every consumer, not just the first one.
    expect(built.tz).toBe('America/New_York');
    expect(built.daily.tz).toBe('America/New_York');
    expect(built.weekly.enrichment.tz).toBe('America/New_York');

    // Real config, not defaults: every configured source is classifiable.
    const sources = loadSourcesFile(join(process.cwd(), 'config', 'sources.yaml'));
    expect(built.daily.sources.length).toBe(sources.length);
    expect(built.weekly.sourceKinds.size).toBe(sources.length);

    // The backend comes from config/llm.yaml — never a literal in src/.
    expect(built.weekly.enrichment.backend.name).toBe('ollama');
    expect(built.weekly.enrichment.backend.model.length).toBeGreaterThan(0);
    expect(built.weekly.enrichment.policy.ceiling.dailyTokens).toBeGreaterThan(0);
  });

  it('gives the daily note and the weekly note the SAME decay and overrides', () => {
    // Two loads of the same file would drift the moment one call site is
    // edited; the ranking behind the two notes has to be one decision.
    const db = migratedDb();
    const built = loadVaultSyncDeps({ repoRoot: process.cwd(), db, tz: TZ });
    expect(built.daily.decayConfig).toBe(built.weekly.rank.decayConfig);
    expect(built.daily.overridesConfig).toBe(built.weekly.rank.overridesConfig);
  });
});
