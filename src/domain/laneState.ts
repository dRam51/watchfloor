import type { Db } from '../db/connection.ts';
import { assertCanonicalTimestamp } from './item.ts';
import { BEATS, type Beat } from './item.ts';

/**
 * Lane order and per-lane collapse state (M3 task 6). §7: "lane order and
 * per-lane collapse state must persist server-side." §7.1: "Read/saved/
 * dismissed state is server-side, keyed to nothing ... Don't put any of it
 * in browser storage." The same reasoning applies here: this is not a
 * browser preference, it is user state that must read identically on every
 * device, so it lives in `lane_layout` (db/migrations/0006_lane_layout.sql)
 * rather than localStorage.
 *
 * Backed by `lane_layout`, which is deliberately mutable -- current state,
 * not history -- the same asymmetry `item_state` documents on itself
 * (0001_init.sql) and `src/domain/itemState.ts` follows. No append-only
 * triggers, no event-log modeling: a lane's position and collapsed flag are
 * each overwritten in place.
 *
 * ## Full replace, not partial PATCH
 * `setLaneLayout` always replaces the entire six-lane layout in one
 * transaction. A partial update of an ORDERED collection (e.g. "move ai to
 * position 2") has no obvious semantics once other lanes' positions must
 * shift to make room, and per-lane collapse toggles are cheap enough at six
 * lanes that sending the whole layout back is not a real cost. The API
 * layer (`src/api/routes/dashboard.ts`) mirrors this: `PUT /dashboard/layout`
 * takes the complete ordered list, never a single-lane patch.
 *
 * ## Order is array order, not a stored field on the wire
 * `LaneLayoutEntry` deliberately carries no `position` number -- the array's
 * own order IS the lane order, both in `getLaneLayout`'s return value and in
 * `setLaneLayout`'s `lanes` parameter. `position` exists only as an internal
 * SQL sort key; exposing it as a second, parallel source of truth (index vs.
 * field) would only create a way for the two to disagree.
 *
 * ## Graceful degradation against an unknown or missing beat
 * `BEATS` (src/domain/item.ts) is a closed set defined in code, and
 * `lane_layout.beat` carries no CHECK/FK constraint tying it to that set
 * (see the migration's own comment for why). Two failure shapes follow from
 * that, and both must not crash:
 *   - A beat in storage that is no longer in `BEATS` (e.g. retired in a
 *     later code change) is silently dropped by `getLaneLayout` rather than
 *     surfaced or thrown.
 *   - A beat in `BEATS` with no stored row yet gets a default entry
 *     (collapsed: false), appended after whatever IS stored, in `BEATS`'s
 *     own canonical order -- so a fresh database, or one that has only ever
 *     had some lanes explicitly written, still returns all six.
 */
export interface LaneLayoutEntry {
  beat: Beat;
  collapsed: boolean;
}

/**
 * The shape `setLaneLayout` accepts: deliberately wider than
 * {@link LaneLayoutEntry} (`beat: string`, not `beat: Beat`). Callers with
 * already-validated data (e.g. another domain module) satisfy this
 * structurally for free since `Beat` is a string union. Callers with
 * genuinely unvalidated input -- chiefly the API route layer, which only
 * knows `request.body` parsed to `string`/`boolean` via Zod -- can pass it
 * straight through without an unsafe cast; `assertIsCompletePermutation`
 * below is where the real "is this actually one of the six beats" check
 * happens, once, rather than being re-asserted at every call site.
 */
export interface LaneLayoutInput {
  beat: string;
  collapsed: boolean;
}

export class InvalidLaneLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLaneLayoutError';
  }
}

interface LaneLayoutRow {
  beat: string;
  position: number;
  collapsed: number;
  updated_at: string;
}

function isBeat(value: string): value is Beat {
  return (BEATS as readonly string[]).includes(value);
}

function getRows(db: Db): LaneLayoutRow[] {
  // Cast target is an INLINE type literal, not a named interface -- the same
  // node:sqlite `.all()` cast shape as src/cluster/store.ts's
  // getCurrentTitlesForClustering, which documents why a named interface
  // here fails tsc's TS2352 overlap check while an identical inline literal
  // does not.
  return db.prepare('select beat, position, collapsed, updated_at from lane_layout').all() as Array<{
    beat: string;
    position: number;
    collapsed: number;
    updated_at: string;
  }>;
}

/**
 * The current lane layout for all six beats, in lane order. Beats stored
 * with an unknown name are dropped; beats with no stored row get a default
 * entry (collapsed: false) appended after the stored ones, in `BEATS`'s own
 * order. Always returns exactly `BEATS.length` entries.
 */
export function getLaneLayout(db: Db): LaneLayoutEntry[] {
  const stored = getRows(db)
    .filter((row): row is LaneLayoutRow & { beat: Beat } => isBeat(row.beat))
    .map((row) => ({ beat: row.beat, position: row.position, collapsed: row.collapsed === 1 }));

  const storedBeats = new Set(stored.map((s) => s.beat));
  let nextPosition = stored.length === 0 ? 0 : Math.max(...stored.map((s) => s.position)) + 1;

  const defaults = BEATS.filter((beat) => !storedBeats.has(beat)).map((beat) => {
    const entry = { beat, position: nextPosition, collapsed: false };
    nextPosition += 1;
    return entry;
  });

  return [...stored, ...defaults]
    .sort((a, b) => a.position - b.position || a.beat.localeCompare(b.beat))
    .map(({ beat, collapsed }) => ({ beat, collapsed }));
}

const UPSERT = `
  insert into lane_layout (beat, position, collapsed, updated_at)
  values (?, ?, ?, ?)
  on conflict (beat) do update set
    position = excluded.position,
    collapsed = excluded.collapsed,
    updated_at = excluded.updated_at
`;

/**
 * Validates that `lanes` is exactly one entry per `BEATS` member, no more,
 * no fewer, no duplicates, no unknown beat -- a true permutation of the
 * closed beat set. Throws {@link InvalidLaneLayoutError} naming the specific
 * problem rather than a generic "invalid layout".
 */
function assertIsCompletePermutation(lanes: readonly LaneLayoutInput[]): void {
  const seen = new Set<string>();
  for (const lane of lanes) {
    if (!isBeat(lane.beat)) {
      throw new InvalidLaneLayoutError(`unknown beat in layout: ${String(lane.beat)}`);
    }
    if (seen.has(lane.beat)) {
      throw new InvalidLaneLayoutError(`duplicate beat in layout: ${lane.beat}`);
    }
    seen.add(lane.beat);
  }
  for (const beat of BEATS) {
    if (!seen.has(beat)) {
      throw new InvalidLaneLayoutError(`layout is missing beat: ${beat} (a full replace requires all six)`);
    }
  }
}

/**
 * Replaces the entire lane layout in one transaction: `lanes`'s array order
 * becomes the new lane order (index 0 is position 0, and so on), and each
 * entry's `collapsed` flag is written as given. `lanes` must be a complete
 * permutation of `BEATS` -- see {@link assertIsCompletePermutation} -- and a
 * caller supplying an unknown beat, a duplicate, or a partial list gets
 * {@link InvalidLaneLayoutError} with nothing written: either the whole
 * layout changes or none of it does.
 *
 * `now` is required, matching src/domain/itemState.ts's convention for
 * mutators of current (non-append-only) state, and is validated with the
 * same `assertCanonicalTimestamp` every other domain module uses.
 */
export function setLaneLayout(db: Db, lanes: readonly LaneLayoutInput[], now: string): LaneLayoutEntry[] {
  assertCanonicalTimestamp('now', now);
  assertIsCompletePermutation(lanes);

  db.exec('begin');
  try {
    lanes.forEach((lane, index) => {
      db.prepare(UPSERT).run(lane.beat, index, lane.collapsed ? 1 : 0, now);
    });
    db.exec('commit');
  } catch (cause) {
    // SQLite can roll back the transaction itself on some internal errors
    // (SQLITE_FULL, SQLITE_IOERR, SQLITE_NOMEM) -- see src/db/migrate.ts and
    // src/domain/itemState.ts's dismissItem for the same guard against
    // double-rollback replacing the real `cause`.
    if (db.isTransaction) db.exec('rollback');
    throw cause;
  }

  // Read back rather than echo `lanes` directly: this both gives the return
  // value its correctly-narrowed `Beat` type (via getLaneLayout's own
  // `isBeat` filter, without a second unsafe cast here) and proves the
  // write round-trips faithfully instead of merely assuming it did.
  return getLaneLayout(db);
}
