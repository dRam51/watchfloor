import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { VAULT_TEMP_PREFIX } from '../../src/vault/session.ts';
import { buildAlternatingNotes } from './atomicityFixture.ts';
import { createFixtureVault } from './fixture.ts';

/**
 * Atomic writes (M5 plan, Global Constraints):
 *
 * > A half-written daily note in a synced vault propagates to every device.
 * > Write to a temp file in the same directory, then rename.
 *
 * ## Why this file exists at all
 *
 * Measured, not assumed: with `atomicWrite` replaced by a plain
 * `writeFileSync(target, content)`, **all 157 tests in the other four vault
 * test files pass.** Every rule about containment, frontmatter, tiers and caps
 * is still enforced, and the file still ends up with the right bytes once the
 * call returns — so nothing that checks the file *afterwards* can tell the
 * difference. Torn state is only observable while a write is in flight, which
 * means it needs a reader running concurrently with a writer. That is the
 * whole design of the test below, and it is the same lesson M5 task 2 recorded
 * about its own naive first attempt.
 *
 * ## No mocks
 *
 * A real second process writes through the real `openVaultSession` path, this
 * process reads the same file thousands of times, and the writer is then
 * SIGKILLed mid-write. Nothing is stubbed; the only thing constructed is a
 * temp-directory vault.
 */

const BODY_BYTES = 2 * 1024 * 1024;
const CHILD_PATH = join(import.meta.dirname, 'writerChild.ts');
const REL_PATH = 'daily/2026-08-15.md';

type Observation = 'A' | 'B' | 'absent' | 'torn';

function classify(target: string, a: string, b: string): Observation {
  let text: string;
  try {
    text = readFileSync(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw err;
  }
  if (text === a) return 'A';
  if (text === b) return 'B';
  return 'torn';
}

describe('a torn file is a real, observable state — the negative control', () => {
  // Deterministic, in-process, and exactly what `writeFileSync` does
  // internally: opening with 'w' TRUNCATES, so between the truncate and the
  // last byte the file on disk is short. A reader in that window — and
  // iCloud's sync daemon is such a reader — sees a prefix and propagates it.
  it('a truncating write is observably incomplete partway through', () => {
    const { root } = createFixtureVault();
    const target = join(root, 'daily', 'torn-demo.md');
    const [a] = buildAlternatingNotes(1024);

    const fd = openSync(target, 'w');
    try {
      writeSync(fd, a.slice(0, 100));
      const midWrite = readFileSync(target, 'utf8');
      expect(midWrite).not.toBe(a);
      expect(a.startsWith(midWrite)).toBe(true); // a prefix: the torn state
      writeSync(fd, a.slice(100));
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(target, 'utf8')).toBe(a);
  });
});

describe('the production write path, under a concurrent reader', () => {
  it(
    'is never observed half-written, and survives being killed mid-write',
    async () => {
      const { root } = createFixtureVault();
      const target = join(root, ...REL_PATH.split('/'));
      const [a, b] = buildAlternatingNotes(BODY_BYTES);

      const child = spawn(
        process.execPath,
        [CHILD_PATH, root, REL_PATH, String(BODY_BYTES), '6000'],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      // A synchronous poll loop is right here: the writer is a separate
      // process, so blocking this event loop does not slow it down, and it
      // gives the tightest possible read cadence.
      const counts: Record<Observation, number> = { A: 0, B: 0, absent: 0, torn: 0 };
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        counts[classify(target, a, b)] += 1;
      }

      child.kill('SIGKILL');
      await once(child, 'exit');

      expect(stderr, 'the child must not have errored').toBe('');

      // Non-vacuity: the reader must actually have watched the writer work.
      // Without this, a child that died instantly would pass trivially.
      expect(counts.A + counts.B, 'reader saw no complete note at all').toBeGreaterThan(10);
      expect(
        Math.min(counts.A, counts.B),
        'reader never saw the file change, so it never read during a write',
      ).toBeGreaterThan(0);

      expect(counts.torn, 'a half-written note was observable on disk').toBe(0);

      // And after a SIGKILL landing somewhere in the middle of a write, the
      // note is still one of the two complete values — never a prefix.
      expect(['A', 'B']).toContain(classify(target, a, b));
    },
    30_000,
  );

  it('scatters nothing into the directory while writing, only prefixed temp files', async () => {
    const { root } = createFixtureVault();
    const dailyDir = join(root, 'daily');
    const target = join(root, ...REL_PATH.split('/'));
    const [a, b] = buildAlternatingNotes(BODY_BYTES);

    const child = spawn(process.execPath, [CHILD_PATH, root, REL_PATH, String(BODY_BYTES), '6000'], {
      stdio: 'ignore',
    });

    // Sampled DURING the writes, which is the only time a temp file exists.
    const seen = new Set<string>();
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      for (const name of readdirSync(dailyDir)) seen.add(name);
      classify(target, a, b);
    }
    child.kill('SIGKILL');
    await once(child, 'exit');
    for (const name of readdirSync(dailyDir)) seen.add(name);

    // The fixture's hand-authored note, the target, and nothing else that is
    // not a recognisable, prune-able temp file. A writer that fell back to
    // some other scratch name would be invisible to `vault prune` (task 9).
    const unexpected = [...seen].filter(
      (name) =>
        name !== 'Scratch.md' &&
        name !== '2026-08-15.md' &&
        !name.startsWith(VAULT_TEMP_PREFIX),
    );
    expect(unexpected).toEqual([]);
    expect(seen.has('Scratch.md'), 'the hand-authored note is still there').toBe(true);

    // Leftover temp files after a kill are EXPECTED and are not cleaned up
    // here: CLAUDE.md's never-delete rule applies with special force to vault
    // code, and `vault prune` (task 9) is the one job allowed to remove
    // anything. They are dot-prefixed so Obsidian ignores them.
    for (const name of [...seen].filter((n) => n.startsWith(VAULT_TEMP_PREFIX))) {
      expect(name.startsWith('.')).toBe(true);
    }
  }, 30_000);
});
