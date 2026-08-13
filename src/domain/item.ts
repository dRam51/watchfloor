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

export function insertItem(db: Db, item: NewItem): Item {
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
    db.exec('rollback');
    throw cause;
  }

  return { ...item, item_id: itemId, item_key: itemKey, created_at: createdAt };
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
  const row = db
    .prepare('select * from items where item_key = ? order by fetched_at desc limit 1')
    .get(itemKey) as ItemRow | undefined;
  return row ? hydrate(db, row) : null;
}

export function getItemAsOf(db: Db, itemKey: string, asOf: string): Item | null {
  const horizon = db.prepare('select oldest_intact_fetched_at from retention_horizon where id = 1').get() as
    | { oldest_intact_fetched_at: string }
    | undefined;
  if (horizon && asOf < horizon.oldest_intact_fetched_at) {
    throw new RetentionHorizonError(asOf, horizon.oldest_intact_fetched_at);
  }

  const row = db
    .prepare(
      'select * from items where item_key = ? and fetched_at <= ? order by fetched_at desc limit 1',
    )
    .get(itemKey, asOf) as ItemRow | undefined;
  return row ? hydrate(db, row) : null;
}
