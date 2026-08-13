-- Watchfloor initial schema.
-- Timestamps are ISO-8601 UTC strings throughout.

-- Append-only item versions. A correction, re-score, or enrichment writes a NEW
-- row with the same item_key and a later fetched_at. Nothing is ever updated in
-- place, which is what makes point-in-time (as_of) queries truthful (§8.2).
create table items (
  item_id        text primary key,
  item_key       text not null,
  url            text not null,
  canonical_url  text not null,
  title          text not null,
  author         text,
  source_id      text not null,
  item_type      text not null check (item_type in ('event', 'analysis', 'press')),
  published_at   text,
  fetched_at     text not null,
  summary_raw    text,
  raw_json       text not null,
  lat            real,
  lon            real,
  geo_confidence real,
  created_at     text not null
);
create index items_key_fetched on items (item_key, fetched_at desc);
create index items_fetched     on items (fetched_at);
create index items_canonical   on items (canonical_url);

create trigger items_no_update before update on items
begin select raise(ABORT, 'items is append-only: write a new version instead'); end;
create trigger items_no_delete before delete on items
begin select raise(ABORT, 'items is append-only: see the M6 retention job'); end;

-- Items carry multiple beats (§4); never force one.
create table item_beats (
  item_id text not null references items (item_id),
  beat    text not null,
  primary key (item_id, beat)
);

create table item_entities (
  item_id text not null references items (item_id),
  entity  text not null,
  primary key (item_id, entity)
);

-- Mutable UI state, keyed to the stable item_key so it survives re-versioning.
-- Deliberately NOT append-only and never exposed to the trading bot.
create table item_state (
  item_key     text primary key,
  read_at      text,
  saved_at     text,
  dismissed_at text,
  updated_at   text not null
);

-- Derived scores, append-only, keyed on (item_id, beat): one item ranks
-- independently in each lane it belongs to.
create table item_scores (
  score_id       text primary key,
  item_id        text not null references items (item_id),
  beat           text not null,
  signal_score   real not null,
  read_score     real not null,
  scorer_version text not null,
  computed_at    text not null
);
create index item_scores_lookup on item_scores (item_id, beat, computed_at desc);

create trigger item_scores_no_update before update on item_scores
begin select raise(ABORT, 'item_scores is append-only'); end;
create trigger item_scores_no_delete before delete on item_scores
begin select raise(ABORT, 'item_scores is append-only'); end;

-- Cluster membership is append-only and timestamped so cluster size can be
-- reconstructed as of any past instant. Without this, an as_of query replays
-- today's cluster size onto a historical item — lookahead contamination.
create table clusters (
  cluster_id text primary key,
  created_at text not null
);

create table item_clusters (
  membership_id text primary key,
  cluster_id    text not null references clusters (cluster_id),
  item_key      text not null,
  fetched_at    text not null
);
create index item_clusters_asof on item_clusters (cluster_id, fetched_at);

create trigger item_clusters_no_update before update on item_clusters
begin select raise(ABORT, 'item_clusters is append-only'); end;
create trigger item_clusters_no_delete before delete on item_clusters
begin select raise(ABORT, 'item_clusters is append-only'); end;

-- Curated gazetteer (§7.2). Hand-maintained; never auto-geocoded.
-- source_url and verified_at are mandatory so the UI can show how stale a pin is.
create table locations (
  location_id text primary key,
  name        text not null,
  kind        text not null check (kind in ('fab', 'packaging', 'datacenter', 'colo', 'cloud_region', 'hq', 'port')),
  operator    text,
  country     text not null,
  lat         real not null,
  lon         real not null,
  notes       text,
  source_url  text not null,
  verified_at text not null
);

create table item_locations (
  item_id        text not null references items (item_id),
  location_id    text not null references locations (location_id),
  geo_confidence real not null,
  primary key (item_id, location_id)
);

-- Retention horizon (§3 + decision 2). as_of queries older than this must fail
-- loudly rather than return archived, thinned rows. Seeded by the M6 job; until
-- then the table is empty and every as_of query is answerable.
create table retention_horizon (
  id           integer primary key check (id = 1),
  oldest_intact_fetched_at text not null,
  updated_at   text not null
);
