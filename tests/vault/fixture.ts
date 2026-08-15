/**
 * A fixture vault built around the owner's REAL hand-authored filenames.
 *
 * The M5 ledger's hazard note is the reason this file exists:
 *
 * > The owner's vault already contains 12 hand-authored notes under
 * > `01 Tech Projects/Watchfloor/` [...] They are prose written by hand, and
 * > none of them carries Watchfloor sync frontmatter. [...] if the sync root
 * > were ever pointed at that directory, `daily/`/`weekly/` are "fully
 * > managed, rewritten every run".
 *
 * So the fixture models the worst case rather than a comfortable one: the
 * twelve notes sit **directly inside the sync root**, exactly as they would if
 * `WF_VAULT_ROOT` were pointed at `01 Tech Projects/Watchfloor/` — an easy
 * mistake, because the directory name matches.
 *
 * Invented `foo.md` fixtures cannot fail the way this does. A path check that
 * happens to work for `a/b.md` and breaks on an em dash, a space, or a
 * digit-leading filename is a real class of bug, and every one of those
 * appears in the real names below.
 *
 * Counts, verified against the live vault on 2026-08-15: twelve files, of
 * which FOUR are milestone notes (Milestone 0 through Milestone 3). The ledger
 * says "five milestone notes"; it is off by one, and the total of twelve is
 * right.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

/**
 * The real filenames, with prose in the shape of the real notes: an H1, a
 * paragraph, no frontmatter of any kind.
 */
export const HAND_AUTHORED_NOTES: ReadonlyArray<readonly [string, string]> = [
  ['Architecture.md', '# Architecture\n\nSix beats, one SQLite file, append-only items.\n'],
  ['Open Questions.md', '# Open Questions\n\n- Does `item_type` need the M4b rework?\n'],
  ['Settled Decisions.md', '# Settled Decisions\n\nNode 26. Branchless on `main`.\n'],
  ['Standing Rules.md', '# Standing Rules\n\nNever delete anything. Zero-dollar by default.\n'],
  ['Portability Debt.md', '# Portability Debt\n\nThe vault is on iCloud Drive.\n'],
  ['Source Inventory.md', '# Source Inventory\n\n28 sources, all robots-verified.\n'],
  ['Plan Corrections.md', '# Plan Corrections\n\nThe M1 plan was corrected five times.\n'],
  ['Watchfloor.md', '# Watchfloor\n\nSingle-user situational-awareness dashboard.\n'],
  ['Milestone 0 — Scaffold.md', '# Milestone 0 — Scaffold\n\nDone.\n'],
  ['Milestone 1 — Ingest.md', '# Milestone 1 — Ingest\n\nRecovered after five corrections.\n'],
  ['Milestone 2 — Scoring.md', '# Milestone 2 — Scoring\n\nClustering chained 1,543 CVEs.\n'],
  ['Milestone 3 — API and Dashboard.md', '# Milestone 3 — API and Dashboard\n\n12 tasks.\n'],
] as const;

/** A hand-written entity note: the M5 acceptance case, inside a managed area. */
export const HAND_AUTHORED_ENTITY_PATH = 'entities/Anthropic.md';
export const HAND_AUTHORED_ENTITY_TEXT =
  '# Anthropic\n\nMy own reading notes. Constitutional AI, the RSP, and why the\n' +
  'interpretability work matters more than the model releases.\n';

/** A hand-written note a human dropped inside a FULLY-MANAGED directory. */
export const HAND_AUTHORED_IN_MANAGED_PATH = 'daily/Scratch.md';
export const HAND_AUTHORED_IN_MANAGED_TEXT = '# Scratch\n\nNotes I keep here on purpose.\n';

/** A `saved/` note that already exists. §8.1: never touched again by any job. */
export const EXISTING_SAVED_PATH = 'saved/2026-08-01-a-piece-i-kept.md';
export const EXISTING_SAVED_TEXT = '# A piece I kept\n\nWith a line I later fixed by hand.\n';

export interface FixtureVault {
  /** The Obsidian vault directory: the sync root's parent. */
  readonly anchor: string;
  /** The sync root — named to match the real `01 Tech Projects/Watchfloor`. */
  readonly root: string;
}

/**
 * Builds a vault in a real temp directory. No mocks: real directories, real
 * files, real permissions.
 *
 * Nothing here is ever cleaned up, matching every other test in this project
 * (`mkdtempSync` with no teardown) and CLAUDE.md's never-delete rule.
 */
export function createFixtureVault(): FixtureVault {
  const anchor = mkdtempSync(join(tmpdir(), 'wf-vault-'));

  // Siblings of the sync root, inside the vault. Nothing may ever touch these.
  mkdirSync(join(anchor, '.obsidian'));
  writeFileSync(join(anchor, '.obsidian', 'app.json'), '{}\n');
  mkdirSync(join(anchor, '02 Career'));
  writeFileSync(join(anchor, '02 Career', 'Resume.md'), '# Resume\n\nMine.\n');
  writeFileSync(join(anchor, 'VAULT-INDEX.md'), '# Vault index\n');

  const root = join(anchor, 'Watchfloor');
  mkdirSync(root);
  for (const [name, text] of HAND_AUTHORED_NOTES) {
    writeFileSync(join(root, name), text);
  }

  mkdirSync(join(root, 'entities'));
  writeFileSync(join(root, HAND_AUTHORED_ENTITY_PATH), HAND_AUTHORED_ENTITY_TEXT);
  mkdirSync(join(root, 'daily'));
  writeFileSync(join(root, HAND_AUTHORED_IN_MANAGED_PATH), HAND_AUTHORED_IN_MANAGED_TEXT);
  mkdirSync(join(root, 'saved'));
  writeFileSync(join(root, EXISTING_SAVED_PATH), EXISTING_SAVED_TEXT);

  return { anchor, root };
}

/**
 * sha256 of every regular file under `dir`, keyed by path relative to it.
 *
 * A digest rather than an mtime comparison: a rewrite with identical content
 * still moves the mtime, and a rewrite with different content inside the same
 * second does not. The question here is only ever "are these bytes the bytes
 * that were there", and the digest answers exactly that.
 */
export function digestTree(dir: string): Map<string, string> {
  const digests = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        digests.set(
          relative(dir, full),
          createHash('sha256').update(readFileSync(full)).digest('hex'),
        );
      }
    }
  };
  walk(dir);
  return digests;
}

/** Every path under `dir`, so a test can assert nothing NEW appeared either. */
export function listTree(dir: string): string[] {
  return [...digestTree(dir).keys()].sort();
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
