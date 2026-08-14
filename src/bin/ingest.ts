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
import { runMigrations } from '../db/migrate.ts';
import { loadSourcesFile } from '../sources/load.ts';
import { closeDb } from '../db/connection.ts';
import { runPollCycle, type SchedulerAdapterRegistry } from '../scheduler/run.ts';
import { rssAdapter } from '../adapters/rss.ts';
import { jsonAdapter } from '../adapters/json.ts';
import { newsSitemapAdapter } from '../adapters/newsSitemap.ts';
import { googleNewsAdapter } from '../adapters/googleNews.ts';

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
};

/** Mirrors src/bin/scheduler.ts's own formatLocal exactly -- WF_TZ governs any human-readable local-time display, never the host clock's zone. Duplicated rather than imported: scheduler.ts keeps it private, and each bin/*.ts here is already an independent composition root (api.ts and scheduler.ts share none of this boilerplate with each other either). */
function formatLocal(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso));
}

try {
  const env = loadEnv();
  const db = openDatabase(env.WF_DB_PATH);
  try {
    const applied = runMigrations(db, join(repoRoot, 'db', 'migrations'));
    if (applied.length > 0) console.log(`applied migrations: ${applied.join(', ')}`);

    const sources = loadSourcesFile(join(repoRoot, 'config', 'sources.yaml'));
    console.log(`watchfloor one-shot ingest starting (TZ=${env.WF_TZ}, sources=${sources.length})`);

    const now = new Date().toISOString();
    const report = await runPollCycle(db, sources, adapters, now);

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
