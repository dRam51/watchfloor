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
import {
  advanceVaultSlots,
  dueVaultWork,
  NO_VAULT_SLOTS,
  WEEKLY_RELEASE_HOUR,
  type VaultSyncSlots,
} from '../vault/cadence.ts';
import { openVaultSession } from '../vault/session.ts';
import {
  loadVaultSyncDeps,
  resolveVaultTarget,
  runVaultSync,
  type VaultSyncDeps,
} from '../vault/sync.ts';

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
  // M4a task 9. The adapter landed in task 4 but this registry belonged to no
  // M4a task, so github_search compiled fine and failed at POLL time, once per
  // cycle -- found only by the live run.
  github_search: githubSearchAdapter,
};

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

  // Entrypoints no longer auto-apply migrations -- run `npm run migrate`
  // first, including before restarting an unattended scheduler. See
  // src/db/migrate.ts's doc comment on assertMigrationsUpToDate and
  // §12's runbook (deploy step: `npm run migrate` runs before the
  // scheduler is (re)started, same as any other deploy).
  const { backfilledChecksums } = assertMigrationsUpToDate(db, join(repoRoot, 'db', 'migrations'));
  if (backfilledChecksums.length > 0) {
    console.log(
      `backfilled checksum for previously-applied migration(s) with no recorded checksum: ` +
        `${backfilledChecksums.join(', ')}`,
    );
  }

  const sources = loadSourcesFile(join(repoRoot, 'config', 'sources.yaml'));
  console.log(
    `watchfloor scheduler starting (TZ=${env.WF_TZ}, sources=${sources.length}, ` +
      `tick=${env.WF_SCHEDULER_TICK_INTERVAL_MS}ms)`,
  );

  // -------------------------------------------------------------------------
  // The vault (M5 task 15), beside recordStarSnapshots and enrichRepoReadmes
  // and for exactly the same reason those two are here: this is the process
  // that actually runs, and a component wired only into the one-shot
  // entrypoint is a component that never runs in production.
  //
  // WHETHER a vault is configured is decided once, at boot -- WF_VAULT_ROOT
  // comes from the environment and cannot change while the process lives, so
  // re-deciding it 1,440 times a day would only produce 1,440 identical log
  // lines. WHETHER IT IS MOUNTED is re-decided on every attempt, because that
  // genuinely does change: an iCloud vault can be absent at 09:00 and back at
  // 09:30, and the sync should resume without a restart.
  //
  // The state is in memory, deliberately. Persisting the watermarks would need
  // a migration, and it would buy nothing: both notes are idempotent
  // overwrites whose content is a pure function of (corpus, period, zone), so
  // the worst a restart can cause is one extra rewrite of a file that was
  // going to be rewritten anyway. See src/vault/cadence.ts.
  // -------------------------------------------------------------------------
  const vaultTarget = resolveVaultTarget();
  let vaultDeps: VaultSyncDeps | null = null;
  let vaultSlots: VaultSyncSlots = NO_VAULT_SLOTS;

  if (vaultTarget.status === 'not_configured') {
    // Said once. The common path is "no vault" -- WF_VAULT_ROOT is commented
    // out in .env -- and a daemon that mentioned it every tick would be
    // training its operator to ignore its output.
    console.log('vault sync is off: WF_VAULT_ROOT is unset. (Not mentioned again.)');
  } else {
    // Config is loaded even when the vault is currently unmounted: a malformed
    // decay.yaml should stop the boot while someone is watching, not fail the
    // first sync hours later.
    vaultDeps = loadVaultSyncDeps({ repoRoot, db, tz: env.WF_TZ });
    console.log(
      `vault sync is on (root=${vaultTarget.root}, model=` +
        `${vaultDeps.weekly.enrichment.backend.name}/${vaultDeps.weekly.enrichment.backend.model}) -- ` +
        `daily note hourly, weekly note from ${WEEKLY_RELEASE_HOUR}:00 Friday in ${env.WF_TZ}`,
    );
    if (vaultTarget.status === 'unmounted') {
      // Loud at boot, because a configured vault that cannot be written means
      // the owner expects sync and is not getting it.
      console.error(
        `vault is not mounted: ${vaultTarget.refusal.detail} (${vaultTarget.refusal.reason}). ` +
          `${vaultTarget.refusal.remedy} The scheduler will keep checking.`,
      );
    }
  }

  /**
   * Writes whatever the cadence says is owed, and returns a summary fragment.
   *
   * Refusals are logged rather than thrown: one unwritable note must not take
   * down a poll loop that is also the thing keeping the corpus current.
   */
  async function syncVaultIfDue(deps: VaultSyncDeps, now: string): Promise<string> {
    const due = dueVaultWork(vaultSlots, now, env.WF_TZ);
    if (!due.daily && !due.weekly) return '';

    const target = resolveVaultTarget();
    if (target.status !== 'ready') {
      const detail =
        target.status === 'unmounted'
          ? `${target.refusal.detail} (${target.refusal.reason}). ${target.refusal.remedy}`
          : 'WF_VAULT_ROOT is unset';
      // At most once an hour, because the daily slot is the attempt clock --
      // loud enough to notice, quiet enough to keep reading.
      console.error(`vault sync skipped: ${detail}`);
      vaultSlots = advanceVaultSlots(vaultSlots, due, { weeklyWritten: false });
      return ' -- vault: skipped (not mounted)';
    }

    try {
      const report = await runVaultSync(openVaultSession(target.root), deps, {
        now,
        // `entities` rides with the daily refresh: it has no period of its own,
        // and each note's own as-of instant is derived from the corpus.
        work: { daily: due.daily, weekly: due.weekly, entities: due.daily },
      });
      vaultSlots = advanceVaultSlots(vaultSlots, due, { weeklyWritten: report.weekly !== null });
      for (const refusal of report.refusals) {
        console.error(`vault ${refusal.area} refused: ${refusal.detail}`);
      }
      const parts = [
        report.daily === null ? null : `daily ${report.date}`,
        report.weekly === null ? null : `weekly ${report.week.label}`,
        report.entities === null || report.entities.written.length === 0
          ? null
          : `${report.entities.written.length} entit(ies)`,
      ].filter((p): p is string => p !== null);
      return parts.length === 0 ? ' -- vault: nothing written' : ` -- vault: ${parts.join(', ')}`;
    } catch (err) {
      // Only an unrecognised error reaches here (runVaultSync collects the
      // rest), and one bad note must not kill the daemon. The slot still
      // advances so the next attempt is an hour away rather than 60 seconds.
      console.error(`vault sync threw unexpectedly: ${(err as Error).message}`);
      vaultSlots = advanceVaultSlots(vaultSlots, due, { weeklyWritten: false });
      return ' -- vault: error';
    }
  }

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  async function tick(): Promise<void> {
    const now = new Date().toISOString();
    try {
      const report = await runPollCycle(db, sources, adapters, now);

      // M4a task 9. Mirrors src/bin/ingest.ts's own call at the same point in
      // the cycle -- the daemon is the path that will ACTUALLY accumulate the
      // seven days of history §4's star velocity needs, so omitting it here
      // would leave velocity permanently uncomputable in production while a
      // hand-run `npm run ingest` looked fine. See src/ingest/starSnapshots.ts.
      const stars = recordStarSnapshots(db, sources, report.finishedAt, env.WF_TZ);

      // M4a task 11. Mirrors src/bin/ingest.ts's own call at the same point in
      // the cycle -- and the daemon is the path that matters most here, because
      // README coverage COMPOUNDS across polls: 359 repos against 8 requests a
      // sweep reach full coverage in roughly 45 cycles, which only ever happens
      // if the long-running process does it. A hand-run `npm run ingest` would
      // look identical while covering 8 repos and stopping.
      //
      // GATED on the repo source having been due this cycle. This tick fires
      // every WF_SCHEDULER_TICK_INTERVAL_MS (default 60s) while task 6 sized
      // its per-sweep cap against an HOURLY poll -- ungated, the sweep would
      // drain the whole 60/hour Core budget in six minutes and hold it at the
      // reserve floor thereafter. See repoSourceWasDue.
      // See src/ingest/repoEnrichment.ts.
      const readmes = repoSourceWasDue(sources, report.sources)
        ? await enrichRepoReadmes(db, sources, { now: report.finishedAt })
        : null;

      const counts = new Map<string, number>();
      for (const outcome of report.sources) {
        counts.set(outcome.kind, (counts.get(outcome.kind) ?? 0) + 1);
      }
      const summary = [...counts.entries()].map(([kind, n]) => `${kind}=${n}`).join(' ');
      const starSummary =
        stars.examined > 0
          ? ` -- stars: ${stars.inserted} new, ${stars.updated} updated` +
            (stars.unusable > 0 ? `, ${stars.unusable} unusable` : '')
          : '';
      // `answered` and `failed` are reported separately on purpose: a failure
      // answers nothing and the repo is retried, so folding the two into one
      // "processed" count would hide the difference §4 suppresses on.
      const readmeSummary =
        readmes !== null && readmes.examined > 0
          ? ` -- readmes: ${readmes.answered} answered, ${readmes.report?.cached ?? 0} cached` +
            (readmes.failed > 0 ? `, ${readmes.failed} failed` : '')
          : '';
      // M5 task 15. AFTER the cycle, over what was actually persisted -- the
      // same placement as the star snapshots above, and for the same reason:
      // a note written before the poll would describe the corpus as it was an
      // instant ago and then sit unchanged for an hour.
      const vaultSummary = vaultDeps === null ? '' : await syncVaultIfDue(vaultDeps, report.finishedAt);

      console.log(
        `poll cycle finished at ${formatLocal(report.finishedAt, env.WF_TZ)} ` +
          `(${report.durationMs}ms): ${summary || 'no sources'}${starSummary}${readmeSummary}${vaultSummary}`,
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
    if (!stopped) timer = setTimeout(tick, env.WF_SCHEDULER_TICK_INTERVAL_MS);
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
