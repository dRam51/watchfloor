import type { Db } from '../db/connection.ts';
import { assertCanonicalTimestamp } from '../domain/item.ts';
import { matchGazetteer } from './gazetteer.ts';
import { gazetteerVersion, type GazetteerConfig } from './load.ts';

/**
 * The geo-extraction sweep: level-triggered off the gazetteer's content
 * digest, bounded per run, writing `item_locations`, `item_countries` and the
 * `item_location_extractions` ledger.
 *
 * Structurally the twin of `src/entities/sweep.ts`, and the resemblance is
 * deliberate rather than incidental -- the same problem has the same solution,
 * and a reader who has understood one has understood this.
 *
 * ## Why the ledger matters MORE here than it does for entities
 *
 * Migration 0010 exists because zero rows in `item_entities` could not
 * distinguish "no extractor exists" from "nothing matched", and that ambiguity
 * let entity extraction sit empty across three milestones while looking
 * exactly like success.
 *
 * Geo extraction is more exposed to that failure, not less. **Most items
 * genuinely have no location**, so a nearly-empty `item_locations` is the
 * expected steady state rather than a symptom. Without the ledger there is no
 * observation that could distinguish a working extractor from an inert one.
 *
 * That is not hypothetical here. The first live run of this matcher over the
 * stored corpus returned **six** location matches across 16,570 items -- and
 * the matcher was correct. The corpus had no semiconductor or data-centre
 * coverage at all (`TSMC` 0, `ASML` 0, `Hsinchu` 0, `Veldhoven` 0). The
 * diagnosis needed exactly two numbers: how many items were scanned, and how
 * many carried anything. This ledger is where the first one comes from.
 *
 * ## Every stored match, but not every drawn pin
 *
 * The sweep stores what it finds, INCLUDING matches below `minConfidence`. The
 * threshold is a read-path decision (§7.2's *"never plot below the
 * threshold"*), so lowering it in config changes the map immediately without
 * re-running an extraction, and the weak matches that were stored are the
 * evidence you tune against. `plottable()` in `./gazetteer.ts` is the filter.
 */

/**
 * Same value and same reasoning as `src/entities/sweep.ts`'s: bounded so one
 * tick can never become an unbounded scan, large enough that a config edit
 * reaches the whole corpus within a few polls.
 */
export const DEFAULT_SWEEP_LIMIT = 2000;

export interface LocationSweepOptions {
  /** Canonical UTC instant recorded in the ledger. */
  now: string;
  limit?: number;
}

export interface LocationSweepReport {
  gazetteerVersion: string;
  limit: number;
  /** Item versions examined this run. */
  scanned: number;
  /** `item_locations` rows inserted (an already-present pair counts 0). */
  locationsWritten: number;
  /** `item_countries` rows inserted. */
  countriesWritten: number;
  /** Of `scanned`, how many carried at least one location match at any confidence. */
  itemsWithLocation: number;
  /** Of `scanned`, how many carried at least one location match ABOVE the threshold. */
  itemsPlottable: number;
  /** Item versions still awaiting this gazetteer version AFTER this run. */
  remaining: number;
}

export interface LocationExtractionCoverage {
  gazetteerVersion: string;
  total: number;
  done: number;
  remaining: number;
}

/**
 * How far the current gazetteer has got over the stored corpus, without
 * writing anything.
 *
 * Separate from `sweepLocations` so "did this pass ever run" is answerable at
 * all -- the question nothing in this system could answer about entity
 * extraction for three milestones.
 */
export function locationExtractionCoverage(
  db: Db,
  config: GazetteerConfig,
): LocationExtractionCoverage {
  const version = gazetteerVersion(config);
  // Inline type literal, NOT a named interface: `.all()`/`.get()` return
  // `Record<string, SQLOutputValue>` and TypeScript's `as` overlap check is
  // stricter about a named-interface target (TS2352). Fifth module to hit
  // this -- see src/cluster/store.ts and CLAUDE.md. Leave this comment, or the
  // next tidy-up reintroduces the error.
  const row = db
    .prepare(
      `select (select count(*) from items) as total,
              (select count(*) from item_location_extractions where gazetteer_version = ?) as done`,
    )
    .get(version) as { total: number; done: number };

  return {
    gazetteerVersion: version,
    total: row.total,
    done: row.done,
    remaining: row.total - row.done,
  };
}

export function sweepLocations(
  db: Db,
  config: GazetteerConfig,
  options: LocationSweepOptions,
): LocationSweepReport {
  assertCanonicalTimestamp('now', options.now);
  const version = gazetteerVersion(config);
  const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;

  const report: LocationSweepReport = {
    gazetteerVersion: version,
    limit,
    scanned: 0,
    locationsWritten: 0,
    countriesWritten: 0,
    itemsWithLocation: 0,
    itemsPlottable: 0,
    remaining: 0,
  };

  // Newest first, `item_id` breaking ties: a bounded backfill should cover
  // what a reader is looking at before it works backwards through the archive,
  // and a partial run must be deterministic rather than scan-order dependent.
  const pending = db
    .prepare(
      `select i.item_id, i.title, i.summary_raw
         from items i
        where not exists (
          select 1 from item_location_extractions x
           where x.item_id = i.item_id and x.gazetteer_version = ?
        )
        order by i.fetched_at desc, i.item_id
        limit ?`,
    )
    .all(version, limit) as Array<{
    item_id: string;
    title: string;
    summary_raw: string | null;
  }>;

  if (pending.length > 0) {
    const insertLocation = db.prepare(
      `insert into item_locations (item_id, location_id, geo_confidence) values (?,?,?)
       on conflict (item_id, location_id) do update set geo_confidence = excluded.geo_confidence`,
    );
    const insertCountry = db.prepare(
      `insert into item_countries (item_id, country_code, geo_confidence) values (?,?,?)
       on conflict (item_id, country_code) do update set geo_confidence = excluded.geo_confidence`,
    );
    const insertLedger = db.prepare(
      `insert into item_location_extractions
         (item_id, gazetteer_version, extracted_at, location_count, country_count)
       values (?,?,?,?,?)`,
    );

    // One transaction for the whole batch. A half-applied sweep would leave
    // match rows with no ledger row, which reads as "never scanned" and would
    // be re-scanned forever -- and match rows WITHOUT their ledger row is the
    // one state this design cannot recover from, since the ledger is the only
    // thing that distinguishes scanned-and-empty from unscanned.
    db.exec('begin');
    try {
      for (const row of pending) {
        const matches = matchGazetteer(
          { title: row.title, summaryRaw: row.summary_raw },
          config,
        );

        // `changes` is `number | bigint` in node:sqlite's types -- SQLite can
        // report a 64-bit count. Narrowed with Number() rather than widened
        // through the report's types: a per-item upsert affects 0 or 1 rows,
        // so the bigint branch is unreachable here, and letting it propagate
        // would make every consumer of this report handle a case that cannot
        // happen.
        for (const m of matches.locations) {
          const result = insertLocation.run(row.item_id, m.locationId, m.confidence);
          report.locationsWritten += Number(result.changes);
        }
        for (const c of matches.countries) {
          const result = insertCountry.run(row.item_id, c.countryCode, c.confidence);
          report.countriesWritten += Number(result.changes);
        }

        insertLedger.run(
          row.item_id,
          version,
          options.now,
          matches.locations.length,
          matches.countries.length,
        );

        report.scanned += 1;
        if (matches.locations.length > 0) report.itemsWithLocation += 1;
        if (matches.locations.some((m) => m.confidence >= config.minConfidence)) {
          report.itemsPlottable += 1;
        }
      }
      db.exec('commit');
    } catch (cause) {
      db.exec('rollback');
      throw cause;
    }
  }

  report.remaining = locationExtractionCoverage(db, config).remaining;
  return report;
}
