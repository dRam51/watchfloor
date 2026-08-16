import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverDelegatedCommands, renderHelp } from '../../src/cli/help.ts';

/**
 * Help text, and the command list it is built from (M5 task 12).
 *
 * The list is **discovered from `src/bin/` rather than written down**, and that
 * is the interesting design decision in this file. A hand-maintained table of
 * commands is the exact shape of this project's characteristic defect: it
 * compiles, it is tested, and it silently stops describing reality the day
 * someone adds an entrypoint. `src/bin/*.ts` is already the complete list of
 * ways this system can be started (`tests/vault/wiring.test.ts` rests on the
 * same fact), so the CLI reads it instead of duplicating it.
 */

function binDirWith(names: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'wf-bin-fixture-'));
  for (const name of names) writeFileSync(join(dir, name), '// entrypoint\n');
  return dir;
}

describe('the command list is discovered, not written down', () => {
  it('lists every entrypoint in the directory, sorted', () => {
    const dir = binDirWith(['score.ts', 'ingest.ts', 'migrate.ts']);
    expect(discoverDelegatedCommands(dir, '.ts').map((c) => c.name)).toEqual([
      'ingest',
      'migrate',
      'score',
    ]);
  });

  it('lists an entrypoint nobody told it about', () => {
    // The property that matters: a future `src/bin/mcp.ts` is reachable from
    // the CLI the moment it lands, with no edit to this package and no test
    // going red in the session that adds it.
    const dir = binDirWith(['ingest.ts', 'somethingnewentirely.ts']);
    expect(discoverDelegatedCommands(dir, '.ts').map((c) => c.name)).toContain(
      'somethingnewentirely',
    );
  });

  it('excludes the CLI itself and the vault group', () => {
    // Both would be loops. `watchfloor` is this program, and `vault` is
    // handled in this process — src/bin/vault.ts routes back into the CLI, so
    // delegating to it would spawn processes until the OS said no.
    const dir = binDirWith(['watchfloor.ts', 'vault.ts', 'ingest.ts']);
    expect(discoverDelegatedCommands(dir, '.ts').map((c) => c.name)).toEqual(['ingest']);
  });

  it('ignores files that are not entrypoints of the right kind', () => {
    const dir = binDirWith(['ingest.ts', 'README.md', 'notes.txt', 'ingest.js']);
    expect(discoverDelegatedCommands(dir, '.ts').map((c) => c.name)).toEqual(['ingest']);
  });

  it('carries a description for the entrypoints that exist today', () => {
    const dir = binDirWith(['ingest.ts', 'somethingnewentirely.ts']);
    const found = discoverDelegatedCommands(dir, '.ts');
    expect(found.find((c) => c.name === 'ingest')?.description).toBeTruthy();
    // And an unknown one is listed with an honest blank rather than omitted —
    // omitting it would make the help lie about what the CLI can run.
    expect(found.find((c) => c.name === 'somethingnewentirely')?.description).toBeNull();
  });
});

describe('against the real src/bin', () => {
  const real = discoverDelegatedCommands(join('src', 'bin'), '.ts');
  const names = real.map((c) => c.name);

  it('finds the operational surface', () => {
    for (const name of ['migrate', 'ingest', 'score', 'rank', 'suggest', 'api', 'scheduler']) {
      expect(names, `${name} is not reachable from the CLI`).toContain(name);
    }
  });

  it('does not offer to spawn the vault group', () => {
    expect(names).not.toContain('vault');
  });

  it('has a description for every one of them', () => {
    // Not a discovery property — a curation one. This goes red when an
    // entrypoint is added, which is a prompt to describe it, not a failure to
    // run it: the command already works, undescribed.
    for (const command of real) {
      expect(command.description, `src/bin/${command.name}.ts has no description`).not.toBeNull();
    }
  });
});

describe('--help is actually useful', () => {
  const commands = discoverDelegatedCommands(join('src', 'bin'), '.ts');
  const root = renderHelp('root', commands);

  it('names the two commands §8.1 asks for by name', () => {
    expect(root).toContain('vault verify');
    expect(root).toContain('vault prune');
  });

  it('says how to run it through npm, which is how it is actually invoked', () => {
    expect(root).toContain('npm run watchfloor --');
  });

  it('documents the exit codes, because they are a contract', () => {
    expect(root).toMatch(/\b0\b/);
    expect(root).toContain('could not run');
    expect(root).toContain('found');
  });

  it('lists the delegated commands with what they do', () => {
    expect(root).toContain('scheduler');
    expect(root).toContain('suggest');
  });

  it('warns about prune at the top level, not only in its own help', () => {
    // The one command in this system permitted to delete should not be
    // discoverable without its safety story attached.
    expect(root).toContain('dry run');
  });

  it('tells the prune reader exactly how to delete, and that it is two steps', () => {
    const prune = renderHelp('vault prune', commands);
    expect(prune).toContain('--expect');
    expect(prune).toContain('--apply');
    expect(prune).toContain('dry run');
    // And what it will never touch, at any setting.
    expect(prune).toContain('saved/');
    expect(prune).toContain('entities/');
  });

  it('tells the verify reader that there is no repair path', () => {
    const verify = renderHelp('vault verify', commands);
    expect(verify).toContain('never');
    expect(verify.toLowerCase()).toContain('report');
  });

  it('says what sync writes and what it never regenerates', () => {
    const sync = renderHelp('vault sync', commands);
    expect(sync).toContain('daily/');
    expect(sync).toContain('weekly/');
    expect(sync).toContain('entities/');
    expect(sync).toContain('saved/');
  });

  it('every topic renders something a person could read', () => {
    for (const topic of ['root', 'vault', 'vault sync', 'vault verify', 'vault prune'] as const) {
      const text = renderHelp(topic, commands);
      expect(text.length, topic).toBeGreaterThan(120);
      expect(text.startsWith('\n'), topic).toBe(false);
      expect(text.endsWith('\n'), topic).toBe(true);
    }
  });
});
