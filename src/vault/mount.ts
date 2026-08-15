/**
 * The unmounted-vault guard (M5 task 4).
 *
 * The M5 plan's Global Constraints:
 *
 * > iCloud Drive can be absent or still materialising. Writing into an
 * > unmounted mount point silently creates a local shadow directory that never
 * > syncs and diverges forever. Detect and refuse.
 *
 * This failure has no error to catch. `mkdirSync(root, { recursive: true })`
 * on a path whose ancestors are all gone SUCCEEDS, every write after it
 * succeeds, and the owner sees a healthy-looking system writing into a local
 * directory that no device will ever see. So the guard is a precondition, not
 * error handling.
 *
 * ## What "mounted" means here, and why it is not a mount(2) question
 *
 * The textbook test for "is this a mount point" compares device ids:
 * `stat(p).dev !== stat(dirname(p)).dev`. **That test is useless for this
 * vault**, and not marginally so — it answers a different question. iCloud
 * Drive on macOS is not a filesystem mount: `~/Library/Mobile Documents` lives
 * on the boot volume and is populated by a userspace daemon (`bird`), so the
 * device ids match for a perfectly healthy vault and go on matching when the
 * data is gone. A guard built on it would be false in the healthy case and
 * false in the broken one.
 *
 * So "mounted" is defined against the **shadow-directory signature** instead,
 * and the definition is two rules that together make the signature impossible
 * to produce accidentally:
 *
 * 1. **Watchfloor never creates anything above its own sync root.** There is
 *    no `recursive: true` anywhere in this package. The sync root's parent —
 *    the *anchor* — must already exist. If iCloud is absent, the anchor is
 *    absent, and the answer is a refusal rather than a fabricated tree.
 * 2. **The anchor must already contain something.** A shadow tree is empty by
 *    construction: it exists only because something invented it. A real
 *    Obsidian vault directory has notes, an `.obsidian/`, or at minimum the
 *    sync root from a previous run. An empty anchor is either a shadow or a
 *    location the operator has not actually prepared, and both deserve the
 *    same refusal.
 *
 * Rule 2 is what keeps rule 1 honest. Without it, a shadow tree created once
 * by anything else — an older build, a typo'd path, a different tool — would
 * be indistinguishable from a real vault forever after.
 *
 * ## The root itself may be absent, and that is deliberate
 *
 * M5 acceptance requires deleting the entire `watchfloor/` tree and re-running
 * sync. So a missing root is a *mounted* state carrying `rootExists: false`,
 * and the caller creates it with a single non-recursive `mkdir` inside an
 * anchor that has already been vouched for. The guard is about the anchor.
 *
 * ## Present but not materialised
 *
 * iCloud evicts file *content*, leaving a `.Foo.md.icloud` stub in place of
 * `Foo.md`. A directory whose every entry is a stub is one iCloud knows about
 * and has not brought down; writing into it is how two divergent copies of the
 * same note come to exist. That is a distinguishable state and gets its own
 * refusal.
 *
 * This module reads the filesystem and never writes to it.
 */

import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type VaultMountRefusal =
  | 'root_is_filesystem_root'
  | 'anchor_is_filesystem_root'
  | 'anchor_missing'
  | 'anchor_not_a_directory'
  | 'anchor_not_writable'
  | 'anchor_empty'
  | 'anchor_dematerialised'
  | 'root_not_a_directory'
  | 'root_not_writable';

export interface VaultMounted {
  readonly mounted: true;
  /** The sync root as configured. Not resolved — `resolveVaultPath` does that. */
  readonly root: string;
  /** The sync root's parent, which this guard has vouched for. */
  readonly anchor: string;
  /** False after the acceptance test deletes the tree; the caller may mkdir it. */
  readonly rootExists: boolean;
}

export interface VaultUnmounted {
  readonly mounted: false;
  readonly root: string;
  readonly reason: VaultMountRefusal;
  readonly detail: string;
  /** What a human should do about it. A refusal with no remedy gets routed around. */
  readonly remedy: string;
}

export type VaultMountStatus = VaultMounted | VaultUnmounted;

export class VaultMountError extends Error {
  readonly reason: VaultMountRefusal;
  readonly remedy: string;
  constructor(status: VaultUnmounted) {
    super(
      `vault at ${JSON.stringify(status.root)} is not mounted: ${status.detail} ` +
        `(${status.reason}). ${status.remedy}`,
    );
    this.name = 'VaultMountError';
    this.reason = status.reason;
    this.remedy = status.remedy;
  }
}

/**
 * `WF_VAULT_ROOT` as a value, or `null` when it is unset or blank.
 *
 * Blank is `null` rather than `''`: an empty string would resolve against the
 * process working directory, which is the repository, and a sync that
 * "succeeded" into `./daily/` would be both wrong and easy to miss. Same
 * reasoning as `src/config/env.ts`'s treatment of a blank optional credential
 * — an unset optional must never become a *different* configuration.
 *
 * Unset is the shipped configuration: `.env` keeps `WF_VAULT_ROOT` commented
 * out, and until a human sets it, nothing here can write anywhere.
 */
export function vaultRootFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.WF_VAULT_ROOT;
  if (raw === undefined) return null;
  return raw.trim() === '' ? null : raw;
}

/**
 * The stub iCloud leaves behind when it evicts a file's contents: a dot-
 * prefixed sibling with `.icloud` appended to the whole original name,
 * extension included.
 */
export function icloudPlaceholderFor(filePath: string): string {
  return join(dirname(filePath), `.${basename(filePath)}.icloud`);
}

function isDirectory(p: string): boolean | null {
  try {
    return statSync(p).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function isWritableDirectory(p: string): boolean {
  try {
    // X_OK as well as W_OK: a directory that cannot be traversed cannot be
    // written into either, and the two failures read identically to a caller.
    accessSync(p, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function unmounted(
  root: string,
  reason: VaultMountRefusal,
  detail: string,
  remedy: string,
): VaultUnmounted {
  return { mounted: false, root, reason, detail, remedy };
}

/**
 * Inspects the configured sync root and its anchor. Reads only — it creates
 * nothing, which is the whole point.
 */
export function checkVaultMount(root: string): VaultMountStatus {
  const anchor = dirname(root);

  if (anchor === root) {
    return unmounted(
      root,
      'root_is_filesystem_root',
      'the configured root is the filesystem root',
      'Point WF_VAULT_ROOT at a subtree inside the vault, e.g. <vault>/watchfloor.',
    );
  }
  if (dirname(anchor) === anchor) {
    return unmounted(
      root,
      'anchor_is_filesystem_root',
      'the sync root sits directly in the filesystem root',
      'Point WF_VAULT_ROOT at a subtree inside the vault, e.g. <vault>/watchfloor.',
    );
  }

  const anchorIsDir = isDirectory(anchor);
  if (anchorIsDir === null) {
    return unmounted(
      root,
      'anchor_missing',
      `the sync root's parent ${JSON.stringify(anchor)} does not exist`,
      'The vault is not mounted, or WF_VAULT_ROOT is wrong. Watchfloor will not create the ' +
        'directory chain: doing so on an absent iCloud mount produces a local shadow tree that ' +
        'never syncs. Mount the vault, or fix WF_VAULT_ROOT.',
    );
  }
  if (!anchorIsDir) {
    return unmounted(
      root,
      'anchor_not_a_directory',
      `the sync root's parent ${JSON.stringify(anchor)} is not a directory`,
      'Fix WF_VAULT_ROOT to point inside the vault.',
    );
  }
  if (!isWritableDirectory(anchor)) {
    return unmounted(
      root,
      'anchor_not_writable',
      `the sync root's parent ${JSON.stringify(anchor)} is not writable`,
      'Fix the directory permissions, or point WF_VAULT_ROOT somewhere Watchfloor can write.',
    );
  }

  const entries = readdirSync(anchor);
  if (entries.length === 0) {
    return unmounted(
      root,
      'anchor_empty',
      `the sync root's parent ${JSON.stringify(anchor)} is empty`,
      'An empty parent is the signature of a shadow directory invented by a previous run or a ' +
        'typo, not of a real vault. If this really is the intended location, create the sync ' +
        'root directory yourself once — that act is deliberately left to a human.',
    );
  }
  if (entries.every((name) => name.startsWith('.') && name.endsWith('.icloud'))) {
    return unmounted(
      root,
      'anchor_dematerialised',
      `every entry in ${JSON.stringify(anchor)} is an evicted iCloud placeholder`,
      'The vault is known to iCloud but its contents have not been downloaded. Open the vault ' +
        'and let it materialise before syncing, or two divergent copies of each note will exist.',
    );
  }

  const rootIsDir = isDirectory(root);
  if (rootIsDir === false) {
    return unmounted(
      root,
      'root_not_a_directory',
      'the configured sync root exists but is not a directory',
      'Move the file aside — Watchfloor will not replace it — or fix WF_VAULT_ROOT.',
    );
  }
  if (rootIsDir === true && !isWritableDirectory(root)) {
    return unmounted(
      root,
      'root_not_writable',
      'the configured sync root is not writable',
      'Fix the directory permissions.',
    );
  }

  return { mounted: true, root, anchor, rootExists: rootIsDir === true };
}

/** {@link checkVaultMount}, as a preconditon that throws. */
export function assertVaultMounted(root: string): VaultMounted {
  const status = checkVaultMount(root);
  if (!status.mounted) throw new VaultMountError(status);
  return status;
}
