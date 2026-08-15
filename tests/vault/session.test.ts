import { describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_VAULT_CAPS,
  openVaultSession,
  VaultCapError,
  VAULT_TEMP_PREFIX,
  VaultWriteError,
} from '../../src/vault/session.ts';
import { renderManagedNote, WATCHFLOOR_BEGIN_MARKER } from '../../src/vault/frontmatter.ts';
import { VaultMountError } from '../../src/vault/mount.ts';
import { VaultPathError } from '../../src/vault/paths.ts';
import {
  createFixtureVault,
  digestTree,
  EXISTING_SAVED_PATH,
  EXISTING_SAVED_TEXT,
  HAND_AUTHORED_ENTITY_PATH,
  HAND_AUTHORED_ENTITY_TEXT,
  HAND_AUTHORED_IN_MANAGED_PATH,
  HAND_AUTHORED_IN_MANAGED_TEXT,
  HAND_AUTHORED_NOTES,
  listTree,
} from './fixture.ts';

/**
 * The write session: every §8.1 rule as an enforced primitive.
 *
 * Nothing in Waves 2-4 writes to the vault except through this, which is what
 * makes the guarantees below properties of the integration rather than of each
 * later task's care. `tests/vault/noDirectFs.test.ts` is what keeps that true.
 */

const AT = '2026-08-15T07:00:00.000Z';

function note(body: string) {
  return renderManagedNote({ tier: 'fully-managed', generatedAt: AT, body });
}

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof VaultWriteError) return err.reason;
    if (err instanceof VaultCapError) return err.reason;
    if (err instanceof VaultPathError) return err.reason;
    return `unexpected: ${(err as Error).name}: ${(err as Error).message}`;
  }
  return 'no error thrown';
}

describe('openVaultSession — the preconditions', () => {
  it('refuses an unmounted vault before anything can be written', () => {
    const parent = mkdtempSync(join(tmpdir(), 'wf-vault-'));
    expect(() => openVaultSession(join(parent, 'gone', 'watchfloor'))).toThrow(VaultMountError);
  });

  // The M5 acceptance test deletes the whole tree; the next run must rebuild it.
  it('creates a missing sync root inside a vouched anchor', () => {
    const { anchor } = createFixtureVault();
    const root = join(anchor, 'Watchfloor-rebuilt');
    openVaultSession(root);
    expect(statSync(root).isDirectory()).toBe(true);
  });

  it('opens cleanly on the fixture vault and writes nothing by opening', () => {
    const { root } = createFixtureVault();
    const before = digestTree(root);
    openVaultSession(root);
    expect(digestTree(root)).toEqual(before);
  });
});

describe('the twelve hand-authored notes survive everything', () => {
  it('cannot be addressed at all, and are byte-identical after a full battery', () => {
    const { anchor, root } = createFixtureVault();
    const anchorBefore = digestTree(anchor);
    const session = openVaultSession(root);

    // Every way a caller might try to reach them, deliberate or accidental.
    const attempts: Array<[string, () => unknown]> = [];
    for (const [name] of HAND_AUTHORED_NOTES) {
      attempts.push([name, () => session.writeManagedNote(name, note('clobbered'))]);
      attempts.push([`../${name}`, () => session.writeManagedNote(`../${name}`, note('x'))]);
      attempts.push([
        `daily/../${name}`,
        () => session.writeManagedNote(`daily/../${name}`, note('x')),
      ]);
      attempts.push([`saved/../${name}`, () => session.writeSavedNote(`saved/../${name}`, note('x'))]);
      attempts.push([
        `entities/../${name}`,
        () => session.writeEntityNote(`entities/../${name}`, 'x', { generatedAt: AT, title: 'x' }),
      ]);
    }
    for (const [, attempt] of attempts) expect(attempt).toThrow(VaultPathError);

    // And a legitimate write in between, so the battery is not vacuous.
    session.writeManagedNote('daily/2026-08-15.md', note('# 2026-08-15\n'));

    const anchorAfter = digestTree(anchor);
    for (const [name] of HAND_AUTHORED_NOTES) {
      const key = join('Watchfloor', name);
      expect(anchorAfter.get(key), `${name} must still exist`).toBeDefined();
      expect(anchorAfter.get(key), `${name} must be byte-identical`).toBe(anchorBefore.get(key));
    }
    // Nothing outside the sync root changed or appeared, either.
    for (const [path, digest] of anchorBefore) {
      expect(anchorAfter.get(path), `${path} must be unchanged`).toBe(digest);
    }
  });

  it('refuses a hand-authored note a human put INSIDE a fully-managed directory', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    expect(reasonOf(() => session.writeManagedNote(HAND_AUTHORED_IN_MANAGED_PATH, note('gone')))).toBe(
      'not_managed',
    );
    expect(readFileSync(join(root, HAND_AUTHORED_IN_MANAGED_PATH), 'utf8')).toBe(
      HAND_AUTHORED_IN_MANAGED_TEXT,
    );
  });
});

describe('writeManagedNote — the fully-managed tier', () => {
  it('creates the note and its directory', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    const content = note('# 2026-08-15\n\nToday.\n');
    session.writeManagedNote('weekly/2026-W33.md', content);
    expect(readFileSync(join(root, 'weekly', '2026-W33.md'), 'utf8')).toBe(content);
  });

  it('overwrites a note it wrote before — idempotent overwrite, never append', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    session.writeManagedNote('daily/2026-08-15.md', note('first'));
    session.writeManagedNote('daily/2026-08-15.md', note('second'));
    const onDisk = readFileSync(join(root, 'daily', '2026-08-15.md'), 'utf8');
    expect(onDisk).toBe(note('second'));
    expect(onDisk).not.toContain('first');
  });

  it('leaves no temp file behind on a successful write', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    session.writeManagedNote('daily/2026-08-15.md', note('x'));
    const leftovers = readdirSync(join(root, 'daily')).filter((n) =>
      n.startsWith(VAULT_TEMP_PREFIX),
    );
    expect(leftovers).toEqual([]);
  });

  it('refuses a path in another tier rather than treating it as fully managed', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    expect(reasonOf(() => session.writeManagedNote('entities/Anthropic.md', note('x')))).toBe(
      'wrong_tier',
    );
    expect(reasonOf(() => session.writeManagedNote(EXISTING_SAVED_PATH, note('x')))).toBe(
      'wrong_tier',
    );
    expect(readFileSync(join(root, EXISTING_SAVED_PATH), 'utf8')).toBe(EXISTING_SAVED_TEXT);
  });

  it('refuses to write over a file whose contents were evicted by iCloud', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    writeFileSync(join(root, 'daily', '.2026-08-15.md.icloud'), '');
    expect(reasonOf(() => session.writeManagedNote('daily/2026-08-15.md', note('x')))).toBe(
      'dematerialised',
    );
  });
});

describe('writeEntityNote — the managed-block tier', () => {
  it('appends markers to the hand-authored note, keeping its prose byte-identical', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    session.writeEntityNote(HAND_AUTHORED_ENTITY_PATH, '- a generated line', {
      generatedAt: AT,
      title: 'Anthropic',
    });
    const after = readFileSync(join(root, HAND_AUTHORED_ENTITY_PATH), 'utf8');
    expect(after.startsWith(HAND_AUTHORED_ENTITY_TEXT)).toBe(true);
    expect(after).toContain(WATCHFLOOR_BEGIN_MARKER);
    expect(after).toContain('- a generated line');
  });

  it('replaces only between the markers on the next run', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    const opts = { generatedAt: AT, title: 'Anthropic' };
    session.writeEntityNote(HAND_AUTHORED_ENTITY_PATH, 'first', opts);
    session.writeEntityNote(HAND_AUTHORED_ENTITY_PATH, 'second', opts);
    const after = readFileSync(join(root, HAND_AUTHORED_ENTITY_PATH), 'utf8');
    expect(after.startsWith(HAND_AUTHORED_ENTITY_TEXT)).toBe(true);
    expect(after).toContain('second');
    expect(after).not.toContain('first');
  });

  it('preserves prose the owner adds below the block', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    const opts = { generatedAt: AT, title: 'Anthropic' };
    session.writeEntityNote(HAND_AUTHORED_ENTITY_PATH, 'generated', opts);
    const path = join(root, HAND_AUTHORED_ENTITY_PATH);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n## Mine\n\nAdded by hand.\n`);
    session.writeEntityNote(HAND_AUTHORED_ENTITY_PATH, 'regenerated', opts);
    const after = readFileSync(path, 'utf8');
    expect(after.startsWith(HAND_AUTHORED_ENTITY_TEXT)).toBe(true);
    expect(after.endsWith('\n## Mine\n\nAdded by hand.\n')).toBe(true);
    expect(after).toContain('regenerated');
  });

  it('creates a new entity note with frontmatter and markers', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    session.writeEntityNote('entities/CISA.md', 'generated', { generatedAt: AT, title: 'CISA' });
    const after = readFileSync(join(root, 'entities', 'CISA.md'), 'utf8');
    expect(after.startsWith('---\nwatchfloor: managed\n')).toBe(true);
    expect(after).toContain(WATCHFLOOR_BEGIN_MARKER);
  });

  it('refuses a path outside the entities area', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    expect(
      reasonOf(() =>
        session.writeEntityNote('daily/2026-08-15.md', 'x', { generatedAt: AT, title: 'x' }),
      ),
    ).toBe('wrong_tier');
  });
});

describe('writeSavedNote — write once, then never touched again by any job', () => {
  it('writes a new saved note', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    const content = note('# Kept\n');
    session.writeSavedNote('saved/2026-08-15-kept.md', content);
    expect(readFileSync(join(root, 'saved', '2026-08-15-kept.md'), 'utf8')).toBe(content);
  });

  // A KNOWN, ACCEPTED COST, pinned here so task 9 inherits it as a fact rather
  // than a surprise. `saved/` writes commit with `link`, not `rename`, because
  // link fails EEXIST and that is what makes write-once structural. Link does
  // not consume the temp name the way rename does, and CLAUDE.md forbids
  // unlinking it — so every saved note leaves one dot-prefixed sibling that is
  // a second hard link to the same inode: a directory entry, not a second copy
  // of the bytes. `vault prune` is the job that clears them.
  //
  // The alternative — writing straight to the target with 'wx' — trades this
  // for a crash leaving a permanently partial saved note that no job is ever
  // allowed to rewrite. That is strictly worse, which is why this cost was
  // taken deliberately.
  it('leaves exactly one prefixed temp hard link per saved note, for prune to clear', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    session.writeSavedNote('saved/2026-08-15-kept.md', note('# Kept\n'));

    const leftovers = readdirSync(join(root, 'saved')).filter((n) =>
      n.startsWith(VAULT_TEMP_PREFIX),
    );
    expect(leftovers).toHaveLength(1);
    // Same inode: a directory entry, not a duplicated note.
    expect(statSync(join(root, 'saved', leftovers[0]!)).ino).toBe(
      statSync(join(root, 'saved', '2026-08-15-kept.md')).ino,
    );
    // And it is hidden from Obsidian, which ignores dot-prefixed entries.
    expect(leftovers[0]!.startsWith('.')).toBe(true);
  });

  it('refuses a second write to the same path, even with identical content', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    const content = note('# Kept\n');
    session.writeSavedNote('saved/2026-08-15-kept.md', content);
    expect(reasonOf(() => session.writeSavedNote('saved/2026-08-15-kept.md', content))).toBe(
      'saved_exists',
    );
  });

  // §8.1: "written once at creation, then never touched again by any job. Not
  // even to fix a typo." The fixture's existing saved note has a hand-fixed
  // line in it; that line is the thing this rule protects.
  it('refuses to touch a saved note that already exists, leaving it byte-identical', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    expect(reasonOf(() => session.writeSavedNote(EXISTING_SAVED_PATH, note('typo fixed')))).toBe(
      'saved_exists',
    );
    expect(readFileSync(join(root, EXISTING_SAVED_PATH), 'utf8')).toBe(EXISTING_SAVED_TEXT);
  });

  it('refuses a path outside the saved area', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    expect(reasonOf(() => session.writeSavedNote('daily/x.md', note('x')))).toBe('wrong_tier');
  });
});

describe('write caps — a loud refusal, never a silent truncation', () => {
  it('refuses a file over the byte cap and writes nothing at all', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root, { maxBytesPerFile: 200 });
    const big = note('x'.repeat(5_000));
    expect(reasonOf(() => session.writeManagedNote('daily/big.md', big))).toBe('bytes_per_file');
    expect(readdirSync(join(root, 'daily'))).not.toContain('big.md');
  });

  it('names the cap, the actual size, and the file in the refusal', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root, { maxBytesPerFile: 200 });
    let thrown: unknown;
    try {
      session.writeManagedNote('daily/big.md', note('x'.repeat(5_000)));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(VaultCapError);
    expect((thrown as Error).message).toMatch(/200/);
    expect((thrown as Error).message).toMatch(/daily\/big\.md/);
  });

  it('measures bytes, not characters — an em dash is three bytes in UTF-8', () => {
    const { root } = createFixtureVault();
    const content = note('—'.repeat(100));
    const session = openVaultSession(root, { maxBytesPerFile: content.length + 10 });
    expect(reasonOf(() => session.writeManagedNote('daily/dash.md', content))).toBe(
      'bytes_per_file',
    );
  });

  it('refuses past the files-per-run cap', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root, { maxFilesPerRun: 3 });
    for (let i = 0; i < 3; i += 1) session.writeManagedNote(`daily/n${i}.md`, note(`${i}`));
    expect(reasonOf(() => session.writeManagedNote('daily/n3.md', note('3')))).toBe(
      'files_per_run',
    );
  });

  // A runaway that could be caught and continued one exception at a time is
  // not bounded. The count cap latches the session shut.
  it('latches the session shut once the files-per-run cap is hit', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root, { maxFilesPerRun: 1 });
    session.writeManagedNote('daily/n0.md', note('0'));
    expect(reasonOf(() => session.writeManagedNote('daily/n1.md', note('1')))).toBe('files_per_run');
    expect(reasonOf(() => session.writeManagedNote('daily/n2.md', note('2')))).toBe(
      'session_latched',
    );
    expect(reasonOf(() => session.writeSavedNote('saved/x.md', note('x')))).toBe('session_latched');
    expect(
      reasonOf(() => session.writeEntityNote('entities/X.md', 'x', { generatedAt: AT, title: 'X' })),
    ).toBe('session_latched');
    expect(readdirSync(join(root, 'daily')).sort()).toEqual(['Scratch.md', 'n0.md']);
  });

  // The byte cap is per-file and does NOT latch: one oversized note is a bad
  // note, not a runaway, and refusing the other 40 notes of a daily sync
  // because of it would turn a content bug into an outage.
  it('does not latch on the byte cap — the run continues', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root, { maxBytesPerFile: 300 });
    expect(reasonOf(() => session.writeManagedNote('daily/big.md', note('x'.repeat(5_000))))).toBe(
      'bytes_per_file',
    );
    session.writeManagedNote('daily/small.md', note('ok'));
    expect(readdirSync(join(root, 'daily'))).toContain('small.md');
  });

  it('counts a refused write against neither cap', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root, { maxFilesPerRun: 2, maxBytesPerFile: 300 });
    expect(reasonOf(() => session.writeManagedNote('daily/big.md', note('x'.repeat(5_000))))).toBe(
      'bytes_per_file',
    );
    session.writeManagedNote('daily/a.md', note('a'));
    session.writeManagedNote('daily/b.md', note('b'));
    expect(session.filesWritten).toBe(2);
  });

  it('ships defaults that bound a runaway without binding a normal run', () => {
    // ~40 notes a day against a 500-file cap; a 256 KiB note is far larger
    // than anything this project's ~300-character excerpts can produce.
    expect(DEFAULT_VAULT_CAPS.maxFilesPerRun).toBe(500);
    expect(DEFAULT_VAULT_CAPS.maxBytesPerFile).toBe(256 * 1024);
  });
});

describe('containment holds through the session, not only in resolveVaultPath', () => {
  it('refuses a symlink planted inside a managed directory', () => {
    const { anchor, root } = createFixtureVault();
    const session = openVaultSession(root);
    const before = digestTree(anchor);
    // A symlink from inside the sync root out to the vault's own notes. Every
    // syntactic check passes; only symlink resolution catches this one.
    mkdirSync(join(root, 'weekly'));
    symlinkSync(join(anchor, '02 Career'), join(root, 'weekly', 'career'));
    expect(reasonOf(() => session.writeManagedNote('weekly/career/Resume.md', note('x')))).toBe(
      'escapes_root',
    );
    expect(readFileSync(join(anchor, '02 Career', 'Resume.md'), 'utf8')).toBe('# Resume\n\nMine.\n');
    expect(digestTree(anchor).get('02 Career/Resume.md')).toBe(before.get('02 Career/Resume.md'));
  });

  it('never creates a directory outside the sync root', () => {
    const { anchor, root } = createFixtureVault();
    const session = openVaultSession(root);
    const before = listTree(anchor);
    expect(reasonOf(() => session.writeManagedNote('../elsewhere/x.md', note('x')))).toBe(
      'parent_traversal',
    );
    expect(listTree(anchor)).toEqual(before);
  });
});
