/**
 * The entity backfill sweep (M5 task 16).
 *
 * ## The problem it exists for
 * 7,267 item versions were already stored when the extractor landed, all with
 * zero entity rows, and `items` is append-only and trigger-enforced -- they
 * cannot be re-normalised. Without this pass, `entities/` would stay empty for
 * as long as it took new ingest to outweigh the archive, M5's strongest
 * acceptance test ("delete the tree, it reproduces identically") would keep
 * passing vacuously, and §7.4's graph would have nothing to render.
 *
 * ## Why backfilling is legal under append-only, checked rather than assumed
 * The append-only triggers in `db/migrations/0001_init.sql` are on `items`,
 * and this pass never writes to `items` -- not an UPDATE, not a new version.
 * `item_entities` is a separate table with a foreign key to `items` and no
 * triggers of its own, so adding an entity row for an existing `item_id` adds a
 * fact ABOUT that version without rewriting it, exactly as `item_scores` does
 * for a re-score. A test asserts the `items` rows are byte-identical across a
 * sweep.
 *
 * ## Why there is a ledger and not just "items with no entity rows"
 * `[]` is deliberately the answer both for "scanned, nothing matched" and for
 * "never scanned" (`src/domain/itemEntities.ts` documents that uniformity as
 * load-bearing). So an entity-row-count probe would rescan every barren item on
 * every cycle, forever, and could never report coverage. `0010`'s
 * `item_entity_extractions` stores the distinction, keyed on
 * `(item_id, ruleset_version)`.
 *
 * ## Two write paths, and why that is safe
 * New items get entities inside `insertItem`'s own transaction, via
 * `normalizeItem`. This sweep covers everything else: the stored corpus, any
 * item whose insert predates the extractor, and -- the case that matters most
 * over time -- **every item again whenever `config/entities.yaml` changes**,
 * because the ruleset version is a content digest of the rules.
 *
 * Both paths call the same pure `extractEntities` over the same four inputs
 * (title, summary, canonical URL, that version's beats), which is what makes
 * "they agree" a property rather than a hope. A test runs both over real
 * corpus rows and compares.
 *
 * ## Insert-only, and the divergence that follows
 * The sweep never deletes an entity row -- CLAUDE.md's never-delete rule, and
 * there is no principled repair anyway (an entity attributed under an older
 * ruleset was genuinely attributed). So **removing a term from the config
 * leaves its rows behind.** That is reported (`orphaned`) rather than left to
 * be discovered by someone reading a stale note; closing it would take a
 * reviewed migration.
 */

import type { Db } from '../db/connection.ts';
import { assertCanonicalTimestamp, type Beat } from '../domain/item.ts';
import { extractEntities, PATTERN_EXTRACTORS } from './extract.ts';
import { rulesetVersion, type EntityRuleset, type EntityType } from './rules.ts';

/**
 * Items scanned per run.
 *
 * Sized against measurement, not taste: extraction is ~120 compiled regexes
 * over a title plus a 300-character summary, and the full 7,267-item corpus
 * sweeps in well under a second. 2,000 keeps a single cycle's added latency in
 * the low hundreds of milliseconds while converging the whole backlog in four
 * polls -- fast enough that a config edit reaches the corpus within an hour,
 * bounded enough that it can never be the reason a poll cycle stalls.
 *
 * There is a default at all because a caller that forgets a limit must not be
 * able to turn one tick into an unbounded scan; `repoEnrichment`'s own
 * per-sweep cap exists for the same reason.
 */
export const DEFAULT_SWEEP_LIMIT = 2000;

export interface EntitySweepOptions {
  /** Canonical UTC instant recorded in the ledger. */
  now: string;
  limit?: number;
}

export interface EntitySweepReport {
  rulesetVersion: string;
  limit: number;
  /** Item VERSIONS examined this run. */
  scanned: number;
  /** `item_entities` rows actually inserted (an already-present pair counts 0). */
  entitiesWritten: number;
  /** Of `scanned`, how many carried at least one entity. */
  itemsWithEntities: number;
  /** Item versions still awaiting this ruleset AFTER this run. */
  remaining: number;
  /** What was written this run, by the config's own taxonomy. */
  byType: Record<EntityType, number>;
  /**
   * Stored entity strings the CURRENT ruleset can no longer produce -- a term
   * removed from config, or a pattern turned off. Sorted, capped.
   */
  orphaned: string[];
}

const ORPHAN_REPORT_CAP = 50;



// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export interface EntityExtractionCoverage {
  rulesetVersion: string;
  total: number;
  done: number;
  remaining: number;
}

/**
 * How far the current ruleset has got over the stored corpus.
 *
 * Separate from `sweepEntities` so a CLI or a report can ask without writing
 * anything -- and so "did the pass ever run" is answerable at all, which is the
 * question nothing in this system could answer for three milestones.
 */
export function entityExtractionCoverage(db: Db, ruleset: EntityRuleset): EntityExtractionCoverage {
  const version = rulesetVersion(ruleset);
  // Inline type literal rather than a named interface: `.all()` returns
  // `Record<string, SQLOutputValue>[]` and TypeScript's `as` overlap check is
  // stricter about a named-interface array target. See src/cluster/store.ts.
  const row = db
    .prepare(
      `select (select count(*) from items) as total,
              (select count(*) from item_entity_extractions where ruleset_version = ?) as done`,
    )
    .get(version) as { total: number; done: number };
  return {
    rulesetVersion: version,
    total: row.total,
    done: row.done,
    remaining: row.total - row.done,
  };
}

// ---------------------------------------------------------------------------
// sweepEntities
// ---------------------------------------------------------------------------

export function sweepEntities(db: Db, ruleset: EntityRuleset, options: EntitySweepOptions): EntitySweepReport {
  assertCanonicalTimestamp('now', options.now);
  const version = rulesetVersion(ruleset);
  const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;

  const report: EntitySweepReport = {
    rulesetVersion: version,
    limit,
    scanned: 0,
    entitiesWritten: 0,
    itemsWithEntities: 0,
    remaining: 0,
    byType: { org: 0, product: 0, concept: 0, identifier: 0 },
    orphaned: [],
  };

  // Newest first. A bounded backfill should cover what a reader is actually
  // looking at before it works backwards through the archive; `item_id`
  // breaks ties so a partial run is deterministic rather than
  // SQLite-scan-order dependent.
  const pending = db
    .prepare(
      `select i.item_id, i.title, i.summary_raw, i.canonical_url
       from items i
       where not exists (
         select 1 from item_entity_extractions x
         where x.item_id = i.item_id and x.ruleset_version = ?
       )
       order by i.fetched_at desc, i.item_id
       limit ?`,
    )
    // Inline type literal, NOT a named interface: `.all()` returns
    // `Record<string, SQLOutputValue>[]` and TypeScript's `as` overlap check is
    // stricter about a named-interface array target (TS2352). Fourth module to
    // hit this -- see src/cluster/store.ts and CLAUDE.md. Leave this comment,
    // or the next tidy-up reintroduces the error.
    .all(version, limit) as Array<{
    item_id: string;
    title: string;
    summary_raw: string | null;
    canonical_url: string;
  }>;

  if (pending.length > 0) {
    const beatsByItem = readBeats(
      db,
      pending.map((p) => p.item_id),
    );
    const typeOf = typeIndex(ruleset);

    const insertEntity = db.prepare('insert or ignore into item_entities (item_id, entity) values (?, ?)');
    const insertLedger = db.prepare(
      `insert into item_entity_extractions (item_id, ruleset_version, extracted_at, entity_count)
       values (?, ?, ?, ?)`,
    );

    // One transaction for the whole batch: a half-applied sweep would leave
    // entity rows with no ledger row, which reads as "never scanned" and would
    // be re-swept -- harmless, but it makes the counts lie.
    db.exec('begin');
    try {
      for (const row of pending) {
        const entities = extractEntities(
          {
            title: row.title,
            summaryRaw: row.summary_raw,
            canonicalUrl: row.canonical_url,
            beats: beatsByItem.get(row.item_id) ?? [],
          },
          ruleset,
        );
        for (const entity of entities) {
          const changed = insertEntity.run(row.item_id, entity).changes;
          if (Number(changed) > 0) {
            report.entitiesWritten++;
            report.byType[typeOf.get(entity) ?? 'identifier']++;
          }
        }
        insertLedger.run(row.item_id, version, options.now, entities.length);
        report.scanned++;
        if (entities.length > 0) report.itemsWithEntities++;
      }
      db.exec('commit');
    } catch (err) {
      db.exec('rollback');
      throw err;
    }
  }

  report.remaining = entityExtractionCoverage(db, ruleset).remaining;
  report.orphaned = findOrphaned(db, ruleset);
  return report;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Beats per `item_id` -- THIS version's own, not the `item_key`-wide union.
 *
 * Deliberate, and the one place this file departs from the union read path
 * that has bitten four times. See `EntityExtractionInput.beats` in
 * `./extract.ts`: an extraction is stored per `item_id`, so it must be a pure
 * function of that row for the insert-time path and this one to provably
 * agree. `getItemEntities` recovers the union at read time, which is what it
 * was built for.
 *
 * One query for the whole batch rather than one per item -- the batching
 * `src/domain/itemBeats.ts` says is deliberately not built until something
 * needs it. This needs it: 2,000 items would otherwise be 2,000 queries.
 */
function readBeats(db: Db, itemIds: readonly string[]): Map<string, Beat[]> {
  const out = new Map<string, Beat[]>();
  // SQLITE_MAX_VARIABLE_NUMBER is 32,766 on any build this project runs on,
  // but chunking makes the sweep limit and the parameter limit independent
  // facts rather than one silently constraining the other.
  const CHUNK = 500;
  for (let i = 0; i < itemIds.length; i += CHUNK) {
    const chunk = itemIds.slice(i, i + CHUNK);
    const rows = db
      .prepare(`select item_id, beat from item_beats where item_id in (${chunk.map(() => '?').join(', ')})`)
      .all(...chunk) as Array<{ item_id: string; beat: Beat }>;
    for (const row of rows) {
      const existing = out.get(row.item_id);
      if (existing) existing.push(row.beat);
      else out.set(row.item_id, [row.beat]);
    }
  }
  return out;
}

/** Canonical name -> declared type, for the report's breakdown. */
function typeIndex(ruleset: EntityRuleset): Map<string, EntityType> {
  const out = new Map<string, EntityType>();
  for (const entity of ruleset.entities) out.set(entity.name, entity.type);
  return out;
}

/**
 * Stored entity strings this ruleset could not produce again.
 *
 * A gazetteer name is producible if the ruleset still declares it. An
 * identifier is producible if the pattern that recognises its shape is still
 * enabled -- checked by running the enabled extractors over the string itself,
 * so the answer comes from the same code that would have produced it rather
 * than from a second, drift-prone description of what an id looks like.
 */
function findOrphaned(db: Db, ruleset: EntityRuleset): string[] {
  const known = new Set(ruleset.entities.map((e) => e.name));
  const rows = db.prepare('select distinct entity from item_entities order by entity').all() as Array<{
    entity: string;
  }>;

  const orphaned: string[] = [];
  for (const { entity } of rows) {
    if (known.has(entity)) continue;
    const reproducible = ruleset.patterns.some((p) => PATTERN_EXTRACTORS[p](entity).includes(entity));
    if (!reproducible) orphaned.push(entity);
    if (orphaned.length >= ORPHAN_REPORT_CAP) break;
  }
  return orphaned;
}
