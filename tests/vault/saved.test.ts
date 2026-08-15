import { describe, expect, it } from 'vitest';
import {
  SAVED_KEY_SUFFIX_LENGTH,
  SAVED_SLUG_MAX_LENGTH,
  savedNotePath,
  savedTitleSlug,
} from '../../src/vault/saved.ts';
import { resolveVaultPath } from '../../src/vault/paths.ts';
import { VaultContentError } from '../../src/vault/frontmatter.ts';
import { createFixtureVault } from './fixture.ts';
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
