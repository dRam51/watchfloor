/**
 * One-shot ingest (M2 Task 9): runs exactly one poll cycle and exits --
 * fills the gap CLAUDE.md's M2 progress ledger names directly: "there is no
 * npm script for [the scheduler], so a one-shot acceptance ingest today
 * means running it and interrupting after cycle one."
 *
 * Deliberately NOT a fork of src/bin/scheduler.ts's logic: this file reuses
 * the exact same runPollCycle (src/scheduler/run.ts) the daemon calls on its
 * first tick, wired through the identical adapter registry. What differs is
 * only composition-root shape -- no self-rescheduling setTimeout, no SIGINT
 * handler, no "keep the process alive" loop. It runs the cycle once, prints
 * a summary, closes the database, and exits -- making
 * `npm run ingest && npm run score && npm run rank` a real, scriptable
 * sequence for the M2 acceptance check.
 */

import { join } from 'node:path';
import { loadEnv } from '../config/env.ts';
import { openDatabase } from '../db/openDatabase.ts';
import { assertMigrationsUpToDate } from '../db/migrate.ts';
import { loadSourcesFile } from '../sources/load.ts';
import { closeDb } from '../db/connection.ts';
import { runPollCycle, type SchedulerAdapterRegistry } from '../scheduler/run.ts';
import { rssAdapter } from '../adapters/rss.ts';
import { jsonAdapter } from '../adapters/json.ts';
import { newsSitemapAdapter } from '../adapters/newsSitemap.ts';
import { googleNewsAdapter } from '../adapters/googleNews.ts';
import { githubSearchAdapter } from '../adapters/github.ts';
import { recordStarSnapshots } from '../ingest/starSnapshots.ts';
import { enrichRepoReadmes, repoSourceWasDue } from '../ingest/repoEnrichment.ts';
import { loadEntityRulesFile } from '../entities/rules.ts';
import { sweepEntities } from '../entities/sweep.ts';
import { loadInterestsFile } from '../interests/load.ts';
import { loadMechanicalScoreConfig } from '../score/mechanical.ts';
import { loadClusterConfig } from '../cluster/config.ts';
import { runClusteringPass } from '../cluster/run.ts';
import { runScoringPass } from '../score/pass.ts';

// Resolved relative to this module, not the process cwd -- matches
// src/bin/api.ts / src/bin/scheduler.ts exactly.
const repoRoot = join(import.meta.dirname, '..', '..');

// Identical registry to src/bin/scheduler.ts's own -- five lines of
// composition-root wiring, duplicated deliberately rather than factored into
// a shared module two three-line call sites don't justify. See that file's
// own comment on the 'atom' -> rssAdapter routing.
const adapters: SchedulerAdapterRegistry = {
  rss: rssAdapter,
  atom: rssAdapter,
  json: jsonAdapter,
  news_sitemap: newsSitemapAdapter,
  google_news: googleNewsAdapter,
  // M4a task 9. The adapter landed in task 4 but this registry belonged to no
  // M4a task, so github_search compiled fine and failed at POLL time, once per
  // cycle -- found only by the live run.
  github_search: githubSearchAdapter,
};

/** Mirrors src/bin/scheduler.ts's own formatLocal exactly -- WF_TZ governs any human-readable local-time display, never the host clock's zone. Duplicated rather than imported: scheduler.ts keeps it private, and each bin/*.ts here is already an independent composition root (api.ts and scheduler.ts share none of this boilerplate with each other either). */
function formatLocal(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));
}

try {
  const env = loadEnv();
  const db = openDatabase(env.WF_DB_PATH);
  try {
    // Entrypoints no longer auto-apply migrations -- run `npm run migrate`
    // first. See src/db/migrate.ts's doc comment on assertMigrationsUpToDate.
    const { backfilledChecksums } = assertMigrationsUpToDate(db, join(repoRoot, 'db', 'migrations'));
    if (backfilledChecksums.length > 0) {
      console.log(
        `backfilled checksum for previously-applied migration(s) with no recorded checksum: ` +
          `${backfilledChecksums.join(', ')}`,
      );
    }

    const sources = loadSourcesFile(join(repoRoot, 'config', 'sources.yaml'));
    // M5 task 16. Loaded at boot, beside sources: a malformed entities.yaml
    // should stop the run while someone is watching, not fail per-item later.
    const entityRules = loadEntityRulesFile(join(repoRoot, 'config', 'entities.yaml'));
    const interestProfile = loadInterestsFile(join(repoRoot, 'config', 'interests.yaml'));
    const scoringConfig = loadMechanicalScoreConfig(join(repoRoot, 'config', 'scoring.yaml'));
    const clusterConfig = loadClusterConfig(join(repoRoot, 'config', 'cluster.yaml'));
    console.log(
      `watchfloor one-shot ingest starting (TZ=${env.WF_TZ}, sources=${sources.length}, ` +
        `entity rules=${entityRules.entities.length}+${entityRules.patterns.length} patterns)`,
    );

    const now = new Date().toISOString();
    const report = await runPollCycle(db, sources, adapters, now, { entityRules });

    // M4a task 9. Runs AFTER the cycle, over what was actually persisted --
    // `stargazers_count` rides along in items.raw_json, so a snapshot costs no
    // extra HTTP request. Without this the repos lane's velocity would return
    // `no_snapshots` forever rather than for seven days, and would look
    // correct while being permanently inert. See src/ingest/starSnapshots.ts.
    const stars = recordStarSnapshots(db, sources, report.finishedAt, env.WF_TZ);
    if (stars.examined > 0) {
      console.log(
        `  star snapshots (${env.WF_TZ}): examined=${stars.examined} inserted=${stars.inserted} ` +
          `updated=${stars.updated} ignored=${stars.ignored} unusable=${stars.unusable}`,
      );
    }

    // M4a task 11, beside the star snapshots and for the same reason: task 6's
    // README enricher shipped complete and was called by nothing, so
    // readmeExcerpt was null on every row and §4's "suppress repos with no
    // README" rule never ran. Bounded by task 6's own budget policy (8 requests
    // per sweep unauthenticated) and by a stored answer, so successive polls
    // COMPOUND coverage rather than re-reading the same repos.
    // Gated on the repo source actually having been due -- see
    // repoSourceWasDue for why the sweep must not run on every tick.
    // See src/ingest/repoEnrichment.ts.
    const readmes = repoSourceWasDue(sources, report.sources)
      ? await enrichRepoReadmes(db, sources, { now: report.finishedAt })
      : null;
    if (readmes !== null && readmes.examined > 0) {
      const r = readmes.report;
      console.log(
        `  repo readmes (${r?.mode ?? 'not run'}): examined=${readmes.examined} ` +
          `answered=${readmes.answered} failed=${readmes.failed} cached=${r?.cached ?? 0} ` +
          `requested=${r?.requested ?? 0} unusable=${readmes.unusable} ` +
          `core-remaining=${r?.coreRemaining ?? 'unknown'}`,
      );
    }

    // M5 task 16, beside the star snapshots and for the same reason -- except
    // that this pass covers the STORED corpus as well as what the cycle just
    // wrote. 7,267 item versions existed with zero entity rows and `items` is
    // append-only, so they cannot be re-normalised; `item_entities` has no
    // append-only trigger and takes new rows for an existing item_id without
    // touching the version. Bounded per run and level-triggered off the
    // ruleset's content digest, so editing config/entities.yaml re-opens the
    // whole corpus automatically. See src/entities/sweep.ts.
    const entities = sweepEntities(db, entityRules, { now: report.finishedAt });

    // M6. The daemon scores (src/bin/scheduler.ts); this path did not, and an
    // unscored item cannot rank. That is the SAME drift, on the other side:
    // `npm run ingest && npm run score` is the documented two-command
    // sequence, so this was correct for a human typing both -- and silently
    // wrong for anything that runs only the first, which is exactly what a
    // scheduled one-shot does.
    //
    // Fixing both paths is the point. This file's own header says it
    // "deliberately does NOT fork src/bin/scheduler.ts's logic"; two
    // entrypoints that disagree about whether scoring is part of a cycle are
    // that fork arriving by omission.
    //
    // Clustering first -- cluster size is a scoring input. See src/bin/score.ts.
    const clusters = runClusteringPass(db, clusterConfig, report.finishedAt);
    const scored = runScoringPass(db, { sources, interestProfile, config: scoringConfig }, report.finishedAt);
    console.log(
      `  scored: ${scored.itemsScored} item(s), ${scored.rowsWritten} row(s); ` +
        `clusters: ${clusters.clustersCreated} created`,
    );
    if (scored.failures.length > 0) {
      console.log(`  ${scored.failures.length} item(s) failed to score (every other item still scored)`);
    }
    if (entities.scanned > 0 || entities.remaining > 0) {
      console.log(
        `  entities (ruleset ${entities.rulesetVersion}): scanned=${entities.scanned} ` +
          `written=${entities.entitiesWritten} withEntities=${entities.itemsWithEntities} ` +
          `remaining=${entities.remaining} ` +
          `[org=${entities.byType.org} product=${entities.byType.product} ` +
          `concept=${entities.byType.concept} id=${entities.byType.identifier}]`,
      );
    }
    if (entities.orphaned.length > 0) {
      // Insert-only, per CLAUDE.md's never-delete rule: a term removed from
      // config leaves its rows behind. Reported rather than silently divergent.
      console.log(
        `  ! ${entities.orphaned.length} stored entit(ies) the current ruleset can no longer ` +
          `produce: ${entities.orphaned.slice(0, 8).join(', ')}`,
      );
    }

    const counts = new Map<string, number>();
    for (const outcome of report.sources) counts.set(outcome.kind, (counts.get(outcome.kind) ?? 0) + 1);
    const totalItems = report.sources.reduce((sum, o) => sum + o.itemCount, 0);
    const summary = [...counts.entries()].map(([kind, n]) => `${kind}=${n}`).join(' ');

    console.log(
      `ingest cycle finished at ${formatLocal(report.finishedAt, env.WF_TZ)} (${report.durationMs}ms): ` +
        `${totalItems} item(s) across ${report.sources.length} source(s) -- ${summary || 'no sources'}`,
    );

    // Per-source trouble printed explicitly -- an operator running this by
    // hand for the M2 acceptance check should not have to grep logs to find
    // out one feed was down. Matches pollOneSource's own "one dead feed
    // never takes down the run" philosophy: these are reported, not fatal.
    for (const outcome of report.sources) {
      if (outcome.kind === 'failure' || outcome.kind === 'robots-denied' || outcome.kind === 'robots-unavailable') {
        console.log(`  ! ${outcome.sourceId} (${outcome.kind})${outcome.error ? `: ${outcome.error}` : ''}`);
      }
    }
  } finally {
    closeDb(db);
  }
  process.exit(0);
} catch (err) {
  // EnvError, DatabaseOpenError, SourceConfigError all carry messages
  // written specifically to name the offending variable, path, or config
  // line -- same pattern as src/bin/api.ts / src/bin/scheduler.ts.
  console.error((err as Error).message);
  process.exit(1);
}
