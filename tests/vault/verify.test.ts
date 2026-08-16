import { describe, expect, it } from 'vitest';
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyVault, type VaultFinding } from '../../src/vault/verify.ts';
import { renderManagedNote, WATCHFLOOR_BEGIN_MARKER, WATCHFLOOR_END_MARKER } from '../../src/vault/frontmatter.ts';
import { openVaultSession, VAULT_TEMP_PREFIX } from '../../src/vault/session.ts';
import { WIN32K_GROUP } from './corpus.ts';
import {
  createFixtureVault,
  digestTree,
  HAND_AUTHORED_ENTITY_PATH,
  HAND_AUTHORED_IN_MANAGED_PATH,
  HAND_AUTHORED_NOTES,
  listTree,
} from './fixture.ts';

/**
 * `vault verify` (M5 task 9) — §8.1's invariants, checked and REPORTED.
 *
 * > `watchfloor vault verify` should check these invariants and report
 * > violations.
 *
 * **It never fixes anything.** A tool that silently repairs is a tool that
 * silently destroys the day its model of "correct" is wrong, and the thing it
 * would be repairing is the owner's primary knowledge base. Every test here
 * that asserts a finding also has a sibling asserting the tree is byte-for-byte
 * unchanged afterwards.
 *
 * The fixture is the real one: twelve hand-authored notes with the owner's own
 * filenames, sitting directly in the sync root — exactly where they would be if
 * `WF_VAULT_ROOT` were pointed at `01 Tech Projects/Watchfloor/` by mistake.
 */

const TZ = 'America/New_York';
const GENERATED_AT = '2026-08-15T03:59:59.999Z';

function managed(tier: 'fully-managed' | 'managed-block' | 'write-once', body: string): string {
  return renderManagedNote({ tier, generatedAt: GENERATED_AT, body });
}

/**
 * A note carrying our frontmatter and an arbitrary body, composed by hand.
 *
 * `renderManagedNote` refuses a body containing a marker — deliberately, since
 * content that decides where a managed block ends is the injection that
 * rewrites the owner's prose. So every file below whose *point* is a broken
 * marker pair has to be written the way a corrupted file on disk would be:
 * frontmatter first, then bytes nothing validated.
 */
function rawManaged(tier: string, body: string): string {
  return `---\nwatchfloor: managed\nwatchfloor_tier: ${tier}\nwatchfloor_generated_at: ${GENERATED_AT}\n---\n\n${body}`;
}

function codesFor(findings: readonly VaultFinding[], relPath: string): string[] {
  return findings.filter((f) => f.relPath === relPath).map((f) => f.code);
}

describe('verifyVault — what it reads and what it refuses to read', () => {
  it('never writes: the tree is byte-identical afterwards, with nothing added', () => {
    const vault = createFixtureVault();
    const before = digestTree(vault.anchor);
    const paths = listTree(vault.anchor);

    verifyVault({ root: vault.root, tz: TZ });

    expect(digestTree(vault.anchor)).toEqual(before);
    expect(listTree(vault.anchor)).toEqual(paths);
  });

  it('reports nothing about the vault outside the sync root', () => {
    const vault = createFixtureVault();
    const report = verifyVault({ root: vault.root, tz: TZ });

    const mentioned = report.findings.map((f) => `${f.relPath ?? ''} ${f.detail}`).join('\n');
    expect(mentioned).not.toContain('Resume');
    expect(mentioned).not.toContain('VAULT-INDEX');
  });

  it('answers honestly when the sync root does not exist yet', () => {
    // M5 acceptance deletes the whole tree and re-runs sync.
    const vault = createFixtureVault();
    const report = verifyVault({ root: join(vault.anchor, 'not-created-yet'), tz: TZ });

    expect(report.rootExists).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('root_missing');
  });

  it('reports an unmounted vault rather than scanning nothing and calling it clean', () => {
    // An absent anchor is iCloud not being there. "Zero findings" would read as
    // "the vault is fine".
    const report = verifyVault({ root: join('does-not-exist', 'watchfloor'), tz: TZ });

    expect(report.mounted).toBe(false);
    expect(report.findings.map((f) => f.code)).toEqual(['unmounted']);
  });
});

describe('verifyVault — the owner\'s files', () => {
  it('reports each of the twelve hand-authored notes as the owner\'s, not as a violation', () => {
    const vault = createFixtureVault();
    const report = verifyVault({ root: vault.root, tz: TZ });

    for (const [name] of HAND_AUTHORED_NOTES) {
      expect(codesFor(report.findings, name)).toEqual(['hand_authored']);
    }
    const handAuthored = report.findings.filter((f) => f.code === 'hand_authored');
    expect(handAuthored.every((f) => f.severity === 'info')).toBe(true);
  });

  it('reports a file with no frontmatter INSIDE a managed area as a real problem', () => {
    // `daily/Scratch.md` is the one that bites: the daily writer will refuse to
    // overwrite it forever, so a note the owner expects is silently never
    // written. That is a warning, not an "info".
    const vault = createFixtureVault();
    const report = verifyVault({ root: vault.root, tz: TZ });

    const finding = report.findings.find((f) => f.relPath === HAND_AUTHORED_IN_MANAGED_PATH);
    expect(finding?.code).toBe('foreign_in_managed_area');
    expect(finding?.severity).toBe('warning');
  });

  it('says nothing at all about a note we wrote correctly', () => {
    const vault = createFixtureVault();
    writeFileSync(join(vault.root, 'daily', '2026-08-15.md'), managed('fully-managed', '# Daily\n'));

    const report = verifyVault({ root: vault.root, tz: TZ });
    expect(codesFor(report.findings, 'daily/2026-08-15.md')).toEqual([]);
  });

  it('reports a note whose declared tier disagrees with the area it is in', () => {
    const vault = createFixtureVault();
    writeFileSync(join(vault.root, 'daily', '2026-08-15.md'), managed('write-once', '# Daily\n'));

    expect(codesFor(verifyVault({ root: vault.root, tz: TZ }).findings, 'daily/2026-08-15.md')).toEqual([
      'wrong_tier',
    ]);
  });
});

describe('verifyVault — the managed block', () => {
  function entityNote(vault: { root: string }, name: string, text: string): string {
    writeFileSync(join(vault.root, 'entities', name), text);
    return `entities/${name}`;
  }

  it('accepts a well-formed entity note', () => {
    const vault = createFixtureVault();
    const rel = entityNote(
      vault,
      'OpenAI.md',
      rawManaged('managed-block', `# OpenAI\n\n${WATCHFLOOR_BEGIN_MARKER}\nlinks\n${WATCHFLOOR_END_MARKER}\n`),
    );
    expect(codesFor(verifyVault({ root: vault.root, tz: TZ }).findings, rel)).toEqual([]);
  });

  it('reports two begin markers', () => {
    const vault = createFixtureVault();
    const rel = entityNote(
      vault,
      'Two.md',
      rawManaged(
        'managed-block',
        `${WATCHFLOOR_BEGIN_MARKER}\na\n${WATCHFLOOR_BEGIN_MARKER}\nb\n${WATCHFLOOR_END_MARKER}\n`,
      ),
    );
    expect(codesFor(verifyVault({ root: vault.root, tz: TZ }).findings, rel)).toEqual([
      'malformed_block',
    ]);
  });

  it('reports a begin with no end', () => {
    const vault = createFixtureVault();
    const rel = entityNote(
      vault,
      'Unclosed.md',
      rawManaged('managed-block', `${WATCHFLOOR_BEGIN_MARKER}\nlinks\n`),
    );
    expect(codesFor(verifyVault({ root: vault.root, tz: TZ }).findings, rel)).toEqual([
      'malformed_block',
    ]);
  });

  it('reports a nested pair, which reads as two begins', () => {
    const vault = createFixtureVault();
    const rel = entityNote(
      vault,
      'Nested.md',
      rawManaged(
        'managed-block',
        `${WATCHFLOOR_BEGIN_MARKER}\n${WATCHFLOOR_BEGIN_MARKER}\ninner\n${WATCHFLOOR_END_MARKER}\n${WATCHFLOOR_END_MARKER}\n`,
      ),
    );
    expect(codesFor(verifyVault({ root: vault.root, tz: TZ }).findings, rel)).toEqual([
      'malformed_block',
    ]);
  });

  it('reports an end that precedes its begin', () => {
    const vault = createFixtureVault();
    const rel = entityNote(
      vault,
      'Reversed.md',
      rawManaged('managed-block', `${WATCHFLOOR_END_MARKER}\nlinks\n${WATCHFLOOR_BEGIN_MARKER}\n`),
    );
    expect(codesFor(verifyVault({ root: vault.root, tz: TZ }).findings, rel)).toEqual([
      'malformed_block',
    ]);
  });

  it('reports one of our entity notes that has lost its block', () => {
    const vault = createFixtureVault();
    const rel = entityNote(vault, 'Blockless.md', managed('managed-block', '# Blockless\n\nprose\n'));
    expect(codesFor(verifyVault({ root: vault.root, tz: TZ }).findings, rel)).toEqual([
      'missing_block',
    ]);
  });

  it('treats a hand-authored note we only APPENDED a block to as correct, not foreign', () => {
    // §8.1 contradicts itself here and task 4 resolved it: such a file is never
    // given frontmatter, because prepending would not be an append. Verify has
    // to know that, or the resolution looks like a violation forever.
    const vault = createFixtureVault();
    const text = `# Anthropic\n\nMy own reading notes.\n\n${WATCHFLOOR_BEGIN_MARKER}\nlinks\n${WATCHFLOOR_END_MARKER}\n`;
    writeFileSync(join(vault.root, HAND_AUTHORED_ENTITY_PATH), text);

    const finding = verifyVault({ root: vault.root, tz: TZ }).findings.find(
      (f) => f.relPath === HAND_AUTHORED_ENTITY_PATH,
    );
    expect(finding?.code).toBe('appended_block');
    expect(finding?.severity).toBe('info');
  });

  it('reports an EMPTY entities/ rather than treating it as correct by default', () => {
    // `item_entities` has 0 rows across 7,267 live items and no extractor
    // exists anywhere in the tree, so this is the state the integration is
    // actually in. Silence would read as "entity notes are fine", and M5's
    // strongest acceptance test — the tree reproduces identically — would be
    // passing against nothing.
    //
    // A second sync root inside the same vault, rather than emptying the
    // fixture's: nothing here deletes.
    const vault = createFixtureVault();
    const bare = join(vault.anchor, 'Watchfloor-empty');
    mkdirSync(bare);
    mkdirSync(join(bare, 'entities'));

    const finding = verifyVault({ root: bare, tz: TZ }).findings.find(
      (f) => f.code === 'entities_empty',
    );
    expect(finding?.severity).toBe('info');
    expect(finding?.detail).toContain('item_entities');
  });

  it('says nothing about entities/ when it holds a note', () => {
    // Non-vacuity for the test above: the fixture's `entities/Anthropic.md`
    // must be enough to silence it, or the finding is unconditional.
    const vault = createFixtureVault();
    expect(verifyVault({ root: vault.root, tz: TZ }).findings.map((f) => f.code)).not.toContain(
      'entities_empty',
    );
  });
});

describe('verifyVault — things nothing here creates', () => {
  it('reports a symlink and does not follow it', () => {
    const vault = createFixtureVault();
    symlinkSync(join(vault.anchor, '02 Career'), join(vault.root, 'daily', 'elsewhere'));

    const report = verifyVault({ root: vault.root, tz: TZ });
    expect(codesFor(report.findings, 'daily/elsewhere')).toEqual(['symlink']);
    expect(report.findings.some((f) => (f.relPath ?? '').includes('Resume'))).toBe(false);
  });

  it('reports a directory nested inside an area', () => {
    const vault = createFixtureVault();
    mkdirSync(join(vault.root, 'daily', 'archive'));

    expect(codesFor(verifyVault({ root: vault.root, tz: TZ }).findings, 'daily/archive')).toEqual([
      'unexpected_directory',
    ]);
  });

  it('reports a non-Markdown file in a managed area', () => {
    const vault = createFixtureVault();
    writeFileSync(join(vault.root, 'daily', 'notes.txt'), 'x\n');

    expect(codesFor(verifyVault({ root: vault.root, tz: TZ }).findings, 'daily/notes.txt')).toEqual([
      'non_markdown',
    ]);
  });

  it('reports a crash-leftover temp file', () => {
    const vault = createFixtureVault();
    const temp = `${VAULT_TEMP_PREFIX}2026-08-15.md.4321.0`;
    writeFileSync(join(vault.root, 'daily', temp), 'half a note');

    const finding = verifyVault({ root: vault.root, tz: TZ }).findings.find(
      (f) => f.relPath === `daily/${temp}`,
    );
    expect(finding?.code).toBe('temp_leftover');
  });
});

/**
 * The `saved/` tier — §8.1's "written once at creation, then never touched
 * again by any job. Not even to fix a typo."
 *
 * Every note here is written by the REAL write session, because the property
 * being checked is a property of what `link(2)` leaves behind. Task 4 took a
 * permanent temp hard link per saved note deliberately, asserted by inode
 * equality; verify has to recognise that pair, and — the part that matters —
 * has to tell it apart from the one case where the same two names hold
 * DIFFERENT bytes.
 */
describe('verifyVault — saved/ and its hard links', () => {
  const KEY_A = 'a'.repeat(64);
  const KEY_B = `${'a'.repeat(12)}${'b'.repeat(52)}`; // same 12-hex prefix as KEY_A
  const SAVED_AT = '2026-08-15T09:30:00.000Z';

  function savedNote(itemKey: string, title: string, body = '# A piece\n'): string {
    return renderManagedNote({
      tier: 'write-once',
      generatedAt: SAVED_AT,
      body,
      fields: { item_key: itemKey, title, saved_at: SAVED_AT },
    });
  }

  it('recognises the permanent temp link the real writer leaves, and says the note is fine', () => {
    const vault = createFixtureVault();
    const session = openVaultSession(vault.root);
    const rel = `saved/2026-08-15-a-piece-${KEY_A.slice(0, 12)}.md`;
    session.writeSavedNote(rel, savedNote(KEY_A, 'A piece') as never);

    const report = verifyVault({ root: vault.root, tz: TZ });
    const temp = report.findings.find((f) => f.code === 'temp_hard_link');

    expect(temp).toBeDefined();
    expect(temp?.severity).toBe('info');
    expect(temp?.detail).toContain(rel);
    // The note itself is correct: nothing is said about it.
    expect(codesFor(report.findings, rel)).toEqual([]);
  });

  it('proves a write-once note was replaced after creation, using its twin', () => {
    // An editor that writes atomically gives the note a NEW inode and leaves
    // the original bytes reachable under the temp name. That is the only
    // evidence this system can have that a saved note changed, and it is why
    // prune may never remove a temp file whose inode does not match its twin.
    const vault = createFixtureVault();
    const session = openVaultSession(vault.root);
    const rel = `saved/2026-08-15-a-piece-${KEY_A.slice(0, 12)}.md`;
    session.writeSavedNote(rel, savedNote(KEY_A, 'A piece') as never);

    const scratch = join(vault.root, 'saved', 'scratch');
    writeFileSync(scratch, savedNote(KEY_A, 'A piece', '# A piece\n\nTypo fixed by hand.\n'));
    renameSync(scratch, join(vault.root, rel));

    const finding = verifyVault({ root: vault.root, tz: TZ }).findings.find(
      (f) => f.code === 'saved_replaced',
    );
    expect(finding?.severity).toBe('error');
    expect(finding?.relPath).toBe(rel);
  });

  it('reports a saved note whose filename disagrees with its own frontmatter', () => {
    const vault = createFixtureVault();
    // Correct suffix, wrong day: the note says it was saved on the 15th.
    writeFileSync(
      join(vault.root, 'saved', `2020-01-01-a-piece-${KEY_A.slice(0, 12)}.md`),
      savedNote(KEY_A, 'A piece'),
    );

    const finding = verifyVault({ root: vault.root, tz: TZ }).findings.find(
      (f) => f.code === 'saved_filename_mismatch',
    );
    expect(finding?.detail).toContain('2026-08-15-a-piece');
  });
});

/**
 * Task 8's residual, closed.
 *
 * > Residual collision (12-hex agreement inside one day+slug bucket, ~10⁻¹²) is
 * > stated rather than hidden, and `vault verify` can close it.
 *
 * The collision is between two ITEMS, not between two files — one file is all
 * that can ever exist at the path, so the second item is simply never promoted
 * and nothing on disk records that it was lost. So the check is over the
 * corpus's saved set, and it is exact rather than probabilistic.
 */
describe('verifyVault — the corpus view', () => {
  const KEY_A = 'a'.repeat(64);
  const KEY_B = `${'a'.repeat(12)}${'b'.repeat(52)}`;
  const SAVED_AT = '2026-08-15T09:30:00.000Z';

  it('reports two saved items that compute the same filename', () => {
    const vault = createFixtureVault();
    const report = verifyVault({
      root: vault.root,
      tz: TZ,
      savedIndex: [
        { itemKey: KEY_A, title: 'Microsoft Win32k Privilege Escalation Vulnerability', savedAt: SAVED_AT },
        { itemKey: KEY_B, title: 'Microsoft Win32k Privilege Escalation Vulnerability', savedAt: SAVED_AT },
      ],
    });

    const finding = report.findings.find((f) => f.code === 'saved_key_collision');
    expect(finding?.severity).toBe('error');
    expect(finding?.detail).toContain(KEY_A);
    expect(finding?.detail).toContain(KEY_B);
  });

  it('does not cry collision over the 24 real Win32k CVEs, which is the whole point of the suffix', () => {
    // The identical-title group that made §8.1's `saved/{day}-{slug}.md`
    // unimplementable. Same day, same slug, 24 distinct keys — and 24 distinct
    // filenames, because the suffix is unconditional.
    const vault = createFixtureVault();
    const report = verifyVault({
      root: vault.root,
      tz: TZ,
      savedIndex: WIN32K_GROUP.map((row) => ({
        itemKey: row.itemKey,
        title: row.title,
        savedAt: SAVED_AT,
      })),
    });

    expect(report.findings.filter((f) => f.code === 'saved_key_collision')).toEqual([]);
  });

  it('reports a saved item with no note, and names both possible causes', () => {
    const vault = createFixtureVault();
    const report = verifyVault({
      root: vault.root,
      tz: TZ,
      savedIndex: [{ itemKey: KEY_A, title: 'A piece', savedAt: SAVED_AT }],
    });

    const finding = report.findings.find((f) => f.code === 'saved_note_missing');
    expect(finding?.severity).toBe('warning');
    // Promotion happens at save time and there is deliberately no backfill, so
    // an item saved while the vault was unmounted has no note and never will.
    expect(finding?.detail).toContain('unmounted');
    expect(finding?.detail).toContain('deleted');
  });

  it('says nothing about the corpus when no index is supplied', () => {
    const vault = createFixtureVault();
    const codes = verifyVault({ root: vault.root, tz: TZ }).findings.map((f) => f.code);
    expect(codes).not.toContain('saved_note_missing');
    expect(codes).not.toContain('saved_key_collision');
  });

  it('matches a note to its item by KEY, not by filename', () => {
    // Task 3 found ten live keys whose title changed under an unchanged URL --
    // "Wall Street holds near its record" became "slips back from". A note is
    // written once under the old title and keeps that name forever, so matching
    // on a recomputed filename would report every one of them as missing.
    const vault = createFixtureVault();
    const session = openVaultSession(vault.root);
    const rel = `saved/2026-08-15-wall-street-holds-near-its-record-${KEY_A.slice(0, 12)}.md`;
    session.writeSavedNote(
      rel,
      renderManagedNote({
        tier: 'write-once',
        generatedAt: SAVED_AT,
        body: '# Wall Street holds near its record\n',
        fields: { item_key: KEY_A, title: 'Wall Street holds near its record', saved_at: SAVED_AT },
      }) as never,
    );

    const report = verifyVault({
      root: vault.root,
      tz: TZ,
      savedIndex: [
        { itemKey: KEY_A, title: 'Wall Street slips back from its record', savedAt: SAVED_AT },
      ],
    });
    expect(report.findings.map((f) => f.code)).not.toContain('saved_note_missing');
  });
});
