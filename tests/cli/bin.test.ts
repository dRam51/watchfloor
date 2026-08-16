import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';
import { closeDb, openDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { createFixtureVault, digestTree, listTree } from '../vault/fixture.ts';

/**
 * The `watchfloor` CLI, run as a real process (M5 task 12).
 *
 * **No mocks.** A composition root is exactly the thing a unit test cannot
 * check, and this CLI exists because two complete, fully-tested modules
 * (`src/vault/verify.ts`, `src/vault/prune.ts`) had no way to be run at all —
 * occurrence six of the defect M4a named. So every test here spawns the
 * entrypoint `npm run watchfloor` spawns and reads what it actually printed
 * and exited with.
 *
 * Every run gets its own temp working directory, its own migrated SQLite file,
 * and an explicitly-constructed environment. `WF_VAULT_ROOT` is only ever a
 * `mkdtemp` fixture, so nothing here can reach the owner's twelve real
 * hand-authored notes even by accident — which matters more in this file than
 * anywhere else in the project, because one of these commands deletes.
 */

const execFileAsync = promisify(execFile);
const REPO = process.cwd();
const ENTRYPOINT = join('src', 'bin', 'watchfloor.ts');
const VAULT_ENTRYPOINT = join('src', 'bin', 'vault.ts');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function envFor(cwd: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: cwd,
    WF_DB_PATH: 'wf.db',
    WF_TZ: 'America/New_York',
    WF_API_TOKEN: 'test-token-for-the-cli-test',
    ...extra,
  };
}

async function run(
  entrypoint: string,
  cwd: string,
  args: readonly string[],
  extra: Record<string, string> = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [join(REPO, entrypoint), ...args],
      { cwd, env: envFor(cwd, extra) },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const cli = (cwd: string, args: readonly string[], extra: Record<string, string> = {}) =>
  run(ENTRYPOINT, cwd, args, extra);

/** A temp working directory holding a fully migrated, empty database. */
function workspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'wf-cli-'));
  const db = openDb(join(cwd, 'wf.db'));
  runMigrations(db, join(REPO, 'db', 'migrations'));
  closeDb(db);
  return cwd;
}

/** A mounted vault whose sync root is empty: nothing for verify to report. */
function emptyVault(): string {
  const anchor = mkdtempSync(join(tmpdir(), 'wf-clean-vault-'));
  writeFileSync(join(anchor, 'VAULT-INDEX.md'), '# Vault index\n');
  const root = join(anchor, 'Watchfloor');
  mkdirSync(root);
  return root;
}

const MANAGED_NOTE =
  '---\nwatchfloor: managed\nwatchfloor_tier: fully-managed\n' +
  'watchfloor_generated_at: 2026-08-15T23:59:59.999Z\n---\n\n# A note\n';

/**
 * A crash leftover: `atomicWrite`'s temp name, our frontmatter, naming no
 * note that exists, and old enough that no sync could be mid-write on it.
 */
function plantCrashLeftover(root: string, name = '2026-08-01.md'): string {
  const relPath = join('daily', `.watchfloor-tmp-${name}.4242.0`);
  const full = join(root, relPath);
  writeFileSync(full, MANAGED_NOTE);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(full, twoHoursAgo, twoHoursAgo);
  return relPath.split(sep).join('/');
}

// ---------------------------------------------------------------------------

describe('the npm script and the entrypoint agree', () => {
  it('package.json runs the file this test spawns', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.watchfloor).toBe(
      `node --env-file=.env ${ENTRYPOINT.split(sep).join('/')}`,
    );
  });
});

describe('watchfloor --help', () => {
  it('with no command at all, prints help on stderr and exits 1', async () => {
    // Asking and not asking deserve different codes: an empty invocation is a
    // usage error, and a script that runs `watchfloor` with an unset variable
    // should not look like a success.
    const result = await cli(workspace(), []);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('vault verify');
    expect(result.stdout).toBe('');
  });

  it('when asked for, prints help on stdout and exits 0', async () => {
    const result = await cli(workspace(), ['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('vault verify');
    expect(result.stdout).toContain('vault prune');
    expect(result.stderr).toBe('');
  });

  it('lists the delegated entrypoints it discovered on disk', async () => {
    const result = await cli(workspace(), ['--help']);
    for (const name of ['ingest', 'score', 'scheduler', 'suggest']) {
      expect(result.stdout).toContain(name);
    }
  });

  it('refuses an unknown command rather than guessing', async () => {
    const result = await cli(workspace(), ['frobnicate']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('frobnicate');
  });
});

describe('watchfloor vault verify', () => {
  it('exits 1 when no vault is configured — there is no answer, not a clean one', async () => {
    // The asymmetry with `vault sync`, which exits 0 in the same state and is
    // right to. Sync is an instruction with nothing to do; verify is a
    // question about a vault that is not there, and 0 would assert a clean
    // bill of health for it.
    const result = await cli(workspace(), ['vault', 'verify']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('WF_VAULT_ROOT');
  });

  it('exits 1 on an unmounted vault, and creates no shadow tree', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'wf-gone-'));
    const root = join(parent, 'not-mounted', 'watchfloor');
    const result = await cli(workspace(), ['vault', 'verify'], { WF_VAULT_ROOT: root });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('anchor_missing');
    expect(existsSync(join(parent, 'not-mounted'))).toBe(false);
  });

  it('exits 0 on a vault with nothing to say about it', async () => {
    const result = await cli(workspace(), ['vault', 'verify'], { WF_VAULT_ROOT: emptyVault() });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('0 finding');
  });

  it('exits 2 on the fixture vault, and names the real findings', async () => {
    // The fixture models the worst case: the owner's twelve hand-authored
    // notes sitting directly in the sync root, plus files a human dropped
    // inside managed areas. Those are `info` and `warning` respectively, and
    // the difference is the whole severity argument.
    const vault = createFixtureVault();
    const result = await cli(workspace(), ['vault', 'verify'], { WF_VAULT_ROOT: vault.root });

    expect(result.code).toBe(2);
    expect(result.stdout).toContain('hand_authored');
    expect(result.stdout).toContain('foreign_in_managed_area');
    expect(result.stdout).toContain('Architecture.md');
  });

  it('writes nothing — the vault is byte-identical afterwards', async () => {
    const vault = createFixtureVault();
    const before = digestTree(vault.anchor);
    await cli(workspace(), ['vault', 'verify'], { WF_VAULT_ROOT: vault.root });
    expect(digestTree(vault.anchor)).toEqual(before);
  });

  it('--json emits the report the exit code was computed from', async () => {
    const vault = createFixtureVault();
    const result = await cli(workspace(), ['vault', 'verify', '--json'], {
      WF_VAULT_ROOT: vault.root,
    });
    const report = JSON.parse(result.stdout) as {
      mounted: boolean;
      findings: { code: string; severity: string }[];
    };
    expect(report.mounted).toBe(true);
    expect(report.findings.map((f) => f.code)).toContain('hand_authored');
    expect(result.code).toBe(2);
  });

  it('refuses --fix, and says why there is no repair path', async () => {
    const result = await cli(workspace(), ['vault', 'verify', '--fix'], {
      WF_VAULT_ROOT: emptyVault(),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--fix');
  });
});

describe('watchfloor vault prune — the destructive path is two deliberate steps', () => {
  it('deletes nothing by default, and says what it would remove', async () => {
    // THE test in this file. A default that deleted would be one typo away
    // from the standing rule this whole project is built on.
    const vault = createFixtureVault();
    const leftover = plantCrashLeftover(vault.root);
    const before = digestTree(vault.anchor);

    const result = await cli(workspace(), ['vault', 'prune'], { WF_VAULT_ROOT: vault.root });

    expect(result.code).toBe(2);
    expect(result.stdout).toContain('dry run');
    expect(result.stdout).toContain(leftover);
    expect(digestTree(vault.anchor)).toEqual(before);
  });

  it('refuses --apply on its own', async () => {
    const vault = createFixtureVault();
    plantCrashLeftover(vault.root);
    const before = digestTree(vault.anchor);

    const result = await cli(workspace(), ['vault', 'prune', '--apply'], {
      WF_VAULT_ROOT: vault.root,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--expect');
    expect(digestTree(vault.anchor)).toEqual(before);
  });

  it('refuses --apply when the count disagrees, and shows both numbers', async () => {
    // Not ceremony: the count is a claim about a tree the operator has seen.
    // If it changed in between, the claim is stale and nothing is deleted.
    const vault = createFixtureVault();
    plantCrashLeftover(vault.root);
    const before = digestTree(vault.anchor);

    const result = await cli(workspace(), ['vault', 'prune', '--apply', '--expect=7'], {
      WF_VAULT_ROOT: vault.root,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('7');
    expect(result.stderr).toContain('1');
    expect(digestTree(vault.anchor)).toEqual(before);
  });

  it('removes exactly the leftover when the count agrees', async () => {
    const vault = createFixtureVault();
    const leftover = plantCrashLeftover(vault.root);
    const before = digestTree(vault.anchor);

    const result = await cli(workspace(), ['vault', 'prune', '--apply', '--expect=1'], {
      WF_VAULT_ROOT: vault.root,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('removed 1');
    expect(existsSync(join(vault.root, leftover))).toBe(false);

    // And nothing else moved: the twelve hand-authored notes, the hand-written
    // entity note, the saved/ note, and everything outside the sync root.
    const after = digestTree(vault.anchor);
    before.delete(join('Watchfloor', leftover));
    expect(after).toEqual(before);
  });

  it('exits 0 with nothing to do', async () => {
    const result = await cli(workspace(), ['vault', 'prune'], { WF_VAULT_ROOT: emptyVault() });
    expect(result.code).toBe(0);
  });

  it('exits 1 on an unmounted vault rather than reporting an empty tidy-up', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'wf-gone-prune-'));
    const result = await cli(workspace(), ['vault', 'prune'], {
      WF_VAULT_ROOT: join(parent, 'not-mounted', 'watchfloor'),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not mounted');
  });

  it('exits 1 when no vault is configured', async () => {
    const result = await cli(workspace(), ['vault', 'prune']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('WF_VAULT_ROOT');
  });

  it('--help does not prune, even with --apply on the same line', async () => {
    const vault = createFixtureVault();
    plantCrashLeftover(vault.root);
    const before = digestTree(vault.anchor);

    const result = await cli(
      workspace(),
      ['vault', 'prune', '--apply', '--expect=1', '--help'],
      { WF_VAULT_ROOT: vault.root },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--expect');
    expect(digestTree(vault.anchor)).toEqual(before);
  });
});

describe('watchfloor vault sync — the same run npm run vault has always done', () => {
  it('writes the managed areas', async () => {
    const vault = createFixtureVault();
    const result = await cli(workspace(), ['vault', 'sync'], { WF_VAULT_ROOT: vault.root });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('watchfloor vault sync starting');
    const written = listTree(vault.root);
    expect(written.some((p) => /^daily[/\\]\d{4}-\d{2}-\d{2}\.md$/.test(p))).toBe(true);
  });

  it('is reachable from src/bin/vault.ts too, which is what npm run vault runs', async () => {
    // The old entrypoint keeps its name and gains the other two commands
    // rather than staying the sync-only dead end task 9 flagged.
    const result = await run(VAULT_ENTRYPOINT, workspace(), ['verify'], {
      WF_VAULT_ROOT: emptyVault(),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('finding');
  });
});

describe('delegation — the other entrypoints are spawned, never reimplemented', () => {
  it('runs the real migration entrypoint, side effect and all', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wf-cli-unmigrated-'));
    const result = await cli(cwd, ['migrate']);

    expect(result.code).toBe(0);
    expect(existsSync(join(cwd, 'wf.db'))).toBe(true);

    // And the CLI did not become the thing that applies migrations: a second
    // command against the same file now finds nothing pending.
    const again = await cli(cwd, ['migrate']);
    expect(again.code).toBe(0);
  });

  it("propagates the child's exit code and its stderr verbatim", async () => {
    // src/bin/score.ts refuses to boot with pending migrations. If the CLI
    // swallowed either half, an unattended run would look successful.
    const cwd = mkdtempSync(join(tmpdir(), 'wf-cli-pending-'));
    const result = await cli(cwd, ['score']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('npm run migrate');
  });

  it('passes flags through untouched, including ones this CLI also has', async () => {
    // `--json` means something in src/bin/suggest.ts. This layer must not
    // read it, or the two interfaces drift the first time either changes.
    const result = await cli(workspace(), ['suggest', '--json']);
    expect(result.code).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it('names the entrypoint it looked for when a command does not exist', async () => {
    const result = await cli(workspace(), ['nosuchentrypoint']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('nosuchentrypoint');
  });
});
