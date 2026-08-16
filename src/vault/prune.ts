/**
 * `vault prune` (M5 task 9) — **the only job in this project allowed to
 * delete anything.**
 *
 * CLAUDE.md: *"Never delete anything. No `rm`, no history rewrites… Same
 * standard applies inside any script written here."* The M5 plan carves out
 * exactly one exception, and this is it:
 *
 * > `vault prune` is the one job allowed to remove anything, it is confined to
 * > `watchfloor/`, and it must be tested against a fixture vault containing
 * > hand-authored files that must survive.
 *
 * ## The confinement is not in this file, and that is the design
 *
 * This module contains no filesystem call. Every removal goes through
 * `removeVaultFile` in `session.ts`, which re-checks the area gate,
 * containment after symlink resolution, regular-file-ness and ownership at the
 * moment of the delete — so a policy bug here can propose something wrong and
 * still be refused. `tests/vault/sourceProperties.test.ts` holds that shape in
 * place: this module may not import the filesystem, and the source rule names
 * the single sanctioned `unlinkSync` call site in the safety layer.
 *
 * ## What it will delete
 *
 * | class | rule |
 * | --- | --- |
 * | crash-leftover temp file | a `.watchfloor-tmp-…` file nothing else points at (`nlink` 1), older than {@link DEFAULT_MIN_TEMP_AGE_MS} |
 * | `saved/` temp hard link | the spare directory entry `link(2)` leaves, **only** when the note it belongs to is found in the same directory with the *same inode* and carries our frontmatter |
 * | stale fully-managed note | a `daily/`+`weekly/` note of ours that a caller-supplied manifest does not list |
 *
 * ## What it will never delete, at any setting
 *
 * - Anything outside `watchfloor/`, or reached through a symlink. Not policy —
 *   `removeVaultFile` cannot express it.
 * - Anything the owner wrote. A file with no frontmatter of ours is refused by
 *   the primitive, whatever this module thinks.
 * - **Anything in `entities/`.** A managed-block note may carry the owner's
 *   prose above and below the block, and nothing here can tell "ours" from
 *   "ours plus four paragraphs the owner added".
 * - **Any `saved/` note.** §8.1: written once, then never touched by any job.
 * - Any directory. There is no `rmdir` in this package.
 * - Anything at all, unless {@link PruneOptions.apply} is explicitly `true`.
 *
 * ## The hard-link hazard, stated plainly
 *
 * `writeSavedNote` uses `link(2)` rather than `rename(2)`, because `link`
 * fails with EEXIST instead of replacing — that is what makes write-once
 * structural. The cost, which task 4 took deliberately, is that the temp name
 * survives as a **second directory entry for the same inode**. Two names, one
 * file. Delete the wrong one and the owner's saved note is gone.
 *
 * Three things stop that here, and they are independent:
 *
 * 1. A candidate in `saved/` must have a name starting with
 *    {@link VAULT_TEMP_PREFIX}. A note never can — `resolveVaultPath` refuses
 *    dot-prefixed segments, so no note in the vault has such a name.
 * 2. The pair is proven by **inode equality**, not by parsing the temp name:
 *    the twin must be a non-temp file in the same directory whose `dev:ino`
 *    matches exactly, and whose bytes carry our frontmatter. If the inodes
 *    differ, the temp is a *different file* — the only way that happens to a
 *    write-once note is that the note was replaced after creation, and then
 *    the temp holds the original bytes and is the only evidence of it. Refused,
 *    and `vault verify` reports it as `saved_replaced`.
 * 3. A runtime self-check immediately before each delete, in the spirit of
 *    task 4's `applyManagedBlock` assertion: a `saved/` path that is not
 *    temp-prefixed throws rather than being removed, even if some future edit
 *    to the classification proposes one.
 */

import { isWatchfloorManaged, readWatchfloorFrontmatter } from './frontmatter.ts';
import { checkVaultMount } from './mount.ts';
import { vaultAreaOf, type VaultArea } from './paths.ts';
import {
  readVaultText,
  removeVaultFile,
  scanVaultTree,
  VAULT_TEMP_PREFIX,
  type VaultEntry,
} from './session.ts';

/**
 * How old an unreferenced temp file must be before it is garbage rather than a
 * write in progress.
 *
 * A sync run writes a note in milliseconds, so an hour is three orders of
 * magnitude of headroom against the only race that matters: prune removing the
 * temp file a concurrent `atomicWrite` is about to rename into place.
 */
export const DEFAULT_MIN_TEMP_AGE_MS = 60 * 60 * 1000;

/**
 * A run this large is a bug, not a tidy-up. Deleting the first N and stopping
 * would leave an arbitrary subset behind and look like it worked, so the whole
 * run is refused instead and a human is asked to look.
 */
export const DEFAULT_MAX_DELETIONS_PER_RUN = 50;

export type PruneReason = 'temp_leftover' | 'saved_temp_link' | 'stale_managed_note';

export type PruneSkipReason =
  | 'too_young'
  | 'inode_mismatch'
  | 'unpaired_hard_link'
  | 'twin_not_managed'
  | 'empty_manifest'
  | 'refused_by_safety_layer';

export interface PruneCandidate {
  readonly relPath: string;
  readonly reason: PruneReason;
  readonly bytes: number;
  readonly detail: string;
}

export interface PruneSkip {
  readonly relPath: string;
  readonly reason: PruneSkipReason;
  readonly detail: string;
}

export interface PruneResult {
  readonly root: string;
  readonly mounted: boolean;
  /** False for a dry run — which is the default, and the only default. */
  readonly applied: boolean;
  readonly candidates: readonly PruneCandidate[];
  readonly removed: readonly string[];
  readonly skipped: readonly PruneSkip[];
  /** Set when the whole run was refused rather than partly performed. */
  readonly refused: 'deletion_cap' | null;
}

export interface PruneOptions {
  readonly root: string;
  /**
   * **Nothing is deleted unless this is `true`.** Absent or false is a dry run
   * that reports exactly what it would have removed. Deleting is an explicit
   * act, and the shape of the option is what makes forgetting it safe rather
   * than destructive.
   */
  readonly apply?: boolean;
  /**
   * Vault-relative paths the current sync would write. Only fully-managed
   * notes ABSENT from this list are proposed, and only when a list is given at
   * all: prune has no view of the corpus and must not guess which days still
   * exist in it.
   */
  readonly expected?: readonly string[];
  /**
   * The only clock this module reads, and it is injected so tests are
   * deterministic. It is used for one thing: how old a temp file is.
   */
  readonly nowMs?: number;
  readonly minTempAgeMs?: number;
  readonly maxDeletionsPerRun?: number;
}

function skip(relPath: string, reason: PruneSkipReason, detail: string): PruneSkip {
  return { relPath, reason, detail };
}

/**
 * The note a temp file's NAME claims to belong to, if exactly one exists in
 * the same directory.
 *
 * `atomicWrite` names its temp file `${PREFIX}${basename(target)}.${pid}.${n}`,
 * so the name is a claim about which note these bytes were becoming. It is
 * only a claim — the inode is what settles whether the two names are the same
 * file — but finding the claimed note is what turns "an unreferenced temp
 * file" from a garbage question into a question about a specific note.
 *
 * Ambiguity answers `null`: two candidates means guessing which note is
 * involved, and guessing is how the wrong one gets deleted.
 */
function nameTwin(entry: VaultEntry, entries: readonly VaultEntry[]): VaultEntry | null {
  const dir = entry.relPath.slice(0, entry.relPath.lastIndexOf('/') + 1);
  const stem = entry.name.slice(VAULT_TEMP_PREFIX.length);
  const twins = entries.filter(
    (candidate) =>
      candidate.kind === 'file' &&
      !candidate.name.startsWith(VAULT_TEMP_PREFIX) &&
      candidate.relPath === `${dir}${candidate.name}` &&
      stem.startsWith(`${candidate.name}.`),
  );
  return twins.length === 1 ? twins[0]! : null;
}

/**
 * What one temp file is, and whether it may go.
 *
 * The order is the safety argument. **A temp file that names an existing note
 * is never garbage**, whatever its link count says, and that is the case the
 * first version of this function got wrong:
 *
 * - Same inode → the spare directory entry `link(2)` left for a `saved/` note.
 *   Removable, because the note's own name still points at the same bytes.
 * - **Different inode → refuse.** The temp is a separate file holding the
 *   note's *original* bytes, and the way a write-once note comes to have new
 *   bytes under its own name is that something replaced it atomically. Those
 *   original bytes are then the only copy in existence, and `nlink` is 1 on
 *   both — so a rule that trusted the link count alone would delete the
 *   owner's original saved note and call it a crash leftover. `vault verify`
 *   reports this as `saved_replaced`.
 *
 * Only a temp file that names nothing is a leftover, and even then it must be
 * old enough that no sync can be mid-write on it.
 */
function classifyTemp(
  entry: VaultEntry,
  entries: readonly VaultEntry[],
  read: (relPath: string) => string | null,
  nowMs: number,
  minAgeMs: number,
): PruneCandidate | PruneSkip {
  const twin = nameTwin(entry, entries);

  if (twin !== null) {
    if (twin.inode !== entry.inode) {
      return skip(
        entry.relPath,
        'inode_mismatch',
        `names ${twin.relPath} but is a different file (inode ${entry.inode} against ` +
          `${twin.inode}). Either that note was replaced after creation and these are its ` +
          'original bytes, or a write of it failed. Both are things to look at rather than ' +
          'delete — see `vault verify`',
      );
    }
    const twinText = read(twin.relPath);
    if (twinText === null || !isWatchfloorManaged(twinText)) {
      return skip(
        entry.relPath,
        'twin_not_managed',
        `shares an inode with ${twin.relPath}, which carries no Watchfloor frontmatter`,
      );
    }
    return {
      relPath: entry.relPath,
      reason: 'saved_temp_link',
      bytes: 0, // a directory entry, not a copy: removing it frees no bytes
      detail:
        `the spare directory entry link(2) left for ${twin.relPath}. Same inode (${entry.inode}), ` +
        `so the note keeps its own name and its bytes; the link count drops from ${entry.nlink} ` +
        `to ${entry.nlink - 1}`,
    };
  }

  if (entry.nlink > 1) {
    return skip(
      entry.relPath,
      'unpaired_hard_link',
      `${entry.nlink} links to inode ${entry.inode} and no note in this directory names it. ` +
        'Another name for these bytes exists somewhere this tool cannot see, and this job does ' +
        "not garbage-collect other people's links",
    );
  }

  const ageMs = nowMs - entry.mtimeMs;
  if (ageMs < minAgeMs) {
    return skip(
      entry.relPath,
      'too_young',
      `last written ${Math.round(ageMs / 1000)}s ago; a sync may be in the middle of writing it`,
    );
  }
  return {
    relPath: entry.relPath,
    reason: 'temp_leftover',
    bytes: entry.bytes,
    detail: `an interrupted write left this behind ${Math.round(ageMs / 3600000)}h ago, naming no note`,
  };
}

function isCandidate(value: PruneCandidate | PruneSkip): value is PruneCandidate {
  return (value as PruneCandidate).reason === 'temp_leftover' ||
    (value as PruneCandidate).reason === 'saved_temp_link' ||
    (value as PruneCandidate).reason === 'stale_managed_note';
}

/** Areas whose notes may ever be proposed. `entities/` and `saved/` are absent. */
const PRUNABLE_NOTE_AREAS: readonly VaultArea[] = ['daily', 'weekly'];

/**
 * Reads the tree, decides, and — only with {@link PruneOptions.apply} — removes.
 */
export function pruneVault(options: PruneOptions): PruneResult {
  const { root } = options;
  const apply = options.apply === true;
  const nowMs = options.nowMs ?? Date.now();
  const minAgeMs = options.minTempAgeMs ?? DEFAULT_MIN_TEMP_AGE_MS;
  const maxDeletions = options.maxDeletionsPerRun ?? DEFAULT_MAX_DELETIONS_PER_RUN;

  const mount = checkVaultMount(root);
  if (!mount.mounted || !mount.rootExists) {
    // A shadow tree looks exactly like a real vault that has lost its
    // contents, and this is the one job that could act on the difference.
    return {
      root,
      mounted: mount.mounted,
      applied: false,
      candidates: [],
      removed: [],
      skipped: [],
      refused: null,
    };
  }

  const entries = scanVaultTree(root);
  const read = (relPath: string): string | null => readVaultText(root, relPath);
  const candidates: PruneCandidate[] = [];
  const skipped: PruneSkip[] = [];

  for (const entry of entries) {
    if (entry.kind !== 'file') continue; // never a directory, never a symlink
    const area = vaultAreaOf(entry.relPath);
    if (area === null) continue; // the owner's, and not addressable anyway

    if (entry.name.startsWith(VAULT_TEMP_PREFIX)) {
      const verdict = classifyTemp(entry, entries, read, nowMs, minAgeMs);
      if (isCandidate(verdict)) candidates.push(verdict);
      else skipped.push(verdict);
      continue;
    }

    if (options.expected === undefined) continue;
    if (!PRUNABLE_NOTE_AREAS.includes(area)) continue;
    if (options.expected.length === 0) {
      skipped.push(
        skip(
          entry.relPath,
          'empty_manifest',
          'the manifest of notes this sync would write is empty. A caller whose corpus query ' +
            'returned nothing is indistinguishable from a legitimately empty period, and one of ' +
            'those two readings deletes every managed note in the vault',
        ),
      );
      continue;
    }
    if (options.expected.includes(entry.relPath)) continue;

    const text = read(entry.relPath);
    const front = text === null ? null : readWatchfloorFrontmatter(text);
    // Not ours, or not this tier: the safety layer would refuse it anyway, and
    // proposing it in a dry-run report would misrepresent what prune does.
    if (front === null || front.tier !== 'fully-managed') continue;

    candidates.push({
      relPath: entry.relPath,
      reason: 'stale_managed_note',
      bytes: entry.bytes,
      detail: 'a fully-managed note of ours that the current sync no longer writes',
    });
  }

  if (candidates.length > maxDeletions) {
    return {
      root,
      mounted: true,
      applied: false,
      candidates,
      removed: [],
      skipped,
      refused: 'deletion_cap',
    };
  }

  const removed: string[] = [];
  if (apply) {
    // Every candidate is checked BEFORE any of them is removed. Asserting
    // inside the loop would abort a run that had already deleted files, which
    // is the one outcome worse than refusing: a partly-pruned tree with an
    // exception on top of it.
    for (const candidate of candidates) assertRemovable(candidate);
    for (const candidate of candidates) {
      try {
        removeVaultFile(root, candidate.relPath);
        removed.push(candidate.relPath);
      } catch (err) {
        // The safety layer re-checks everything at the moment of the delete. A
        // refusal here is a policy bug in this module, and it is reported
        // rather than swallowed or retried.
        skipped.push(
          skip(candidate.relPath, 'refused_by_safety_layer', (err as Error).message),
        );
      }
    }
  }

  return { root, mounted: true, applied: apply, candidates, removed, skipped, refused: null };
}

/**
 * The last gate, checked immediately before each delete.
 *
 * Task 4's `applyManagedBlock` proved the value of this shape: when its append
 * path was replaced with a clobber, *the runtime self-check fired before any
 * test assertion did*. The invariant caught it, not the tests. So the rule
 * that protects the owner's saved notes is asserted here as well as encoded in
 * the classification above — if some future edit ever proposes a `saved/` note,
 * this throws instead of removing it.
 */
function assertRemovable(candidate: PruneCandidate): void {
  const area = vaultAreaOf(candidate.relPath);
  const name = candidate.relPath.slice(candidate.relPath.lastIndexOf('/') + 1);

  if (area === 'saved' && !name.startsWith(VAULT_TEMP_PREFIX)) {
    throw new Error(
      `prune refused to remove ${candidate.relPath}: saved/ notes are written once and never ` +
        'touched again by any job. Only the spare temp directory entry is ever removable there',
    );
  }
  if (area === 'entities' && !name.startsWith(VAULT_TEMP_PREFIX)) {
    throw new Error(
      `prune refused to remove ${candidate.relPath}: an entities/ note can carry the owner's own ` +
        'prose outside the managed block',
    );
  }
}
