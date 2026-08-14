import { randomUUID } from 'node:crypto';
import type { Db } from '../db/connection.ts';
import { assertCanonicalTimestamp } from './item.ts';

/**
 * Read/saved/dismissed UI state for one item, keyed on `item_key` (the
 * stable identity across versions -- `db/migrations/0001_init.sql`), not
 * `item_id`. That keying is what makes state survive re-versioning: if a
 * source re-delivers an item as a new row (a new `item_id` sharing the same
 * `item_key`), nothing here needs to change or be migrated forward, because
 * nothing here was ever scoped to the old version in the first place. See
 * `dismissItem`'s doc comment and the re-delivery test in
 * `tests/domain/itemState.test.ts` for the concrete proof.
 *
 * Backed by `item_state` (0001_init.sql), which is deliberately mutable --
 * unlike `items` / `item_scores` / `item_clusters`, it carries no
 * append-only triggers, per its own schema comment: "Mutable UI state ...
 * Deliberately NOT append-only". Do not "fix" that asymmetry.
 *
 * ## Legal flag combinations
 * All eight combinations of (read, saved, dismissed) are legal and none is
 * enforced or cleared as a side effect of another:
 *   - `dismissItem` never clears `saved_at` -- a user can dismiss an item
 *     from the active stream while keeping it in their saved list.
 *   - `saveItem` never clears `dismissed_at` -- saving a dismissed item is
 *     allowed and does not un-dismiss it (there is no un-dismiss at all;
 *     see below).
 *   - `markItemRead` is independent of both.
 * See "legal flag combinations" in the test file for a proof of each pair.
 *
 * ## Reversibility, decided per flag
 *   - **Read**: one-way within a "session of interest" -- `markItemRead` is
 *     idempotent. The first call stamps `read_at`; every later call is a
 *     no-op that leaves the original timestamp alone. §7.4's "persistent
 *     left-edge accent until read" is a boolean the UI checks
 *     (`readAt !== null`), not a recency clock, so re-stamping on every view
 *     would just add write churn for a value nothing reads.
 *   - **Saved**: fully reversible. `saveItem` sets `saved_at`; `unsaveItem`
 *     clears it back to `null` -- not to a separate "was saved, now isn't"
 *     marker, so "is this saved" is always exactly `saved_at !== null`, one
 *     predicate, no second state to keep in sync. Save/un-save/save again
 *     produces a fresh `saved_at` on the second save.
 *   - **Dismissed**: one-way, permanently. There is no `undismissItem`
 *     export in this module -- "dismissed items never come back" (§7) is
 *     enforced structurally, not by a flag this module could be asked to
 *     flip back. `dismissItem` itself is idempotent (a repeat call on an
 *     already-dismissed item is a no-op that preserves the original
 *     `dismissed_at`), which matters for the negative-signal log below: it
 *     is what keeps a re-delivered dismissed item from logging a second
 *     signal every time the source re-sends it.
 *
 * ## `now` is always injected
 * Every mutator takes `now` as a required parameter and never reads the
 * wall clock itself, matching every other domain module in this project
 * (`src/domain/item.ts`, `src/db/fetchState.ts`). `now` is validated with
 * the same `assertCanonicalTimestamp` those modules use -- not a second
 * validator -- so a malformed caller-supplied value fails loudly here
 * exactly as it would in `insertItem`.
 */
export interface ItemState {
  itemKey: string;
  readAt: string | null;
  savedAt: string | null;
  dismissedAt: string | null;
  updatedAt: string;
}

interface ItemStateRow {
  item_key: string;
  read_at: string | null;
  saved_at: string | null;
  dismissed_at: string | null;
  updated_at: string;
}

function hydrate(row: ItemStateRow): ItemState {
  return {
    itemKey: row.item_key,
    readAt: row.read_at,
    savedAt: row.saved_at,
    dismissedAt: row.dismissed_at,
    updatedAt: row.updated_at,
  };
}

function getRow(db: Db, itemKey: string): ItemStateRow | null {
  const row = db.prepare('select * from item_state where item_key = ?').get(itemKey) as
    | ItemStateRow
    | undefined;
  return row ?? null;
}

/** Current read/saved/dismissed state for `itemKey`, or `null` if it has never been touched. */
export function getItemState(db: Db, itemKey: string): ItemState | null {
  const row = getRow(db, itemKey);
  return row ? hydrate(row) : null;
}

const UPSERT = `
  insert into item_state (item_key, read_at, saved_at, dismissed_at, updated_at)
  values (?, ?, ?, ?, ?)
  on conflict (item_key) do update set
    read_at = excluded.read_at,
    saved_at = excluded.saved_at,
    dismissed_at = excluded.dismissed_at,
    updated_at = excluded.updated_at
`;

function upsert(db: Db, row: ItemStateRow): void {
  db.prepare(UPSERT).run(row.item_key, row.read_at, row.saved_at, row.dismissed_at, row.updated_at);
}

/**
 * Marks `itemKey` read. Idempotent: a call on an already-read item is a
 * no-op that returns the existing state unchanged -- `read_at` records when
 * the item was FIRST seen, not most recently, per this module's doc comment.
 */
export function markItemRead(db: Db, itemKey: string, now: string): ItemState {
  assertCanonicalTimestamp('now', now);

  const existing = getRow(db, itemKey);
  if (existing && existing.read_at !== null) return hydrate(existing);

  const row: ItemStateRow = {
    item_key: itemKey,
    read_at: now,
    saved_at: existing?.saved_at ?? null,
    dismissed_at: existing?.dismissed_at ?? null,
    updated_at: now,
  };
  upsert(db, row);
  return hydrate(row);
}

/**
 * Saves `itemKey`. Idempotent in the same shape as {@link markItemRead}: a
 * call on an already-saved item is a no-op that preserves the original
 * `saved_at` rather than bumping it to `now`.
 */
export function saveItem(db: Db, itemKey: string, now: string): ItemState {
  assertCanonicalTimestamp('now', now);

  const existing = getRow(db, itemKey);
  if (existing && existing.saved_at !== null) return hydrate(existing);

  const row: ItemStateRow = {
    item_key: itemKey,
    read_at: existing?.read_at ?? null,
    saved_at: now,
    dismissed_at: existing?.dismissed_at ?? null,
    updated_at: now,
  };
  upsert(db, row);
  return hydrate(row);
}

/**
 * Un-saves `itemKey`, clearing `saved_at` back to `null`. Returns `null`
 * (rather than creating a row) when `itemKey` has no `item_state` row at
 * all -- there is nothing to unsave. Returns the existing state unchanged
 * when a row exists but is already unsaved (`saved_at` already `null`).
 */
export function unsaveItem(db: Db, itemKey: string, now: string): ItemState | null {
  assertCanonicalTimestamp('now', now);

  const existing = getRow(db, itemKey);
  if (!existing) return null;
  if (existing.saved_at === null) return hydrate(existing);

  const row: ItemStateRow = { ...existing, saved_at: null, updated_at: now };
  upsert(db, row);
  return hydrate(row);
}

/**
 * Dismisses `itemKey`. Idempotent and, deliberately, one-way: there is no
 * `undismissItem` export anywhere in this module. A repeat call on an
 * already-dismissed item is a no-op that preserves the original
 * `dismissed_at` -- both so "when was this dismissed" stays truthful across
 * however many times a source re-delivers the item, and so the
 * negative-signal log below records the event once, not once per
 * re-delivery.
 *
 * Because `item_state` is keyed on `item_key`, dismissal is inherently
 * immune to re-versioning: inserting a new `items` row for the same
 * `item_key` (a source re-delivering an unchanged entry -- see
 * `src/domain/itemFirstFetchedAt.ts`'s doc comment for why `cisa-kev` does
 * exactly this on every poll) never touches `item_state` at all, so the
 * dismissal it already recorded is simply still there. No special-casing
 * was needed to make that true; it falls out of keying on the right
 * identity. See this file's re-delivery test for the two-version proof.
 *
 * Also writes one row to `interest_dismissal_signals`
 * (`db/migrations/0004_interest_dismissal_signals.sql`), atomically with the
 * `item_state` update -- the negative interest signal the brief's §7 asks
 * for ("dismissal feeds the interest profile as a negative signal (log it;
 * don't auto-tune the weights)"). This module only ever INSERTs into that
 * table; nothing here (or anywhere else in this codebase) reads it back to
 * adjust `config/interests.yaml` or any score weight -- see the "never
 * touches config/interests.yaml" test for a byte-level proof, not just an
 * absence-of-import argument.
 */
export function dismissItem(db: Db, itemKey: string, now: string): ItemState {
  assertCanonicalTimestamp('now', now);

  const existing = getRow(db, itemKey);
  if (existing && existing.dismissed_at !== null) return hydrate(existing);

  const row: ItemStateRow = {
    item_key: itemKey,
    read_at: existing?.read_at ?? null,
    saved_at: existing?.saved_at ?? null,
    dismissed_at: now,
    updated_at: now,
  };

  db.exec('begin');
  try {
    upsert(db, row);
    db.prepare(
      'insert into interest_dismissal_signals (signal_id, item_key, dismissed_at, created_at) values (?, ?, ?, ?)',
    ).run(randomUUID(), itemKey, now, now);
    db.exec('commit');
  } catch (cause) {
    // Same guard as src/domain/item.ts's insertItem and src/db/migrate.ts:
    // SQLite can roll back the transaction itself on some internal errors,
    // and an unconditional rollback here would then throw "cannot rollback
    // - no transaction is active", replacing the real `cause`.
    if (db.isTransaction) db.exec('rollback');
    throw cause;
  }

  return hydrate(row);
}

/** One logged negative interest signal -- see {@link dismissItem}'s doc comment. */
export interface DismissalSignal {
  itemKey: string;
  dismissedAt: string;
}

/** Every dismissal signal logged for `itemKey`, oldest first. Read-only: nothing in this module updates or deletes from this table (it is append-only, trigger-enforced). */
export function getDismissalSignals(db: Db, itemKey: string): DismissalSignal[] {
  // Inline type literal, not a named interface, in the cast target --
  // matches src/cluster/store.ts's getCurrentTitlesForClustering and
  // src/domain/itemBeats.ts's established pattern for this exact node:sqlite
  // `.all()` cast shape; see that file's comment for why a named interface
  // here fails tsc's TS2352 overlap check while an identical inline literal
  // does not.
  const rows = db
    .prepare(
      'select item_key, dismissed_at from interest_dismissal_signals where item_key = ? order by dismissed_at asc',
    )
    .all(itemKey) as Array<{ item_key: string; dismissed_at: string }>;
  return rows.map((r) => ({ itemKey: r.item_key, dismissedAt: r.dismissed_at }));
}
