/**
 * The vault write session (M5 task 4) — §8.1's rules as enforced primitives.
 *
 * **Nothing in Waves 2–4 writes to the vault except through this module.**
 * That is not a convention: `tests/vault/noDirectFs.test.ts` fails if any
 * module importing `src/vault/` also imports `node:fs`. The point is that the
 * guarantees below become properties of the integration rather than of each
 * later task remembering them.
 *
 * ## What the three write methods are, and why there are three
 *
 * §8.1's three tiers behave differently enough that one `write(path, content)`
 * would need a mode flag, and a mode flag is a thing a caller can get wrong.
 * Instead the tier is a property of the *area* (`src/vault/paths.ts`) and each
 * method is pinned to one tier: asking {@link VaultSession.writeManagedNote}
 * to overwrite a `saved/` note is not a policy violation to detect, it is a
 * `wrong_tier` refusal.
 *
 * | method | area | rule |
 * | --- | --- | --- |
 * | `writeManagedNote` | `daily/`, `weekly/` | idempotent overwrite, and only over a file carrying our frontmatter |
 * | `writeEntityNote`  | `entities/`         | only between the markers; append them if absent |
 * | `writeSavedNote`   | `saved/`            | write once; a second write is refused |
 *
 * ## Atomic writes
 *
 * A half-written daily note in a *synced* vault propagates that torn state to
 * every device. Every write here goes to a temp file **in the target's own
 * directory** (a rename cannot cross filesystems), is `fsync`ed, and is then
 * moved into place with `rename` — which POSIX guarantees is atomic. A reader
 * — and iCloud's sync daemon is exactly such a reader — sees either the whole
 * old file or the whole new one, never a prefix.
 *
 * ## Never delete
 *
 * CLAUDE.md's standing rule applies "with special force to vault code". There
 * is no `rm`, `unlink`, `rmdir`, or `recursive: true` anywhere in this
 * package, and `tests/vault/noDirectFs.test.ts` asserts that as a source
 * property. Two consequences worth stating rather than discovering:
 *
 * - A crash between the temp write and the rename leaves a
 *   `{@link VAULT_TEMP_PREFIX}`-prefixed dotfile. It is not cleaned up here.
 *   `vault prune` (task 9) is the one job allowed to remove anything, and the
 *   prefix is exported so it can find them.
 * - `saved/` uses `link` rather than `rename`, so its temp file survives as a
 *   second hard link to the same inode — costing a directory entry, not disk
 *   space. `link` is what makes write-once *structural*: it fails with EEXIST
 *   rather than replacing, so there is no check-then-write window in which a
 *   saved note could be lost. A `rename` guarded by an `existsSync` would be
 *   the same guarantee minus the atomicity.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import {
  applyManagedBlock,
  hasManagedBlock,
  isWatchfloorManaged,
  WATCHFLOOR_BEGIN_MARKER,
  WATCHFLOOR_END_MARKER,
  type ManagedBlockOptions,
  type ManagedContent,
} from './frontmatter.ts';
import { assertVaultMounted, icloudPlaceholderFor } from './mount.ts';
import {
  isContainedIn,
  realpathOfDeepestExisting,
  resolveVaultPath,
  vaultAreaOf,
  VAULT_AREAS,
  type ResolvedVaultPath,
  type VaultTier,
} from './paths.ts';

/** Recognisable, dot-prefixed (so Obsidian ignores it) and prune-able. */
export const VAULT_TEMP_PREFIX = '.watchfloor-tmp-';

export interface VaultCaps {
  /**
   * A runaway sync must not write ten thousand files into a knowledge base.
   * 500 against a sync that produces roughly one daily note, one weekly note
   * and a few dozen entity notes: two orders of magnitude of headroom, and
   * still three orders below "the vault is now unrecognisable".
   */
  readonly maxFilesPerRun: number;
  /**
   * This project stores links and ~300-character excerpts, never full text
   * (`src/domain/repo.ts`). 256 KiB is far above anything that can produce and
   * far below a size that would matter to a vault.
   */
  readonly maxBytesPerFile: number;
}

export const DEFAULT_VAULT_CAPS: VaultCaps = {
  maxFilesPerRun: 500,
  maxBytesPerFile: 256 * 1024,
};

export type VaultCapKind = 'files_per_run' | 'bytes_per_file';

export class VaultCapError extends Error {
  readonly reason: VaultCapKind;
  constructor(reason: VaultCapKind, message: string) {
    super(message);
    this.name = 'VaultCapError';
    this.reason = reason;
  }
}

export type VaultWriteRefusal =
  | 'wrong_tier'
  | 'not_managed'
  | 'saved_exists'
  | 'dematerialised'
  | 'session_latched'
  | 'block_invariant';

export class VaultWriteError extends Error {
  readonly reason: VaultWriteRefusal;
  constructor(reason: VaultWriteRefusal, relPath: string, detail: string) {
    super(`refusing to write ${JSON.stringify(relPath)}: ${detail} (${reason})`);
    this.name = 'VaultWriteError';
    this.reason = reason;
  }
}

export interface VaultWriteResult {
  readonly relPath: string;
  readonly bytes: number;
  readonly created: boolean;
}

let tempCounter = 0;

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Creates every missing directory between the root and `target`, **one
 * non-recursive `mkdir` at a time**, checking containment at each level.
 *
 * `mkdirSync(dir, { recursive: true })` is the single call that produces the
 * iCloud shadow tree the mount guard exists to prevent, so it appears nowhere
 * in this package. Walking down from a root that has already been vouched for
 * cannot climb: every level is asserted to be inside the root before it is
 * created.
 */
function ensureDirectoriesWithin(rootReal: string, targetFile: string): void {
  const missing: string[] = [];
  let current = dirname(targetFile);
  while (current !== rootReal) {
    if (!isContainedIn(rootReal, current)) {
      throw new Error(`refusing to create ${current}: outside the vault root`);
    }
    if (existsSync(current)) break;
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) throw new Error(`walked past the filesystem root from ${targetFile}`);
    current = parent;
  }
  for (const dir of missing.reverse()) mkdirSync(dir);
}

/** Best effort: some platforms refuse to open a directory for fsync. */
function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // A missing directory fsync costs durability of the rename across a power
    // loss, not atomicity. Nothing here can act on the failure.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Writes `content` to `target` atomically.
 *
 * `mode: 'replace'` uses `rename`, which replaces whatever is there in one
 * indivisible step. `mode: 'create-only'` uses `link`, which fails with EEXIST
 * instead — the structural half of the `saved/` write-once rule.
 */
function atomicWrite(target: string, content: string, mode: 'replace' | 'create-only'): void {
  const dir = dirname(target);
  const temp = join(dir, `${VAULT_TEMP_PREFIX}${basename(target)}.${process.pid}.${tempCounter++}`);

  // 'wx' rather than 'w': a temp name that already exists is a condition to
  // surface, not to overwrite.
  const fd = openSync(temp, 'wx', 0o644);
  try {
    writeFileSync(fd, content, 'utf8');
    // Without this the rename can be durable while the CONTENT is not, which
    // on a crash leaves a correctly-named empty file — the torn state in its
    // most confusing form.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  if (mode === 'create-only') linkSync(temp, target);
  else renameSync(temp, target);
  fsyncDirectory(dir);
}

/**
 * A bounded unit of vault writing. Open one per sync run.
 *
 * Construct with {@link openVaultSession}, which asserts the vault is mounted
 * before the session exists at all — so there is no window in which a session
 * is holding an unmounted root.
 */
export class VaultSession {
  readonly #rootReal: string;
  readonly #caps: VaultCaps;
  #filesWritten = 0;
  #latched = false;

  /** @internal Use {@link openVaultSession}. */
  constructor(rootReal: string, caps: VaultCaps) {
    this.#rootReal = rootReal;
    this.#caps = caps;
  }

  get filesWritten(): number {
    return this.#filesWritten;
  }

  /** True once the files-per-run cap latched the session shut. */
  get latched(): boolean {
    return this.#latched;
  }

  get root(): string {
    return this.#rootReal;
  }

  /**
   * `daily/` and `weekly/`: rewritten every run, idempotent overwrite, never
   * append.
   *
   * Takes {@link ManagedContent}, which only `renderManagedNote` produces, so
   * a whole-file write cannot be handed arbitrary text — and therefore cannot
   * produce a file that the next run's frontmatter gate would refuse to touch.
   *
   * Refuses `not_managed` if the target exists and does not carry our
   * frontmatter. That is §8.1's "never modify a file lacking Watchfloor
   * frontmatter", checked against the bytes on disk rather than against what
   * we believe we wrote last time.
   */
  writeManagedNote(relPath: string, content: ManagedContent): VaultWriteResult {
    const resolved = this.#begin(relPath, 'fully-managed');
    const existing = readIfPresent(resolved.absolute);
    if (existing !== null && !isWatchfloorManaged(existing)) {
      throw new VaultWriteError(
        'not_managed',
        relPath,
        'the file on disk carries no Watchfloor frontmatter, so it is not ours to overwrite',
      );
    }
    return this.#commit(resolved, content, 'replace', existing === null);
  }

  /**
   * `entities/`: replace only between the markers; append them if they are
   * missing; create the file if it is absent.
   *
   * The invariant is re-checked here, at the boundary every later task
   * crosses, and not only inside `applyManagedBlock`: the bytes outside the
   * markers must be exactly the bytes that were on disk. See
   * `src/vault/frontmatter.ts` for why appending to a marker-less,
   * frontmatter-less hand-authored note satisfies §8.1 rather than violating
   * it.
   */
  writeEntityNote(
    relPath: string,
    body: string,
    options: ManagedBlockOptions,
  ): VaultWriteResult {
    const resolved = this.#begin(relPath, 'managed-block');
    const existing = readIfPresent(resolved.absolute);
    const next = applyManagedBlock(existing, body, options);

    if (existing !== null) {
      const preserved = hasManagedBlock(existing)
        ? outsideBlockPreserved(existing, next)
        : next.startsWith(existing);
      if (!preserved) {
        throw new VaultWriteError(
          'block_invariant',
          relPath,
          'the new content would not have preserved the bytes outside the managed block',
        );
      }
    }
    return this.#commit(resolved, next, 'replace', existing === null);
  }

  /**
   * `saved/`: written once at creation, then never touched again by any job.
   * Not even to fix a typo.
   *
   * The `existsSync` check exists for the error message; `link` is what makes
   * the rule structural. Both are here because a good message and a real
   * guarantee are different things.
   */
  writeSavedNote(relPath: string, content: ManagedContent): VaultWriteResult {
    const resolved = this.#begin(relPath, 'write-once');
    if (existsSync(resolved.absolute)) {
      throw new VaultWriteError(
        'saved_exists',
        relPath,
        'saved notes are written once and never touched again',
      );
    }
    return this.#commit(resolved, content, 'create-only', true);
  }

  /** Everything that must be true before any write, in refusal order. */
  #begin(relPath: string, tier: VaultTier): ResolvedVaultPath {
    if (this.#latched) {
      throw new VaultWriteError(
        'session_latched',
        relPath,
        'this session was closed by the files-per-run cap',
      );
    }
    const resolved = resolveVaultPath(this.#rootReal, relPath);
    if (resolved.tier !== tier) {
      throw new VaultWriteError(
        'wrong_tier',
        relPath,
        `is in the ${resolved.area} area (${resolved.tier}), not ${tier}`,
      );
    }
    if (existsSync(icloudPlaceholderFor(resolved.absolute))) {
      throw new VaultWriteError(
        'dematerialised',
        relPath,
        "iCloud has evicted this file's contents; writing now would create a second, divergent copy",
      );
    }
    return resolved;
  }

  #commit(
    resolved: ResolvedVaultPath,
    content: string,
    mode: 'replace' | 'create-only',
    created: boolean,
  ): VaultWriteResult {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.#caps.maxBytesPerFile) {
      // Per-file, and deliberately NOT latching: one oversized note is a
      // content bug, and refusing the run's other forty notes because of it
      // turns a bad note into an outage. Loud refusal, never truncation --
      // a truncated note is a note that silently lost its last section.
      throw new VaultCapError(
        'bytes_per_file',
        `refusing to write ${JSON.stringify(resolved.relPath)}: ${bytes} bytes exceeds the ` +
          `${this.#caps.maxBytesPerFile}-byte per-file cap`,
      );
    }
    if (this.#filesWritten >= this.#caps.maxFilesPerRun) {
      // Latches: a cap a caller can catch and continue past is not a cap.
      this.#latched = true;
      throw new VaultCapError(
        'files_per_run',
        `refusing to write ${JSON.stringify(resolved.relPath)}: this run has already written ` +
          `${this.#filesWritten} files, at the ${this.#caps.maxFilesPerRun}-file cap`,
      );
    }

    ensureDirectoriesWithin(this.#rootReal, resolved.absolute);
    atomicWrite(resolved.absolute, content, mode);
    this.#filesWritten += 1;
    return { relPath: resolved.relPath, bytes, created };
  }
}

// ---------------------------------------------------------------------------
// The READ primitives (M5 task 9).
//
// `vault verify` and `vault prune` need to walk the sync root and read what is
// there. Neither may import the filesystem itself: the rule in
// `tests/vault/sourceProperties.test.ts` exempts exactly three modules, and
// this is one of them. So the traversal lives here, next to the writer whose
// leftovers it is looking for — a change to the temp-file naming scheme and
// the code that recognises those files are then in the same diff.
// ---------------------------------------------------------------------------

export type VaultAccessRefusal =
  | 'empty'
  | 'absolute'
  | 'nul_byte'
  | 'backslash'
  | 'parent_traversal'
  | 'dot_segment'
  | 'root_unresolvable'
  | 'escapes_root';

export class VaultAccessError extends Error {
  readonly reason: VaultAccessRefusal;
  constructor(reason: VaultAccessRefusal, relPath: string, detail: string) {
    super(`refusing vault access to ${JSON.stringify(relPath)}: ${detail} (${reason})`);
    this.name = 'VaultAccessError';
    this.reason = reason;
  }
}

/**
 * Containment for a path that is being INSPECTED rather than written.
 *
 * Deliberately not {@link resolveVaultPath}, and the difference is one rule:
 * a **dot-prefixed final segment is allowed**. `atomicWrite` names its temp
 * files `.watchfloor-tmp-…`, and `resolveVaultPath` refuses every dot-prefixed
 * segment — so the files `vault prune` exists to remove are, by construction,
 * the ones the write path cannot express. A reader that could not name them
 * either would leave them undiscoverable.
 *
 * Everything else is kept: no absolutes, no `..`, no NUL, no backslash, no
 * empty or bare-dot segment, and containment re-checked after symlink
 * resolution. A dot-prefixed *directory* segment is still refused, so
 * `.obsidian/…` is not addressable through here either.
 */
function safeSegments(relPath: string): string[] {
  if (relPath.trim() === '') {
    throw new VaultAccessError('empty', relPath, 'a vault path must name something');
  }
  if (relPath.includes('\0')) {
    throw new VaultAccessError('nul_byte', relPath, 'contains a NUL byte');
  }
  if (relPath.includes('\\')) {
    throw new VaultAccessError('backslash', relPath, 'contains a backslash');
  }
  if (isAbsolute(relPath)) {
    throw new VaultAccessError('absolute', relPath, 'vault paths are relative to the sync root');
  }

  const segments = relPath.split('/');
  segments.forEach((segment, index) => {
    if (segment === '..') {
      throw new VaultAccessError('parent_traversal', relPath, 'contains a `..` segment');
    }
    const isLast = index === segments.length - 1;
    if (segment === '.' || segment === '' || (segment.startsWith('.') && !isLast)) {
      throw new VaultAccessError(
        'dot_segment',
        relPath,
        'contains an empty segment, a bare dot, or a dot-prefixed directory',
      );
    }
  });
  return segments;
}

/** {@link safeSegments}, then containment against the resolved sync root. */
function resolveWithinRoot(root: string, relPath: string): string {
  const segments = safeSegments(relPath);

  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch (err) {
    throw new VaultAccessError(
      'root_unresolvable',
      relPath,
      `sync root does not resolve: ${(err as Error).message}`,
    );
  }

  const absolute = realpathOfDeepestExisting(join(rootReal, ...segments));
  if (!isContainedIn(rootReal, absolute)) {
    throw new VaultAccessError(
      'escapes_root',
      relPath,
      'resolves outside the sync root after symlink resolution',
    );
  }
  return absolute;
}

/**
 * The bytes of one file under the sync root, or `null` if it is not there.
 *
 * Read-only by construction, so it is the one primitive that does not need the
 * area gate: `vault verify` must be able to see the owner's hand-authored
 * notes sitting in the sync root in order to REPORT them, and reporting a file
 * is the opposite of touching it. Containment still applies in full.
 */
export function readVaultText(root: string, relPath: string): string | null {
  return readIfPresent(resolveWithinRoot(root, relPath));
}

export type VaultEntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface VaultEntry {
  /** Path relative to the sync root, `/`-separated. */
  readonly relPath: string;
  readonly name: string;
  readonly kind: VaultEntryKind;
  /** 0 for anything that is not a regular file. */
  readonly bytes: number;
  /**
   * Hard links to these bytes. **2 is how a `saved/` note's permanent temp
   * link is told apart from a crash leftover**, which is the distinction that
   * keeps `vault prune` from removing the only name a saved note has.
   */
  readonly nlink: number;
  /**
   * `dev:ino` — a device-qualified identity, so two files on different
   * filesystems that happen to share an inode number are not confused.
   */
  readonly inode: string;
  readonly mtimeMs: number;
}

function entryOf(relPath: string, absolute: string): VaultEntry {
  // lstat, never stat: a symlink must be reported as a symlink rather than as
  // whatever it points at. See `scanVaultTree` for why that matters here.
  const stats = lstatSync(absolute);
  const kind: VaultEntryKind = stats.isSymbolicLink()
    ? 'symlink'
    : stats.isFile()
      ? 'file'
      : stats.isDirectory()
        ? 'directory'
        : 'other';
  return {
    relPath,
    name: basename(relPath),
    kind,
    bytes: kind === 'file' ? stats.size : 0,
    nlink: stats.nlink,
    inode: `${stats.dev}:${stats.ino}`,
    mtimeMs: stats.mtimeMs,
  };
}

/**
 * Every entry under the sync root, sorted by path. Reads only.
 *
 * **Symlinks are reported and never followed.** The sync root is a directory
 * the owner can put anything into, and following a link would let
 * `daily/elsewhere -> ../../02 Career` turn a read-only audit of Watchfloor's
 * own subtree into a read of the owner's wider vault. The same property keeps
 * a link cycle from hanging the walk.
 *
 * A missing root answers `[]` rather than throwing: M5 acceptance deletes the
 * whole `watchfloor/` tree, and "there is nothing there" is a state verify
 * must be able to report.
 */
export function scanVaultTree(root: string): VaultEntry[] {
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const found: VaultEntry[] = [];
  const walk = (dirAbsolute: string, prefix: string): void => {
    for (const child of readdirSync(dirAbsolute, { withFileTypes: true })) {
      const relPath = prefix === '' ? child.name : `${prefix}/${child.name}`;
      const absolute = join(dirAbsolute, child.name);
      const entry = entryOf(relPath, absolute);
      found.push(entry);
      // Only a real directory is descended into. `child.isDirectory()` is
      // false for a symlink to one, which is exactly the behaviour wanted.
      if (entry.kind === 'directory') walk(absolute, relPath);
    }
  };
  walk(rootReal, '');
  return found.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

// ---------------------------------------------------------------------------
// THE ONE DELETE (M5 task 9).
//
// CLAUDE.md: "Never delete anything." The M5 plan carves out exactly one
// exception: "`vault prune` is the one job allowed to remove anything, it is
// confined to `watchfloor/`." This is that exception, and it is here rather
// than in `prune.ts` for the same reason every write is here — `prune.ts` may
// not import the filesystem, so it cannot route around these gates even by
// accident, and the source rule in `sourceRules.ts` names this one call site.
// ---------------------------------------------------------------------------

export type VaultRemoveRefusal = 'unknown_area' | 'nested_path' | 'missing' | 'not_a_file' | 'foreign_file';

export class VaultRemoveError extends Error {
  readonly reason: VaultRemoveRefusal;
  constructor(reason: VaultRemoveRefusal, relPath: string, detail: string) {
    super(`refusing to remove ${JSON.stringify(relPath)}: ${detail} (${reason})`);
    this.name = 'VaultRemoveError';
    this.reason = reason;
  }
}

/**
 * Removes one file from inside the sync root. **The only delete in this
 * repository.**
 *
 * Four gates, in this order, and the order is deliberate:
 *
 * 1. **Syntax**, then **area** — the first segment must be one of
 *    {@link VAULT_AREAS}. This is Task 4's stronger gate, unchanged: there is
 *    no area for a bare filename, so the owner's `Architecture.md`, sitting
 *    exactly where `WF_VAULT_ROOT` would be pointed by mistake, is not
 *    protected by a check — **it is not an expressible request**.
 * 2. **Containment** after `..` and symlink resolution. Checked *before* the
 *    shape rule below, so a path that leaves the tree is always reported as
 *    leaving the tree rather than as some tidier local violation.
 * 3. **Shape** — exactly `area/file`. This package creates no directory inside
 *    an area, so a nested path is something else's, whatever it is.
 * 4. **Ours** — the name is one {@link atomicWrite} produces, or the bytes on
 *    disk carry Watchfloor frontmatter. §8.1's *"never modify a file lacking
 *    Watchfloor frontmatter"*, applied to the strongest modification there is.
 *    Note what this refuses: an `entities/` note that a human wrote and we
 *    only appended a block to has no frontmatter of ours, so it is foreign and
 *    stays.
 *
 * `lstat`, never `stat`: a symlink is refused rather than followed, so this
 * cannot be pointed at a file elsewhere in the owner's vault.
 *
 * Returns what was removed, so a caller can report it without re-reading a
 * path that is now gone.
 */
export function removeVaultFile(root: string, relPath: string): VaultEntry {
  const segments = safeSegments(relPath);
  if (vaultAreaOf(relPath) === null) {
    throw new VaultRemoveError(
      'unknown_area',
      relPath,
      `must start with one of ${VAULT_AREAS.join(', ')} — Watchfloor removes nothing else`,
    );
  }

  // Containment is decided on the RESOLVED path...
  resolveWithinRoot(root, relPath);

  if (segments.length !== 2) {
    throw new VaultRemoveError(
      'nested_path',
      relPath,
      'this package never creates a directory inside an area, so it never removes one either',
    );
  }

  // ...and the delete then acts on the LITERAL one. The two differ for a
  // symlink, and the difference is the whole game: resolving first and
  // unlinking the result means `daily/link.md -> daily/2026-01-01.md` deletes
  // the note instead of the link — a real defect, caught by the symlink test
  // below on its first run. Containment has already been established, so
  // lstat-ing the literal path cannot reach outside the tree; it can only
  // reveal that the final component is a link, which is then refused.
  const absolute = join(realpathSync(root), ...segments);

  let entry: VaultEntry;
  try {
    entry = entryOf(relPath, absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new VaultRemoveError('missing', relPath, 'there is nothing there');
    }
    throw err;
  }
  if (entry.kind !== 'file') {
    throw new VaultRemoveError('not_a_file', relPath, `is a ${entry.kind}, not a regular file`);
  }

  const isTemp = entry.name.startsWith(VAULT_TEMP_PREFIX);
  if (!isTemp) {
    const text = readIfPresent(absolute);
    if (text === null || !isWatchfloorManaged(text)) {
      throw new VaultRemoveError(
        'foreign_file',
        relPath,
        'carries no Watchfloor frontmatter and is not one of our temp files, so it is not ours',
      );
    }
  }

  unlinkSync(absolute);
  return entry;
}

/**
 * The managed-block invariant, computed from the two texts alone: whatever sat
 * before the begin marker and after the end marker in `before` must still sit
 * at the start and end of `after`.
 *
 * Deliberately independent of `applyManagedBlock`'s own slicing — if both used
 * the same helper, a bug in that helper would satisfy the check.
 */
function outsideBlockPreserved(before: string, after: string): boolean {
  const beginAt = before.indexOf(WATCHFLOOR_BEGIN_MARKER);
  const endAt = before.indexOf(WATCHFLOOR_END_MARKER) + WATCHFLOOR_END_MARKER.length;
  return after.startsWith(before.slice(0, beginAt)) && after.endsWith(before.slice(endAt));
}

/**
 * Opens a session against `root`, asserting the vault is mounted first.
 *
 * Creates the sync root itself if it is missing — a **single** non-recursive
 * `mkdir` inside an anchor the mount guard has already vouched for. That is
 * what makes M5's destructive acceptance test ("delete the entire
 * `watchfloor/` tree, re-run sync") work without weakening the guard: the
 * thing that must never be invented is the path *above* the root.
 */
export function openVaultSession(root: string, caps: Partial<VaultCaps> = {}): VaultSession {
  const status = assertVaultMounted(root);
  // A SINGLE, non-recursive mkdir. `recursive: true` is what produces the
  // iCloud shadow tree, and it appears nowhere in this package.
  if (!status.rootExists) mkdirSync(root);
  // realpath after creation: `resolveVaultPath` compares against the resolved
  // root, and on macOS `/var` is itself a symlink to `/private/var`.
  return new VaultSession(realpathSync(root), { ...DEFAULT_VAULT_CAPS, ...caps });
}
