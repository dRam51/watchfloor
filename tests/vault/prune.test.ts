import { describe, expect, it } from 'vitest';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pruneVault } from '../../src/vault/prune.ts';
import { renderManagedNote } from '../../src/vault/frontmatter.ts';
import { openVaultSession, scanVaultTree, VAULT_TEMP_PREFIX } from '../../src/vault/session.ts';
import {
  createFixtureVault,
  digestTree,
  EXISTING_SAVED_PATH,
  HAND_AUTHORED_ENTITY_PATH,
  HAND_AUTHORED_IN_MANAGED_PATH,
  HAND_AUTHORED_NOTES,
  listTree,
} from './fixture.ts';

/**
 * `vault prune` (M5 task 9) — the ONE job in this project allowed to delete.
 *
 * CLAUDE.md: *"Never delete anything."* The M5 plan carves out exactly this
 * one exception, and the test that matters is not "does it delete the right
 * things". It is **"does it leave everything else alone"** — so every case
 * below digests the whole vault before and after and asserts that the only
 * paths that changed are the ones named.
 *
 * The fixture carries the owner's real filenames. `Architecture.md`,
 * `Milestone 2 — Scoring.md` and the other ten sit directly in the sync root,
 * exactly where they would be if `WF_VAULT_ROOT` were pointed at
 * `01 Tech Projects/Watchfloor/` by mistake. Invented `foo.md` fixtures cannot
 * fail the way an em dash in a filename can.
 */

const GENERATED_AT = '2026-08-15T03:59:59.999Z';
const HOUR = 60 * 60 * 1000;

/**
 * The injected clock, two hours ahead of the files these tests create.
 *
 * Deliberately relative rather than a fixed instant: every fixture file is
 * written with the real clock, so a hard-coded `NOW` is only ever correct
 * until the wall clock passes it — the first version of this file used
 * `2026-08-16T00:00:00Z` and every temp file came out "too young" because the
 * machine had already passed it. Two hours clears the one-hour age gate with
 * room to spare.
 */
const NOW = Date.now() + 2 * HOUR;

function managed(tier: 'fully-managed' | 'write-once', body: string, fields = {}): string {
  return renderManagedNote({ tier, generatedAt: GENERATED_AT, body, fields });
}

/** Paths whose bytes differ between two digests, in either direction. */
function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [path, digest] of before) if (after.get(path) !== digest) changed.add(path);
  for (const [path, digest] of after) if (before.get(path) !== digest) changed.add(path);
  return [...changed].sort();
}

describe('pruneVault — a dry run is the default', () => {
  it('deletes nothing at all unless deletion is asked for explicitly', () => {
    const vault = createFixtureVault();
    writeFileSync(join(vault.root, 'daily', `${VAULT_TEMP_PREFIX}2026-08-15.md.4321.0`), 'half');
    const before = digestTree(vault.anchor);

    const result = pruneVault({ root: vault.root, nowMs: NOW });

    expect(result.applied).toBe(false);
    expect(result.candidates.map((c) => c.relPath)).toEqual([
      `daily/${VAULT_TEMP_PREFIX}2026-08-15.md.4321.0`,
    ]);
    expect(result.removed).toEqual([]);
    expect(changedPaths(before, digestTree(vault.anchor))).toEqual([]);
  });

  it('removes the same candidate once deletion is asked for, and nothing else', () => {
    const vault = createFixtureVault();
    const temp = `daily/${VAULT_TEMP_PREFIX}2026-08-15.md.4321.0`;
    writeFileSync(join(vault.root, temp), 'half');
    const before = digestTree(vault.anchor);

    const result = pruneVault({ root: vault.root, apply: true, nowMs: NOW });

    expect(result.removed).toEqual([temp]);
    expect(changedPaths(before, digestTree(vault.anchor))).toEqual([join('Watchfloor', temp)]);
  });
});

describe('pruneVault — everything it refuses to touch', () => {
  function pruneEverything(root: string) {
    return pruneVault({ root, apply: true, nowMs: NOW });
  }

  it('leaves all twelve hand-authored notes exactly as they were', () => {
    const vault = createFixtureVault();
    const before = digestTree(vault.root);

    pruneEverything(vault.root);

    const after = digestTree(vault.root);
    for (const [name] of HAND_AUTHORED_NOTES) {
      expect(after.get(name), `${name} must survive`).toBe(before.get(name));
    }
    expect(changedPaths(before, after)).toEqual([]);
  });

  it('leaves a hand-authored note that is sitting inside a managed area', () => {
    const vault = createFixtureVault();
    pruneEverything(vault.root);
    expect(digestTree(vault.root).has(HAND_AUTHORED_IN_MANAGED_PATH)).toBe(true);
  });

  it('never proposes an entities/ note, even one that is entirely ours', () => {
    // A managed-block note can carry the owner's prose above and below the
    // block, and nothing in this package can tell "ours" from "ours plus four
    // paragraphs the owner added". Deleting one is not a recoverable mistake.
    const vault = createFixtureVault();
    writeFileSync(
      join(vault.root, 'entities', 'OpenAI.md'),
      `---\nwatchfloor: managed\nwatchfloor_tier: managed-block\nwatchfloor_generated_at: ${GENERATED_AT}\n---\n\n# OpenAI\n`,
    );
    const before = digestTree(vault.root);

    const result = pruneVault({
      root: vault.root,
      apply: true,
      nowMs: NOW,
      expected: ['daily/2026-08-15.md'],
    });

    expect(result.candidates.some((c) => c.relPath.startsWith('entities/'))).toBe(false);
    expect(changedPaths(before, digestTree(vault.root))).toEqual([]);
  });

  it('never proposes a saved/ note — written once, then never touched by any job', () => {
    const vault = createFixtureVault();
    writeFileSync(join(vault.root, 'saved', '2026-08-15-kept-abcdefabcdef.md'), managed('write-once', '# Kept\n'));
    const before = digestTree(vault.root);

    const result = pruneVault({
      root: vault.root,
      apply: true,
      nowMs: NOW,
      expected: ['daily/2026-08-15.md'],
    });

    expect(result.candidates.some((c) => c.relPath === 'saved/2026-08-15-kept-abcdefabcdef.md')).toBe(false);
    expect(changedPaths(before, digestTree(vault.root))).toEqual([]);
    expect(digestTree(vault.root).has(EXISTING_SAVED_PATH)).toBe(true);
  });

  it('does not follow a symlink out of the tree, and does not remove the link either', () => {
    const vault = createFixtureVault();
    symlinkSync(join(vault.anchor, '02 Career'), join(vault.root, 'daily', 'elsewhere'));
    const before = digestTree(vault.anchor);

    const result = pruneEverything(vault.root);

    expect(result.removed).toEqual([]);
    expect(changedPaths(before, digestTree(vault.anchor))).toEqual([]);
    expect(listTree(vault.anchor)).toContain(join('02 Career', 'Resume.md'));
  });

  it('refuses to run at all against an unmounted vault', () => {
    // A shadow tree looks exactly like a real one that has lost its contents.
    const result = pruneVault({ root: join('does-not-exist', 'watchfloor'), apply: true, nowMs: NOW });
    expect(result.mounted).toBe(false);
    expect(result.removed).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it('leaves a temp file that is too young, in case a sync is writing it right now', () => {
    const vault = createFixtureVault();
    const temp = join(vault.root, 'daily', `${VAULT_TEMP_PREFIX}2026-08-15.md.4321.0`);
    writeFileSync(temp, 'half');

    const result = pruneVault({ root: vault.root, apply: true, nowMs: statSync(temp).mtimeMs + 1000 });

    expect(result.removed).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toContain('too_young');
  });
});

/**
 * The hazard task 4 handed forward, in its own block because it is the one
 * that can destroy something irreplaceable.
 *
 * > **One permanent temp hard link per `saved/` note.** `link` does not consume
 * > the temp name the way `rename` does. It is a *directory entry*, not a
 * > second copy of the bytes — asserted by inode equality.
 *
 * Two names, one inode. Delete the wrong one and the note is gone.
 */
describe('pruneVault — the saved/ hard-link pair', () => {
  const KEY = 'a'.repeat(64);
  const REL = `saved/2026-08-15-a-piece-${'a'.repeat(12)}.md`;

  function vaultWithSavedNote() {
    const vault = createFixtureVault();
    const session = openVaultSession(vault.root);
    session.writeSavedNote(
      REL,
      managed('write-once', '# A piece\n', { item_key: KEY, title: 'A piece', saved_at: GENERATED_AT }) as never,
    );
    return vault;
  }

  it('the fixture really does produce two names for one inode', () => {
    // Non-vacuity: if `writeSavedNote` ever stops leaving the link, every
    // assertion below would pass while testing nothing.
    const vault = vaultWithSavedNote();
    const entries = scanVaultTree(vault.root).filter((e) => e.relPath.startsWith('saved/'));
    const note = entries.find((e) => e.relPath === REL);
    const temp = entries.find((e) => e.name.startsWith(VAULT_TEMP_PREFIX));

    expect(note?.nlink).toBe(2);
    expect(temp?.inode).toBe(note?.inode);
  });

  it('removes the temp entry and leaves the note byte-identical', () => {
    const vault = vaultWithSavedNote();
    const noteBytes = readFileSync(join(vault.root, REL), 'utf8');

    const result = pruneVault({ root: vault.root, apply: true, nowMs: NOW });

    expect(result.removed.every((rel) => rel.includes(VAULT_TEMP_PREFIX))).toBe(true);
    expect(readFileSync(join(vault.root, REL), 'utf8')).toBe(noteBytes);
    // The bytes survived because the note's own directory entry was never the
    // one removed: the link count drops from two to one.
    expect(statSync(join(vault.root, REL)).nlink).toBe(1);
  });

  it('never names the saved note itself as a candidate, whatever else it decides', () => {
    const vault = vaultWithSavedNote();
    const result = pruneVault({ root: vault.root, nowMs: NOW });
    expect(result.candidates.map((c) => c.relPath)).not.toContain(REL);
  });

  it('refuses the temp entry when the twin cannot be proven by inode', () => {
    // A temp file whose inode does NOT match the note is not a spare directory
    // entry — it is a separate file, and the only case where that happens to a
    // write-once note is one that was replaced after creation. That temp holds
    // the ORIGINAL bytes and is the only evidence the note changed.
    const vault = vaultWithSavedNote();
    const scratch = join(vault.root, 'saved', 'scratch');
    writeFileSync(scratch, managed('write-once', '# A piece\n\nEdited by hand.\n', { item_key: KEY }));
    renameSync(scratch, join(vault.root, REL));
    const before = digestTree(vault.root);

    const result = pruneVault({ root: vault.root, apply: true, nowMs: NOW });

    expect(result.removed).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toContain('inode_mismatch');
    expect(changedPaths(before, digestTree(vault.root))).toEqual([]);
  });

  it('refuses a hard-linked temp file whose partner is outside the tree', () => {
    // A REAL second directory entry, made with link(2) — an earlier version of
    // this test copied the bytes instead, which produces a second file with
    // `nlink` 1 and proves nothing at all about the hard-link rule.
    const vault = createFixtureVault();
    const outside = join(vault.anchor, '02 Career', 'Resume.md');
    const temp = join(vault.root, 'daily', `${VAULT_TEMP_PREFIX}linked.md.1.0`);
    linkSync(outside, temp);
    const before = digestTree(vault.anchor);

    const result = pruneVault({ root: vault.root, apply: true, nowMs: NOW });

    // No note in daily/ names it, and its bytes are reachable under a name
    // this tool cannot see. Refused rather than tidied.
    expect(result.removed).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toContain('unpaired_hard_link');
    expect(changedPaths(before, digestTree(vault.anchor))).toEqual([]);
    expect(digestTree(vault.anchor).has(join('02 Career', 'Resume.md'))).toBe(true);
  });
});

describe('pruneVault — stale fully-managed notes need a manifest', () => {
  function withNotes() {
    const vault = createFixtureVault();
    mkdirSync(join(vault.root, 'weekly'));
    writeFileSync(join(vault.root, 'daily', '2026-08-15.md'), managed('fully-managed', '# Today\n'));
    writeFileSync(join(vault.root, 'daily', '2026-08-14.md'), managed('fully-managed', '# Yesterday\n'));
    return vault;
  }

  it('proposes a managed note the manifest does not mention', () => {
    const vault = withNotes();
    const result = pruneVault({
      root: vault.root,
      apply: true,
      nowMs: NOW,
      expected: ['daily/2026-08-15.md'],
    });

    expect(result.removed).toEqual(['daily/2026-08-14.md']);
    expect(digestTree(vault.root).has('daily/2026-08-15.md')).toBe(true);
  });

  it('proposes nothing when no manifest is supplied', () => {
    const vault = withNotes();
    const before = digestTree(vault.root);

    const result = pruneVault({ root: vault.root, apply: true, nowMs: NOW });

    expect(result.candidates.some((c) => c.reason === 'stale_managed_note')).toBe(false);
    expect(changedPaths(before, digestTree(vault.root))).toEqual([]);
  });

  it('refuses an EMPTY manifest rather than treating it as "delete everything"', () => {
    // A caller whose corpus query returned nothing is the failure mode here,
    // and it is indistinguishable from a legitimately empty week.
    const vault = withNotes();
    const before = digestTree(vault.root);

    const result = pruneVault({ root: vault.root, apply: true, nowMs: NOW, expected: [] });

    expect(result.removed).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toContain('empty_manifest');
    expect(changedPaths(before, digestTree(vault.root))).toEqual([]);
  });

  it('refuses the whole run when more files are proposed than the cap allows', () => {
    const vault = withNotes();
    for (let i = 0; i < 8; i += 1) {
      writeFileSync(join(vault.root, 'daily', `2026-07-0${i}.md`), managed('fully-managed', `# ${i}\n`));
    }
    const before = digestTree(vault.root);

    const result = pruneVault({
      root: vault.root,
      apply: true,
      nowMs: NOW,
      expected: ['daily/2026-08-15.md'],
      maxDeletionsPerRun: 3,
    });

    // Deleting the first three and stopping would leave an arbitrary subset and
    // look like it worked. A run this size wants a human to look at it.
    expect(result.removed).toEqual([]);
    expect(result.refused).toBe('deletion_cap');
    expect(changedPaths(before, digestTree(vault.root))).toEqual([]);
  });

  it('leaves the hand-authored note in daily/ out of it even with a manifest', () => {
    const vault = withNotes();
    const result = pruneVault({
      root: vault.root,
      apply: true,
      nowMs: NOW,
      expected: ['daily/2026-08-15.md'],
    });

    expect(result.removed).not.toContain(HAND_AUTHORED_IN_MANAGED_PATH);
    expect(digestTree(vault.root).has(HAND_AUTHORED_IN_MANAGED_PATH)).toBe(true);
    expect(digestTree(vault.root).has(HAND_AUTHORED_ENTITY_PATH)).toBe(true);
  });
});
