/**
 * The vault safety layer (M5 task 4) — the one door into the owner's Obsidian
 * vault.
 *
 * **Every later vault task writes through this package and nothing else.**
 * Tasks 5–9 (daily notes, weekly notes, entity notes, saved promotion, verify
 * and prune) must import from here and must not import `node:fs`;
 * `tests/vault/sourceProperties.test.ts` fails if one does.
 *
 * The rule that outranks everything else in M5, from §8.1:
 *
 * > Watchfloor owns exactly one subtree and never writes outside it.
 * > - Never write to `notes/` or any hand-authored directory.
 * > - Never delete a file outside `watchfloor/`.
 * > - Never modify a file lacking Watchfloor frontmatter.
 *
 * Each of those is a primitive here rather than a caution in a doc comment:
 *
 * | rule | where it is enforced |
 * | --- | --- |
 * | one subtree | `paths.ts` — four addressable areas, containment after symlink resolution |
 * | never outside it | `paths.ts` + `session.ts` — refuses, never clamps |
 * | never delete | there is no delete in this package, checked by `sourceRules.ts` |
 * | never modify an unmarked file | `frontmatter.ts`, checked against the bytes on disk |
 * | atomic | `session.ts` — temp file in the same directory, fsync, rename |
 * | not into an unmounted vault | `mount.ts` |
 * | bounded | `session.ts` — files per run and bytes per file |
 *
 * Start at `session.ts`; the other modules are its parts.
 */

export {
  applyManagedBlock,
  hasManagedBlock,
  isWatchfloorManaged,
  renderManagedNote,
  splitManagedBlock,
  VaultContentError,
  WATCHFLOOR_BEGIN_MARKER,
  WATCHFLOOR_END_MARKER,
  type ManagedBlockOptions,
  type ManagedContent,
  type ManagedNoteInput,
} from './frontmatter.ts';

export {
  assertVaultMounted,
  checkVaultMount,
  icloudPlaceholderFor,
  vaultRootFromEnv,
  VaultMountError,
  type VaultMounted,
  type VaultMountRefusal,
  type VaultMountStatus,
} from './mount.ts';

export {
  isContainedIn,
  resolveVaultPath,
  vaultAreaOf,
  VAULT_AREAS,
  VaultPathError,
  type ResolvedVaultPath,
  type VaultArea,
  type VaultPath,
  type VaultPathRefusal,
  type VaultTier,
} from './paths.ts';

export {
  openVaultSession,
  DEFAULT_VAULT_CAPS,
  VAULT_TEMP_PREFIX,
  VaultCapError,
  VaultSession,
  VaultWriteError,
  type VaultCapKind,
  type VaultCaps,
  type VaultWriteRefusal,
  type VaultWriteResult,
} from './session.ts';
