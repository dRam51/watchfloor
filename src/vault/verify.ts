/**
 * `vault verify` (M5 task 9) — §8.1's invariants, checked and **reported**.
 *
 * > `watchfloor vault verify` should check these invariants and report
 * > violations.
 *
 * ## It reports. It never fixes.
 *
 * There is no repair path in this module and there is deliberately no option
 * to add one. A tool that silently repairs is a tool that silently destroys
 * the day its model of "correct" is wrong, and what it would be operating on
 * is the owner's primary knowledge base — years of hand-written notes with no
 * backup in this system. Everything here reads; `vault prune` (`prune.ts`) is
 * the only job in the project allowed to remove anything, it is a separate
 * entrypoint, and its default is a dry run.
 *
 * ## The three invariants, and where each is checked
 *
 * | §8.1 rule | how verify checks it after the fact |
 * | --- | --- |
 * | never write to a hand-authored directory | every file with no frontmatter of ours is reported, and the ones sitting inside a managed area are reported louder — those are the ones a writer will collide with |
 * | never delete outside `watchfloor/` | nothing outside the sync root is even read: {@link scanVaultTree} does not follow symlinks and never climbs |
 * | never modify a file lacking our frontmatter | `foreign_in_managed_area` is exactly that population, named |
 *
 * ...plus the three-tier model, which is checked as `wrong_tier` (the tier a
 * file *claims* must be the tier its area *has*) and, for `entities/`, as the
 * marker protocol.
 *
 * ## What it deliberately does NOT check
 *
 * - **Whether a note's content is what today's corpus would produce.** That is
 *   a diff against a regeneration, it would be wrong the moment scores decay,
 *   and re-running sync is the answer to it anyway.
 * - **Anything above the sync root.** Not "we choose not to" — `scanVaultTree`
 *   cannot express it.
 * - **Whether the owner's hand-authored prose is correct.** Obviously; it is
 *   listed because "verify found 12 problems" would be the wrong reading of a
 *   perfectly healthy vault, which is why those are `info`.
 * - **Whether a `saved/` note that has no temp twin was edited.** See
 *   {@link VaultFindingCode}'s `saved_replaced`: the twin is the only evidence
 *   that exists, and when it is gone the honest answer is silence rather than
 *   a guess.
 */

import {
  hasManagedBlock,
  readWatchfloorFrontmatter,
  splitManagedBlock,
  type WatchfloorFrontmatter,
} from './frontmatter.ts';
import { checkVaultMount } from './mount.ts';
import { VAULT_AREAS, vaultAreaOf, type VaultArea, type VaultTier } from './paths.ts';
import { savedNotePath, type SavedItem } from './saved.ts';
import { readVaultText, scanVaultTree, VAULT_TEMP_PREFIX, type VaultEntry } from './session.ts';

export type VaultFindingSeverity = 'error' | 'warning' | 'info';

/**
 * Every state verify can name. The severities are the interesting part:
 *
 * - `info` is **not** "a minor problem". It is "this is what a healthy vault
 *   looks like, and you should be able to see it" — the owner's twelve notes,
 *   an entity note we appended to, the permanent temp link every `saved/` note
 *   carries. A verify run that printed nothing about them would be hiding the
 *   population §8.1 exists to protect.
 * - `warning` is "a write will not happen, or something is here that this
 *   package did not put here".
 * - `error` is "an invariant is broken".
 */
export type VaultFindingCode =
  /** The anchor is missing or unusable: iCloud is not there. Nothing was scanned. */
  | 'unmounted'
  /** The sync root does not exist. Normal after M5's destructive acceptance test. */
  | 'root_missing'
  /** A file with no frontmatter of ours, outside the four areas. The owner's. */
  | 'hand_authored'
  /** The same, but inside a managed area — where a writer will collide with it. */
  | 'foreign_in_managed_area'
  /** Our frontmatter declares a tier the area does not have. */
  | 'wrong_tier'
  /** Markers unbalanced, nested, or reversed. Nothing may touch this file. */
  | 'malformed_block'
  /** One of our `entities/` notes with no managed block at all. */
  | 'missing_block'
  /** A hand-authored note we appended a block to: §8.1's resolution, working. */
  | 'appended_block'
  /** A managed block somewhere it does not belong. */
  | 'block_outside_entities'
  /** `entities/` holds no notes. Reported because empty is the state today. */
  | 'entities_empty'
  /** A symlink under the sync root. Nothing here creates one. */
  | 'symlink'
  /** A directory that is not one of the four areas, or one nested inside them. */
  | 'unexpected_directory'
  /** A file that is neither `.md` nor one of our temp files. */
  | 'non_markdown'
  /** A temp file from an interrupted write. Prunable. */
  | 'temp_leftover'
  /** A `saved/` note's permanent hard link. Expected; prunable with proof. */
  | 'temp_hard_link'
  /**
   * A `saved/` note whose temp twin holds a *different, complete* rendering of
   * the same item — so the note was replaced after creation, which the
   * write-once tier forbids.
   */
  | 'saved_replaced'
  /** A `saved/` note whose filename disagrees with its own frontmatter. */
  | 'saved_filename_mismatch'
  /**
   * Two saved items compute the same `saved/` filename. Task 8's stated
   * residual: the second item is silently never promoted.
   */
  | 'saved_key_collision'
  /** The corpus says this item is saved and no note carries its key. */
  | 'saved_note_missing';

export interface VaultFinding {
  readonly code: VaultFindingCode;
  readonly severity: VaultFindingSeverity;
  /** `null` for a finding about the tree rather than about one file. */
  readonly relPath: string | null;
  readonly detail: string;
}

export interface VaultVerifyReport {
  readonly root: string;
  readonly mounted: boolean;
  readonly rootExists: boolean;
  readonly filesScanned: number;
  /** Notes per area, temp files excluded. */
  readonly notesByArea: Readonly<Record<VaultArea, number>>;
  readonly findings: readonly VaultFinding[];
}

export interface VaultVerifyOptions {
  readonly root: string;
  /** The owner's zone. A saved note's day label is in it, never UTC. */
  readonly tz: string;
  /**
   * Every item the corpus says is saved. Optional: verify is useful against a
   * vault alone, and only the last two findings need the database.
   */
  readonly savedIndex?: readonly SavedIndexEntry[];
}

/** The three fields a `saved/` filename is derived from. */
export interface SavedIndexEntry {
  readonly itemKey: string;
  readonly title: string;
  readonly savedAt: string;
}

const AREA_TIERS: Readonly<Record<VaultArea, VaultTier>> = {
  daily: 'fully-managed',
  weekly: 'fully-managed',
  entities: 'managed-block',
  saved: 'write-once',
};

function finding(
  code: VaultFindingCode,
  severity: VaultFindingSeverity,
  relPath: string | null,
  detail: string,
): VaultFinding {
  return { code, severity, relPath, detail };
}

/**
 * Checks one file and returns everything true of it.
 *
 * Written as a pure function of (path, area, bytes) so the classification can
 * be reasoned about without a filesystem in the way.
 */
function classifyFile(
  relPath: string,
  area: VaultArea | null,
  text: string | null,
): VaultFinding[] {
  const found: VaultFinding[] = [];
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);

  if (name.startsWith(VAULT_TEMP_PREFIX)) return found; // handled by the temp pass
  if (!name.endsWith('.md')) {
    found.push(
      finding(
        'non_markdown',
        'warning',
        relPath,
        'this package writes only Markdown notes, so nothing here created this',
      ),
    );
    return found;
  }
  if (text === null) return found; // vanished between the scan and the read

  const front = readWatchfloorFrontmatter(text);
  const split = splitManagedBlock(text);

  if (front === null) {
    if (split.kind === 'present' && area === 'entities') {
      // §8.1 argues with itself here and task 4 resolved it: a note a human
      // wrote is APPENDED to and is never given frontmatter, because
      // prepending would not be an append. So this shape is the resolution
      // working, not a violation.
      found.push(
        finding(
          'appended_block',
          'info',
          relPath,
          "a hand-authored note carrying our managed block; the owner's prose is outside it and stays",
        ),
      );
      return found;
    }
    if (split.kind === 'malformed') {
      found.push(
        finding('malformed_block', 'error', relPath, `markers are unusable: ${split.detail}`),
      );
      return found;
    }
    found.push(
      area === null
        ? finding(
            'hand_authored',
            'info',
            relPath,
            "no Watchfloor frontmatter: this is the owner's, and nothing in this package can address it",
          )
        : finding(
            'foreign_in_managed_area',
            'warning',
            relPath,
            `no Watchfloor frontmatter, inside ${area}/ — a write to this path will be refused as ` +
              'not_managed for as long as it sits here',
          ),
    );
    return found;
  }

  if (area !== null && front.tier !== AREA_TIERS[area]) {
    found.push(
      finding(
        'wrong_tier',
        'error',
        relPath,
        `declares tier ${front.tier} while sitting in ${area}/, whose tier is ${AREA_TIERS[area]}`,
      ),
    );
    return found;
  }

  if (split.kind === 'malformed') {
    found.push(
      finding('malformed_block', 'error', relPath, `markers are unusable: ${split.detail}`),
    );
    return found;
  }
  if (area === 'entities' && split.kind === 'absent') {
    found.push(
      finding(
        'missing_block',
        'warning',
        relPath,
        'one of our entity notes with no managed block; the next sync will append one',
      ),
    );
    return found;
  }
  if (area !== 'entities' && hasManagedBlock(text)) {
    found.push(
      finding(
        'block_outside_entities',
        'warning',
        relPath,
        'a managed block outside entities/, where the block protocol does not apply',
      ),
    );
  }
  return found;
}

/**
 * Everything the temp files say.
 *
 * Task 4 handed two of these forward deliberately, and telling them apart is
 * what keeps `vault prune` from destroying a saved note:
 *
 * - a **crash leftover** is a temp file nothing else points at;
 * - a **`saved/` twin** is a second *directory entry* for a note's own bytes,
 *   proven by inode equality, because `writeSavedNote` uses `link` rather than
 *   `rename` and `link` does not consume the temp name.
 *
 * The third case is the one worth the trouble: a temp file naming a note that
 * exists, holding a **different but complete** rendering of the same item.
 * That is not garbage — it is the original, still hard-linked under its temp
 * name, while the note itself has been replaced by an editor that writes
 * atomically. It is the only proof available that a write-once note changed
 * after creation, and it is why `vault prune` may never remove a temp file
 * whose inode does not match its twin.
 */
function classifyTempFiles(
  entries: readonly VaultEntry[],
  read: (relPath: string) => string | null,
): VaultFinding[] {
  const found: VaultFinding[] = [];
  const byPath = new Map(entries.map((entry) => [entry.relPath, entry]));

  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.startsWith(VAULT_TEMP_PREFIX)) continue;

    const dir = entry.relPath.slice(0, entry.relPath.lastIndexOf('/') + 1);
    // `${PREFIX}${basename(target)}.${pid}.${n}` — the note's own name is the
    // part between the prefix and the pid, so the twin is found by prefix
    // rather than by parsing a counter this module does not own.
    const stem = entry.name.slice(VAULT_TEMP_PREFIX.length);
    const twin = [...byPath.values()].find(
      (candidate) =>
        candidate.kind === 'file' &&
        !candidate.name.startsWith(VAULT_TEMP_PREFIX) &&
        candidate.relPath.startsWith(dir) &&
        candidate.relPath.slice(dir.length) === candidate.name &&
        stem.startsWith(`${candidate.name}.`),
    );

    if (twin !== undefined && twin.inode === entry.inode) {
      found.push(
        finding(
          'temp_hard_link',
          'info',
          entry.relPath,
          `a second directory entry for ${twin.relPath}, not a second copy — inode ${entry.inode}, ` +
            `${entry.nlink} links. Written by link(2), which is what makes write-once structural`,
        ),
      );
      continue;
    }

    if (twin !== undefined) {
      const tempText = read(entry.relPath);
      const twinText = read(twin.relPath);
      const tempFront = tempText === null ? null : readWatchfloorFrontmatter(tempText);
      const twinFront = twinText === null ? null : readWatchfloorFrontmatter(twinText);
      const sameItem =
        tempFront !== null &&
        twinFront !== null &&
        tempFront.fields.item_key !== undefined &&
        tempFront.fields.item_key === twinFront.fields.item_key;

      if (sameItem && tempText !== twinText) {
        found.push(
          finding(
            'saved_replaced',
            'error',
            twin.relPath,
            `a write-once note was replaced after creation: ${entry.relPath} is a complete, ` +
              'different rendering of the same item, still holding the original inode',
          ),
        );
        continue;
      }
    }

    found.push(
      finding(
        'temp_leftover',
        'warning',
        entry.relPath,
        `an interrupted write left this behind (${entry.bytes} bytes, ${entry.nlink} link` +
          `${entry.nlink === 1 ? '' : 's'}); nothing points at it`,
      ),
    );
  }
  return found;
}

/**
 * `savedNotePath` reads exactly three fields of a {@link SavedItem}. The rest
 * are named here rather than cast away with `as`, so that if the naming rule
 * ever grows a fourth input, `tsc` breaks in this function instead of it
 * quietly computing a stale name and reporting every saved note as misnamed.
 *
 * Re-deriving `{day}-{slug}-{12 hex}` locally would be the alternative, and it
 * would be a second implementation of the exact rule this check exists to
 * police.
 */
function expectedSavedPath(entry: SavedIndexEntry, tz: string): string {
  const item: SavedItem = {
    itemKey: entry.itemKey,
    title: entry.title,
    savedAt: entry.savedAt,
    canonicalUrl: '',
    sourceId: '',
    beats: [],
    entities: [],
    publishedAt: null,
    firstSeenAt: entry.savedAt,
    summaryRaw: null,
  };
  return savedNotePath(item, tz);
}

function stringField(front: WatchfloorFrontmatter, key: string): string | null {
  const value = front.fields[key];
  return typeof value === 'string' ? value : null;
}

/**
 * The `saved/` pass: does each note's filename still follow from the note's
 * own frontmatter, and which item is each note for?
 *
 * The filename is checked against the note's OWN recorded title, never against
 * the corpus's current one. Task 3 found ten live keys whose title changed
 * under an unchanged URL — *"Wall Street holds near its record"* became
 * *"slips back from its record"* — and a write-once note keeps the name it was
 * created with. Checking against today's title would report every one of those
 * as misnamed, which is the opposite of the truth.
 */
function classifySavedNotes(
  entries: readonly VaultEntry[],
  read: (relPath: string) => string | null,
  tz: string,
): { findings: VaultFinding[]; pathByKey: Map<string, string> } {
  const findings: VaultFinding[] = [];
  const pathByKey = new Map<string, string>();

  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    if (vaultAreaOf(entry.relPath) !== 'saved') continue;
    if (entry.name.startsWith(VAULT_TEMP_PREFIX) || !entry.name.endsWith('.md')) continue;

    const text = read(entry.relPath);
    const front = text === null ? null : readWatchfloorFrontmatter(text);
    if (front === null || front.tier !== 'write-once') continue; // reported elsewhere

    const itemKey = stringField(front, 'item_key');
    const title = stringField(front, 'title');
    const savedAt = stringField(front, 'saved_at');
    if (itemKey === null || title === null || savedAt === null) {
      findings.push(
        finding(
          'saved_filename_mismatch',
          'warning',
          entry.relPath,
          'the frontmatter is missing one of item_key, title or saved_at, so the filename this ' +
            'note should have cannot be derived from the note itself',
        ),
      );
      continue;
    }
    pathByKey.set(itemKey, entry.relPath);

    let expected: string;
    try {
      expected = expectedSavedPath({ itemKey, title, savedAt }, tz);
    } catch (err) {
      findings.push(
        finding(
          'saved_filename_mismatch',
          'warning',
          entry.relPath,
          `the filename cannot be derived from this note's own frontmatter: ${(err as Error).message}`,
        ),
      );
      continue;
    }
    if (expected !== entry.relPath) {
      findings.push(
        finding(
          'saved_filename_mismatch',
          'warning',
          entry.relPath,
          `its own frontmatter implies ${expected}. The note is never rewritten, so this is a ` +
            'record of the naming rule changing, not of the note being wrong',
        ),
      );
    }
  }
  return { findings, pathByKey };
}

/**
 * The two checks that need the corpus, and the reason they exist.
 *
 * Task 8 measured §8.1's `saved/{day}-{slug}.md` as unimplementable — 185
 * collision groups over 551 of 5,937 items, the largest being 24 distinct CVEs
 * CISA publishes under one identical title — and settled on an unconditional
 * 12-hex item-key suffix, leaving one stated residual:
 *
 * > Residual collision (12-hex agreement inside one day+slug bucket, ~10⁻¹²) is
 * > stated rather than hidden, and `vault verify` can close it.
 *
 * **The collision is between two items, not between two files.** One file is
 * all that can ever exist at the path: the second item's promotion is refused
 * as `exists`, and nothing on disk records that it was lost. So the check runs
 * over the corpus's saved set, where it is exact rather than probabilistic.
 */
function classifyCorpus(
  savedIndex: readonly SavedIndexEntry[],
  pathByKey: ReadonlyMap<string, string>,
  tz: string,
): VaultFinding[] {
  const findings: VaultFinding[] = [];
  const byPath = new Map<string, string[]>();

  for (const entry of savedIndex) {
    let path: string;
    try {
      path = expectedSavedPath(entry, tz);
    } catch {
      continue; // a malformed key is the corpus's problem, not the vault's
    }
    const keys = byPath.get(path) ?? [];
    if (!keys.includes(entry.itemKey)) keys.push(entry.itemKey);
    byPath.set(path, keys);
  }

  for (const [path, keys] of byPath) {
    if (keys.length > 1) {
      findings.push(
        finding(
          'saved_key_collision',
          'error',
          path,
          `${keys.length} saved items compute this same filename (${keys.join(', ')}), so only ` +
            'the first was ever promoted and the others were refused as already-present',
        ),
      );
    }
  }

  for (const entry of savedIndex) {
    if (pathByKey.has(entry.itemKey)) continue;
    findings.push(
      finding(
        'saved_note_missing',
        'warning',
        null,
        `the corpus says ${entry.itemKey} is saved and no note carries that key. Both causes are ` +
          'possible and this tool cannot tell them apart: the item was saved while the vault was ' +
          'unmounted (promotion runs at save time and there is deliberately no backfill), or the ' +
          'owner deleted the note. Nothing here will recreate it',
      ),
    );
  }
  return findings;
}

/**
 * Reads the vault and reports. Writes nothing, ever.
 */
export function verifyVault(options: VaultVerifyOptions): VaultVerifyReport {
  const { root } = options;
  const notesByArea: Record<VaultArea, number> = { daily: 0, weekly: 0, entities: 0, saved: 0 };

  const mount = checkVaultMount(root);
  if (!mount.mounted) {
    // "Zero findings" would read as "the vault is fine". It is not scanned.
    return {
      root,
      mounted: false,
      rootExists: false,
      filesScanned: 0,
      notesByArea,
      findings: [
        finding('unmounted', 'error', null, `${mount.detail} (${mount.reason}). ${mount.remedy}`),
      ],
    };
  }
  if (!mount.rootExists) {
    return {
      root,
      mounted: true,
      rootExists: false,
      filesScanned: 0,
      notesByArea,
      findings: [
        finding(
          'root_missing',
          'info',
          null,
          'the sync root does not exist; the next sync creates it and rebuilds daily/, weekly/ ' +
            'and entities/. saved/ is never regenerated',
        ),
      ],
    };
  }

  const entries = scanVaultTree(root);
  const read = (relPath: string): string | null => readVaultText(root, relPath);
  const findings: VaultFinding[] = [];
  let filesScanned = 0;

  for (const entry of entries) {
    const area = vaultAreaOf(entry.relPath);

    if (entry.kind === 'symlink') {
      findings.push(
        finding(
          'symlink',
          'warning',
          entry.relPath,
          'a symlink under the sync root: nothing in this package creates one, and it can point ' +
            'outside the subtree Watchfloor owns. Not followed',
        ),
      );
      continue;
    }
    if (entry.kind === 'directory') {
      const isArea =
        !entry.relPath.includes('/') && (VAULT_AREAS as readonly string[]).includes(entry.relPath);
      if (!isArea) {
        findings.push(
          finding(
            'unexpected_directory',
            'warning',
            entry.relPath,
            'not one of the four §8.1 areas; this package creates no other directory',
          ),
        );
      }
      continue;
    }
    if (entry.kind !== 'file') continue;

    filesScanned += 1;
    if (!entry.name.startsWith(VAULT_TEMP_PREFIX) && area !== null && entry.name.endsWith('.md')) {
      notesByArea[area] += 1;
    }
    findings.push(...classifyFile(entry.relPath, area, read(entry.relPath)));
  }

  findings.push(...classifyTempFiles(entries, read));

  const saved = classifySavedNotes(entries, read, options.tz);
  findings.push(...saved.findings);
  if (options.savedIndex !== undefined) {
    findings.push(...classifyCorpus(options.savedIndex, saved.pathByKey, options.tz));
  }

  if (entries.some((entry) => entry.relPath === 'entities' && entry.kind === 'directory')) {
    if (notesByArea.entities === 0) {
      findings.push(
        finding(
          'entities_empty',
          'info',
          'entities',
          'entities/ exists and holds no notes. Reported rather than passed over: `item_entities` ' +
            'has no rows and no extractor exists, so "the tree reproduces identically" is ' +
            'currently a claim about nothing',
        ),
      );
    }
  }

  return { root, mounted: true, rootExists: true, filesScanned, notesByArea, findings };
}
