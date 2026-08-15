import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  isContainedIn,
  resolveVaultPath,
  vaultAreaOf,
  VaultPathError,
  VAULT_AREAS,
  type VaultArea,
} from '../../src/vault/paths.ts';

/**
 * Path containment is the first of §8.1's primitives: "Watchfloor owns exactly
 * one subtree and never writes outside it."
 *
 * The escape cases here are not hypothetical. `WF_VAULT_ROOT` is the one path
 * variable allowed to be absolute (src/config/env.ts), it points at a
 * directory inside the owner's Obsidian vault, and the sibling directories are
 * years of hand-written notes. A `..` that clamps instead of refusing is a
 * write into `02 Career/`.
 */

/**
 * Deliberately NOT realpath'd. On macOS `os.tmpdir()` is `/var/folders/...`,
 * and `/var` is itself a symlink to `/private/var` — so every temp root here
 * is a symlinked root, and the "resolves a symlinked ROOT" case below is
 * exercised by every other test in this file for free. Expectations therefore
 * compare against {@link realOf}, which is what a resolved path is.
 */
function tempRoot(name = 'wf-vault-'): string {
  return mkdtempSync(join(tmpdir(), name));
}

function realOf(p: string): string {
  return realpathSync(p);
}

describe('isContainedIn — the pure comparison, with no filesystem involved', () => {
  it('accepts a path under the root', () => {
    expect(isContainedIn('/vault/watchfloor', '/vault/watchfloor/daily/2026-08-15.md')).toBe(true);
  });

  // The classic prefix bug: `target.startsWith(root)` is true for a SIBLING
  // whose name merely begins with the root's name. `/vault/watchfloor-old` is
  // not inside `/vault/watchfloor`, and neither is the owner's real
  // `01 Tech Projects/Watchfloor Archive/`.
  it('rejects a sibling directory whose name starts with the root name', () => {
    expect(isContainedIn('/vault/watchfloor', '/vault/watchfloor-old/daily/x.md')).toBe(false);
  });

  it('rejects the root itself — the root is a directory, never a write target', () => {
    expect(isContainedIn('/vault/watchfloor', '/vault/watchfloor')).toBe(false);
  });

  it('rejects a parent of the root', () => {
    expect(isContainedIn('/vault/watchfloor', '/vault/Architecture.md')).toBe(false);
  });

  // macOS is case-insensitive; the target host may not be (CLAUDE.md §12).
  // Refusing is the safe direction: a caller that meant the real directory can
  // spell it the way the filesystem does.
  it('rejects a case-variant root rather than assuming case-insensitivity', () => {
    expect(isContainedIn('/vault/watchfloor', '/vault/WATCHFLOOR/daily/x.md')).toBe(false);
  });

  // An Obsidian vault on iCloud lives under `Mobile Documents/` and the
  // owner's subtree under `01 Tech Projects/` — both contain spaces, and a
  // comparison that tokenised on whitespace would break on the real path.
  it('handles roots containing spaces', () => {
    const root = '/a b/01 Tech Projects/Watchfloor';
    expect(isContainedIn(root, `${root}/daily/2026-08-15.md`)).toBe(true);
    expect(isContainedIn(root, '/a b/01 Tech Projects/Architecture.md')).toBe(false);
  });

  // macOS stores filenames in NFD; a path typed into `.env` or produced by
  // Node's path joining is NFC. The two are DIFFERENT STRINGS for the same
  // directory, so a byte comparison would report a contained path as an
  // escape — and a "just clamp it into the root" reaction to that false
  // alarm is how a containment check gets removed.
  it('treats NFC and NFD spellings of the same directory as the same directory', () => {
    const nfc = '/vault/Café'; // é as one code point
    const nfd = '/vault/Café'; // e + combining acute
    expect(nfc).not.toBe(nfd);
    expect(isContainedIn(nfc, `${nfd}/daily/x.md`)).toBe(true);
    expect(isContainedIn(nfd, `${nfc}/daily/x.md`)).toBe(true);
  });

  it('does not let unicode normalisation smuggle a path out of the root', () => {
    expect(isContainedIn('/vault/Café', '/vault/Cafo/daily/x.md')).toBe(false);
  });
});

describe('vaultAreaOf — Watchfloor addresses four directories and nothing else', () => {
  it('names exactly the four §8.1 areas', () => {
    expect([...VAULT_AREAS]).toEqual(['daily', 'weekly', 'entities', 'saved']);
  });

  it.each<[string, VaultArea]>([
    ['daily/2026-08-15.md', 'daily'],
    ['weekly/2026-W33.md', 'weekly'],
    ['entities/Anthropic.md', 'entities'],
    ['saved/2026-08-15-some-piece.md', 'saved'],
  ])('maps %s to the %s area', (rel, area) => {
    expect(vaultAreaOf(rel)).toBe(area);
  });

  // These are the owner's real hand-authored filenames, sitting directly in
  // the directory `WF_VAULT_ROOT` would most plausibly be pointed at by
  // mistake. There is no area for them, so there is no way to address them.
  it.each([
    'Architecture.md',
    'Open Questions.md',
    'Settled Decisions.md',
    'Standing Rules.md',
    'Portability Debt.md',
    'Source Inventory.md',
    'Plan Corrections.md',
    'Watchfloor.md',
    'Milestone 0 — Scaffold.md',
    'Milestone 3 — API and Dashboard.md',
  ])('has no area for the hand-authored note %s', (rel) => {
    expect(vaultAreaOf(rel)).toBeNull();
  });

  it('has no area for notes/, which §8.1 names explicitly', () => {
    expect(vaultAreaOf('notes/Something.md')).toBeNull();
  });
});

describe('resolveVaultPath — refuses, never clamps', () => {
  it('resolves a path inside a managed area', () => {
    const root = tempRoot();
    const resolved = resolveVaultPath(root, 'daily/2026-08-15.md');
    expect(resolved.absolute).toBe(join(realOf(root), 'daily', '2026-08-15.md'));
    expect(resolved.area).toBe('daily');
    expect(resolved.tier).toBe('fully-managed');
    expect(resolved.relPath).toBe('daily/2026-08-15.md');
  });

  it.each<[string, VaultArea, string]>([
    ['daily/2026-08-15.md', 'daily', 'fully-managed'],
    ['weekly/2026-W33.md', 'weekly', 'fully-managed'],
    ['entities/Anthropic.md', 'entities', 'managed-block'],
    ['saved/piece.md', 'saved', 'write-once'],
  ])('assigns %s the %s area and the %s tier', (rel, area, tier) => {
    const root = tempRoot();
    const resolved = resolveVaultPath(root, rel);
    expect(resolved.area).toBe(area);
    expect(resolved.tier).toBe(tier);
  });

  it('allows nesting inside an area', () => {
    const root = tempRoot();
    expect(resolveVaultPath(root, 'daily/2026/08/15.md').absolute).toBe(
      join(realOf(root), 'daily', '2026', '08', '15.md'),
    );
  });

  function expectRefusal(root: string, rel: string, reason: string): void {
    let thrown: unknown;
    try {
      resolveVaultPath(root, rel);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(VaultPathError);
    expect((thrown as VaultPathError).reason).toBe(reason);
  }

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['/etc/passwd', 'absolute'],
    ['/daily/x.md', 'absolute'],
    ['daily/x\0.md', 'nul_byte'],
    ['daily\\x.md', 'backslash'],
    ['..', 'parent_traversal'],
    ['../Architecture.md', 'parent_traversal'],
    ['daily/../../Architecture.md', 'parent_traversal'],
    ['daily/../../../../../../etc/passwd', 'parent_traversal'],
    ['daily/./x.md', 'dot_segment'],
    ['.', 'dot_segment'],
    ['daily/.obsidian/config.md', 'dot_segment'],
    ['Architecture.md', 'unknown_area'],
    ['notes/x.md', 'unknown_area'],
    ['Daily/x.md', 'unknown_area'],
    ['daily', 'unknown_area'],
    ['daily/x.txt', 'not_markdown'],
    ['daily/x', 'not_markdown'],
    ['saved/x.MD', 'not_markdown'],
  ])('refuses %o with reason %s', (rel, reason) => {
    expectRefusal(tempRoot(), rel, reason);
  });

  // §8.1's rule is "never writes outside it", not "writes wherever it can
  // reach". A `..` that resolved back inside would still be a caller asking
  // for something it should not be asking for.
  it('refuses a traversal even when it lands back inside the root', () => {
    expectRefusal(tempRoot(), 'daily/../weekly/x.md', 'parent_traversal');
  });
});

describe('resolveVaultPath — symlinks are resolved before the containment check', () => {
  it('refuses a directory symlink pointing outside the root', () => {
    const parent = tempRoot('wf-vault-parent-');
    const root = join(parent, 'watchfloor');
    const outside = join(parent, 'hand-authored');
    mkdirSync(root);
    mkdirSync(outside);
    mkdirSync(join(root, 'entities'));
    symlinkSync(outside, join(root, 'entities', 'escape'));

    let thrown: unknown;
    try {
      resolveVaultPath(root, 'entities/escape/Architecture.md');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(VaultPathError);
    expect((thrown as VaultPathError).reason).toBe('escapes_root');
  });

  it('refuses a file symlink pointing at a hand-authored note outside the root', () => {
    const parent = tempRoot('wf-vault-parent-');
    const root = join(parent, 'watchfloor');
    mkdirSync(root);
    mkdirSync(join(root, 'daily'));
    const handAuthored = join(parent, 'Architecture.md');
    writeFileSync(handAuthored, '# Architecture\n\nHand written.\n');
    symlinkSync(handAuthored, join(root, 'daily', '2026-08-15.md'));

    let thrown: unknown;
    try {
      resolveVaultPath(root, 'daily/2026-08-15.md');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(VaultPathError);
    expect((thrown as VaultPathError).reason).toBe('escapes_root');
  });

  it('accepts a symlink that stays inside the root', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'daily'));
    mkdirSync(join(root, 'daily', 'real'));
    symlinkSync(join(root, 'daily', 'real'), join(root, 'daily', 'alias'));
    const resolved = resolveVaultPath(root, 'daily/alias/x.md');
    expect(resolved.absolute).toBe(join(realOf(root), 'daily', 'real', 'x.md'));
  });

  it('resolves a symlinked ROOT rather than reporting everything as an escape', () => {
    const parent = tempRoot('wf-vault-parent-');
    const real = join(parent, 'real-root');
    const link = join(parent, 'linked-root');
    mkdirSync(real);
    symlinkSync(real, link);
    expect(resolveVaultPath(link, 'daily/x.md').absolute).toBe(join(realOf(real), 'daily', 'x.md'));
  });

  it('refuses when the root itself does not exist', () => {
    const parent = tempRoot('wf-vault-parent-');
    let thrown: unknown;
    try {
      resolveVaultPath(join(parent, 'never-created'), 'daily/x.md');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(VaultPathError);
    expect((thrown as VaultPathError).reason).toBe('root_unresolvable');
  });

  it('reports the offending path in the message without leaking the whole root twice', () => {
    const root = tempRoot();
    expect(() => resolveVaultPath(root, '../Architecture.md')).toThrow(/\.\.\/Architecture\.md/);
  });
});

describe('the containment defect this suite exists to catch', () => {
  // A naive `resolve(root, rel)` + `startsWith(root)` implementation passes
  // most of the suite above and fails exactly here — which is why both cases
  // are asserted rather than assumed.
  it('a bare startsWith would admit the sibling case', () => {
    const naive = (root: string, target: string): boolean => target.startsWith(root);
    expect(naive('/vault/watchfloor', '/vault/watchfloor-old/x.md')).toBe(true);
    expect(isContainedIn('/vault/watchfloor', '/vault/watchfloor-old/x.md')).toBe(false);
  });

  it('a bare path.resolve would silently clamp a traversal back inside', () => {
    const root = tempRoot();
    // resolve() happily produces the PARENT of the root here — no error, no
    // signal, just a write into the owner's hand-authored notes.
    const clamped = join(root, '..', 'Architecture.md');
    expect(clamped.startsWith(root + sep)).toBe(false);
    expect(() => resolveVaultPath(root, '../Architecture.md')).toThrow(VaultPathError);
  });
});
