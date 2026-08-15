/**
 * Entity notes — §8.1's managed-block tier (M5 task 7).
 *
 * > *Managed block* (`entities/`): the file contains
 * > `<!-- watchfloor:begin -->` / `<!-- watchfloor:end -->` markers. Sync
 * > replaces **only** the content between markers and leaves everything above
 * > and below untouched [...] If the markers are missing from an existing
 * > file, append them rather than overwriting — never clobber a file you
 * > didn't create.
 *
 * This module decides *what goes in the block* and *which file it goes in*.
 * The marker protocol itself, the frontmatter gate, containment, atomicity and
 * the caps all belong to task 4 (`./session.ts`, `./frontmatter.ts`,
 * `./paths.ts`), and nothing here opens a file: every write goes through
 * `VaultSession.writeEntityNote`.
 *
 * ## Refuses, never sanitises
 *
 * An entity name becomes a filename, and that is the whole hazard. Sanitising
 * `../../Architecture` into `Architecture.md` produces a request that
 * `resolveVaultPath` is *right* to accept — and the write lands on a name
 * matching one of the owner's twelve hand-authored notes. Sanitising also
 * merges: two entity names that clean up to the same filename would take turns
 * overwriting each other's block on every run, so the note would not even be
 * idempotent. Every unsafe name is therefore refused with a machine-readable
 * reason and reported, never repaired.
 */

import type { Db } from '../db/connection.ts';
import type { Beat } from '../domain/item.ts';
import { getCurrentItem } from '../domain/item.ts';
import { getItemBeats } from '../domain/itemBeats.ts';
import { getItemEntities } from '../domain/itemEntities.ts';
import { getItemFirstFetchedAt } from '../domain/itemFirstFetchedAt.ts';

export type EntityNameRefusal =
  | 'empty'
  | 'separator'
  | 'whitespace_edge'
  | 'control_char'
  | 'dot_leading'
  | 'reserved_char'
  | 'device_name'
  | 'too_long';

export class EntityNameError extends Error {
  readonly reason: EntityNameRefusal;
  readonly entity: string;
  constructor(reason: EntityNameRefusal, entity: string, detail: string) {
    super(`refusing entity name ${JSON.stringify(entity)}: ${detail} (${reason})`);
    this.name = 'EntityNameError';
    this.reason = reason;
    this.entity = entity;
  }
}

/**
 * Characters that must never appear in a name this module creates.
 *
 * Three groups, deliberately collapsed into one refusal because a caller can
 * act on none of them differently:
 *
 * - `: * ? " < > |` — illegal on Windows, and macOS's Finder displays `:` as
 *   `/`. Obsidian runs on both, and this vault syncs to devices we do not run.
 * - `[ ] # ^ |` — Obsidian's own link syntax. Related entities are rendered as
 *   `[[Name]]` wikilinks, and every one of these either breaks the link or
 *   silently turns part of the name into a heading reference, a block
 *   reference or an alias. Real corpus evidence that this is not hypothetical:
 *   `latent-space` publishes titles of the form `[AINews] ...`, and an
 *   extractor keying on bracketed or capitalised runs would hand us `[AINews]`.
 * - `%` is deliberately NOT here: it is legal everywhere, appears in real
 *   entity-shaped strings, and refusing it would buy nothing.
 */
const RESERVED_CHARS = /[:*?"<>|[\]#^]/;

/** `NUL`, `CON`, `COM1`… — device names on Windows, with or without a suffix. */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * The longest filename this module will produce, in UTF-8 bytes.
 *
 * NAME_MAX is 255 bytes, but the number that actually binds is smaller and it
 * is not obvious: `atomicWrite` in `./session.ts` writes through a temp file
 * named `.watchfloor-tmp-<filename>.<pid>.<counter>`, which adds 24 or more
 * bytes. Measured in a real temp directory on this machine: a 243-byte
 * filename writes fine on its own and fails with **ENAMETOOLONG at 267 bytes**
 * once the temp prefix is on. A 255-byte cap would therefore refuse nothing
 * and still crash mid-run.
 *
 * 200 leaves 55 bytes of headroom — far more than any plausible pid and
 * counter — and is still an order of magnitude above a real entity name.
 */
const MAX_FILENAME_BYTES = 200;

const MARKDOWN_SUFFIX = '.md';

const DEL_CODE = 127;
const FIRST_PRINTABLE_CODE = 32;

function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < FIRST_PRINTABLE_CODE || code === DEL_CODE) return true;
  }
  return false;
}

/**
 * The filename an entity maps to, or a refusal.
 *
 * Order matters only in deciding which reason a name breaking several rules is
 * reported under; every branch here refuses.
 */
export function entityFileName(entity: string): string {
  if (entity.trim() === '') {
    throw new EntityNameError('empty', entity, 'an entity name must not be blank');
  }
  if (entity.includes('/') || entity.includes('\\')) {
    // Refused rather than replaced. `../../Architecture` must never become a
    // plausible filename; it must become an error somebody can read.
    throw new EntityNameError('separator', entity, 'contains a path separator');
  }
  if (entity !== entity.trim()) {
    // Leading and trailing spaces are legal on POSIX and silently stripped by
    // Windows, so `"Anthropic "` and `"Anthropic"` are one file on one host and
    // two on another. Trimming here would merge two DB entities into one note.
    throw new EntityNameError('whitespace_edge', entity, 'has leading or trailing whitespace');
  }
  if (hasControlCharacter(entity)) {
    throw new EntityNameError('control_char', entity, 'contains a control character');
  }
  if (entity.startsWith('.')) {
    // `resolveVaultPath` refuses a dot-prefixed segment anyway; refusing here
    // gives the reason in terms of the entity rather than of a path the caller
    // never built.
    throw new EntityNameError('dot_leading', entity, 'starts with a dot');
  }
  if (RESERVED_CHARS.test(entity)) {
    throw new EntityNameError(
      'reserved_char',
      entity,
      'contains a character reserved by a filesystem or by Obsidian link syntax',
    );
  }
  if (WINDOWS_DEVICE_NAME.test(entity)) {
    throw new EntityNameError('device_name', entity, 'is a reserved device name on Windows');
  }

  // NFC for the name we create, exactly as `isContainedIn` uses NFC for the
  // comparison it makes: macOS matches filenames normalisation-insensitively
  // and Linux does not, so emitting one normal form is what makes "this entity
  // maps to this file" mean the same thing on both hosts.
  const fileName = `${entity.normalize('NFC')}${MARKDOWN_SUFFIX}`;
  const bytes = Buffer.byteLength(fileName, 'utf8');
  if (bytes > MAX_FILENAME_BYTES) {
    throw new EntityNameError(
      'too_long',
      entity,
      `would be ${bytes} bytes, over the ${MAX_FILENAME_BYTES}-byte cap that keeps the ` +
        'atomic-write temp name under NAME_MAX',
    );
  }
  return fileName;
}

/** The vault-relative path for an entity's note. Always inside `entities/`. */
export function entityNoteRelPath(entity: string): string {
  return `entities/${entityFileName(entity)}`;
}

// ---------------------------------------------------------------------------
// The read path
// ---------------------------------------------------------------------------

/**
 * One item as an entity note lists it.
 *
 * Every field that can differ between versions of the same `item_key` is
 * resolved the way `CLAUDE.md`'s three-function rule requires, and the choice
 * is different for each one:
 *
 * - `beats` and the entity attribution itself are **unioned across versions**
 *   (`getItemBeats`, `getItemEntities`) — they are facts about the item.
 * - `sourceIds` is likewise unioned, so a cross-listed paper shows both feeds
 *   rather than whichever one happened to be ingested last.
 * - `title` and `url` come from the **current version**, which is the right
 *   answer for a fact that legitimately changes: M5 task 3 found ten live keys
 *   whose title changed under an unchanged URL, one of them reversing its
 *   claim ("Wall Street holds near its record" → "slips back from its record").
 * - `at` is `published_at` when there is one and the **first-seen**
 *   `fetched_at` when there is not — never the current version's `fetched_at`,
 *   which a re-poll resets (`getItemFirstFetchedAt`).
 */
export interface EntityItemRef {
  readonly itemKey: string;
  readonly title: string;
  readonly url: string;
  /** Every source that carried this item, unioned across versions. */
  readonly sourceIds: readonly string[];
  /** Every beat, unioned across versions. */
  readonly beats: readonly Beat[];
  /** Canonical UTC timestamp: the publication date, or first-seen. */
  readonly at: string;
  /** False when `at` is a first-seen time rather than a publication date. */
  readonly dated: boolean;
}

export interface RelatedEntity {
  readonly entity: string;
  readonly sharedItems: number;
}

export interface EntityNotePlan {
  /** The NFC display name, which is also the note's filename stem. */
  readonly entity: string;
  readonly relPath: string;
  /** Every item carrying this entity, before {@link EntityPlanOptions.maxItems}. */
  readonly totalItems: number;
  readonly items: readonly EntityItemRef[];
  readonly related: readonly RelatedEntity[];
}

export type EntitySkipReason = EntityNameRefusal | 'case_collision';

export interface EntitySkip {
  readonly entity: string;
  readonly reason: EntitySkipReason;
  readonly detail: string;
}

export interface EntityPlan {
  readonly notes: readonly EntityNotePlan[];
  readonly skipped: readonly EntitySkip[];
}

export interface EntityPlanOptions {
  /** Items listed in the block. The count is always reported in full. */
  readonly maxItems?: number;
  readonly maxRelated?: number;
}

export const DEFAULT_MAX_ITEMS = 20;
export const DEFAULT_MAX_RELATED = 15;

/**
 * Codepoint order, everywhere, deliberately.
 *
 * `localeCompare` depends on the host's ICU data and locale, so two machines
 * could order the same corpus differently — and the note would then differ
 * between them, which is exactly the idempotence M5 acceptance tests.
 */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function distinctEntityStrings(db: Db): string[] {
  // Inline type literal rather than a named interface: `.all()` returns
  // `Record<string, SQLOutputValue>[]` and TypeScript's `as` overlap check is
  // stricter about a named-interface array target. See src/cluster/store.ts.
  const rows = db.prepare('select distinct entity from item_entities order by entity').all() as Array<{
    entity: string;
  }>;
  return rows.map((r) => r.entity);
}

function itemKeysForEntities(db: Db, spellings: readonly string[]): string[] {
  const placeholders = spellings.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `select distinct i.item_key as item_key
       from item_entities e
       join items i on i.item_id = e.item_id
       where e.entity in (${placeholders})
       order by i.item_key`,
    )
    .all(...spellings) as Array<{ item_key: string }>;
  return rows.map((r) => r.item_key);
}

function sourceIdsFor(db: Db, itemKey: string): string[] {
  const rows = db
    .prepare('select distinct source_id from items where item_key = ? order by source_id')
    .all(itemKey) as Array<{ source_id: string }>;
  return rows.map((r) => r.source_id);
}

function itemRef(db: Db, itemKey: string): EntityItemRef | null {
  const current = getCurrentItem(db, itemKey);
  if (current === null) return null;
  const firstFetchedAt = getItemFirstFetchedAt(db, itemKey);
  const published = current.publishedAt;
  return {
    itemKey,
    title: current.title,
    url: current.url,
    sourceIds: sourceIdsFor(db, itemKey),
    beats: getItemBeats(db, itemKey),
    // `firstFetchedAt` cannot be null for a key that has a current version;
    // the fallback exists so a future schema change cannot make this throw.
    at: published ?? firstFetchedAt ?? current.fetchedAt,
    dated: published !== null,
  };
}

/**
 * Groups the raw `item_entities` strings into the entities that will get notes.
 *
 * Two different kinds of collision, resolved differently on purpose:
 *
 * - **Unicode normalisation.** `Cafe` + combining acute and the precomposed
 *   `Café` are two byte sequences for one string. They ARE the same entity, so
 *   they are merged and their items unioned.
 * - **Case.** `OpenAI` and `openai` are two entities on Linux and one file on
 *   macOS. Merging them would invent a policy; writing either would mean the
 *   two take turns overwriting each other's block on every run — on one host
 *   and not the other. Both are skipped and reported.
 */
function groupEntities(names: readonly string[]): {
  groups: Map<string, string[]>;
  collisions: EntitySkip[];
} {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const nfc = name.normalize('NFC');
    const spellings = groups.get(nfc);
    if (spellings) spellings.push(name);
    else groups.set(nfc, [name]);
  }

  const byFoldedCase = new Map<string, string[]>();
  for (const nfc of groups.keys()) {
    const folded = nfc.toLowerCase();
    const members = byFoldedCase.get(folded);
    if (members) members.push(nfc);
    else byFoldedCase.set(folded, [nfc]);
  }

  const collisions: EntitySkip[] = [];
  for (const members of byFoldedCase.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort(byCodePoint);
    for (const member of sorted) {
      groups.delete(member);
      collisions.push({
        entity: member,
        reason: 'case_collision',
        detail:
          `${sorted.map((m) => JSON.stringify(m)).join(' and ')} differ only by case, ` +
          'so they are one file on a case-insensitive filesystem and two on any other',
      });
    }
  }
  return { groups, collisions };
}

/**
 * What every entity note in the vault should contain, computed from the corpus
 * alone.
 *
 * Pure with respect to the clock: no decayed score, no relative age, no
 * generation timestamp. That is what makes the rendered block idempotent —
 * regenerating over an unchanged corpus produces byte-identical output —
 * which M5 acceptance requires and which any read-time-decayed number would
 * silently break.
 *
 * ## Cost
 * One query for the entity list, then per entity one query for its item keys
 * and four per item (`getCurrentItem`, `getItemBeats`, `getItemFirstFetchedAt`,
 * sources), plus one `getItemEntities` per item for the related list. Fine at
 * the scale this runs at — a few dozen entities against a 7,000-item corpus,
 * once per sync — and deliberately not batched until something needs it, the
 * same note `src/domain/itemBeats.ts` already carries.
 */
export function planEntityNotes(db: Db, options: EntityPlanOptions = {}): EntityPlan {
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxRelated = options.maxRelated ?? DEFAULT_MAX_RELATED;

  const { groups, collisions } = groupEntities(distinctEntityStrings(db));
  const skipped: EntitySkip[] = [...collisions];

  // First pass: which entities can be written at all. A related-entity link is
  // a `[[wikilink]]`, so an entity with no note must never appear in one --
  // otherwise the owner's graph fills with dangling links to notes that can
  // never exist.
  const writable = new Map<string, string[]>();
  for (const [entity, spellings] of [...groups].sort(([a], [b]) => byCodePoint(a, b))) {
    try {
      entityFileName(entity);
      writable.set(entity, spellings);
    } catch (err) {
      if (!(err instanceof EntityNameError)) throw err;
      skipped.push({ entity, reason: err.reason, detail: err.message });
    }
  }

  const notes: EntityNotePlan[] = [];
  for (const [entity, spellings] of writable) {
    const itemKeys = itemKeysForEntities(db, spellings);
    const refs = itemKeys
      .map((key) => itemRef(db, key))
      .filter((ref): ref is EntityItemRef => ref !== null)
      .sort((a, b) => byCodePoint(b.at, a.at) || byCodePoint(a.itemKey, b.itemKey));

    const counts = new Map<string, number>();
    for (const key of itemKeys) {
      for (const other of getItemEntities(db, key)) {
        const otherNfc = other.normalize('NFC');
        if (otherNfc === entity || !writable.has(otherNfc)) continue;
        counts.set(otherNfc, (counts.get(otherNfc) ?? 0) + 1);
      }
    }
    const related = [...counts]
      .map(([name, sharedItems]) => ({ entity: name, sharedItems }))
      .sort((a, b) => b.sharedItems - a.sharedItems || byCodePoint(a.entity, b.entity))
      .slice(0, maxRelated);

    notes.push({
      entity,
      relPath: entityNoteRelPath(entity),
      totalItems: refs.length,
      items: refs.slice(0, maxItems),
      related,
    });
  }

  return { notes, skipped: skipped.sort((a, b) => byCodePoint(a.entity, b.entity)) };
}
