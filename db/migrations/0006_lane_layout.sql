-- Lane order and per-lane collapse state (M3 task 6, src/domain/laneState.ts).
--
-- §7: "lane order and per-lane collapse state must persist server-side."
-- §7.1: "Read/saved/dismissed state is server-side, keyed to nothing.
-- Single-user means phone and desktop see identical state with no sync
-- logic, no conflict resolution, no device IDs. Don't put any of it in
-- browser storage." The same reasoning applies to lane layout: it is not a
-- browser preference, it is user state that must read identically on every
-- device, so it lives here rather than in localStorage.
--
-- One row per beat, exactly like `item_state` (0001_init.sql): current,
-- mutable UI state, not history. `item_state`'s own schema comment says it
-- best -- "Mutable UI state ... Deliberately NOT append-only" -- and the
-- same asymmetry applies here on purpose: no append-only triggers, no
-- event-log modeling. A lane's position and collapsed flag are each
-- overwritten in place by src/domain/laneState.ts's setLaneLayout, which
-- always replaces the full six-lane layout in one transaction (never a
-- partial per-lane PATCH -- see that module's doc comment for why a partial
-- update of an ORDERED collection has no obvious semantics).
--
-- `beat` is a bare TEXT column with no CHECK/FK constraint against the six
-- known beats, deliberately -- matching `source_fetch_state`'s own precedent
-- of carrying no FK to a `sources` table "because source definitions live in
-- config/sources.yaml ... not in this database" (0003_fetch_state.sql). The
-- canonical beat set (`BEATS`, src/domain/item.ts) lives in code, not the
-- schema, and code is exactly where it can change (a beat renamed or
-- retired). Enforcing it here would mean a code-only change now also needs a
-- migration, and would leave a stale row with no path but to violate a
-- constraint or vanish. Instead: src/domain/laneState.ts's getLaneLayout
-- filters any stored beat that isn't in the CURRENT `BEATS` at read time
-- rather than crashing on it -- a beat retired from the code is silently
-- dropped from the layout the next time it's read, and every beat in the
-- current `BEATS` that has no stored row yet gets a default position
-- (appended after whatever IS stored, in BEATS's own canonical order) and
-- collapsed = false. See that module for the graceful-degradation logic;
-- this schema only needs to not stand in its way.
create table lane_layout (
  beat       text primary key,
  position   integer not null,
  collapsed  integer not null default 0 check (collapsed in (0, 1)),
  updated_at text not null
);
