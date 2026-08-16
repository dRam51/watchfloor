import { describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readVaultText,
  removeVaultFile,
  scanVaultTree,
  VaultAccessError,
  VaultRemoveError,
  VAULT_TEMP_PREFIX,
} from '../../src/vault/session.ts';
import { renderManagedNote } from '../../src/vault/frontmatter.ts';
import {
  createFixtureVault,
  digestTree,
  HAND_AUTHORED_IN_MANAGED_PATH,
  HAND_AUTHORED_NOTES,
} from './fixture.ts';

/**
 * The READ primitives the safety layer grew for M5 task 9 (`vault verify` and
 * `vault prune`).
 *
 * Neither of those two modules may import the filesystem — the rule in
 * `tests/vault/sourceProperties.test.ts` covers every module in the package
 * except `mount.ts`, `paths.ts` and `session.ts` — so the traversal they need
 * has to be a primitive here, next to the writer whose leftovers they inspect.
 *
 * The property that matters most is the one about SYMLINKS: verify walks a
 * directory the owner can put anything into, and a symlink pointing at
 * `02 Career/Resume.md` must not turn a read-only audit into a read of the
 * owner's wider vault.
 */

describe('scanVaultTree', () => {
  it('returns every file under the sync root, relative to it', () => {
    const vault = createFixtureVault();
    const found = scanVaultTree(vault.root)
      .filter((entry) => entry.kind === 'file')
      .map((entry) => entry.relPath);

    for (const [name] of HAND_AUTHORED_NOTES) expect(found).toContain(name);
    expect(found).toContain('entities/Anthropic.md');
    expect(found).toContain('daily/Scratch.md');
  });

  it('never leaves the sync root — the anchor is not walked', () => {
    const vault = createFixtureVault();
    const found = scanVaultTree(vault.root).map((entry) => entry.relPath);

    // Real siblings the fixture puts in the vault next to the sync root.
    expect(found.some((rel) => rel.includes('Resume'))).toBe(false);
    expect(found.some((rel) => rel.includes('VAULT-INDEX'))).toBe(false);
    expect(found.some((rel) => rel.includes('.obsidian'))).toBe(false);
  });

  it('reports a symlink as a symlink and does not follow it', () => {
    const vault = createFixtureVault();
    symlinkSync(join(vault.anchor, '02 Career'), join(vault.root, 'daily', 'elsewhere'));

    const found = scanVaultTree(vault.root);
    const link = found.find((entry) => entry.relPath === 'daily/elsewhere');

    expect(link?.kind).toBe('symlink');
    // Following it would list the owner's `02 Career/Resume.md` under our root.
    expect(found.some((entry) => entry.relPath.includes('Resume'))).toBe(false);
  });

  it('answers with an empty list when the sync root does not exist', () => {
    // M5 acceptance deletes the whole tree; verify must survive that state.
    const vault = createFixtureVault();
    expect(scanVaultTree(join(vault.anchor, 'never-created'))).toEqual([]);
  });

  it('reports the hard-link count, which is how a saved twin is recognised', () => {
    const vault = createFixtureVault();
    const dir = join(vault.root, 'saved');
    writeFileSync(join(dir, 'one.md'), 'x\n');
    mkdirSync(join(vault.root, 'weekly'));

    const single = scanVaultTree(vault.root).find((e) => e.relPath === 'saved/one.md');
    expect(single?.nlink).toBe(1);
  });
});

describe('readVaultText', () => {
  it('reads a file inside the sync root', () => {
    const vault = createFixtureVault();
    expect(readVaultText(vault.root, 'entities/Anthropic.md')).toContain('# Anthropic');
  });

  it('answers null for a file that is not there', () => {
    const vault = createFixtureVault();
    expect(readVaultText(vault.root, 'daily/2026-08-15.md')).toBeNull();
  });

  it('reads a dot-prefixed temp file — the one `resolveVaultPath` cannot express', () => {
    // This is why a second resolver exists. `atomicWrite` names its temp files
    // with a leading dot, and `resolveVaultPath` refuses every dot-prefixed
    // segment, so the files prune exists to remove are unaddressable through
    // the write path.
    const vault = createFixtureVault();
    const temp = `${VAULT_TEMP_PREFIX}2026-08-15.md.4321.0`;
    writeFileSync(join(vault.root, 'daily', temp), 'half a note');

    expect(readVaultText(vault.root, `daily/${temp}`)).toBe('half a note');
  });

  // `toThrow(SomeClass)` is not enough here: while the function did not exist,
  // every one of these "passed" on the TypeError from calling `undefined`.
  // Asserting the machine-readable reason makes the test fail for anything but
  // the refusal it names.
  function refusalReason(fn: () => unknown): string {
    try {
      fn();
    } catch (err) {
      if (err instanceof VaultAccessError) return err.reason;
      throw err;
    }
    throw new Error('expected a VaultAccessError, nothing was thrown');
  }

  it.each([
    ['a parent traversal', '../Architecture.md', 'parent_traversal'],
    ['a parent traversal through an area', 'daily/../../Architecture.md', 'parent_traversal'],
    ['a NUL byte', 'daily/x\0.md', 'nul_byte'],
    ['a backslash', 'daily\\x.md', 'backslash'],
    ['an empty segment', 'daily//x.md', 'dot_segment'],
    ['a bare dot segment', 'daily/./x.md', 'dot_segment'],
    ['an empty path', '', 'empty'],
  ])('refuses %s', (_label, relPath, reason) => {
    const vault = createFixtureVault();
    expect(refusalReason(() => readVaultText(vault.root, relPath))).toBe(reason);
  });

  it('refuses an absolute path even when it names a file inside the root', () => {
    const vault = createFixtureVault();
    const absolute = join(vault.root, 'entities', 'Anthropic.md');
    expect(refusalReason(() => readVaultText(vault.root, absolute))).toBe('absolute');
  });

  it('refuses a path that leaves the root through a symlink', () => {
    const vault = createFixtureVault();
    symlinkSync(join(vault.anchor, '02 Career'), join(vault.root, 'daily', 'elsewhere'));

    // The owner's résumé really is readable at that path — the refusal has to
    // come from the containment check, not from the file being absent.
    expect(refusalReason(() => readVaultText(vault.root, 'daily/elsewhere/Resume.md'))).toBe(
      'escapes_root',
    );
  });

  // -------------------------------------------------------------------------
  // THE SIBLING-PREFIX CASE, and why it has its own test here.
  //
  // Task 4 found `startsWith` without a separator TWICE IN ONE DAY -- once in
  // `isContainedIn` and once in the source-rule exemption, where
  // `startsWith('src/vault')` also matched `src/vault-sync/`. This resolver is
  // the third place the same check exists, and an injected-defect run over
  // this suite found that replacing `isContainedIn` with a bare
  // `absolute.startsWith(rootReal)` here turned NOTHING red: every other
  // containment test uses paths that also fail the naive check.
  //
  // A vault genuinely has sibling directories sharing a name prefix -- an
  // `01 Tech Projects/Watchfloor-old` next to the sync root is exactly the
  // shape of an owner's backup.
  // -------------------------------------------------------------------------
  function vaultWithPrefixSibling() {
    const vault = createFixtureVault();
    const sibling = `${vault.root}-old`; // e.g. .../Watchfloor-old
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'Architecture.md'), '# Architecture\n\nLast year, by hand.\n');
    symlinkSync(sibling, join(vault.root, 'daily', 'elsewhere'));
    return vault;
  }

  it('refuses a sibling directory whose name merely starts with the root', () => {
    const vault = vaultWithPrefixSibling();
    expect(refusalReason(() => readVaultText(vault.root, 'daily/elsewhere/Architecture.md'))).toBe(
      'escapes_root',
    );
  });

  it('refuses to REMOVE anything in that sibling directory', () => {
    const vault = vaultWithPrefixSibling();
    const before = digestTree(`${vault.root}-old`);

    try {
      removeVaultFile(vault.root, 'daily/elsewhere/Architecture.md');
    } catch {
      // The assertion below is the one that matters.
    }
    expect(digestTree(`${vault.root}-old`)).toEqual(before);
  });
});

/**
 * The one delete in this repository.
 *
 * CLAUDE.md forbids deleting anything; the M5 plan carves out exactly one
 * exception — *"`vault prune` is the one job allowed to remove anything, it is
 * confined to `watchfloor/`"*. That confinement is enforced here, in the
 * safety layer, and not in `prune.ts`: the policy layer cannot import the
 * filesystem, so it cannot route around these gates even by accident.
 *
 * Four gates, and the first two are Task 4's, unchanged:
 *
 * 1. **Area.** The first segment must be one of the four §8.1 areas. The
 *    owner's `Architecture.md` sits directly in the sync root, so it is not
 *    "protected by a check" — there is no expressible request to delete it.
 * 2. **Containment**, after `..` and symlink resolution.
 * 3. **Regular file.** Never a directory, never a symlink.
 * 4. **Ours.** Either the name is one `atomicWrite` produced, or the bytes on
 *    disk carry Watchfloor frontmatter. §8.1's "never modify a file lacking
 *    Watchfloor frontmatter" — and a delete is the strongest modification
 *    there is.
 */
describe('removeVaultFile', () => {
  const GENERATED_AT = '2026-08-15T03:59:59.999Z';

  function managedNote(body: string): string {
    return renderManagedNote({ tier: 'fully-managed', generatedAt: GENERATED_AT, body });
  }

  // Two error types, deliberately: `VaultAccessError` is the containment gate
  // shared with the read primitives, `VaultRemoveError` is what only a delete
  // can violate. Collapsing them would mean re-declaring eight refusal reasons
  // in a second union to gain nothing — both carry the same machine-readable
  // `reason`, which is what a caller acts on.
  function removalRefusal(fn: () => unknown): string {
    try {
      fn();
    } catch (err) {
      if (err instanceof VaultRemoveError || err instanceof VaultAccessError) return err.reason;
      throw err;
    }
    throw new Error('expected a refusal, nothing was thrown');
  }

  it('removes a crash-leftover temp file inside a managed area', () => {
    const vault = createFixtureVault();
    const temp = `${VAULT_TEMP_PREFIX}2026-08-15.md.4321.0`;
    writeFileSync(join(vault.root, 'daily', temp), 'half a note');

    removeVaultFile(vault.root, `daily/${temp}`);

    expect(scanVaultTree(vault.root).some((e) => e.name === temp)).toBe(false);
  });

  it('removes a note carrying our own frontmatter', () => {
    const vault = createFixtureVault();
    writeFileSync(join(vault.root, 'daily', '2026-01-01.md'), managedNote('# Old\n'));

    removeVaultFile(vault.root, 'daily/2026-01-01.md');

    expect(readVaultText(vault.root, 'daily/2026-01-01.md')).toBeNull();
  });

  it('cannot be asked to delete a hand-authored note in the sync root', () => {
    // The AREA gate, which is the stronger of the two. `Architecture.md` is
    // exactly where WF_VAULT_ROOT would be pointed by mistake.
    const vault = createFixtureVault();
    const before = digestTree(vault.root);

    expect(removalRefusal(() => removeVaultFile(vault.root, 'Architecture.md'))).toBe(
      'unknown_area',
    );
    expect(digestTree(vault.root)).toEqual(before);
  });

  it('refuses a hand-authored note that is sitting INSIDE a managed area', () => {
    // `daily/Scratch.md` passes the area gate and must still survive: it has
    // no Watchfloor frontmatter, so it is not ours.
    const vault = createFixtureVault();
    const before = digestTree(vault.root);

    expect(removalRefusal(() => removeVaultFile(vault.root, HAND_AUTHORED_IN_MANAGED_PATH))).toBe(
      'foreign_file',
    );
    expect(digestTree(vault.root)).toEqual(before);
  });

  it('refuses to walk out of the root with a parent traversal', () => {
    const vault = createFixtureVault();
    const before = digestTree(vault.anchor);

    expect(removalRefusal(() => removeVaultFile(vault.root, 'daily/../../VAULT-INDEX.md'))).toBe(
      'parent_traversal',
    );
    expect(digestTree(vault.anchor)).toEqual(before);
  });

  it('refuses to leave the root through a symlinked directory', () => {
    const vault = createFixtureVault();
    symlinkSync(join(vault.anchor, '02 Career'), join(vault.root, 'daily', 'elsewhere'));
    const before = digestTree(join(vault.anchor, '02 Career'));

    expect(removalRefusal(() => removeVaultFile(vault.root, 'daily/elsewhere/Resume.md'))).toBe(
      'escapes_root',
    );
    expect(digestTree(join(vault.anchor, '02 Career'))).toEqual(before);
  });

  it('refuses a symlink, even one that is inside the root', () => {
    const vault = createFixtureVault();
    const managed = join(vault.root, 'daily', '2026-01-01.md');
    writeFileSync(managed, managedNote('# Old\n'));
    symlinkSync(managed, join(vault.root, 'daily', 'link.md'));

    expect(removalRefusal(() => removeVaultFile(vault.root, 'daily/link.md'))).toBe('not_a_file');
  });

  it('refuses a directory', () => {
    const vault = createFixtureVault();
    mkdirSync(join(vault.root, 'daily', 'archive'));

    expect(removalRefusal(() => removeVaultFile(vault.root, 'daily/archive'))).toBe('not_a_file');
  });

  it('refuses a file that is not there', () => {
    const vault = createFixtureVault();
    expect(removalRefusal(() => removeVaultFile(vault.root, 'daily/nothing.md'))).toBe('missing');
  });

  it('refuses a nested path: this package never creates a directory inside an area', () => {
    const vault = createFixtureVault();
    mkdirSync(join(vault.root, 'daily', 'archive'));
    writeFileSync(join(vault.root, 'daily', 'archive', 'old.md'), managedNote('# Old\n'));

    expect(removalRefusal(() => removeVaultFile(vault.root, 'daily/archive/old.md'))).toBe(
      'nested_path',
    );
  });
});
