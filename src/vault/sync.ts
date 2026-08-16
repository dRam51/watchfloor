/**
 * The one composition that turns four note writers into a run (M5 task 15).
 *
 * Tasks 5–8 each built a complete, heavily-tested area of §8.1 — `daily/`,
 * `weekly/`, `entities/`, `saved/` — and each ended its report saying it had
 * no caller, because a task that owns `src/vault/weekly.ts` does not own an
 * entrypoint. This module and `src/bin/vault.ts` are that owner.
 *
 * ## Why this lives inside the package rather than in `src/bin/`
 *
 * Two entrypoints need it — the one-shot `npm run vault` and the daemon — and
 * the composition is not the five lines `src/bin/ingest.ts` and
 * `src/bin/scheduler.ts` duplicate for the adapter registry. It is six config
 * files, an LLM backend, a token-ceiling policy, and a source-kind map,
 * assembled into three differently-shaped dependency objects. Duplicated, it
 * would drift, and a drift between the hand-run sync and the daemon's sync is
 * precisely the class of defect this task exists to close: the hand run would
 * look correct while the thing that actually runs did something else. M4a's
 * README enricher is the same shape in the other direction — a hand-run
 * `npm run ingest` looked identical while covering 8 repos and stopping.
 *
 * The package's own rule still holds: **nothing here imports `node:fs`**
 * (`tests/vault/sourceProperties.test.ts` checks every module in this
 * directory). Every byte written goes through task 4's session, and the
 * config loaders that do read files are called by path — with `repoRoot`
 * supplied by the caller, so there is no absolute path and no assumption about
 * the process working directory.
 *
 * ## Three states, and only one of them is an error
 *
 * `WF_VAULT_ROOT` is **commented out in `.env`**. That is the shipped
 * configuration, so the common path is "no vault", and it must be a quiet
 * no-op rather than a warning every 60 seconds. {@link resolveVaultTarget}
 * separates the three cases the operator actually cares about:
 *
 * | state | meaning | how loud |
 * | --- | --- | --- |
 * | `not_configured` | no `WF_VAULT_ROOT`. Nothing to do. | said once, at startup |
 * | `unmounted` | configured, and task 4's guard refuses | **loud** — the owner expects sync and is not getting it |
 * | `ready` | configured and mountable | a one-line summary per run |
 *
 * ## Refusals are collected, never thrown past the area they belong to
 *
 * The same argument `syncEntityNotes` makes for its own skip list: letting one
 * area's refusal propagate would abandon the rest of the run, and the next run
 * would stop in the same place. A hand-authored `daily/2026-08-15.md` must not
 * cost the week its reading note. What still propagates is an error this
 * module does not recognise — that is a bug, and swallowing it into a list
 * nobody reads is how the integration would lose the owner's trust quietly.
 */

import { join } from 'node:path';
import type { Db } from '../db/connection.ts';
import { loadInterestsFile } from '../interests/load.ts';
import { loadSourcesFile } from '../sources/load.ts';
import { loadRankDepsFromConfigFiles } from '../score/rank.ts';
import { loadEnrichmentPolicy } from '../enrich/ceiling.ts';
import { createLlmBackend } from '../enrich/llm/backend.ts';
import { loadLlmConfig } from '../enrich/llm/config.ts';
import { localDayOf } from './cadence.ts';
import { writeDailyNote, type DailyNoteDeps } from './daily.ts';
import { syncEntityNotes, type EntitySyncResult } from './entities.ts';
import { VaultContentError } from './frontmatter.ts';
import {
  checkVaultMount,
  vaultRootFromEnv,
  type VaultUnmounted,
} from './mount.ts';
import {
  VaultCapError,
  VaultWriteError,
  type VaultSession,
  type VaultWriteResult,
} from './session.ts';
import {
  isoWeekOf,
  syncWeeklyNote,
  type IsoWeek,
  type WeeklySyncDeps,
  type WeeklySyncResult,
} from './weekly.ts';

// ---------------------------------------------------------------------------
// Is there a vault at all?
// ---------------------------------------------------------------------------

export type VaultTarget =
  | { readonly status: 'not_configured' }
  | { readonly status: 'unmounted'; readonly root: string; readonly refusal: VaultUnmounted }
  | { readonly status: 'ready'; readonly root: string };

/**
 * What `WF_VAULT_ROOT` currently means, without creating anything.
 *
 * `env` is a parameter rather than a read of `process.env` so a test can
 * exercise all three states without touching the real environment — and
 * therefore without any path by which a test could reach the owner's vault.
 */
export function resolveVaultTarget(env: NodeJS.ProcessEnv = process.env): VaultTarget {
  const root = vaultRootFromEnv(env);
  if (root === null) return { status: 'not_configured' };
  const status = checkVaultMount(root);
  return status.mounted ? { status: 'ready', root } : { status: 'unmounted', root, refusal: status };
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface VaultSyncDeps {
  readonly db: Db;
  /** `WF_TZ`. Every day and week boundary in a run comes from this. */
  readonly tz: string;
  readonly daily: DailyNoteDeps;
  readonly weekly: WeeklySyncDeps;
}

export interface VaultSyncDepsOptions {
  /** The repository root, resolved by the caller from `import.meta.dirname`. */
  readonly repoRoot: string;
  readonly db: Db;
  readonly tz: string;
  /** Threaded through for the §15 paid-backend gate. Never read from here directly. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Builds every dependency the three syncs need, from the repo's config files.
 *
 * Loaded **once per process**, at composition time, not per run: a malformed
 * `decay.yaml` should stop a boot while someone is watching rather than fail
 * an unattended sync at 02:00, which is the same argument `src/bin/api.ts`
 * makes for loading `sources.yaml` at boot.
 *
 * `rank` is shared by reference between the daily note and the weekly one on
 * purpose. Two independent loads of the same file drift the moment one call
 * site is edited, and the ranking behind the two notes is one decision.
 */
export function loadVaultSyncDeps(options: VaultSyncDepsOptions): VaultSyncDeps {
  const { repoRoot, db, tz } = options;
  const config = (name: string): string => join(repoRoot, 'config', name);

  const sources = loadSourcesFile(config('sources.yaml'));
  const rank = loadRankDepsFromConfigFiles(config('decay.yaml'), config('overrides.yaml'));
  const llmConfig = loadLlmConfig(config('llm.yaml'));

  return {
    db,
    tz,
    daily: {
      tz,
      decayConfig: rank.decayConfig,
      overridesConfig: rank.overridesConfig,
      sources,
      interests: loadInterestsFile(config('interests.yaml')),
    },
    weekly: {
      rank,
      // `sourceId -> kind`, built the way src/api/routes/feed.ts builds it. A
      // source with no `kind` maps to null rather than being omitted, so
      // `selectWeeklyReading` can tell "not a reading kind" from "unknown
      // source".
      sourceKinds: new Map(sources.map((source) => [source.id, source.kind ?? null])),
      enrichment: {
        db,
        backend: createLlmBackend(llmConfig, options.env ?? process.env),
        defaults: {
          maxOutputTokens: llmConfig.limits.maxOutputTokens,
          // What actually goes on the wire, which is what the cache key has to
          // describe. Only Ollama carries a temperature in config; the
          // Anthropic block has none, and its backend ships hard-disabled
          // (RULING 2) so it never reaches a request to have one applied.
          temperature: llmConfig.backend === 'ollama' ? llmConfig.ollama.temperature ?? null : null,
        },
        policy: loadEnrichmentPolicy(config('enrichment.yaml')),
        tz,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Which areas a run should write. Absent means all three. */
export interface VaultSyncWork {
  readonly daily: boolean;
  readonly weekly: boolean;
  readonly entities: boolean;
}

const ALL_WORK: VaultSyncWork = { daily: true, weekly: true, entities: true };

/** One area's refusal: recorded against the area, never swallowed. */
export interface VaultAreaRefusal {
  readonly area: 'daily' | 'weekly';
  readonly reason: string;
  readonly detail: string;
}

export interface VaultSyncReport {
  /** The calendar day the daily note is for, in `deps.tz`. */
  readonly date: string;
  readonly week: IsoWeek;
  readonly attempted: VaultSyncWork;
  /** `null` means not attempted, or attempted and refused — see `refusals`. */
  readonly daily: VaultWriteResult | null;
  readonly weekly: WeeklySyncResult | null;
  /** `syncEntityNotes` reports its own per-entity skips; it does not refuse wholesale. */
  readonly entities: EntitySyncResult | null;
  readonly refusals: readonly VaultAreaRefusal[];
  readonly filesWritten: number;
}

/**
 * Recognised refusals become a record; anything else is a bug and propagates.
 *
 * `files_per_run` is included deliberately: task 4's cap latches the session
 * shut, so every later write in the run refuses with `session_latched`. Both
 * are recorded rather than thrown, because a truncated run reported as a
 * complete one is how a missing note becomes invisible.
 */
function refusalOf(area: 'daily' | 'weekly', err: unknown): VaultAreaRefusal {
  if (err instanceof VaultWriteError) return { area, reason: err.reason, detail: err.message };
  if (err instanceof VaultCapError) return { area, reason: err.reason, detail: err.message };
  if (err instanceof VaultContentError) return { area, reason: 'malformed_block', detail: err.message };
  throw err;
}

/**
 * Writes the managed areas for the day and week `now` falls in, in `deps.tz`.
 *
 * The instant is a parameter and nothing here reads a clock. What each note is
 * *stamped* with is not this instant — the daily note carries the last
 * millisecond of its day and the weekly note the last millisecond of its week,
 * which is what makes both a pure function of (corpus, period, zone) and lets
 * M5's acceptance test delete the tree and reproduce it exactly.
 */
export async function runVaultSync(
  session: VaultSession,
  deps: VaultSyncDeps,
  opts: { readonly now: string; readonly work?: VaultSyncWork },
): Promise<VaultSyncReport> {
  const work = opts.work ?? ALL_WORK;
  const date = localDayOf(opts.now, deps.tz);
  const week = isoWeekOf(date);
  const refusals: VaultAreaRefusal[] = [];

  let daily: VaultWriteResult | null = null;
  if (work.daily) {
    try {
      daily = writeDailyNote(session, deps.db, date, deps.daily);
    } catch (err) {
      refusals.push(refusalOf('daily', err));
    }
  }

  let weekly: WeeklySyncResult | null = null;
  if (work.weekly) {
    try {
      weekly = await syncWeeklyNote(session, deps.weekly, { now: opts.now });
    } catch (err) {
      refusals.push(refusalOf('weekly', err));
    }
  }

  // Last, and with no try/catch of its own: syncEntityNotes already collects
  // every per-note refusal into `skipped` and stops the run only on the cap
  // that latches the session. There is nothing left for this layer to catch.
  const entities = work.entities ? syncEntityNotes(session, deps.db) : null;

  return {
    date,
    week,
    attempted: work,
    daily,
    weekly,
    entities,
    refusals,
    filesWritten: session.filesWritten,
  };
}
