import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
