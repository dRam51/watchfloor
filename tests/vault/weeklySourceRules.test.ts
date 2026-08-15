import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findForbiddenCalls,
  findVaultCallersTouchingFs,
  importsNodeFs,
  type SourceFile,
} from '../../src/vault/sourceRules.ts';

/**
 * **The rule that is supposed to cover this module does not cover it.**
 *
 * `tests/vault/sourceProperties.test.ts` asserts that nothing importing
 * `src/vault/` also imports `node:fs` — and exempts `src/vault/` itself,
 * correctly, because that is the package allowed to touch the filesystem.
 * `src/vault/weekly.ts` lives inside that prefix, so the milestone's headline
 * safety property is **silent about it**: a `writeFileSync` added here would
 * pass every existing test in the suite.
 *
 * That is the M4a shape exactly — *"a test literally named 'only uses source
 * types that have a registered M1 adapter' passed throughout, because no source
 * used the type"*. So the exemption is closed here, for this file, explicitly.
 *
 * The detectors themselves are `src/vault/sourceRules.ts`'s and already have
 * their own synthetic-input tests; this file only points them at one module.
 */

const WEEKLY_PATH = join('src', 'vault', 'weekly.ts');

function weeklySource(): SourceFile {
  return { path: WEEKLY_PATH, text: readFileSync(WEEKLY_PATH, 'utf8') };
}

describe('src/vault/weekly.ts', () => {
  it('is inside the prefix the fs rule exempts, which is why this file exists', () => {
    // If this ever stops being true, the general rule covers the module and
    // this file becomes redundant rather than load-bearing. Worth knowing.
    expect(findVaultCallersTouchingFs([weeklySource()], ['src/vault'])).toEqual([]);
  });

  it('does not import node:fs', () => {
    const source = weeklySource();
    // Non-vacuity: the detector must fire on a file that does.
    expect(importsNodeFs(readFileSync(join('src', 'vault', 'session.ts'), 'utf8'))).toBe(true);
    expect(importsNodeFs(source.text)).toBe(false);
  });

  it('contains none of the forbidden calls', () => {
    // `rm`, `unlink`, `rmdir`, and `recursive: true` -- CLAUDE.md's never-delete
    // rule, plus the one call that fabricates an iCloud shadow tree.
    expect(findForbiddenCalls([weeklySource()])).toEqual([]);
  });

  it('reaches the vault only through the session', () => {
    const { text } = weeklySource();
    // The only vault modules it may import: the write session, the path
    // resolver's types, and the frontmatter producer. Notably NOT `index.ts`,
    // which three siblings are editing concurrently.
    const vaultImports = [...text.matchAll(/from '\.\/([A-Za-z]+)\.ts'/g)].map((m) => m[1]);
    expect([...new Set(vaultImports)].sort()).toEqual(['frontmatter', 'session']);
  });
});
