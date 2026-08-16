import { describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyVault, type VaultFinding } from '../../src/vault/verify.ts';
import { renderManagedNote, WATCHFLOOR_BEGIN_MARKER, WATCHFLOOR_END_MARKER } from '../../src/vault/frontmatter.ts';
import { VAULT_TEMP_PREFIX } from '../../src/vault/session.ts';
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
