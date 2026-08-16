import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * **The sixth-occurrence test.**
 *
 * Five times in this project a correctly-built, fully-tested component has
 * shipped with no caller: M3's `registerItems`, M4a's `github_search` adapter,
 * its star snapshots, its README enricher, and now the whole of `src/vault/`.
 * Every one was found by a live run rather than by a test, and M4a's
 * post-mortem names the reason:
 *
 * > It is not "write more unit tests." It is that a milestone is not done
 * > until it has been run against reality, and that every wave needs an
 * > explicit owner for the wiring.
 *
 * A live run is still the last word. But the *absence of a caller* is a
 * property of the source tree, and a property of the source tree can be
 * checked — which is what this file does, at the only altitude that catches
 * the defect: **is the symbol reachable from something a human or a supervisor
 * can actually start?**
 *
 * ## Why module reachability is not enough
 *
 * `github_search` was in the tree, exported, and its module was imported by
 * `src/adapters/index.ts`. What was missing was one key in a registry object
 * inside a composition root. So the question is not "is this file imported"
 * but "does anything on a path from `src/bin/*.ts` **use this name**". Both
 * halves are checked below, and the two of them together are what the M4a
 * defect would have failed.
 *
 * ## Why the roots are `src/bin/` and nothing else
 *
 * `package.json`'s scripts are the complete list of ways this system is
 * started, and each one runs a file in `src/bin/`. A symbol not reachable from
 * one of them cannot run, whatever else imports it — including a barrel that
 * re-exports it, which is exactly the shape that makes an unreachable module
 * look wired.
 */

const SRC = 'src';

interface Module {
  /** Repo-relative, POSIX-ish — `src/vault/daily.ts`. */
  readonly path: string;
  readonly text: string;
  /** Repo-relative paths of every relative import, resolved. */
  readonly imports: readonly string[];
}

/**
 * Every relative import specifier in a file. This project mandates explicit
 * `.ts` extensions, which is what makes resolution a `join` rather than a
 * search: there is no index-file guessing and no extension guessing to get
 * wrong.
 */
function relativeImports(file: string, text: string): string[] {
  const dir = dirname(file);
  const out: string[] = [];
  for (const m of text.matchAll(/from\s+'(\.[^']+\.ts)'/g)) {
    const spec = m[1];
    if (spec === undefined) continue;
    out.push(relative('.', resolve(dir, spec)));
  }
  return [...new Set(out)];
}

function loadModules(dir: string): Map<string, Module> {
  const modules = new Map<string, Module>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        const text = readFileSync(full, 'utf8');
        modules.set(full, { path: full, text, imports: relativeImports(full, text) });
      }
    }
  };
  walk(dir);
  return modules;
}

const MODULES = loadModules(SRC);

/** Every `src/bin/*.ts` — the complete set of ways this system is started. */
const ROOTS = [...MODULES.keys()].filter((p) => p.startsWith(join(SRC, 'bin'))).sort();

function reachableFrom(roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of MODULES.get(current)?.imports ?? []) {
      if (MODULES.has(next)) stack.push(next);
    }
  }
  return seen;
}

const REACHABLE = reachableFrom(ROOTS);

/**
 * Modules that name `symbol` as a call, excluding the one that defines it.
 *
 * A call rather than a mention: `symbol(` or `symbol (`, which a re-export in
 * a barrel does not match. That distinction is the whole point — a barrel
 * export is precisely the thing that makes an unreachable component look
 * wired.
 */
function callersOf(symbol: string, definedIn: string): string[] {
  const call = new RegExp(`\\b${symbol}\\s*\\(`);
  return [...MODULES.values()]
    .filter((m) => m.path !== definedIn && call.test(m.text))
    .map((m) => m.path)
    .sort();
}

interface Entrypoint {
  readonly symbol: string;
  readonly definedIn: string;
  /** What §8.1 loses if this one is unreachable. */
  readonly consequence: string;
}

/**
 * Every function in `src/vault/` that a run of the system must reach.
 *
 * Adding a note writer without adding a row here does not fail — but adding a
 * row and forgetting the wiring does, which is the direction this table exists
 * to constrain.
 */
const VAULT_ENTRYPOINTS: readonly Entrypoint[] = [
  {
    symbol: 'writeDailyNote',
    definedIn: join(SRC, 'vault', 'daily.ts'),
    consequence: '§8.1 daily/ is never written',
  },
  {
    symbol: 'syncWeeklyNote',
    definedIn: join(SRC, 'vault', 'weekly.ts'),
    consequence: '§8.1 weekly/ — "the artifact I care most about" — is never written',
  },
  {
    symbol: 'syncEntityNotes',
    definedIn: join(SRC, 'vault', 'entities.ts'),
    consequence: '§8.1 entities/ is never written',
  },
  {
    symbol: 'promoteSavedItem',
    definedIn: join(SRC, 'vault', 'saved.ts'),
    consequence: 'saving an item in the dashboard never reaches saved/',
  },
  // M5 task 12. Task 9 shipped both of these complete and tested, and ended
  // its report naming them as occurrence SIX of this project's characteristic
  // defect: "neither `verify` nor `prune` has a CLI caller." §8.1 asks for
  // `watchfloor vault verify` by name, so an unreachable verifyVault is not an
  // internal tidiness question — it is a named deliverable that cannot be run.
  {
    symbol: 'verifyVault',
    definedIn: join(SRC, 'vault', 'verify.ts'),
    consequence: '§8.1\'s `watchfloor vault verify` cannot be run at all',
  },
  {
    symbol: 'pruneVault',
    definedIn: join(SRC, 'vault', 'prune.ts'),
    consequence: 'the one job allowed to delete has no way to be invoked',
  },
];

describe('the scan reads this repository', () => {
  it('finds the source tree and every start-up entrypoint', () => {
    expect(MODULES.size).toBeGreaterThan(50);
    expect(ROOTS).toContain(join(SRC, 'bin', 'api.ts'));
    expect(ROOTS).toContain(join(SRC, 'bin', 'scheduler.ts'));
    expect(ROOTS).toContain(join(SRC, 'bin', 'ingest.ts'));
  });

  it('resolves relative imports to real modules', () => {
    // Non-vacuity for the graph itself: a resolver that returned nothing would
    // make REACHABLE = ROOTS and every assertion below meaningless.
    expect(REACHABLE.size).toBeGreaterThan(ROOTS.length * 3);
    expect(REACHABLE).toContain(join(SRC, 'api', 'server.ts'));
    expect(REACHABLE).toContain(join(SRC, 'scheduler', 'run.ts'));
  });

  it('detects a call but not a bare re-export', () => {
    // The distinction the whole file rests on, exercised directly.
    expect(/\bwriteDailyNote\s*\(/.test('export { writeDailyNote } from "./daily.ts";')).toBe(false);
    expect(/\bwriteDailyNote\s*\(/.test('  writeDailyNote(session, db, date, deps);')).toBe(true);
  });

  it('reports a symbol nothing calls as having no caller', () => {
    // The M4a shape, asserted against a name that genuinely has no caller, so
    // the rule below is known to be capable of failing.
    expect(callersOf('thisSymbolDoesNotExistAnywhere', 'nowhere.ts')).toEqual([]);
  });
});

describe('every vault entrypoint is reachable from a way of starting this system', () => {
  it.each(VAULT_ENTRYPOINTS)(
    '$symbol has a caller — otherwise $consequence',
    ({ symbol, definedIn }) => {
      expect(MODULES.has(definedIn), `${definedIn} must exist`).toBe(true);
      expect(callersOf(symbol, definedIn)).not.toEqual([]);
    },
  );

  it.each(VAULT_ENTRYPOINTS)(
    '$symbol is reachable from src/bin — otherwise $consequence',
    ({ symbol, definedIn }) => {
      // The half module reachability alone does not give: `github_search` was
      // in the tree, exported, and imported by a barrel. What was missing was
      // a key in a registry object inside a composition root.
      const reachableCallers = callersOf(symbol, definedIn).filter((p) => REACHABLE.has(p));
      expect(reachableCallers).not.toEqual([]);
    },
  );

  it('reaches the vault through BOTH entrypoints, not just the one-shot', () => {
    // M4a again, precisely: the daemon is the path that actually accumulates
    // state in production, and a hand-run `npm run ingest` looked identical
    // while covering 8 repos and stopping. A vault sync wired only into
    // src/bin/vault.ts would leave the daemon writing nothing, forever, with
    // every test green.
    for (const root of ['vault.ts', 'scheduler.ts']) {
      const reached = reachableFrom([join(SRC, 'bin', root)]);
      expect(reached, `src/bin/${root} does not reach the vault sync`).toContain(
        join(SRC, 'vault', 'sync.ts'),
      );
    }
  });

  it('drives the daemon from the cadence, not from a raw clock comparison', () => {
    // Structural, and deliberately so: the daemon's tick cannot be run in a
    // test (it polls 28 real sources), so what is pinned here is that its
    // vault work goes through the level-triggered slots rather than through
    // the two rules src/vault/cadence.ts exists to replace. A future edit that
    // reached for `getHours() === 18` would leave every other test green.
    const scheduler = MODULES.get(join(SRC, 'bin', 'scheduler.ts'))?.text ?? '';
    expect(scheduler).not.toBe('');
    for (const call of ['dueVaultWork(', 'advanceVaultSlots(', 'runVaultSync(']) {
      expect(scheduler, `src/bin/scheduler.ts does not call ${call}`).toContain(call);
    }
    // And it reads the zone from config, never from the host.
    expect(scheduler).toContain('env.WF_TZ');
    expect(scheduler).not.toMatch(/getHours\(\)|getDay\(\)|resolvedOptions\(\)/);
  });

  it('reaches saved-item promotion from the API, and only from the API', () => {
    // Promotion is an event on the save transition, never part of a sync pass:
    // a reconciliation pass cannot tell "never written" from "the owner
    // deleted it", and would rebuild what `saved/`'s never-regenerated rule
    // forbids. So the API must reach it and the sync entrypoints must not.
    const fromApi = reachableFrom([join(SRC, 'bin', 'api.ts')]);
    expect(fromApi).toContain(join(SRC, 'api', 'routes', 'items.ts'));
    expect(callersOf('promoteSavedItem', join(SRC, 'vault', 'saved.ts'))).toEqual([
      join(SRC, 'vault', 'sync.ts'),
    ]);
    for (const module of [join(SRC, 'bin', 'vault.ts'), join(SRC, 'bin', 'scheduler.ts')]) {
      expect(MODULES.get(module)?.text).not.toMatch(/\bpromoteSavedItem\w*\s*\(/);
    }
  });
});

describe('the barrel is the whole package, not a quarter of it', () => {
  it('exports every entrypoint Wave 2 built', async () => {
    const barrel = await import('../../src/vault/index.ts');
    for (const { symbol } of VAULT_ENTRYPOINTS) {
      expect(typeof (barrel as Record<string, unknown>)[symbol], symbol).toBe('function');
    }
  });

  it('exports the reads and the renders each writer is paired with', async () => {
    const barrel = await import('../../src/vault/index.ts') as Record<string, unknown>;
    for (const symbol of [
      'buildDailyNote',
      'dailyNoteInstant',
      'selectWeeklyReading',
      'renderWeeklyNote',
      'weeklyNoteRelPath',
      'weeklyNoteInstant',
      'isoWeekOf',
      'planEntityNotes',
      'renderEntityBlock',
      'entityNoteRelPath',
      'readSavedItem',
      'renderSavedNote',
      'savedNotePath',
    ]) {
      expect(typeof barrel[symbol], symbol).toBe('function');
    }
  });

  it('re-exports every module in the package', () => {
    // A module added to src/vault/ and not added to the barrel is the same
    // defect one level down: it compiles, it is tested, and the one door into
    // the package does not mention it.
    const barrelText = readFileSync(join(SRC, 'vault', 'index.ts'), 'utf8');
    const modules = readdirSync(join(SRC, 'vault'))
      .filter((name) => name.endsWith('.ts') && name !== 'index.ts')
      // sourceRules.ts is a test helper that happens to live here: it describes
      // the package rather than being part of its surface.
      .filter((name) => name !== 'sourceRules.ts');
    expect(modules.length).toBeGreaterThan(4);
    for (const name of modules) {
      expect(barrelText, `${name} is not re-exported by the barrel`).toContain(`from './${name}'`);
    }
  });
});
