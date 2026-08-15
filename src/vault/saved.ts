/**
 * `saved/` promotion (M5 task 8) — §8.1's write-once tier.
 *
 * > *Mine* (`saved/`): **written once at creation, then never touched again by
 * > any job. Not even to fix a typo.**
 *
 * And, from the same section: *"`saved/` is the exception and is never
 * regenerated."* M5 acceptance deletes the whole `watchfloor/` tree and
 * requires `daily/`, `weekly/` and `entities/` to come back byte-identical —
 * while `saved/` must come back **empty**. That asymmetry is not a detail of
 * this module, it is the whole shape of it, and it decides the one design
 * question the plan left open (below).
 *
 * ## WHEN promotion runs, and why there is no other answer
 *
 * Promotion is an **event at save time**: one call, on the transition from
 * unsaved to saved. It is deliberately NOT a reconciliation pass over
 * `item_state where saved_at is not null`.
 *
 * A reconciliation pass is the obvious design, and it fails acceptance on the
 * first run: delete the tree, re-sync, and it faithfully rebuilds every saved
 * note from the database — which is exactly what "never regenerated" forbids.
 * There is no way to distinguish, from the database alone, a note that was
 * never written from one the owner deleted on purpose; the vault is the only
 * record of that, and the acceptance test deletes it. So the sync pass has no
 * `saved/` code path at all, and `tests/vault/saved.test.ts` proves the
 * consequence directly: with the tree moved aside, a full sync leaves `saved/`
 * absent.
 *
 * **The failure mode of that choice, stated rather than discovered.** If the
 * vault is unmounted, or `WF_VAULT_ROOT` is unset — which is the *shipped*
 * configuration — an item saved at that moment is never promoted, and nothing
 * will ever pick it up. There is no backfill, deliberately: a backfill cannot
 * tell "never promoted" from "promoted, then deleted by the owner", and
 * re-creating the second kind is the failure that makes the owner stop
 * trusting the integration. The cost is bounded and visible (the item is still
 * saved in the dashboard); the alternative silently overrules a deletion.
 *
 * ## Write-once is the SYSCALL, not a check
 *
 * `VaultSession.writeSavedNote` commits with `link(2)`, which fails with
 * `EEXIST` rather than replacing — task 4's report records that removing its
 * `existsSync` guard left the refusal intact and only degraded the message. So
 * this module never asks "does the note exist?" before writing. It attempts
 * the write, and a `saved_exists` refusal *is* the answer: the note is already
 * there. That is what makes promotion idempotent with no state, no probe, and
 * no window between the check and the write in which a crash could double a
 * note. **This module makes no filesystem call of its own** — every byte goes
 * through the session.
 *
 * ## The item key is in the filename, and the corpus is why
 *
 * §8.1 says `saved/YYYY-MM-DD-title-slug.md`. Taken literally that loses
 * items. Measured over the live corpus (5,937 keys): **185 slug-collision
 * groups covering 551 items**, the largest being **24 distinct CVEs** that
 * CISA publishes as *"Microsoft Win32k Privilege Escalation Vulnerability"*
 * (23 byte-identical, one differing only in the case of the `k`). Under
 * write-once the second of those saves is refused — the first note is not
 * damaged, but the second item is **never promoted, silently, forever**, which
 * is the worse of the two failures.
 *
 * A collision-triggered suffix does not fix it either: with 24 members the
 * ladder is unbounded, and which member gets the clean name would depend on
 * the order the owner happened to save them — history, not identity. So the
 * suffix is **unconditional**, and the path is a pure function of
 * (day, title, item key). Two different items cannot collide; the same item
 * always maps to the same path.
 *
 * The residual, stated: two items sharing a day and a slug whose item keys
 * agree on their first {@link SAVED_KEY_SUFFIX_LENGTH} hex digits would be
 * read as one. That is a 48-bit agreement inside a bucket the corpus shows
 * reaching 24 members — around 10^-12 — and `vault verify` (task 9) can close
 * it completely by checking every saved note's `item_key` frontmatter against
 * its own filename suffix.
 *
 * ## What a saved note contains
 *
 * A durable pointer plus context: the link, a ~300-character excerpt through
 * the project's standing {@link toExcerpt} cap, and the facts needed to find
 * the item again. **Never the full article text** — that is a standing policy
 * of this project (`src/domain/repo.ts`), not a formatting preference. The
 * empty `## Notes` heading at the end is the one place in the vault where
 * hand-written prose is safe by construction: nothing will ever rewrite this
 * file.
 */

import type { Db } from '../db/connection.ts';
import { localDay } from '../db/repoSnapshots.ts';
import { assertCanonicalTimestamp, getCurrentItem, type Beat } from '../domain/item.ts';
import { getItemBeats } from '../domain/itemBeats.ts';
import { getItemEntities } from '../domain/itemEntities.ts';
import { getItemFirstFetchedAt } from '../domain/itemFirstFetchedAt.ts';
import { getItemState } from '../domain/itemState.ts';
import { toExcerpt } from '../domain/repo.ts';
import { renderManagedNote, VaultContentError, type ManagedContent } from './frontmatter.ts';
import { VaultWriteError, type VaultSession, type VaultWriteResult } from './session.ts';

/**
 * How much of the slug survives. The longest real title is 288 characters;
 * with the day (10), the key suffix (12) and the separators, 80 keeps every
 * filename under 110 — comfortably inside the 255-byte limit ext4 imposes and
 * the 255-UTF-16-unit limit APFS imposes, with room for a vault path above it.
 */
export const SAVED_SLUG_MAX_LENGTH = 80;

/**
 * Hex digits of `item_key` appended to every saved filename. 12 gives 48 bits
 * of separation inside a (day, slug) bucket; see the module comment for the
 * residual and how `vault verify` closes it.
 */
export const SAVED_KEY_SUFFIX_LENGTH = 12;

/**
 * Used when a title contains no ASCII letter or digit at all — a
 * Japanese-language or Cyrillic source produces one on its first poll. No
 * current corpus title does, but an empty slug yields `saved/2026-08-15-.md`,
 * whose `-` -prefixed segment `resolveVaultPath` refuses outright, so the item
 * would be unpromotable rather than merely awkwardly named.
 */
export const SAVED_SLUG_FALLBACK = 'untitled';

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Everything a saved note records. Assembled by {@link readSavedItem} from the
 * three-function read path, or supplied directly by a test.
 *
 * `beats` and `entities` are the UNION across every version sharing the item
 * key, never the current version's own — CLAUDE.md's "beats belong to the
 * item", which has bitten four times.
 */
export interface SavedItem {
  /** sha256 of the canonical URL. Full digest; the filename carries a prefix. */
  readonly itemKey: string;
  readonly title: string;
  readonly canonicalUrl: string;
  readonly sourceId: string;
  readonly beats: readonly Beat[];
  readonly entities: readonly string[];
  readonly publishedAt: string | null;
  /** First-seen `fetched_at` — the immutable one, not the current version's. */
  readonly firstSeenAt: string;
  /** When the owner saved it. The day label in the filename comes from this. */
  readonly savedAt: string;
  readonly summaryRaw: string | null;
}

/**
 * A title as a filename component: NFKD-folded, combining marks stripped,
 * lowercased, everything outside `[a-z0-9]` collapsed to a single `-`.
 *
 * **Lowercasing is a portability decision, not a style one.** The corpus holds
 * nine pairs of titles differing only in case (`Cross-site` / `Cross-Site`,
 * `Win32k` / `Win32K`). Preserved, they are two files on Linux and one file on
 * macOS — so write-once would refuse on the dev machine and not on the target
 * host, which is precisely the case-sensitivity trap CLAUDE.md's portability
 * rule names. Folded, the behaviour is identical on both.
 *
 * Stripping combining marks matters for the same reason from the other
 * direction: `è` is one code point in NFC and two in NFD, macOS stores
 * filenames decomposed, and a path that round-trips through both spellings is
 * a path that sometimes fails to open. Folding to `e` removes the question.
 */
export function savedTitleSlug(title: string): string {
  const folded = title.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  const collapsed = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (collapsed === '') return SAVED_SLUG_FALLBACK;
  if (collapsed.length <= SAVED_SLUG_MAX_LENGTH) return collapsed;

  // Cut at a word boundary so a truncated slug still reads as words. `> 0`,
  // not `>= 0`: a single leading `-` would otherwise truncate to nothing.
  const cut = collapsed.slice(0, SAVED_SLUG_MAX_LENGTH);
  const lastDash = cut.lastIndexOf('-');
  const trimmed = (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
  return trimmed === '' ? SAVED_SLUG_FALLBACK : trimmed;
}

/**
 * The vault-relative path this item's saved note occupies, forever.
 *
 * `saved/{day}-{slug}-{key prefix}.md`, where the day is the OWNER's calendar
 * day in `tz` — never the host's, and never UTC. The same instant is a
 * different day in New York and in Tokyo, and the note is a record of the
 * owner's act, so it is dated in the owner's zone.
 *
 * Pure: no filesystem access, no clock.
 */
export function savedNotePath(item: SavedItem, tz: string): string {
  if (!SHA256_HEX.test(item.itemKey)) {
    // The suffix is what makes two colliding titles two files. A truncated or
    // invented key would silently weaken that into a collision.
    throw new VaultContentError(
      `saved note item key ${JSON.stringify(item.itemKey)} is not a sha256 digest`,
    );
  }
  assertCanonicalTimestamp('savedAt', item.savedAt);
  const day = localDay(item.savedAt, tz);
  const suffix = item.itemKey.slice(0, SAVED_KEY_SUFFIX_LENGTH);
  return `saved/${day}-${savedTitleSlug(item.title)}-${suffix}.md`;
}

/**
 * A CommonMark autolink (`<https://...>`) has no escape mechanism: a space or
 * an angle bracket inside it silently stops being a link. A saved note whose
 * whole purpose is to be a working pointer must not contain a broken one, so
 * this refuses rather than emitting `[title](url)` — link-text escaping is a
 * second set of rules to get wrong, and every canonical URL in the corpus is
 * already percent-encoded.
 */
function assertAutolinkable(url: string): void {
  if (/[\s<>]/.test(url) || url === '') {
    throw new VaultContentError(
      `saved note url ${JSON.stringify(url)} cannot be written as a markdown autolink`,
    );
  }
}

/**
 * The complete text of one saved note.
 *
 * Pure, and a pure function of its inputs byte for byte — which is what makes
 * the write-once guarantee checkable: re-running promotion for an item that is
 * already promoted produces the same bytes, so "we did not rewrite it" and
 * "rewriting it would have changed nothing" are both true, and the test can
 * assert the stronger one (the inode is unchanged).
 *
 * `generatedAt` is injected, never read from the wall clock — the contract
 * every domain module in this project keeps.
 *
 * A title or excerpt containing a watchfloor block marker is refused by
 * {@link renderManagedNote}. That is not decoration: content that decides
 * where a managed block ends is the injection that turns a saved excerpt into
 * a rewrite of the owner's own prose in an `entities/` note.
 */
export function renderSavedNote(item: SavedItem, generatedAt: string): ManagedContent {
  assertCanonicalTimestamp('savedAt', item.savedAt);
  assertCanonicalTimestamp('firstSeenAt', item.firstSeenAt);
  if (item.publishedAt !== null) assertCanonicalTimestamp('publishedAt', item.publishedAt);
  assertAutolinkable(item.canonicalUrl);

  // The project-wide cap, imported rather than re-implemented: links and
  // ~300-character excerpts, never full text.
  const excerpt = toExcerpt(item.summaryRaw);

  const lines = [`# ${item.title}`, '', `<${item.canonicalUrl}>`, ''];
  if (excerpt !== null) lines.push(`> ${excerpt}`, '');

  lines.push(`- Source: ${item.sourceId}`);
  lines.push(`- Beats: ${item.beats.join(', ')}`);
  if (item.entities.length > 0) lines.push(`- Entities: ${item.entities.join(', ')}`);
  lines.push(
    item.publishedAt === null
      ? // 1,715 items in the first-run corpus have a null published_at. An
        // absent date rendered as a present one is the failure the rest of
        // this codebase avoids by distinguishing never-polled from
        // polled-and-empty; the note says which fact it is showing.
        `- Published: not stated by the source; first seen ${item.firstSeenAt}`
      : `- Published: ${item.publishedAt}`,
  );
  lines.push(`- Saved: ${item.savedAt}`);
  // Nothing will ever rewrite this file, which makes the space below the only
  // place in the vault where hand-written prose is safe BY CONSTRUCTION rather
  // than by a marker protocol.
  lines.push('', '## Notes', '');

  return renderManagedNote({
    tier: 'write-once',
    generatedAt,
    body: lines.join('\n'),
    fields: {
      item_key: item.itemKey,
      title: item.title,
      url: item.canonicalUrl,
      source: item.sourceId,
      beats: [...item.beats],
      entities: [...item.entities],
      published_at: item.publishedAt,
      first_seen_at: item.firstSeenAt,
      saved_at: item.savedAt,
    },
  });
}

/**
 * What happened to one item's saved note.
 *
 * `exists` is deliberately not called `already_promoted`: what the write
 * actually established is that **the path was occupied**, which is normally
 * this item's own note from an earlier promotion and is occasionally something
 * the owner put there. Either way §8.1's answer is the same — nothing is
 * written — and claiming to know which would be a claim this module has not
 * checked.
 */
export type SavedPromotion =
  | { readonly status: 'written'; readonly relPath: string; readonly bytes: number }
  | { readonly status: 'exists'; readonly relPath: string };

/**
 * Promotes one saved item into `saved/`, once.
 *
 * Idempotent with no probe and no state: the write is attempted, and a refusal
 * because the path is occupied *is* the "already there" answer. Both shapes of
 * that refusal are handled, and the second one is the point:
 *
 * - `VaultWriteError('saved_exists')` — the session's `existsSync` guard, which
 *   exists for the error message.
 * - a raw `EEXIST` from `link(2)` — the actual enforcement. It is reachable
 *   whenever the guard cannot see the entry (a dangling symlink at the target,
 *   or a second process winning the race between the check and the link), and
 *   task 4's report records that deleting the guard leaves this path refusing
 *   correctly with only a worse message. Catching only the first would make
 *   this function depend on the guard rather than on the syscall.
 *
 * Every other refusal — a cap, an unmounted vault, a wrong tier — propagates.
 * Reporting a truncated run as a complete one is how a missing note becomes
 * invisible.
 */
export function promoteSavedItem(
  session: VaultSession,
  item: SavedItem,
  options: { readonly tz: string; readonly generatedAt: string },
): SavedPromotion {
  const relPath = savedNotePath(item, options.tz);
  const content = renderSavedNote(item, options.generatedAt);
  try {
    const written: VaultWriteResult = session.writeSavedNote(relPath, content);
    return { status: 'written', relPath: written.relPath, bytes: written.bytes };
  } catch (err) {
    const isGuard = err instanceof VaultWriteError && err.reason === 'saved_exists';
    const isSyscall = err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST';
    if (isGuard || isSyscall) return { status: 'exists', relPath };
    throw err;
  }
}

/**
 * Assembles one {@link SavedItem} from the database, or `null` when the item
 * is not saved (or does not exist).
 *
 * **Four reads, not one, and that is the whole reason this function exists.**
 * CLAUDE.md: *"The scoring read path is three functions, not one."*
 * `getCurrentItem` returns a single stored VERSION, and three facts are wrong
 * if taken from it:
 *
 * - `beats` — an arXiv paper cross-listed in `cs.AI` and `cs.CR` is two rows
 *   sharing one key, and the current-version read returns only the tie-break
 *   winner's beat. {@link getItemBeats} unions them.
 * - `entities` — same shape, same fix ({@link getItemEntities}).
 * - the first-seen instant — {@link getItemFirstFetchedAt}, not
 *   `current.fetchedAt`. For the 1,715 items with no `published_at` this is
 *   the only date the note can honestly show, and the current version's
 *   `fetched_at` moves every time a source re-delivers the entry (`cisa-kev`
 *   does exactly that on every poll).
 *
 * `title`, `summary_raw` and `canonical_url` DO come from the current version,
 * deliberately: those are the newest known facts about the item, and task 3
 * found ten real keys whose title or summary changed under an unchanged URL —
 * *"Wall Street holds near its record"* became *"Wall Street slips back from
 * its record"*. A note written today should quote today's version.
 */
export function readSavedItem(db: Db, itemKey: string): SavedItem | null {
  const state = getItemState(db, itemKey);
  if (state === null || state.savedAt === null) return null;

  const current = getCurrentItem(db, itemKey);
  if (current === null) return null;

  const firstSeenAt = getItemFirstFetchedAt(db, itemKey);
  // Unreachable while `current` is non-null -- both read the same table --
  // and asserted rather than defaulted, because a fabricated timestamp here
  // would be written once into a note that can never be corrected.
  if (firstSeenAt === null) return null;

  return {
    itemKey,
    title: current.title,
    canonicalUrl: current.canonicalUrl,
    sourceId: current.sourceId,
    beats: getItemBeats(db, itemKey),
    entities: getItemEntities(db, itemKey),
    publishedAt: current.publishedAt,
    firstSeenAt,
    savedAt: state.savedAt,
    summaryRaw: current.summaryRaw,
  };
}
