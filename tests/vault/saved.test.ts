import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SAVED_KEY_SUFFIX_LENGTH,
  SAVED_SLUG_MAX_LENGTH,
  promoteSavedItem,
  readSavedItem,
  renderSavedNote,
  savedNotePath,
  savedTitleSlug,
} from '../../src/vault/saved.ts';
import { resolveVaultPath } from '../../src/vault/paths.ts';
import {
  isWatchfloorManaged,
  renderManagedNote,
  VaultContentError,
  WATCHFLOOR_BEGIN_MARKER,
} from '../../src/vault/frontmatter.ts';
import { MAX_EXCERPT_LENGTH } from '../../src/domain/repo.ts';
import { closeDb, openDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, type Beat, type NewItem } from '../../src/domain/item.ts';
import { saveItem } from '../../src/domain/itemState.ts';
import { openVaultSession, VaultCapError } from '../../src/vault/session.ts';
import { createFixtureVault, digestTree, EXISTING_SAVED_PATH } from './fixture.ts';
import { REAL_ITEMS, WIN32K_GROUP, type CorpusRow } from './corpus.ts';

/**
 * `saved/` promotion (M5 task 8) — §8.1's write-once tier.
 *
 * > *Mine* (`saved/`): written once at creation, then never touched again by
 * > any job. Not even to fix a typo.
 *
 * Every title below is a real row from the live corpus (`data/wf.db`, copied
 * out with `VACUUM INTO` and read from the copy). Invented `foo-bar` titles
 * cannot fail the way these do.
 */

const TZ = 'America/New_York';

const openDbs: Array<ReturnType<typeof openDb>> = [];
function migratedDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-saved-')), 'wf.db'));
  openDbs.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}
afterEach(() => {
  while (openDbs.length) closeDb(openDbs.pop()!);
});

function item(row: CorpusRow, savedAt = '2026-08-15T09:30:00.000Z') {
  return {
    itemKey: row.itemKey,
    title: row.title,
    canonicalUrl: row.canonicalUrl,
    sourceId: row.sourceId,
    beats: row.beats,
    entities: row.entities,
    publishedAt: row.publishedAt,
    firstSeenAt: row.firstSeenAt,
    savedAt,
    summaryRaw: row.summaryRaw,
  };
}

describe('savedTitleSlug — real titles from the live corpus', () => {
  it.each([
    // A slash in a title is a DIRECTORY SEPARATOR in a filename. 379 distinct
    // corpus titles contain one.
    ['PaperCut NG/MF Improper Authentication Vulnerability', 'papercut-ng-mf-improper-authentication-vulnerability'],
    // Combining marks: `è` must fold to `e`, not vanish and not survive as a
    // decomposed pair that two filesystems spell differently (NFC vs NFD).
    ['Dassault Systèmes DELMIA Apriso Code Injection Vulnerability', 'dassault-systemes-delmia-apriso-code-injection-vulnerability'],
    // 80 corpus titles carry an emoji; a lone surrogate in a filename is how a
    // path becomes unopenable.
    ['🤗 Kernels: Major Updates', 'kernels-major-updates'],
    ['ThinkPHP "noneCms" Remote Code Execution Vulnerability', 'thinkphp-nonecms-remote-code-execution-vulnerability'],
    // Spanish-language AP wire copy, from the archived first-run corpus.
    ['Swiatek vence a Rybakina en Toronto para su primer título de la WTA en el año', 'swiatek-vence-a-rybakina-en-toronto-para-su-primer-titulo-de-la-wta-en-el-ano'],
    ['[AINews] Jeff, Sanjay, Oriol, and Quoc depart DeepMind; Demis to Chair; Koray to SVP — what is going on at GDM???', 'ainews-jeff-sanjay-oriol-and-quoc-depart-deepmind-demis-to-chair-koray-to-svp'],
  ])('slugs %o', (title, expected) => {
    expect(savedTitleSlug(title)).toBe(expected);
  });

  // The nine real case-only pairs in the corpus (`Cross-site` vs
  // `Cross-Site`, `Win32k` vs `Win32K`) are the reason this matters: with case
  // preserved they are two files on Linux and ONE file on macOS, so write-once
  // would refuse on the dev machine and not on the target host. Folding case
  // makes the behaviour identical on both.
  it('folds the corpus case-only variants onto one slug', () => {
    expect(savedTitleSlug('Microsoft Win32K Privilege Escalation Vulnerability')).toBe(
      savedTitleSlug('Microsoft Win32k Privilege Escalation Vulnerability'),
    );
    expect(savedTitleSlug('RoundCube Webmail Cross-site Scripting Vulnerability')).toBe(
      savedTitleSlug('Roundcube Webmail Cross-Site Scripting Vulnerability'),
    );
  });

  it('caps the longest real title at the slug limit, on a word boundary', () => {
    const longest = REAL_ITEMS.find((r) => r.title.length > 280);
    expect(longest).toBeDefined();
    const slug = savedTitleSlug(longest!.title);
    expect(slug.length).toBeLessThanOrEqual(SAVED_SLUG_MAX_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug).toBe('actions-by-the-united-states-in-the-investigations-under-section-301-of-the');
  });

  // No corpus title slugs to nothing today; a CJK or Cyrillic source would
  // produce one on its first poll, and an empty slug yields `saved/2026-08-15-
  // .md` — a dot segment `resolveVaultPath` refuses outright.
  it('never returns an empty slug', () => {
    expect(savedTitleSlug('日本語のタイトル')).toBe('untitled');
    expect(savedTitleSlug('—')).toBe('untitled');
    expect(savedTitleSlug('')).toBe('untitled');
  });
});

describe('savedNotePath — §8.1 shape, plus the disambiguator the corpus forces', () => {
  it('is saved/YYYY-MM-DD-title-slug-<key>.md, dated by the day it was saved', () => {
    const row = REAL_ITEMS.find((r) => r.title.startsWith('PaperCut'))!;
    expect(savedNotePath(item(row, '2026-08-15T09:30:00.000Z'), TZ)).toBe(
      `saved/2026-08-15-papercut-ng-mf-improper-authentication-vulnerability-${row.itemKey.slice(0, SAVED_KEY_SUFFIX_LENGTH)}.md`,
    );
  });

  // The day label is the OWNER's day, from WF_TZ -- never the host clock's.
  it('takes the calendar day from WF_TZ, not from the host', () => {
    const row = REAL_ITEMS.find((r) => r.title.startsWith('PaperCut'))!;
    const atMidnightUtc = item(row, '2026-08-15T03:00:00.000Z');
    expect(savedNotePath(atMidnightUtc, 'America/New_York')).toContain('saved/2026-08-14-');
    expect(savedNotePath(atMidnightUtc, 'Asia/Tokyo')).toContain('saved/2026-08-15-');
  });

  /**
   * THE FINDING THAT SHAPED THIS TASK. `saved/YYYY-MM-DD-title-slug.md` taken
   * literally loses items: 185 slug-collision groups covering 551 of the
   * 5,937 corpus items, the largest being these 24 distinct CVEs published as
   * `Microsoft Win32k Privilege Escalation Vulnerability` — 23 byte-identical
   * titles plus one differing only in the case of the `k`.
   *
   * Under write-once the second save is REFUSED, so the item is not
   * overwritten — it is simply never promoted, silently, forever.
   */
  it('gives all 24 identically-titled CVEs distinct paths', () => {
    expect(WIN32K_GROUP.length).toBe(24);
    const paths = new Set(WIN32K_GROUP.map((row) => savedNotePath(item(row), TZ)));
    expect(paths.size).toBe(24);
  });

  it('produces a path resolveVaultPath accepts, in the write-once tier, for every real title', () => {
    const { root } = createFixtureVault();
    for (const row of REAL_ITEMS) {
      const resolved = resolveVaultPath(root, savedNotePath(item(row), TZ));
      expect(resolved.area).toBe('saved');
      expect(resolved.tier).toBe('write-once');
    }
  });

  it('refuses an item_key that is not a full sha256 digest', () => {
    const row = REAL_ITEMS[0]!;
    expect(() => savedNotePath({ ...item(row), itemKey: 'not-a-digest' }, TZ)).toThrow(
      VaultContentError,
    );
  });
});

describe('renderSavedNote — a durable pointer, never a copy of the article', () => {
  const paperCut = REAL_ITEMS.find((r) => r.title.startsWith('PaperCut'))!;
  const GENERATED_AT = '2026-08-15T09:30:05.000Z';

  it('carries frontmatter the write-once tier recognises as ours', () => {
    const note = renderSavedNote(item(paperCut), GENERATED_AT);
    expect(isWatchfloorManaged(note)).toBe(true);
    expect(note).toContain('watchfloor_tier: write-once');
  });

  it('records the FULL item key, not the filename prefix', () => {
    const note = renderSavedNote(item(paperCut), GENERATED_AT);
    expect(note).toContain(`item_key: ${paperCut.itemKey}`);
  });

  it('renders the title, the link and the excerpt', () => {
    const note = renderSavedNote(item(paperCut), GENERATED_AT);
    expect(note).toContain(`# ${paperCut.title}`);
    expect(note).toContain(`<${paperCut.canonicalUrl}>`);
    expect(note).toContain('bypass authentication on affected installations');
  });

  /**
   * The standing policy: this project stores links and ~300-character
   * excerpts, **never full article text** (`src/domain/repo.ts`). A saved note
   * is the one place where mirroring the article would be tempting, so the cap
   * is asserted against text far longer than anything `summary_raw` can hold.
   */
  it('caps the excerpt at the project-wide 300 characters', () => {
    const long = `${paperCut.summaryRaw} `.repeat(40);
    const note = renderSavedNote({ ...item(paperCut), summaryRaw: long }, GENERATED_AT);
    expect(long.length).toBeGreaterThan(5000);
    expect(note).not.toContain(long.slice(0, 400));
    const quoted = note.split('\n').find((line) => line.startsWith('> '))!;
    expect(quoted.length - 2).toBeLessThanOrEqual(MAX_EXCERPT_LENGTH);
  });

  it('says so when the source stated no publication date', () => {
    const note = renderSavedNote({ ...item(paperCut), publishedAt: null }, GENERATED_AT);
    // 1,715 of the first-run corpus items have a null published_at. An absent
    // date rendered as a present one is the failure `/api/sources` avoids by
    // distinguishing never-polled from polled-and-empty.
    expect(note).toContain('published_at: null');
    expect(note).toContain('not stated by the source');
  });

  it('names both beats of a cross-listed item', () => {
    const crossListed = REAL_ITEMS.find((r) => r.beats.length > 1)!;
    const note = renderSavedNote(item(crossListed), GENERATED_AT);
    expect(note).toContain('beats: ["aisec","cyber"]');
  });

  // `item_entities` holds ZERO rows in both the live corpus and the archived
  // first run, so "no entities" is the only state that exists today.
  it('omits the entities line rather than rendering an empty one', () => {
    const note = renderSavedNote(item(paperCut), GENERATED_AT);
    expect(note).not.toContain('Entities');
  });

  it('is a pure function of its inputs, byte for byte', () => {
    expect(renderSavedNote(item(paperCut), GENERATED_AT)).toBe(
      renderSavedNote(item(paperCut), GENERATED_AT),
    );
  });

  // Content that decides where a managed block ends is the injection that
  // turns a saved excerpt into a rewrite of the owner's own prose elsewhere.
  it('refuses a title or excerpt carrying a watchfloor marker', () => {
    expect(() =>
      renderSavedNote({ ...item(paperCut), title: `Hi ${WATCHFLOOR_BEGIN_MARKER}` }, GENERATED_AT),
    ).toThrow(VaultContentError);
    expect(() =>
      renderSavedNote(
        { ...item(paperCut), summaryRaw: `Hi ${WATCHFLOOR_BEGIN_MARKER}` },
        GENERATED_AT,
      ),
    ).toThrow(VaultContentError);
  });

  // The URL is emitted as a CommonMark autolink, which has no escape
  // mechanism: a space or an angle bracket inside it silently stops being a
  // link, and the note's whole purpose is to be a working pointer.
  it('refuses a URL that cannot be an autolink', () => {
    expect(() =>
      renderSavedNote({ ...item(paperCut), canonicalUrl: 'https://x.test/a b' }, GENERATED_AT),
    ).toThrow(VaultContentError);
    expect(() =>
      renderSavedNote({ ...item(paperCut), canonicalUrl: 'https://x.test/<a>' }, GENERATED_AT),
    ).toThrow(VaultContentError);
  });
});

describe('promoteSavedItem — write-once, and nothing else touched', () => {
  const paperCut = REAL_ITEMS.find((r) => r.title.startsWith('PaperCut'))!;
  const options = { tz: TZ, generatedAt: '2026-08-15T09:30:05.000Z' };

  it('writes the note at the §8.1 path', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    const result = promoteSavedItem(session, item(paperCut), options);

    expect(result.status).toBe('written');
    expect(result.relPath).toBe(savedNotePath(item(paperCut), TZ));
    expect(readFileSync(join(root, result.relPath), 'utf8')).toContain(paperCut.canonicalUrl);
  });

  /**
   * Idempotence, asserted the strong way. Byte-identical content proves
   * nothing about whether the file was REWRITTEN — the note is a pure function
   * of its input, so a rewrite would produce the same bytes. The inode and
   * mtime prove the file was not replaced at all.
   */
  it('does not rewrite an existing note, and does not spend a write to find out', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    const first = promoteSavedItem(session, item(paperCut), options);
    const before = statSync(join(root, first.relPath));

    const second = promoteSavedItem(session, item(paperCut), {
      ...options,
      generatedAt: '2026-09-01T00:00:00.000Z',
    });

    expect(second).toEqual({ status: 'exists', relPath: first.relPath });
    const after = statSync(join(root, first.relPath));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    // The second call consumed no part of the run's file budget either.
    expect(session.filesWritten).toBe(1);
  });

  it('promotes all 24 identically-titled CVEs without losing one', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    const written = WIN32K_GROUP.map((row) => promoteSavedItem(session, item(row), options));

    expect(written.every((r) => r.status === 'written')).toBe(true);
    expect(new Set(written.map((r) => r.relPath)).size).toBe(24);
    for (const result of written) {
      expect(readFileSync(join(root, result.relPath), 'utf8')).toContain(`item_key: `);
    }
  });

  it('leaves every hand-authored note in the fixture vault byte-identical', () => {
    const { anchor, root } = createFixtureVault();
    const before = digestTree(anchor);
    const session = openVaultSession(root);
    for (const row of WIN32K_GROUP.slice(0, 5)) promoteSavedItem(session, item(row), options);

    const after = digestTree(anchor);
    for (const [path, digest] of before) expect(after.get(path)).toBe(digest);
    // Including the saved/ note that was already there, which §8.1 forbids any
    // job from touching ever again.
    expect(after.get(join('Watchfloor', EXISTING_SAVED_PATH))).toBe(
      before.get(join('Watchfloor', EXISTING_SAVED_PATH)),
    );
  });

  /**
   * Write-once is the SYSCALL, not the guard. A dangling symlink is invisible
   * to `existsSync` (which follows links) and fatal to `link(2)` (which sees
   * the directory entry), so this reaches the raw `EEXIST` path that task 4's
   * report identified as the real enforcement — the one that survives the
   * `existsSync` check being deleted.
   */
  it('refuses through the syscall when the existence check cannot see the entry', () => {
    const { root } = createFixtureVault();
    const relPath = savedNotePath(item(paperCut), TZ);
    symlinkSync(join(root, 'nothing-here.md'), join(root, relPath));
    expect(existsSync(join(root, relPath))).toBe(false);

    const session = openVaultSession(root);
    expect(promoteSavedItem(session, item(paperCut), options)).toEqual({
      status: 'exists',
      relPath,
    });
  });

  // A cap refusal is not an "already promoted" answer, and collapsing them
  // would turn a truncated run into a silently complete-looking one.
  it('lets a cap refusal through rather than reporting it as already present', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root, { maxFilesPerRun: 1 });
    promoteSavedItem(session, item(WIN32K_GROUP[0]!), options);
    expect(() => promoteSavedItem(session, item(WIN32K_GROUP[1]!), options)).toThrow(VaultCapError);
  });
});

/**
 * M5 acceptance, the half that is a REFUSAL rather than a reproduction:
 *
 * > Delete the entire `watchfloor/` tree, re-run sync: `daily/`, `weekly/`,
 * > `entities/` reproduce identically [...] `saved/` is never regenerated.
 *
 * The tree is moved aside rather than removed — CLAUDE.md's never-delete rule
 * has no exception for a test fixture, and `git mv` to `attic/` is the pattern
 * it prescribes. The result on disk is the same absence a delete produces, and
 * the moved tree is still readable, which lets the second assertion below be
 * made at all.
 */
describe('a re-sync after the tree is gone does NOT bring saved/ back', () => {
  const options = { tz: TZ, generatedAt: '2026-08-15T09:30:05.000Z' };

  it('rebuilds daily/ and entities/ and leaves saved/ absent', () => {
    const { root } = createFixtureVault();
    const first = openVaultSession(root);
    const promoted = WIN32K_GROUP.slice(0, 3).map((row) =>
      promoteSavedItem(first, item(row), options),
    );
    expect(promoted.every((r) => r.status === 'written')).toBe(true);

    const movedAside = `${root}.deleted-2026-08-15`;
    renameSync(root, movedAside);
    expect(existsSync(root)).toBe(false);

    // The sync pass, as the session sees it: the fully-managed and
    // managed-block tiers, written through the same door tasks 5-7 use.
    const resync = openVaultSession(root);
    resync.writeManagedNote(
      'daily/2026-08-15.md',
      renderManagedNote({ tier: 'fully-managed', generatedAt: options.generatedAt, body: '# Daily' }),
    );
    resync.writeEntityNote('entities/Microsoft.md', 'Three CVEs today.', {
      generatedAt: options.generatedAt,
      title: 'Microsoft',
    });

    expect(existsSync(join(root, 'daily', '2026-08-15.md'))).toBe(true);
    expect(existsSync(join(root, 'entities', 'Microsoft.md'))).toBe(true);
    // The whole point. Not "empty" -- the directory is not even created,
    // because nothing in a sync has a reason to name it.
    expect(existsSync(join(root, 'saved'))).toBe(false);

    // And the notes that were there are still there, in the moved tree,
    // untouched -- which is why the tree was moved rather than deleted.
    for (const result of promoted) {
      expect(existsSync(join(movedAside, result.relPath))).toBe(true);
    }
  });

  /**
   * The property behind that test, so it cannot quietly stop being true when
   * tasks 5-7 land: `writeSavedNote` is the only way into the write-once tier,
   * and only this module calls it. A sync module that acquired a `saved/` code
   * path would turn this red.
   *
   * Non-vacuity is checked first, because M4a's post-mortem is about exactly
   * this shape of test passing for a milestone while reading nothing.
   */
  it('is called by nothing but this module', () => {
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && readFileSync(full, 'utf8').includes('writeSavedNote'))
          callers.push(full);
      }
    };
    walk('src');

    expect(callers).toContain(join('src', 'vault', 'session.ts'));
    expect(callers.sort()).toEqual([join('src', 'vault', 'saved.ts'), join('src', 'vault', 'session.ts')]);
  });
});

describe('readSavedItem — the three-function read path, not the current version', () => {
  const arxivUrl = 'https://arxiv.org/abs/2608.11274';
  const NOW = '2026-08-15T09:30:00.000Z';

  function version(beats: Beat[], fetchedAt: string, title: string): NewItem {
    return {
      url: arxivUrl,
      canonicalUrl: arxivUrl,
      title,
      sourceId: beats[0] === 'ai' ? 'arxiv-cs-ai' : 'arxiv-cs-cr',
      itemType: 'analysis',
      beats,
      entities: [],
      publishedAt: null,
      fetchedAt,
      summaryRaw: 'An abstract.',
      rawJson: '{}',
    };
  }

  it('returns null for an item that is not saved', () => {
    const db = migratedDb();
    const inserted = insertItem(db, version(['ai'], '2026-08-14T10:00:00.000Z', 'A paper'));
    expect(readSavedItem(db, inserted.item_key)).toBeNull();
  });

  it('returns null for a key with no item at all', () => {
    const db = migratedDb();
    saveItem(db, 'a'.repeat(64), NOW);
    expect(readSavedItem(db, 'a'.repeat(64))).toBeNull();
  });

  /**
   * The cross-listing that has bitten four times: one arXiv paper announced in
   * `cs.AI` and `cs.CR` is two rows sharing one `item_key`, and the
   * current-version read returns only the tie-break winner's beat.
   */
  it('unions the beats of every version', () => {
    const db = migratedDb();
    insertItem(db, version(['ai'], '2026-08-14T10:00:00.000Z', 'A paper'));
    const second = insertItem(db, version(['aisec'], '2026-08-14T11:00:00.000Z', 'A paper'));
    saveItem(db, second.item_key, NOW);

    const saved = readSavedItem(db, second.item_key)!;
    expect([...saved.beats].sort()).toEqual(['ai', 'aisec']);
  });

  // An undated item's baseline is the FIRST fetch, never the newest version's
  // -- the same read path M2 needed for decay.
  it('dates an undated item by first-seen, not by the current version', () => {
    const db = migratedDb();
    insertItem(db, version(['ai'], '2026-08-14T10:00:00.000Z', 'A paper'));
    const second = insertItem(db, version(['ai'], '2026-08-15T08:00:00.000Z', 'A paper, revised'));
    saveItem(db, second.item_key, NOW);

    const saved = readSavedItem(db, second.item_key)!;
    expect(saved.firstSeenAt).toBe('2026-08-14T10:00:00.000Z');
    expect(saved.publishedAt).toBeNull();
    expect(saved.title).toBe('A paper, revised');
    expect(saved.savedAt).toBe(NOW);
  });

  it('promotes what it read, into a real vault', () => {
    const db = migratedDb();
    const inserted = insertItem(db, version(['ai'], '2026-08-14T10:00:00.000Z', 'A paper'));
    saveItem(db, inserted.item_key, NOW);

    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    const result = promoteSavedItem(session, readSavedItem(db, inserted.item_key)!, {
      tz: TZ,
      generatedAt: '2026-08-15T09:30:05.000Z',
    });

    expect(result.status).toBe('written');
    expect(readFileSync(join(root, result.relPath), 'utf8')).toContain(
      `item_key: ${inserted.item_key}`,
    );
  });
});

describe('known costs, pinned so they are decisions rather than surprises', () => {
  const paperCut = REAL_ITEMS.find((r) => r.title.startsWith('PaperCut'))!;
  const options = { tz: TZ, generatedAt: '2026-08-15T09:30:05.000Z' };

  /**
   * `saveItem` is fully reversible, and a save after an un-save produces a
   * FRESH `saved_at` (`src/domain/itemState.ts`). The day label comes from
   * that instant, so un-saving in August and re-saving in September writes a
   * SECOND note.
   *
   * Accepted rather than fixed. The first note is a true record of the August
   * save and write-once forbids amending it, so the choice is between a second
   * record and no record of the second act. Closing it would need the vault
   * package to offer a sanctioned way to LIST an area — `resolveVaultPath`
   * refuses anything that is not a `.md` file, deliberately — and that is a
   * change to task 4's files, which this task does not own.
   */
  it('writes a second note when an item is un-saved and saved again on another day', () => {
    const { root } = createFixtureVault();
    const session = openVaultSession(root);
    const august = promoteSavedItem(session, item(paperCut, '2026-08-15T09:30:00.000Z'), options);
    const september = promoteSavedItem(
      session,
      item(paperCut, '2026-09-02T09:30:00.000Z'),
      options,
    );

    expect(august.status).toBe('written');
    expect(september.status).toBe('written');
    expect(september.relPath).not.toBe(august.relPath);
    // The August note is untouched, which is the rule that matters.
    expect(readFileSync(join(root, august.relPath), 'utf8')).toContain(
      'saved_at: 2026-08-15T09:30:00.000Z',
    );
  });

  /**
   * THE WIRING PIN. M4a's post-mortem: a `github_search` adapter that compiled
   * fine and was unreachable, found only by a live run. Nothing in `src/`
   * calls {@link promoteSavedItem} yet — the composition roots and
   * `src/api/routes/items.ts` were outside this task's ownership.
   *
   * This test asserts the gap so it cannot be forgotten. When the save route
   * is wired, this turns red and whoever wired it must say so here.
   */
  it('IS NOT WIRED YET — promoteSavedItem has no caller in src/', () => {
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          entry.name.endsWith('.ts') &&
          full !== join('src', 'vault', 'saved.ts') &&
          readFileSync(full, 'utf8').includes('promoteSavedItem')
        )
          callers.push(full);
      }
    };
    walk('src');
    expect(callers).toEqual([]);
  });

  // A summary arriving with newlines must not be able to close the blockquote
  // and inject headings into a note nothing will ever be allowed to correct.
  it('cannot be broken out of its blockquote by newlines in the excerpt', () => {
    const note = renderSavedNote(
      { ...item(paperCut), summaryRaw: 'First line.\n\n# Injected heading\n\n- and a list' },
      options.generatedAt,
    );
    const quoted = note.split('\n').filter((line) => line.startsWith('> '));
    expect(quoted.length).toBe(1);
    expect(note).not.toContain('\n# Injected heading');
  });

  it('collapses a multi-line title into one heading, keeping the raw title in frontmatter', () => {
    const note = renderSavedNote(
      { ...item(paperCut), title: 'A title\nwith a newline' },
      options.generatedAt,
    );
    expect(note).toContain('# A title with a newline');
    expect(note).toContain('title: "A title\\nwith a newline"');
  });
});
