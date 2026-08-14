/**
 * The scoring CLI (M2 Task 9): clusters, then scores, then exits. Two
 * explicit, separately-logged steps -- NOT one function that hides
 * clustering inside "scoring" -- because cluster size is a scoring INPUT and
 * the ordering is load-bearing (see src/score/pass.ts's own module doc
 * comment, "Clustering dependency"). Reuses runClusteringPass
 * (src/cluster/run.ts, unmodified) and runScoringPass (src/score/pass.ts,
 * this task's own module) -- no scoring or clustering logic lives here.
 *
 * `--force` rescopes every item_key unconditionally, even ones already
 * up to date under the current scorer_version -- see src/score/pass.ts's
 * ScoringPassOptions doc comment. Useful after retuning config/scoring.yaml
 * without bumping scorer_version, or to pick up a fresh clustering pass's
 * corroboration counts without waiting for new items.
 *
 *   npm run score          -- cluster, then score only what's unscored
 *   npm run score:force    -- cluster, then rescope EVERYTHING
 */

import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { loadEnv } from '../config/env.ts';
import { openDatabase } from '../db/openDatabase.ts';
import { assertMigrationsUpToDate } from '../db/migrate.ts';
import { closeDb } from '../db/connection.ts';
import { loadSourcesFile } from '../sources/load.ts';
import { loadInterestsFile } from '../interests/load.ts';
import { loadMechanicalScoreConfig } from '../score/mechanical.ts';
import { loadClusterConfig } from '../cluster/config.ts';
import { runClusteringPass } from '../cluster/run.ts';
import { runScoringPass } from '../score/pass.ts';

const repoRoot = join(import.meta.dirname, '..', '..');

const { values } = parseArgs({
  options: { force: { type: 'boolean', default: false } },
});

/** Mirrors src/bin/scheduler.ts's own formatLocal -- see src/bin/ingest.ts's identical comment for why this is duplicated rather than shared. */
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
    const interestProfile = loadInterestsFile(join(repoRoot, 'config', 'interests.yaml'));
    const scoringConfig = loadMechanicalScoreConfig(join(repoRoot, 'config', 'scoring.yaml'));
    const clusterConfig = loadClusterConfig(join(repoRoot, 'config', 'cluster.yaml'));

    const now = new Date().toISOString();
    console.log(`watchfloor scoring pass -- ${formatLocal(now, env.WF_TZ)} (scorer_version=${scoringConfig.scorer_version}${values.force ? ', --force' : ''})`);

    console.log('step 1/2: clustering (cluster size is a scoring input -- must run first)');
    const clusterSummary = runClusteringPass(db, clusterConfig, now);
    console.log(
      `  candidates=${clusterSummary.candidatesConsidered} groups_found=${clusterSummary.groupsFound} ` +
        `clusters_created=${clusterSummary.clustersCreated} memberships_written=${clusterSummary.membershipsWritten}`,
    );

    console.log('step 2/2: scoring');
    const scoreSummary = runScoringPass(db, { sources, interestProfile, config: scoringConfig }, now, { force: values.force });
    console.log(
      `  candidates=${scoreSummary.candidatesConsidered} scored=${scoreSummary.itemsScored} ` +
        `skipped=${scoreSummary.itemsSkipped} rows_written=${scoreSummary.rowsWritten}`,
    );
    if (scoreSummary.failures.length > 0) {
      console.log(`  ${scoreSummary.failures.length} item(s) failed to score (every other item still scored normally):`);
      for (const f of scoreSummary.failures) console.log(`    ! ${f.itemKey}: ${f.error}`);
    }

    console.log('done -- run `npm run rank` to see the top items per beat');
  } finally {
    closeDb(db);
  }
  process.exit(0);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
