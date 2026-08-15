import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertVaultMounted,
  checkVaultMount,
  icloudPlaceholderFor,
  vaultRootFromEnv,
  VaultMountError,
  type VaultMountRefusal,
} from '../../src/vault/mount.ts';

/**
 * The unmounted-vault guard (M5 plan, "Global Constraints").
 *
 * > iCloud Drive can be absent or still materialising. Writing into an
 * > unmounted mount point silently creates a local shadow directory that never
 * > syncs and diverges forever. Detect and refuse.
 *
 * The failure is silent by construction: `mkdirSync(root, { recursive: true })`
 * on a path whose ancestors are gone succeeds, and every subsequent write
 * succeeds, and the owner sees a working system writing to nothing. There is no
 * error to catch — which is why the guard has to be a precondition rather than
 * error handling.
 *
 * ## What "mounted" means here, and why it is not a mount(2) question
 *
 * iCloud Drive is NOT a separate mount on macOS: `~/Library/Mobile Documents`
 * lives on the boot volume and is managed by a userspace daemon, so
 * `statSync(x).dev !== statSync(dirname(x)).dev` — the textbook mount-boundary
 * test — is false for a perfectly healthy vault and stays false for a missing
 * one. It answers a different question than the one being asked.
 *
 * So "mounted" is defined against the SHADOW-DIRECTORY SIGNATURE instead:
 * Watchfloor will create its own sync root, and nothing above it, and only
 * inside a directory that already has something in it. A shadow tree is empty
 * by definition — nothing else put anything there.
 */

function tempDir(name = 'wf-mount-'): string {
  return mkdtempSync(join(tmpdir(), name));
}

/** An anchor that looks like a real vault: it has other things in it. */
function populatedAnchor(): string {
  const anchor = tempDir();
  writeFileSync(join(anchor, 'Architecture.md'), '# Architecture\n');
  return anchor;
}

function expectRefusal(root: string, reason: VaultMountRefusal): void {
  const status = checkVaultMount(root);
  expect(status.mounted).toBe(false);
  if (status.mounted) return;
  expect(status.reason).toBe(reason);
}

describe('checkVaultMount — the happy paths', () => {
  it('reports mounted when the anchor is populated and the root already exists', () => {
    const anchor = populatedAnchor();
    const root = join(anchor, 'watchfloor');
    mkdirSync(root);
    const status = checkVaultMount(root);
    expect(status.mounted).toBe(true);
    if (!status.mounted) return;
    expect(status.rootExists).toBe(true);
  });

  // The M5 acceptance test deletes the whole `watchfloor/` tree and re-runs
  // sync. The root being absent must therefore be a MOUNTED state, not a
  // refusal — the guard is about the anchor, not about the root.
  it('reports mounted with rootExists false when only the sync root is missing', () => {
    const anchor = populatedAnchor();
    const status = checkVaultMount(join(anchor, 'watchfloor'));
    expect(status.mounted).toBe(true);
    if (!status.mounted) return;
    expect(status.rootExists).toBe(false);
  });
});

describe('checkVaultMount — the shadow-directory signature', () => {
  // The exact iCloud failure: `~/Library/Mobile Documents/iCloud~md~obsidian`
  // does not exist because the account is signed out or the machine is fresh.
  it('refuses when the anchor does not exist at all', () => {
    const parent = tempDir();
    expectRefusal(join(parent, 'nowhere', 'watchfloor'), 'anchor_missing');
  });

  it('refuses when the anchor exists but is empty — nothing else ever put anything there', () => {
    const anchor = tempDir();
    expectRefusal(join(anchor, 'watchfloor'), 'anchor_empty');
  });

  it('refuses when the anchor is a file rather than a directory', () => {
    const parent = tempDir();
    const anchor = join(parent, 'not-a-dir');
    writeFileSync(anchor, 'hello');
    expectRefusal(join(anchor, 'watchfloor'), 'anchor_not_a_directory');
  });

  it('refuses when the anchor is not writable', () => {
    const parent = tempDir();
    const anchor = join(parent, 'readonly');
    mkdirSync(anchor);
    writeFileSync(join(anchor, 'Architecture.md'), '# Architecture\n');
    chmodSync(anchor, 0o500);
    expectRefusal(join(anchor, 'watchfloor'), 'anchor_not_writable');
  });

  it('refuses a root whose parent is the filesystem root', () => {
    expectRefusal('/watchfloor', 'anchor_is_filesystem_root');
  });

  it('refuses the filesystem root itself', () => {
    expectRefusal('/', 'root_is_filesystem_root');
  });

  it('refuses when the root exists but is a file', () => {
    const anchor = populatedAnchor();
    const root = join(anchor, 'watchfloor');
    writeFileSync(root, 'not a directory');
    expectRefusal(root, 'root_not_a_directory');
  });

  it('refuses when the root exists but is not writable', () => {
    const anchor = populatedAnchor();
    const root = join(anchor, 'watchfloor');
    mkdirSync(root);
    chmodSync(root, 0o500);
    expectRefusal(root, 'root_not_writable');
  });
});

describe('checkVaultMount — present but not materialised', () => {
  // iCloud evicts file CONTENT, replacing `Foo.md` with a `.Foo.md.icloud`
  // stub. An anchor whose every entry is a stub is a directory iCloud knows
  // about and has not brought down: writing into it is how two divergent
  // copies of the same note get created.
  it('refuses an anchor whose every entry is an iCloud placeholder', () => {
    const anchor = tempDir();
    writeFileSync(join(anchor, '.Architecture.md.icloud'), '');
    writeFileSync(join(anchor, '.Open Questions.md.icloud'), '');
    expectRefusal(join(anchor, 'watchfloor'), 'anchor_dematerialised');
  });

  it('accepts an anchor where at least one entry is materialised', () => {
    const anchor = tempDir();
    writeFileSync(join(anchor, '.Architecture.md.icloud'), '');
    writeFileSync(join(anchor, 'Open Questions.md'), '# Open Questions\n');
    expect(checkVaultMount(join(anchor, 'watchfloor')).mounted).toBe(true);
  });
});

describe('icloudPlaceholderFor', () => {
  it('names the stub iCloud leaves in place of an evicted file', () => {
    expect(icloudPlaceholderFor('/vault/watchfloor/entities/Anthropic.md')).toBe(
      '/vault/watchfloor/entities/.Anthropic.md.icloud',
    );
  });

  it('handles a name that already contains dots', () => {
    expect(icloudPlaceholderFor('/v/daily/2026.08.15.md')).toBe('/v/daily/.2026.08.15.md.icloud');
  });
});

describe('assertVaultMounted', () => {
  it('returns the mounted status when the anchor is healthy', () => {
    const anchor = populatedAnchor();
    expect(assertVaultMounted(join(anchor, 'watchfloor')).rootExists).toBe(false);
  });

  it('throws a VaultMountError naming the reason and a remedy', () => {
    const anchor = tempDir();
    let thrown: unknown;
    try {
      assertVaultMounted(join(anchor, 'watchfloor'));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(VaultMountError);
    expect((thrown as VaultMountError).reason).toBe('anchor_empty');
    // A refusal that does not say what to do gets worked around rather than fixed.
    expect((thrown as VaultMountError).remedy).toMatch(/\S/);
    expect((thrown as VaultMountError).message).toContain('anchor_empty');
  });
});

describe('vaultRootFromEnv', () => {
  it('returns null when WF_VAULT_ROOT is unset — the shipped configuration', () => {
    expect(vaultRootFromEnv({})).toBeNull();
  });

  it('returns null for a blank value rather than resolving to the process cwd', () => {
    expect(vaultRootFromEnv({ WF_VAULT_ROOT: '   ' })).toBeNull();
  });

  it('returns the configured root', () => {
    expect(vaultRootFromEnv({ WF_VAULT_ROOT: './vault/watchfloor' })).toBe('./vault/watchfloor');
  });
});

describe('the defect this guard exists to catch', () => {
  // The naive implementation, demonstrated rather than described: this is
  // precisely what a sync job does if nothing checks first, and it succeeds.
  it('a recursive mkdir on a missing anchor succeeds and produces a shadow tree', () => {
    const parent = tempDir();
    const shadowRoot = join(parent, 'iCloud~md~obsidian', 'Obsidian-Vault', 'watchfloor');
    mkdirSync(shadowRoot, { recursive: true }); // no error, no signal
    writeFileSync(join(shadowRoot, 'x.md'), 'never syncs anywhere');

    // And this is the guard refusing the same path BEFORE that happened: the
    // anchor it would have invented is empty apart from what it invented.
    const secondShadow = join(parent, 'iCloud~md~obsidian2', 'Obsidian-Vault', 'watchfloor');
    expectRefusal(secondShadow, 'anchor_missing');
  });
});
