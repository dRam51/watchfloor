-- The geospatial layer (M7, §7.2). Three tables, none of which replaces
-- anything: `locations` and `item_locations` have existed since 0001_init.sql
-- and are already the right shape.
--
-- ===========================================================================
-- 0. WHAT WAS ALREADY HERE, AND WHY IT NEVER RAN
-- ===========================================================================
-- 0001 created `locations`, `item_locations`, and `items.lat/lon/
-- geo_confidence`. `src/domain/location.ts` implements upsert/list/link/read
-- against them, with a passing test file. All of it holds ZERO rows across
-- 16,570 items, because nothing ever called any of it.
--
-- That is occurrence nine of the defect CLAUDE.md calls this project's
-- characteristic one -- with the distinction that this instance was scaffolded
-- deliberately for a milestone that had not arrived, rather than wired to
-- nothing by accident. M7 is the milestone that owns the wiring, and
-- `item_location_extractions` below is what makes the difference between
-- "nobody looked" and "nothing matched" a STORED FACT rather than an
-- indistinguishable zero.
--
-- ===========================================================================
-- 1. item_countries -- a jurisdiction is not a facility
-- ===========================================================================
-- §7.2 asks for gazetteer matching "against `locations` plus country names",
-- and for a jurisdiction layer you can click through to "the policy items
-- scoped to it".
--
-- Country matches deliberately do NOT go in `item_locations`. Two reasons,
-- and the second is the one that decided it:
--
--  1. 0001's `locations.kind` CHECK is
--     (fab, packaging, datacenter, colo, cloud_region, hq, port) and correctly
--     has no `country` value -- a country is not a site with a coordinate.
--     Adding one would mean rebuilding the table to widen a CHECK, and would
--     put a polygon-shaped thing in a point-shaped table.
--  2. The two are different CLAIMS with different strengths. "This item
--     mentions Taiwan" is weak, common, and useful for a choropleth; "this
--     item is about TSMC Fab 18" is strong, rare, and useful for a pin. Storing
--     them in one table would force one confidence scale across both, and the
--     read paths would have to re-separate them anyway.
create table item_countries (
  item_id        text not null references items (item_id),
  -- ISO 3166-1 alpha-2, uppercase. No FK: country definitions live in
  -- config/jurisdictions.yaml, not in this database -- the same stance
  -- 0003_fetch_state.sql took for sources and 0006_lane_layout.sql took for
  -- beats, and for the same reason. A code retired from config is filtered at
  -- read time rather than left unable to exist.
  country_code   text not null check (length(country_code) = 2 and country_code = upper(country_code)),
  geo_confidence real not null check (geo_confidence > 0 and geo_confidence <= 1),
  primary key (item_id, country_code)
);

-- The choropleth's query is "how many items per country", which the primary
-- key's index cannot serve because it leads with item_id.
create index item_countries_by_country on item_countries (country_code, item_id);

-- ===========================================================================
-- 2. item_location_extractions -- the ledger, modelled on 0010
-- ===========================================================================
-- Identical shape and identical reasoning to `item_entity_extractions`
-- (0010_entity_extraction_ledger.sql), which exists because zero rows in
-- `item_entities` could not distinguish "no extractor exists" from "nothing
-- matched" -- an ambiguity that let entity extraction stay empty across three
-- milestones while looking exactly like success.
--
-- Geo extraction is MORE exposed to that failure, not less: most items
-- genuinely have no location, so an empty `item_locations` is the EXPECTED
-- steady state and an inert extractor is invisible by default.
--
-- `gazetteer_version` is a content digest of config/locations.yaml plus
-- config/jurisdictions.yaml (src/locations/load.ts, gazetteerVersion), never a
-- hand-maintained number. Editing either config changes the digest, which
-- empties the sweep's "already done" set, which re-opens the whole corpus.
-- Presentation-only fields (notes, source_url, verified_at, precision) are
-- excluded from that digest on purpose: correcting a citation must not trigger
-- a 16,570-item re-extraction that cannot produce a different answer.
create table item_location_extractions (
  item_id           text not null references items (item_id),
  gazetteer_version text not null,
  extracted_at      text not null,
  -- Denormalised for the same reason 0010's entity_count is: once a later
  -- gazetteer version writes rows for the same item, what the EARLIER version
  -- found is unrecoverable, because item_locations has no version column and
  -- must not grow one (a location is a fact about the item, not about the
  -- rules that noticed it).
  location_count    integer not null check (location_count >= 0),
  country_count     integer not null check (country_count >= 0),
  primary key (item_id, gazetteer_version)
);

create index item_location_extractions_version
  on item_location_extractions (gazetteer_version, item_id);

-- Canonical UTC, enforced on the only reachable write path. Same mechanism and
-- same glob as 0002's items_fetched_at_format and 0010's: every as-of read
-- compares these lexicographically, so a non-canonical value breaks ordering
-- silently instead of failing loudly.
create trigger item_location_extractions_extracted_at_format
before insert on item_location_extractions
when new.extracted_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
begin
  select raise(ABORT, 'item_location_extractions.extracted_at must be a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)');
end;

-- Ledger stance (0009 named it): a row records that a specific extraction
-- happened, and that never stops being true. UPDATE is refused because
-- (item, gazetteer version) fixes the answer -- a differing result would mean
-- the extractor stopped being pure, which is a bug to find rather than a value
-- to overwrite. DELETE per CLAUDE.md's never-delete rule.
create trigger item_location_extractions_no_update before update on item_location_extractions
begin select raise(ABORT, 'item_location_extractions is a ledger: (item_id, gazetteer_version) fixes the answer'); end;

create trigger item_location_extractions_no_delete before delete on item_location_extractions
begin select raise(ABORT, 'item_location_extractions is append-only'); end;

-- ===========================================================================
-- 3. map_prefs -- §7.2's "remember the choice server-side"
-- ===========================================================================
-- §7.2: "Default to whichever the user last used; remember the choice
-- server-side." §7.1 says why it cannot be localStorage: "Read/saved/dismissed
-- state is server-side, keyed to nothing. Single-user means phone and desktop
-- see identical state with no sync logic, no conflict resolution, no device
-- IDs. Don't put any of it in browser storage." A projection choice is the
-- same kind of state as lane order, and lane order is already here (0006).
--
-- MUTABLE stance, not the ledger stance -- deliberately, and stated because
-- this file contains one of each. There is no history worth keeping in "which
-- projection was showing"; it is current UI state, overwritten in place,
-- exactly like `lane_layout` and `item_state`.
--
-- A key/value shape rather than a column per preference, because the set of
-- toggles grows with the layer list (fabrication, compute, jurisdictions,
-- items, arcs, terminator, ambient) and a migration per toggle would be
-- ceremony with no benefit. Validation lives in src/domain/mapPrefs.ts, which
-- filters unknown keys at read time the same way getLaneLayout filters a
-- retired beat -- a preference removed from the code is dropped on read rather
-- than left as a row that cannot legally exist.
create table map_prefs (
  pref_key   text primary key,
  value      text not null,
  updated_at text not null
);

-- BOTH insert and update. A preference is written with an upsert
-- (`on conflict (pref_key) do update`), and ON CONFLICT DO UPDATE fires UPDATE
-- triggers, not INSERT ones -- so an insert-only guard would validate the
-- first write of a key and silently accept every later one. That is the exact
-- shape of gap this project keeps finding: a check whose scope excludes the
-- only path capable of exhibiting the defect.
create trigger map_prefs_updated_at_format
before insert on map_prefs
when new.updated_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
begin
  select raise(ABORT, 'map_prefs.updated_at must be a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)');
end;

create trigger map_prefs_updated_at_format_on_update
before update on map_prefs
when new.updated_at not glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
begin
  select raise(ABORT, 'map_prefs.updated_at must be a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)');
end;
