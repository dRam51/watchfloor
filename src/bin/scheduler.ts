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

// Resolved relative to this module, not the process cwd: a process
// supervisor (§12) may launch us from any working directory -- same pattern
// src/bin/api.ts uses for config/sources.yaml and db/migrations.
const repoRoot = join(import.meta.dirname, '..', '..');

// Every M1 adapter, keyed by the 5 source types this milestone ships (see
// SchedulerAdapterRegistry's doc comment in src/scheduler/run.ts for why
// this is a Pick<>, not the full 8-type AdapterRegistry). 'atom' routes to
// the same rssAdapter instance as 'rss' -- rss.ts content-sniffs the wire
// format from the parsed document's root element rather than trusting
// source.type, so one adapter instance genuinely serves both keys correctly
// (see that file's own doc comment on the SourceType 'atom' wrinkle).
const adapters: SchedulerAdapterRegistry = {
  rss: rssAdapter,
  atom: rssAdapter,
  json: jsonAdapter,
  news_sitemap: newsSitemapAdapter,
  google_news: googleNewsAdapter,
};

// How often the loop checks which sources are due. Deliberately NOT an env
// var: every WF_* var lives in src/config/env.ts, which this task does not
// touch (concurrent sibling work, per this task's brief), and a fixed 60s
// tick is short enough that the shortest source interval sources.yaml's
// schema allows (1m, after this same task's zero-rejecting tightening) can
// still be served within one tick of becoming eligible, without polling
// isEligible so often it burns CPU for no operational benefit.
const TICK_INTERVAL_MS = 60_000;

/**
 * All schedule arithmetic in this process derives from `WF_TZ`, never the
 * host's own system timezone (a Linux host defaults to UTC and would
 * otherwise mislabel every logged timestamp for an operator elsewhere).
 * Concretely: `now` passed to `runPollCycle` is always
 * `new Date().toISOString()`, which is an absolute UTC instant regardless of
 * the host's configured zone -- there is no local-calendar arithmetic
 * anywhere in a poll cycle for a system timezone to leak into (see
 * runPollCycle's own doc comment, src/scheduler/run.ts). What DOES need
 * `WF_TZ` explicitly is any HUMAN-readable local-time display this process
 * produces, since that is the one place system-zone-by-default would
 * silently mislabel a wall-clock time as if it were the operator's own.
 */
function formatLocal(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(iso));
}

try {
  const env = loadEnv();
  const db = openDatabase(env.WF_DB_PATH);

  const applied = runMigrations(db, join(repoRoot, 'db', 'migrations'));
  if (applied.length > 0) console.log(`applied migrations: ${applied.join(', ')}`);

  const sources = loadSourcesFile(join(repoRoot, 'config', 'sources.yaml'));
  console.log(
    `watchfloor scheduler starting (TZ=${env.WF_TZ}, sources=${sources.length}, ` +
      `tick=${TICK_INTERVAL_MS}ms)`,
  );

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  async function tick(): Promise<void> {
    const now = new Date().toISOString();
    try {
      const report = await runPollCycle(db, sources, adapters, now);
      const counts = new Map<string, number>();
      for (const outcome of report.sources) {
        counts.set(outcome.kind, (counts.get(outcome.kind) ?? 0) + 1);
      }
      const summary = [...counts.entries()].map(([kind, n]) => `${kind}=${n}`).join(' ');
      console.log(
        `poll cycle finished at ${formatLocal(report.finishedAt, env.WF_TZ)} ` +
          `(${report.durationMs}ms): ${summary || 'no sources'}`,
      );
    } catch (err) {
      // runPollCycle itself only ever rejects on a contract violation (e.g.
      // a malformed `now`, which cannot happen here since it is always
      // freshly derived above) -- never on a single source's own failure,
      // which pollOneSource already isolates and reports as a 'failure'
      // outcome. Reaching here would be a genuine bug; log it and keep the
      // process alive rather than let one bad tick kill the whole scheduler.
      console.error(`poll cycle threw unexpectedly: ${(err as Error).message}`);
    }
    if (!stopped) timer = setTimeout(tick, TICK_INTERVAL_MS);
  }

  // Run the first cycle immediately rather than waiting a full tick after
  // startup, then self-reschedule after each cycle completes (not
  // setInterval) so a slow cycle can never overlap with the next one --
  // there is exactly one SQLite connection and sources are processed
  // sequentially, so overlapping cycles would race on it for no benefit.
  void tick();

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      console.log(`${signal} received, shutting down`);
      stopped = true;
      if (timer) clearTimeout(timer);
      closeDb(db);
      process.exit(0);
    });
  }
} catch (err) {
  // EnvError, DatabaseOpenError, and SourceConfigError all carry messages
  // written specifically to name the offending variable, path, or config
  // line -- a raw stack trace buries exactly that. Same pattern as
  // src/bin/api.ts.
  console.error((err as Error).message);
  process.exit(1);
}
