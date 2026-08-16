/**
 * Path containment for the vault integration (M5 task 4).
 *
 * §8.1's first rule: **"Watchfloor owns exactly one subtree and never writes
 * outside it."** This module is where that stops being a convention and
 * becomes a type. Nothing else in `src/vault/` opens a file by a plain string
 * — every write takes a {@link ResolvedVaultPath}, and the only way to obtain
 * one is {@link resolveVaultPath}, which refuses anything it cannot prove is
 * inside the root.
 *
 * ## Two independent gates, and both matter
 *
 * 1. **Area.** A relative path's first segment must be one of
 *    {@link VAULT_AREAS}. There is no area for a bare filename, so a note
 *    sitting directly in the root — which is exactly where the owner's twelve
 *    hand-authored `Architecture.md`-class notes live — is not addressable by
 *    any call in this package. It is not "protected by a check"; there is no
 *    expressible request for it.
 * 2. **Containment.** After `..`/symlink resolution the absolute path must be
 *    strictly inside the root.
 *
 * The area gate is the stronger of the two, because it fails closed on paths
 * nobody thought about. A future task that wants to write somewhere new has to
 * add an area here, in one place, in a reviewed diff.
 *
 * ## Refuses, never clamps
 *
 * `path.resolve(root, '../Architecture.md')` returns the owner's note with no
 * error and no signal. Every refusal below throws a {@link VaultPathError}
 * carrying a machine-readable `reason`, because "the sync wrote nothing today"
 * and "the sync tried to write outside its subtree" are different facts and
 * collapsing them is how the second one goes unnoticed.
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';

/** The four directories §8.1 gives Watchfloor. Order is the tier order. */
export const VAULT_AREAS = ['daily', 'weekly', 'entities', 'saved'] as const;

export type VaultArea = (typeof VAULT_AREAS)[number];

/**
 * §8.1's three-tier model. The tier is a property of the area, never of the
 * caller — so a caller cannot ask for `saved/` to be treated as overwritable.
 *
 * - `fully-managed` — rewritten every run, idempotent overwrite, never append.
 * - `managed-block` — only the bytes between the markers may change.
 * - `write-once`    — written at creation, then never touched by any job.
 */
export type VaultTier = 'fully-managed' | 'managed-block' | 'write-once';

const AREA_TIERS: Readonly<Record<VaultArea, VaultTier>> = {
  daily: 'fully-managed',
  weekly: 'fully-managed',
  entities: 'managed-block',
  saved: 'write-once',
};

export type VaultPathRefusal =
  | 'empty'
  | 'absolute'
  | 'nul_byte'
  | 'backslash'
  | 'parent_traversal'
  | 'dot_segment'
  | 'unknown_area'
  | 'not_markdown'
  | 'root_unresolvable'
  | 'escapes_root';

export class VaultPathError extends Error {
  readonly reason: VaultPathRefusal;
  constructor(reason: VaultPathRefusal, relPath: string, detail: string) {
    super(`refusing vault path ${JSON.stringify(relPath)}: ${detail} (${reason})`);
    this.name = 'VaultPathError';
    this.reason = reason;
  }
}

declare const vaultPathBrand: unique symbol;

/**
 * An absolute filesystem path proven to sit inside the configured vault root,
 * inside one of {@link VAULT_AREAS}, after `..` and symlink resolution.
 *
 * Branded for the same reason `Excerpt` is in `src/domain/repo.ts`: a plain
 * `string` field would let any caller build the record by hand — or, worse,
 * spread a valid one and swap the path — and TypeScript would accept it. The
 * brand is declared and never defined, so it exists only in the type system:
 * no runtime property, nothing to serialise, and every string operation still
 * works. The escape hatch is an explicit `as VaultPath`, which is the point —
 * visible in review rather than silent.
 */
export type VaultPath = string & { readonly [vaultPathBrand]: true };

export interface ResolvedVaultPath {
  /** The absolute, symlink-resolved path. The only thing a writer may open. */
  readonly absolute: VaultPath;
  /** The normalised request, with `/` separators. For logging and error text. */
  readonly relPath: string;
  readonly area: VaultArea;
  readonly tier: VaultTier;
}

/**
 * Which §8.1 area a relative path belongs to, or `null` if none does.
 *
 * `null` is the answer for every hand-authored note in the root, for
 * `notes/`, and for any casing variant (`Daily/`) — because a filesystem that
 * is case-insensitive today may not be on the target host, and guessing which
 * directory the caller meant is exactly the kind of helpfulness that writes to
 * the wrong one.
 */
export function vaultAreaOf(relPath: string): VaultArea | null {
  const slash = relPath.indexOf('/');
  if (slash <= 0) return null; // no segment, or a bare filename with no area
  const head = relPath.slice(0, slash);
  return (VAULT_AREAS as readonly string[]).includes(head) ? (head as VaultArea) : null;
}

/**
 * Whether `target` lies strictly inside `root`. Pure — no filesystem access,
 * so it is testable against the string pairs that actually break containment
 * checks.
 *
 * Three properties this has and a naive `target.startsWith(root)` does not:
 *
 * - **The separator is required.** `/vault/watchfloor-old` is not inside
 *   `/vault/watchfloor`, and the owner's vault genuinely has sibling
 *   directories sharing a name prefix.
 * - **The root itself is not contained in itself.** The root is a directory,
 *   never a write target.
 * - **NFC and NFD spellings compare equal.** macOS stores filenames decomposed
 *   while a path typed into `.env` is composed; they are different strings for
 *   the same directory. Normalising only the COMPARISON (never the path that
 *   gets opened) means a real Unicode directory name is neither rewritten nor
 *   reported as an escape. Normalisation cannot introduce a separator or a
 *   `..`, so it cannot let anything out.
 *
 * Case is compared exactly, which on macOS means a case-variant spelling of
 * a real directory is refused. Refusing is the safe direction: the caller can
 * spell it the way the filesystem does.
 */
export function isContainedIn(root: string, target: string): boolean {
  const r = root.normalize('NFC');
  const t = target.normalize('NFC');
  return t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * The deepest existing ancestor of `p`, symlink-resolved, with the
 * not-yet-existing tail re-appended.
 *
 * `realpathSync` throws on a path that does not exist, and the common case
 * here is a file we are about to create. Resolving the deepest ancestor still
 * catches every symlink that could move the write: a symlinked parent
 * directory, and — when the file itself already exists — a symlinked file
 * pointing at a hand-authored note.
 *
 * ENOTDIR is walked past rather than surfaced: if a component is a regular
 * file, the containment answer is still well defined, and the write will fail
 * loudly at `open` with the kernel's own error rather than one invented here.
 * ELOOP and EACCES are deliberately NOT caught — a symlink cycle or an
 * unreadable ancestor is a real condition the caller must see.
 *
 * Exported for `session.ts`'s inspection primitives (M5 task 9), which need
 * the same resolution under a different set of syntactic rules. Sharing it is
 * the point: two implementations of "where does this path really land" is how
 * one of them ends up with the separator bug the other already fixed.
 */
export function realpathOfDeepestExisting(p: string): string {
  const tail: string[] = [];
  let current = p;
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync(current) : join(realpathSync(current), ...tail);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    }
    const parent = dirname(current);
    // dirname('/') === '/'. Reaching it means not even the filesystem root
    // resolved, which is not a condition worth inventing a recovery for.
    if (parent === current) throw new Error(`no existing ancestor for ${p}`);
    tail.unshift(basename(current));
    current = parent;
  }
}

/**
 * The only sanctioned way to turn a caller's request into something writable.
 *
 * Order matters: the cheap syntactic refusals run before any filesystem
 * access, so a malicious or buggy path never causes a `realpath` on an
 * attacker-chosen string.
 */
export function resolveVaultPath(root: string, relPath: string): ResolvedVaultPath {
  if (relPath.trim() === '') {
    throw new VaultPathError('empty', relPath, 'a vault path must name a file');
  }
  if (relPath.includes('\0')) {
    // Node truncates at a NUL in some paths and throws in others; neither is
    // a behaviour to depend on when the result is which file gets opened.
    throw new VaultPathError('nul_byte', relPath, 'contains a NUL byte');
  }
  if (relPath.includes('\\')) {
    // A backslash is a literal filename character on POSIX and a separator on
    // Windows. Refusing keeps one interpretation on every host.
    throw new VaultPathError('backslash', relPath, 'contains a backslash');
  }
  if (isAbsolute(relPath)) {
    throw new VaultPathError('absolute', relPath, 'vault paths are relative to the vault root');
  }

  const segments = relPath.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      throw new VaultPathError('parent_traversal', relPath, 'contains a `..` segment');
    }
  }
  for (const segment of segments) {
    // Refused even when it would resolve back inside: `.` and a leading dot
    // are how `daily/.obsidian/` and `daily/./x.md` reach places nobody meant
    // to address, and an empty segment is a `//` whose meaning varies.
    if (segment === '.' || segment === '' || segment.startsWith('.')) {
      throw new VaultPathError('dot_segment', relPath, 'contains an empty or dot-prefixed segment');
    }
  }

  const area = vaultAreaOf(relPath);
  if (area === null) {
    throw new VaultPathError(
      'unknown_area',
      relPath,
      `must start with one of ${VAULT_AREAS.join(', ')} — Watchfloor writes nowhere else`,
    );
  }

  if (!relPath.endsWith('.md')) {
    // Narrows the blast radius to Markdown notes: no config files, no
    // attachments, nothing Obsidian treats as machinery.
    throw new VaultPathError('not_markdown', relPath, 'must be a lowercase .md file');
  }

  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch (err) {
    throw new VaultPathError(
      'root_unresolvable',
      relPath,
      `vault root does not resolve: ${(err as Error).message}`,
    );
  }

  const absolute = realpathOfDeepestExisting(join(rootReal, ...segments));
  if (!isContainedIn(rootReal, absolute)) {
    throw new VaultPathError(
      'escapes_root',
      relPath,
      'resolves outside the vault root after symlink resolution',
    );
  }

  return {
    absolute: absolute as VaultPath,
    relPath,
    area,
    tier: AREA_TIERS[area],
  };
}
