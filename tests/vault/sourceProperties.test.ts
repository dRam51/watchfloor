import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import {
  auditForbiddenCalls,
  findForbiddenCalls,
  findVaultCallersTouchingFs,
  importsNodeFs,
  importsVaultPackage,
  VAULT_DELETE_ALLOWANCES,
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

  // ---------------------------------------------------------------------
  // The exemption above is the WHOLE `src/vault` directory, which means
  // every note-writing module inside it -- daily, weekly, entities, saved --
  // is exempt from the one rule that constrains them. That is backwards:
  // the point of the rule is that Task 4's safety layer is the ONLY code
  // allowed to touch the filesystem, and the note writers are precisely the
  // callers it exists to constrain. Task 6 spotted this and closed it for
  // `weekly.ts`; this closes it for the other three and states the
  // membership as a list, so a fifth note writer added later is covered by
  // default rather than by remembering.
  //
  // This is the same shape as M4a's "only uses source types that have a
  // registered M1 adapter" -- an assertion whose name described the exact
  // defect while its scope excluded the only files that could exhibit it.
  // See this file's own header, which cites that case.
  // ---------------------------------------------------------------------
  // `findVaultCallersTouchingFs` cannot express this rule, and finding out
  // why is the point. It requires importsVaultPackage(text) && importsNodeFs(text),
  // where importsVaultPackage looks for `vault/` in a specifier. A note writer
  // inside the package imports its siblings as './session.ts' -- no `vault/`
  // segment -- so it fails the first condition and is never flagged NO MATTER
  // WHAT IT IMPORTS. Narrowing the exemption from the directory to a file list
  // therefore changes nothing: the first version of this block did exactly
  // that, passed, and proved nothing.
  //
  // Inside the package the rule is simply "does it import fs", because these
  // files ARE the package -- there is no second condition to gate on.
  const SAFETY_LAYER = new Set(['mount.ts', 'paths.ts', 'session.ts']);

  function vaultModulesTouchingFs(files: readonly SourceFile[]): string[] {
    return files
      .filter((f) => f.path === VAULT_DIR || f.path.startsWith(`${VAULT_DIR}/`))
      .filter((f) => !SAFETY_LAYER.has(basename(f.path)))
      .filter((f) => importsNodeFs(f.text))
      .map((f) => f.path);
  }

  it('sees every note writer -- the non-vacuity proof for the rule below', () => {
    const scanned = ALL_SOURCES.filter((f) => f.path.startsWith(`${VAULT_DIR}/`))
      .filter((f) => !SAFETY_LAYER.has(basename(f.path)))
      .map((f) => f.path);
    for (const writer of ['daily.ts', 'weekly.ts', 'entities.ts', 'saved.ts']) {
      expect(scanned).toContain(join(VAULT_DIR, writer));
    }
  });

  it('detects fs in a note writer, so the rule below is not vacuous', () => {
    expect(
      vaultModulesTouchingFs([
        {
          path: join(VAULT_DIR, 'monthly.ts'),
          text: "import { writeFileSync } from 'node:fs';\nimport { openVaultSession } from './session.ts';\n",
        },
      ]),
    ).toEqual([join(VAULT_DIR, 'monthly.ts')]);
  });

  it('no note writer touches fs -- only the safety layer does', () => {
    expect(vaultModulesTouchingFs(ALL_SOURCES)).toEqual([]);
  });

  it('the safety layer really is the thing being exempted', () => {
    // If these three ever stop importing fs, the exemption list is stale and
    // this whole block is guarding nothing.
    const layer = ALL_SOURCES.filter((f) => SAFETY_LAYER.has(basename(f.path)))
      .filter((f) => f.path.startsWith(`${VAULT_DIR}/`))
      .filter((f) => importsNodeFs(f.text))
      .map((f) => basename(f.path))
      .sort();
    expect(layer).toEqual(['mount.ts', 'paths.ts', 'session.ts']);
  });

  // ---------------------------------------------------------------------
  // The remaining per-module check, generalised.
  //
  // "Does not import fs" is necessary but not sufficient: a note writer could
  // reach the filesystem indirectly by importing `paths.ts` or `mount.ts` and
  // using their primitives, or import the `index.ts` barrel and pull in
  // everything transitively. The property that actually holds today is
  // narrower and worth pinning -- a note writer talks to exactly two modules,
  // the frontmatter producer and the write session.
  //
  // tests/vault/weeklySourceRules.test.ts (M5 task 6) asserted this for
  // weekly.ts alone, when it was the only writer whose exemption had been
  // closed. Generalised here so a fifth note writer is covered on the day it
  // is added rather than on the day someone remembers to add a test file for
  // it. That file's other three assertions are now duplicated by the block
  // above; it is left in place rather than removed (CLAUDE.md: nothing is
  // deleted) and is harmless.
  // ---------------------------------------------------------------------
  const NOTE_WRITERS = ['daily.ts', 'weekly.ts', 'entities.ts', 'saved.ts'];
  const ALLOWED_SIBLINGS = ['frontmatter', 'session'];

  function siblingVaultImports(text: string): string[] {
    const names: string[] = [];
    // `m[1]` is `string | undefined` to tsc even though a match guarantees the
    // group -- filtered explicitly rather than asserted with `!`, so a regex
    // edit that drops the capture group fails loudly here instead of pushing
    // `undefined` into the comparison and quietly changing what is asserted.
    for (const m of text.matchAll(/from '\.\/([A-Za-z]+)\.ts'/g)) {
      const name = m[1];
      if (name !== undefined) names.push(name);
    }
    return [...new Set(names)].sort();
  }

  it('detects a writer reaching past the session, so the rule below is not vacuous', () => {
    expect(siblingVaultImports("import { x } from './paths.ts';\nimport { y } from './session.ts';")).toEqual([
      'paths',
      'session',
    ]);
  });

  it.each(NOTE_WRITERS)('%s reaches the vault only through frontmatter + session', (name) => {
    const file = ALL_SOURCES.find((f) => f.path === join(VAULT_DIR, name));
    // Non-vacuity: a typo in the name would otherwise make this pass on
    // `undefined` forever -- the exact shape of the M4a defect this file cites.
    expect(file, `${name} must exist to be checked`).toBeDefined();
    expect(siblingVaultImports(file!.text)).toEqual(ALLOWED_SIBLINGS);
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
  //
  // That last clause is what M5 task 9 cashes in, and it is the ONLY exception
  // in the project. `findForbiddenCalls` is left exactly as it was -- it still
  // finds the delete -- and the exception is expressed as a named allowance
  // instead, so the rule below reads "one delete, in one file, of one kind"
  // rather than "no delete". A second one anywhere goes red.
  it('finds no recursive mkdir, and no delete beyond the single sanctioned one', () => {
    const audit = auditForbiddenCalls(VAULT_SOURCES, VAULT_DELETE_ALLOWANCES);
    expect(audit.unsanctioned).toEqual([]);
  });

  it('the sanctioned delete really exists, exactly once, where the allowance says', () => {
    // Without this half, the allowance could name a file that no longer
    // deletes anything and the rule above would pass while guarding nothing --
    // and, worse, the allowance would silently cover a delete added there
    // later for some other reason.
    const audit = auditForbiddenCalls(VAULT_SOURCES, VAULT_DELETE_ALLOWANCES);
    expect(audit.sanctioned.map((c) => `${c.path}:${c.call}`)).toEqual([
      `${join(VAULT_DIR, 'session.ts')}:unlinkSync`,
    ]);
  });
});

describe('the sanctioned-delete allowance itself', () => {
  const files: SourceFile[] = [
    { path: join('src', 'vault', 'session.ts'), text: 'unlinkSync(target);\n' },
    { path: join('src', 'vault', 'prune.ts'), text: 'unlinkSync(target);\n' },
    { path: join('src', 'vault', 'session.ts.bak'), text: 'rmSync(target);\n' },
  ];

  it('covers the exact file and call it names, and nothing else', () => {
    const audit = auditForbiddenCalls(files, [
      { path: join('src', 'vault', 'session.ts'), call: 'unlinkSync' },
    ]);
    expect(audit.sanctioned.map((c) => c.path)).toEqual([join('src', 'vault', 'session.ts')]);
    expect(audit.unsanctioned.map((c) => c.path)).toEqual([
      join('src', 'vault', 'prune.ts'),
      join('src', 'vault', 'session.ts.bak'),
    ]);
  });

  it('does not cover a different call in the allowed file', () => {
    const audit = auditForbiddenCalls([{ path: 'a.ts', text: 'rmSync(x);\n' }], [
      { path: 'a.ts', call: 'unlinkSync' },
    ]);
    expect(audit.unsanctioned.map((c) => c.call)).toEqual(['rmSync']);
    expect(audit.sanctioned).toEqual([]);
  });

  it('does not cover the allowed call in a different file', () => {
    const audit = auditForbiddenCalls([{ path: 'b.ts', text: 'unlinkSync(x);\n' }], [
      { path: 'a.ts', call: 'unlinkSync' },
    ]);
    expect(audit.unsanctioned.map((c) => c.path)).toEqual(['b.ts']);
  });

  it('an allowance is not a wildcard: a second delete in the allowed file is still reported', () => {
    // One allowance, one occurrence. The primitive is a single call site, and
    // "the file may delete things" is a materially weaker rule than "this one
    // line may".
    const audit = auditForbiddenCalls(
      [{ path: 'a.ts', text: 'unlinkSync(x);\nunlinkSync(y);\n' }],
      [{ path: 'a.ts', call: 'unlinkSync' }],
    );
    expect(audit.sanctioned).toHaveLength(1);
    expect(audit.unsanctioned.map((c) => c.line)).toEqual([2]);
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
