import type { Db } from '../db/connection.ts';
import { getCurrentItem, type Item } from '../domain/item.ts';

/**
 * One search hit is one ITEM (item_key), never a version (item_id) -- the
 * hit-granularity decision recorded in db/migrations/0005_fts_search.sql.
 * `item` is the item's CURRENT version (getCurrentItem, ../domain/item.ts),
 * resolved fresh at query time rather than carried inside items_fts, so a
 * hit's title/author/etc. can never drift out of sync with what item.ts
 * itself considers current.
 */
export interface SearchHit {
  item: Item;
  /**
   * FTS5's bm25-based rank (the built-in `rank` hidden column). Lower
   * (more negative) is a better match; results are already sorted by it
   * ascending, so callers normally just need item order, not this value --
   * exposed for a UI that wants to visualize match strength.
   */
  rank: number;
  /** FTS5 snippet() around the best match, with `[` / `]` marking it. */
  snippet: string;
}

export interface SearchOptions {
  /** Maximum hits returned. Defaults to 25. */
  limit?: number;
}

const DEFAULT_LIMIT = 25;
const WHITESPACE = /\s+/;

/**
 * Converts free-text user input into a safe FTS5 MATCH expression.
 *
 * Every whitespace-separated token becomes its own FTS5 quoted string
 * (doubling any embedded `"`, the standard SQL string-literal escape), and
 * the tokens are joined with a bare space -- FTS5's implicit AND between
 * phrase terms. Quoting a token neutralizes every character FTS5's query
 * parser would otherwise treat as syntax: `AND` / `OR` / `NOT` / `NEAR` as
 * bareword operators, a leading `-` (NOT-prefix), a trailing `*`
 * (prefix-match), `column:` (a column filter), and `(` / `)` (grouping) all
 * become inert literal text once inside a quoted string. `&` and `+` are
 * not FTS5 syntax at all (verified directly against node:sqlite -- see
 * tests/search/query.test.ts's "hostile queries" block) and pass straight
 * through the same way.
 *
 * The trade this makes on purpose: a user can never express an FTS5 boolean
 * query through this function -- no OR, no explicit phrase grouping, no
 * column filters. Every search becomes "all of these words, ANDed". In
 * exchange, no input -- an unmatched `"`, a bare `-`, `AT&T`, `C++`, a
 * `title:` prefix, anything -- can produce a syntax error or inject an
 * operator. That is the whole point: this function is the one and only
 * place user input is allowed to reach an FTS5 MATCH string.
 *
 * Returns `null` for a query that is empty, all-whitespace, or (after
 * `NFC` normalization and tokenizing) has nothing left to search for --
 * callers treat that as "no results", not as an error.
 */
export function toSafeMatchQuery(userQuery: string): string | null {
  const tokens = userQuery
    .normalize('NFC')
    .split(WHITESPACE)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

// The row shape returned by the query below is cast as an INLINE type
// literal at the .all() call site, not a named interface -- not a style
// preference. node:sqlite's .all() returns Record<string, SQLOutputValue>[],
// and TypeScript's `as` overlap check treats a named interface array target
// more strictly than a structurally identical inline literal array target
// for this exact cast shape -- confirmed empirically, and already
// documented at src/cluster/store.ts:91-104 (the same fix, hit twice more
// since: src/domain/itemState.ts). Do not "tidy" this into a `SearchRow[]`
// interface cast; it fails `tsc` with TS2352.

/**
 * Full-text search over `items_fts` (db/migrations/0005_fts_search.sql).
 * See that migration's module comment for what is indexed (title,
 * summary_raw, author, source_id -- "everything retained" given the
 * ~300-character excerpt cap) and what a user will consequently fail to
 * find (anything past that excerpt, and PBS's un-decoded `&eacute;`-style
 * HTML entities, which tokenize completely differently from the real
 * accented character AP's version of the same story uses).
 *
 * Results are ranked by FTS5's bm25 (`order by rank`, ascending -- verified
 * directly that ascending is "best match first", not assumed from
 * documentation; see tests/search/query.test.ts). Never throws for
 * hostile or malformed user input -- `toSafeMatchQuery` is the primary
 * defense, and the query itself is additionally wrapped so that any FTS5
 * behaviour this module did not anticipate degrades to "no results" rather
 * than propagating a raw SQLite error up to, eventually, a search box.
 */
export function searchItems(db: Db, rawQuery: string, options: SearchOptions = {}): SearchHit[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const matchQuery = toSafeMatchQuery(rawQuery);
  if (matchQuery === null) return [];

  let rows: Array<{ item_key: string; rank: number; snippet: string }>;
  try {
    rows = db
      .prepare(
        `select item_key, rank,
                snippet(items_fts, -1, '[', ']', '…', 12) as snippet
         from items_fts
         where items_fts match ?
         order by rank
         limit ?`,
      )
      .all(matchQuery, limit) as Array<{ item_key: string; rank: number; snippet: string }>;
  } catch {
    return [];
  }

  const hits: SearchHit[] = [];
  for (const row of rows) {
    // items_fts is kept in sync with items by 0005's AFTER INSERT trigger
    // and migration-time backfill, so this should always resolve -- guarded
    // rather than trusted blindly, since a null here would otherwise throw
    // trying to read `.item` off a hit that doesn't have one.
    const item = getCurrentItem(db, row.item_key);
    if (!item) continue;
    hits.push({ item, rank: row.rank, snippet: row.snippet });
  }
  return hits;
}
