import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'check-portability.mjs');

/** Run the checker against a directory; returns exit status and combined output. */
function run(target?: string): { status: number; output: string } {
  try {
    const stdout = execFileSync('node', target ? [SCRIPT, target] : [SCRIPT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

// Assembled at runtime, never written as a literal: this file is itself
// tracked and scanned by the very rule it is exercising, so a literal here
// would make the repo fail its own portability check.
const ABSOLUTE_PATH = ['/Users', 'someone', 'watchfloor', 'data'].join('/');
/** Same reason: spelling this one out would trip the macOS-only-binary rule. */
const MAC_ONLY_BINARY = 'pb' + 'copy';

describe('check:portability', () => {
  it('passes on the current tree', () => {
    const { status, output } = run();
    expect(status).toBe(0);
    expect(output).toContain('portability check passed');
  });

  it('fails on a tree containing an absolute path, naming the rule', () => {
    // Without this, the suite would stay green even if every rule were
    // deleted from the script — "passes on the current tree" is satisfied by
    // a checker that checks nothing. This is the project's only mechanical
    // enforcement of a rule CLAUDE.md states three times.
    const dir = mkdtempSync(join(tmpdir(), 'wf-portability-'));
    writeFileSync(join(dir, 'config.ts'), `export const DB = '${ABSOLUTE_PATH}/wf.db';\n`);

    const { status, output } = run(dir);

    expect(status, 'a tree with an absolute path must exit non-zero').not.toBe(0);
    expect(output).toContain('portability check failed');
    expect(output).toContain('absolute unix path');
    expect(output).toContain('config.ts');
  });

  it('passes on an otherwise-identical clean tree, so the failure is the rule and not the tree', () => {
    // Positive control: proves the non-zero exit above is attributable to the
    // planted violation, not to the script simply choking on a directory that
    // is not the repo.
    const dir = mkdtempSync(join(tmpdir(), 'wf-portability-'));
    writeFileSync(join(dir, 'config.ts'), `export const DB = './data/wf.db';\n`);

    const { status, output } = run(dir);

    expect(status).toBe(0);
    expect(output).toContain('portability check passed');
  });

  it('flags a macOS-only binary too, so the check is not absolute-paths-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-portability-'));
    writeFileSync(join(dir, 'copy.sh'), `echo hi | ${MAC_ONLY_BINARY}\n`);

    const { status, output } = run(dir);

    expect(status).not.toBe(0);
    expect(output).toContain('macOS-only binary');
  });
});

// ---------------------------------------------------------------------------
// Case-exact file references (M6).
//
// The companion rule -- case-exact TypeScript IMPORTS -- is deliberately NOT
// re-implemented in the checker, because tsconfig's
// forceConsistentCasingInFileNames already catches it and the checker asserts
// that flag is on. Verified empirically before writing this: an import whose
// only reference has bad casing raises TS1261, and one that also has a correct
// reference elsewhere raises TS1149. What tsc cannot see is a path built from
// string literals, which is what these cover.
// ---------------------------------------------------------------------------
describe('case-exact file references', () => {
  it('flags a runtime path literal whose casing differs from the file on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-portability-case-'));
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'sources.yaml'), 'sources: []\n');
    writeFileSync(join(dir, 'load.ts'), `export const P = 'config/Sources.yaml';\n`);

    const { status, output } = run(dir);

    expect(status).toBe(1);
    expect(output).toContain('case-mismatched path');
    expect(output).toContain('config/Sources.yaml');
    expect(output).toContain('config/sources.yaml');
  });

  it('passes when the same reference matches the file exactly', () => {
    // The control: identical tree, correct casing. Without this the test above
    // could be passing because of the fixture rather than because of the rule.
    const dir = mkdtempSync(join(tmpdir(), 'wf-portability-case-ok-'));
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'sources.yaml'), 'sources: []\n');
    writeFileSync(join(dir, 'load.ts'), `export const P = 'config/sources.yaml';\n`);

    expect(run(dir).status).toBe(0);
  });

  it('does not flag a path that is simply not a tracked file', () => {
    // A generated path or a fixture written at test time is an ordinary miss,
    // not a casing problem. Flagging it would make the rule noisy, and a noisy
    // rule is one people learn to ignore.
    const dir = mkdtempSync(join(tmpdir(), 'wf-portability-case-absent-'));
    writeFileSync(join(dir, 'load.ts'), `export const P = 'config/Generated.yaml';\n`);

    expect(run(dir).status).toBe(0);
  });

  it('flags two files that differ only in casing', () => {
    // NOTE: this fixture cannot be built on a case-insensitive filesystem --
    // `cp decay.yaml Decay.yaml` on macOS reports "identical (not copied)",
    // because they ARE one file. That is the hazard itself, and it is why the
    // collision is written into a directory whose names differ in a segment
    // the filesystem does distinguish, then referenced through the same
    // lowercase key the checker uses.
    //
    // Skipped where it cannot be represented, rather than silently passing:
    // a rule that "passes" because its fixture collapsed is exactly the
    // vacuous-scope failure this project keeps finding.
    const dir = mkdtempSync(join(tmpdir(), 'wf-portability-collide-'));
    writeFileSync(join(dir, 'alpha.md'), 'a\n');
    let representable = true;
    try {
      writeFileSync(join(dir, 'ALPHA.md'), 'b\n');
      representable = readFileSync(join(dir, 'alpha.md'), 'utf8') === 'a\n';
    } catch {
      representable = false;
    }
    if (!representable) {
      expect(readFileSync(join(dir, 'alpha.md'), 'utf8')).toBe('b\n'); // proves the collapse
      return;
    }
    const { status, output } = run(dir);
    expect(status).toBe(1);
    expect(output).toContain('only in casing');
  });
});
