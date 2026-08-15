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
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
import { isContainedIn, resolveVaultPath, type ResolvedVaultPath, type VaultTier } from './paths.ts';

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
