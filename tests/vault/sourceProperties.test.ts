import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  findForbiddenCalls,
  findVaultCallersTouchingFs,
  importsNodeFs,
  importsVaultPackage,
  type SourceFile,
} from '../../src/vault/sourceRules.ts';

/**
 * Two properties of the SOURCE TREE, not of any one function.
 *
 * The M5 task brief: *"Nothing in Waves 2–4 may call `fs` directly — make that
 * a property you can check, and check it."* A rule that is only written down
 * is a rule the fifth task in a wave forgets at 1am.
 *
 * ## Why the negative control is the important half
 *
 * Nothing under `src/` imports `src/vault/` yet, so the headline rule is
 * VACUOUSLY true today — and M4a's post-mortem is explicit about what that is
 * worth: *"A test literally named 'only uses source types that have a
 * registered M1 adapter' passed throughout, because no source used the type."*
 *
 * So each rule below is checked three ways: the detector is exercised against
 * synthetic input that must trip it, the scan is run WITHOUT its exemption and
 * must flag real files in this repository (proving it read the tree at all),
 * and only then is the real rule asserted.
 */

const SRC = 'src';
const VAULT_DIR = join('src', 'vault');

function collectSources(dir: string): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push({ path: full, text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(dir);
  return files;
}

const ALL_SOURCES = collectSources(SRC);
const VAULT_SOURCES = ALL_SOURCES.filter((f) => f.path.startsWith(VAULT_DIR));

describe('the scan actually reads this repository', () => {
  it('finds a substantial number of source files', () => {
    // A broken walker returning [] would make every rule below pass.
    expect(ALL_SOURCES.length).toBeGreaterThan(50);
  });

  it('finds the vault package', () => {
    const names = VAULT_SOURCES.map((f) => relative(VAULT_DIR, f.path)).sort();
    expect(names).toContain('session.ts');
    expect(names).toContain('paths.ts');
    expect(names).toContain('mount.ts');
    expect(names).toContain('frontmatter.ts');
  });
});

describe('importsNodeFs / importsVaultPackage — the detectors themselves', () => {
  it.each([
    "import { readFileSync } from 'node:fs';",
    "import { readFile } from 'node:fs/promises';",
    "import fs from 'fs';",
    "const fs = require('node:fs');",
    'const { writeFileSync } = await import("node:fs");',
  ])('detects fs access in %o', (line) => {
    expect(importsNodeFs(line)).toBe(true);
  });

  it.each([
    "import { openVaultSession } from '../vault/session.ts';",
    "import { openVaultSession } from './vault/index.ts';",
    "import type { VaultPath } from '../../vault/paths.ts';",
  ])('detects a vault import in %o', (line) => {
    expect(importsVaultPackage(line)).toBe(true);
  });

  it('does not mistake unrelated words for either', () => {
    expect(importsNodeFs("import { x } from './fsm.ts';")).toBe(false);
    expect(importsVaultPackage("// the vault is on iCloud Drive")).toBe(false);
    expect(importsVaultPackage("import { x } from './vaulting.ts';")).toBe(false);
  });
});

describe('nothing outside src/vault/ may write to the vault directly', () => {
  it('flags a synthetic future module that imports both', () => {
    const synthetic: SourceFile[] = [
      {
        path: join('src', 'vault-sync', 'daily.ts'),
        text: "import { writeFileSync } from 'node:fs';\nimport { openVaultSession } from '../vault/index.ts';\n",
      },
    ];
    expect(findVaultCallersTouchingFs(synthetic, [VAULT_DIR]).map((f) => f.path)).toEqual([
      join('src', 'vault-sync', 'daily.ts'),
    ]);
  });

  // The non-vacuity proof: run the same scan with NO exemption and it must
  // flag files that really exist here. If this ever returns [], the scan is
  // broken and the assertion below means nothing.
  it('flags src/vault/session.ts itself when the exemption is removed', () => {
    const flagged = findVaultCallersTouchingFs(ALL_SOURCES, []).map((f) => f.path);
    expect(flagged).toContain(join(VAULT_DIR, 'session.ts'));
  });

  it('finds no violation in the tree as it stands', () => {
    expect(findVaultCallersTouchingFs(ALL_SOURCES, [VAULT_DIR]).map((f) => f.path)).toEqual([]);
  });
});

describe('the vault package deletes nothing and never creates a directory chain', () => {
  it('flags a synthetic module that deletes or mkdir -p s', () => {
    const synthetic: SourceFile[] = [
      { path: 'a.ts', text: 'rmSync(target);\n' },
      { path: 'b.ts', text: "unlinkSync(temp);\n" },
      { path: 'c.ts', text: 'mkdirSync(root, { recursive: true });\n' },
      { path: 'd.ts', text: 'await rm(dir, { recursive: true, force: true });\n' },
      { path: 'e.ts', text: 'rmdirSync(dir);\n' },
    ];
    // Unique paths: `d.ts` trips two rules at once, which is correct.
    const flagged = [...new Set(findForbiddenCalls(synthetic).map((v) => v.path))].sort();
    expect(flagged).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
  });

  it('does not flag the ordinary calls this package really makes', () => {
    const ok: SourceFile[] = [
      { path: 'ok.ts', text: 'mkdirSync(dir);\nrenameSync(temp, target);\nlinkSync(temp, t);\n' },
    ];
    expect(findForbiddenCalls(ok)).toEqual([]);
  });

  // CLAUDE.md: "Never delete anything [...] Same standard applies inside any
  // script written here." The M5 plan: "This applies with special force to
  // vault code: `vault prune` is the one job allowed to remove anything."
  it('finds no delete and no recursive mkdir anywhere in src/vault/', () => {
    expect(findForbiddenCalls(VAULT_SOURCES)).toEqual([]);
  });
});

describe('the package presents one door', () => {
  it('re-exports the write session from src/vault/index.ts', async () => {
    const barrel = await import('../../src/vault/index.ts');
    expect(typeof barrel.openVaultSession).toBe('function');
    expect(typeof barrel.renderManagedNote).toBe('function');
    expect(typeof barrel.checkVaultMount).toBe('function');
    expect(typeof barrel.resolveVaultPath).toBe('function');
  });
});
