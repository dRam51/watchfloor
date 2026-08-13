import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/connection.ts';

export const BEATS = ['ai', 'cyber', 'aisec', 'repos', 'markets', 'usnews'] as const;
export type Beat = (typeof BEATS)[number];

export type ItemType = 'event' | 'analysis' | 'press';

export class RetentionHorizonError extends Error {
  constructor(asOf: string, horizon: string) {
    super(
      `as_of ${asOf} predates the retention horizon ${horizon}; ` +
        `items before the horizon are archived and cannot be reconstructed faithfully`,
    );
    this.name = 'RetentionHorizonError';
  }
}

// Timestamps are compared lexicographically (JS `<`/`<=` and SQLite `<=` on
// TEXT columns), which is only equivalent to chronological order when every
// value shares the exact same fixed-width shape. A missing-milliseconds or
// non-UTC-offset value silently breaks that invariant and can leak a later
// version into an as_of read (see task-4 fix-round-1 report, Finding 1).
// Reject rather than coerce: silently rewriting a caller's timestamp would
// mask a genuinely broken feed, and `items` is append-only, so a malformed
// value written once can never be corrected.
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class InvalidTimestampError extends Error {
  constructor(field: string, value: string) {
    super(
      `${field} '${value}' is not a canonical UTC timestamp ` +
        `(expected YYYY-MM-DDTHH:mm:ss.sssZ); rejected rather than coerced so a ` +
        `malformed value can't silently corrupt as_of ordering`,
    );
    this.name = 'InvalidTimestampError';
  }
}

/**
 * Exported because every writer of a lexicographically-compared timestamp must
 * validate through this one predicate, not a private copy of it. In particular
 * the M6 retention job, which writes `retention_horizon.oldest_intact_fetched_at`,
 * must call this before storing — see the read-side guard in `getItemAsOf`.
 */
export function assertCanonicalTimestamp(field: string, value: string): void {
  if (!CANONICAL_TIMESTAMP.test(value)) {
    throw new InvalidTimestampError(field, value);
  }
}

export interface NewItem {
  url: string;
  canonicalUrl: string;
  title: string;
  author?: string | null;
  sourceId: string;
  itemType: ItemType;
  beats: Beat[];
  entities: string[];
  publishedAt: string | null;
  fetchedAt: string;
  summaryRaw: string | null;
  rawJson: string;
  lat?: number | null;
  lon?: number | null;
  geoConfidence?: number | null;
}

export interface Item extends NewItem {
  item_id: string;
  item_key: string;
  created_at: string;
}

/** Stable identity across versions. Canonical URL is the dedupe key (§3). */
export function deriveItemKey(canonicalUrl: string): string {
  return createHash('sha256').update(canonicalUrl).digest('hex');
}

/**
 * Appends a new version of an item.
 *
 * **Contract for feed adapters (M1 onward).** `publishedAt` and `fetchedAt`
 * must already be normalized to `YYYY-MM-DDTHH:mm:ss.sssZ` before this is
 * called; anything else throws {@link InvalidTimestampError}. This rejects
 * rather than coerces, deliberately: silently rewriting a caller's timestamp
 * would mask a genuinely broken feed, and because `items` is append-only
 * (trigger-enforced), a malformed value written once is permanently
 * uncorrectable. Normalize at the adapter boundary, where the source's own
 * format is still known — not here, where it is guesswork.
 */
export function insertItem(db: Db, item: NewItem): Item {
  assertCanonicalTimestamp('fetchedAt', item.fetchedAt);
  if (item.publishedAt !== null) assertCanonicalTimestamp('publishedAt', item.publishedAt);

  const itemId = randomUUID();
  const itemKey = deriveItemKey(item.canonicalUrl);
  const createdAt = new Date().toISOString();

  db.exec('begin');
  try {
    db.prepare(
      `insert into items (item_id, item_key, url, canonical_url, title, author, source_id,
                          item_type, published_at, fetched_at, summary_raw, raw_json,
                          lat, lon, geo_confidence, created_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      itemId,
      itemKey,
      item.url,
      item.canonicalUrl,
      item.title,
      item.author ?? null,
      item.sourceId,
      item.itemType,
      item.publishedAt,
      item.fetchedAt,
      item.summaryRaw,
      item.rawJson,
      item.lat ?? null,
      item.lon ?? null,
      item.geoConfidence ?? null,
      createdAt,
    );

    const beatStmt = db.prepare('insert into item_beats (item_id, beat) values (?, ?)');
    for (const beat of item.beats) beatStmt.run(itemId, beat);

    const entityStmt = db.prepare('insert into item_entities (item_id, entity) values (?, ?)');
    for (const entity of item.entities) entityStmt.run(itemId, entity);

    db.exec('commit');
  } catch (cause) {
    // SQLite auto-rolls-back the transaction itself on some internal errors
    // (SQLITE_FULL, SQLITE_IOERR, SQLITE_NOMEM); an unconditional rollback
    // here would then throw "cannot rollback - no transaction is active" and
    // replace the real `cause` with that confusing message. Same hazard,
    // same guard, as src/db/migrate.ts.
    if (db.isTransaction) db.exec('rollback');
    throw cause;
  }

  // Copy the arrays: item is the caller's own object, and returning its
  // beats/entities by reference would let a caller's in-place mutation (e.g.
  // `result.beats.sort()`) silently corrupt the input they still hold.
  return {
    ...item,
    beats: [...item.beats],
    entities: [...item.entities],
    item_id: itemId,
    item_key: itemKey,
    created_at: createdAt,
  };
}

interface ItemRow {
  item_id: string;
  item_key: string;
  url: string;
  canonical_url: string;
  title: string;
  author: string | null;
  source_id: string;
  item_type: ItemType;
  published_at: string | null;
  fetched_at: string;
  summary_raw: string | null;
  raw_json: string;
  lat: number | null;
  lon: number | null;
  geo_confidence: number | null;
  created_at: string;
}

function hydrate(db: Db, row: ItemRow): Item {
  const beats = (
    db.prepare('select beat from item_beats where item_id = ?').all(row.item_id) as Array<{
      beat: Beat;
    }>
  ).map((r) => r.beat);
  const entities = (
    db.prepare('select entity from item_entities where item_id = ?').all(row.item_id) as Array<{
      entity: string;
    }>
  ).map((r) => r.entity);

  return {
    item_id: row.item_id,
    item_key: row.item_key,
    url: row.url,
    canonicalUrl: row.canonical_url,
    title: row.title,
    author: row.author,
    sourceId: row.source_id,
    itemType: row.item_type,
    beats,
    entities,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    summaryRaw: row.summary_raw,
    rawJson: row.raw_json,
    lat: row.lat,
    lon: row.lon,
    geoConfidence: row.geo_confidence,
    created_at: row.created_at,
  };
}

export function getCurrentItem(db: Db, itemKey: string): Item | null {
  // items has no uniqueness on (item_key, fetched_at); two versions can
  // legally share an instant (batch ingest, second-precision source). SQL
  // guarantees no tiebreak among equal sort keys, so `rowid desc` is added
  // explicitly — items is a rowid table, so rowid gives insertion order for
  // free and the most recently inserted version deterministically wins.
  const row = db
    .prepare('select * from items where item_key = ? order by fetched_at desc, rowid desc limit 1')
    .get(itemKey) as ItemRow | undefined;
  return row ? hydrate(db, row) : null;
}

export function getItemAsOf(db: Db, itemKey: string, asOf: string): Item | null {
  assertCanonicalTimestamp('asOf', asOf);

  const horizon = db.prepare('select oldest_intact_fetched_at from retention_horizon where id = 1').get() as
    | { oldest_intact_fetched_at: string }
    | undefined;
  if (horizon) {
    // The horizon is compared lexicographically against an already-validated
    // asOf, so it has to share the exact same fixed-width shape or the
    // comparison means nothing. Both failure modes are silent and wrong:
    // a second-precision horizon ('2026-08-11T00:00:00Z', which is what
    // strftime or .slice(0,19)+'Z' produces) makes an asOf exactly *at* the
    // horizon throw, because '.' sorts before 'Z'; and a horizon carrying a
    // non-UTC offset compares as later than it truly is, quietly returning
    // thinned history. The M6 retention job is required to validate before
    // writing (see assertCanonicalTimestamp); this is the read-side backstop
    // for a value that got in some other way. Fail loudly either way.
    assertCanonicalTimestamp(
      'retention_horizon.oldest_intact_fetched_at',
      horizon.oldest_intact_fetched_at,
    );
    if (asOf < horizon.oldest_intact_fetched_at) {
      throw new RetentionHorizonError(asOf, horizon.oldest_intact_fetched_at);
    }
  }

  const row = db
    .prepare(
      'select * from items where item_key = ? and fetched_at <= ? order by fetched_at desc, rowid desc limit 1',
    )
    .get(itemKey, asOf) as ItemRow | undefined;
  return row ? hydrate(db, row) : null;
}
