import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';
import { closeDb, openDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { createFixtureVault, listTree } from './fixture.ts';

/**
 * `npm run vault`, run as a real process (M5 task 15).
 *
 * A composition root is exactly the thing a unit test cannot check. M4a's
 * `github_search` adapter compiled, was exported, had passing tests, and
 * failed at *poll* time because a registry key was missing in a file no task
 * owned — so this file spawns the entrypoint the npm script spawns and reads
 * what it actually printed and exited with.
 *
 * **No mocks, and no shared state with the developer's machine.** Every run
 * gets its own temp working directory, its own migrated SQLite file, and an
 * explicitly-constructed environment — `WF_VAULT_ROOT` is only ever a
 * `mkdtemp` fixture vault, so no test here can reach the owner's twelve real
 * hand-authored notes even by accident.
 *
 * The corpus is deliberately EMPTY. That is not laziness: with no items,
 * `selectWeeklyReading` produces no candidates and the pass makes zero LLM
 * calls, so this file neither needs Ollama running nor accidentally uses it if
 * it is. What is under test here is the wiring, and the wiring is identical.
 */

const execFileAsync = promisify(execFile);
const REPO = process.cwd();
const ENTRYPOINT = join('src', 'bin', 'vault.ts');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A curated environment: the child inherits PATH and nothing else that could
 * carry a real `WF_VAULT_ROOT` or a real database into the run.
 */
function envFor(cwd: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: cwd,
    WF_DB_PATH: 'wf.db',
    WF_TZ: 'America/New_York',
    WF_API_TOKEN: 'test-token-for-the-bin-test',
    ...extra,
  };
}

async function runVaultBin(cwd: string, extra: Record<string, string>): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [join(REPO, ENTRYPOINT)], {
      cwd,
      env: envFor(cwd, extra),
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** A temp working directory holding a fully migrated, empty database. */
function workspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'wf-bin-'));
  const db = openDb(join(cwd, 'wf.db'));
  runMigrations(db, join(REPO, 'db', 'migrations'));
  closeDb(db);
  return cwd;
}

describe('the npm script and the entrypoint agree', () => {
  it('package.json runs the file this test spawns', async () => {
    // The other half of the wiring: a src/bin/*.ts nobody can start is the
    // same defect as a function nobody calls. Read from package.json rather
    // than asserted from memory.
    const pkg = JSON.parse(
      readFileSync(join(REPO, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.vault).toBe(`node --env-file=.env ${ENTRYPOINT.split(sep).join('/')}`);
  });

  it('every src/bin entrypoint has an npm script', () => {
    // Non-vacuity for the assertion above, and a standing check: this found
    // nothing today, and it is the shape that would catch the next
    // unreachable entrypoint on the day it is added.
    const pkg = JSON.parse(
      readFileSync(join(REPO, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    const scripts = Object.values(pkg.scripts).join(' ');
    const bins = readdirSync(join(REPO, 'src', 'bin')).filter((f) => f.endsWith('.ts'));
    expect(bins.length).toBeGreaterThan(5);
    for (const bin of bins) {
      expect(scripts, `src/bin/${bin} has no npm script`).toContain(`src/bin/${bin}`);
    }
  });
});

describe('npm run vault — no vault configured is the SHIPPED configuration', () => {
  it('says so once and exits 0', async () => {
    // `.env` keeps WF_VAULT_ROOT commented out, so this is the common path. It
    // must be a clean no-op: not an error, not a stack trace, not silence.
    const run = await runVaultBin(workspace(), {});
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('WF_VAULT_ROOT is unset');
    expect(run.stderr).toBe('');
  });

  it('says it exactly once', async () => {
    const run = await runVaultBin(workspace(), {});
    expect(run.stdout.split('WF_VAULT_ROOT').length - 1).toBe(1);
  });

  it('does not even open the database', async () => {
    // No vault means no work, so a missing WF_DB_PATH must not be the error a
    // no-op reports. The workspace here is empty — no migrations, no file.
    const cwd = mkdtempSync(join(tmpdir(), 'wf-bin-nodb-'));
    const run = await runVaultBin(cwd, {});
    expect(run.code).toBe(0);
    expect(existsSync(join(cwd, 'wf.db'))).toBe(false);
  });
});

describe('npm run vault — a configured vault that is not mounted is LOUD', () => {
  it('exits 1, names the reason, and gives the remedy', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'wf-gone-'));
    const root = join(parent, 'not-mounted', 'watchfloor');
    const run = await runVaultBin(workspace(), { WF_VAULT_ROOT: root });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('anchor_missing');
    expect(run.stderr).toContain('not mounted');
    expect(run.stderr).toContain(root);
    // The failure the guard exists for: `mkdir -p` would have "succeeded" and
    // written into a local shadow tree that never syncs.
    expect(existsSync(join(parent, 'not-mounted'))).toBe(false);
  });
});

describe('npm run vault — a mounted vault', () => {
  it('writes all three areas and reports what it wrote', async () => {
    const vault = createFixtureVault();
    const run = await runVaultBin(workspace(), { WF_VAULT_ROOT: vault.root });

    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('watchfloor vault sync starting');
    expect(run.stdout).toMatch(/daily: {2}daily\/\d{4}-\d{2}-\d{2}\.md \(created/);
    expect(run.stdout).toMatch(/weekly: weekly\/\d{4}-W\d{2}\.md \(created/);
    expect(run.stdout).toContain('entities: 0 written');
    expect(run.stdout).toContain('file(s) written under');

    const written = listTree(vault.root);
    expect(written.some((p) => p.startsWith(join('daily', '')) && p.endsWith('.md'))).toBe(true);
    expect(written.some((p) => p.startsWith(join('weekly', '')))).toBe(true);
  });

  it('leaves the rest of the owners vault untouched', async () => {
    const vault = createFixtureVault();
    const before = listTree(vault.anchor).filter((p) => !p.startsWith('Watchfloor'));
    await runVaultBin(workspace(), { WF_VAULT_ROOT: vault.root });
    expect(listTree(vault.anchor).filter((p) => !p.startsWith('Watchfloor'))).toEqual(before);
  });

  it('is idempotent — a second run rewrites the same files and adds none', async () => {
    const vault = createFixtureVault();
    const cwd = workspace();
    await runVaultBin(cwd, { WF_VAULT_ROOT: vault.root });
    const afterFirst = listTree(vault.root);
    const second = await runVaultBin(cwd, { WF_VAULT_ROOT: vault.root });
    expect(second.code).toBe(0);
    expect(listTree(vault.root)).toEqual(afterFirst);
  });
});

describe('npm run vault — it refuses to boot with pending migrations', () => {
  it('names the pending migration rather than syncing against a stale schema', async () => {
    // Every other entrypoint does this (src/db/migrate.ts's
    // assertMigrationsUpToDate); a vault sync reading a half-migrated corpus
    // would write notes that are wrong in a place with no undo.
    const cwd = mkdtempSync(join(tmpdir(), 'wf-bin-unmigrated-'));
    const vault = createFixtureVault();
    const run = await runVaultBin(cwd, { WF_VAULT_ROOT: vault.root });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('npm run migrate');
    // And nothing was written into the vault before it gave up. (The fixture
    // ships a hand-authored `daily/Scratch.md`, so the check is for a NOTE —
    // `daily/YYYY-MM-DD.md` — not for an empty directory.)
    expect(listTree(vault.root).filter((p) => /^daily\/\d{4}-\d{2}-\d{2}\.md$/.test(p))).toEqual([]);
    expect(listTree(vault.root).filter((p) => p.startsWith('weekly'))).toEqual([]);
  });
});
