/**
 * The bot's view of `config/sources.yaml` (M5 task 11).
 *
 * ---------------------------------------------------------------------------
 * RULING 1 — the default filter keys on `kind`, NOT on `item_type`
 * ---------------------------------------------------------------------------
 * §8.2 says, literally: *"Filter bot-facing queries to `item_type` in
 * (`event`) by default, with `analysis` available only on explicit request."*
 *
 * **This module deliberately does not implement that, and the departure is the
 * owner's, recorded in the M5 plan.** M2 measured `item_type` against 3,325
 * real items and found it effectively binary: `event` is exactly the four
 * government-primary sources (`cisa-kev`, `cisa-advisories`,
 * `federal-register`, `whitehouse-actions`), `analysis` is *everything else*
 * including every wire story and every vendor advisory, and `press` matches
 * zero items. So §8.2's literal default does not mean "hard news rather than
 * essays" — it means "four government feeds and nothing else."
 *
 * `kind` is the axis added after M2 for exactly this question. It is
 * SOURCE-level and therefore stable (arXiv is always papers), where
 * `item_type` is an item-level classifier that already failed. The bot's
 * default is `news + advisory`: hard news and security advisories, excluding
 * papers, blogs and aggregators.
 *
 * **Do not "fix" this back to `item_type`.** `DEFAULT_BOT_KINDS` is pinned by
 * a test that names both axes.
 *
 * The sibling precedent is `src/vault/weekly.ts`'s `WEEKLY_READING_KINDS`
 * (`news + paper + blog`) — same axis, opposite population, and its own doc
 * comment states the split: *"The bot's default is news + advisory — act on
 * it; a reading list's is news + paper + blog — read it."*
 *
 * ---------------------------------------------------------------------------
 * Markets: not configured, and it stays that way when a SOURCE appears
 * ---------------------------------------------------------------------------
 * `marketsAvailability` has no branch that returns `configured: true`. That is
 * not a stub — it is the honest answer, and it is the same one
 * `src/vault/daily.ts` gives the market ribbon. M4b is blocked on
 * `config/portfolio.yaml`, which only the owner can write, so there is no
 * EDGAR adapter, no catalyst calendar, and no ribbon snapshot anywhere in the
 * schema. Adding a markets *source* to `config/sources.yaml` would give this
 * process rows in `items` and still not give it a market snapshot, an earnings
 * date or a filing — so the status stays `not_configured` and only the
 * *reason* changes. Getting that second state right is what stops a future
 * reader from reading `configured: false` as "nobody added a feed yet".
 *
 * This module never reads `config/portfolio.yaml`. The bot must never learn
 * the owner's positions, and CLAUDE.md treats that file as the repository's
 * primary privacy hazard.
 */

import { join } from 'node:path';
import { loadSourcesFile, type Kind, type Source } from '../../sources/load.ts';
import type { Beat } from '../../domain/item.ts';

/**
 * A repo config file, resolved against THIS module rather than the process
 * cwd. An MCP client spawns its servers from wherever it happens to be
 * running (`src/bin/mcp.ts` resolves `db/migrations` the same way), so a
 * cwd-relative path is a file-not-found in production and a green test in
 * development.
 */
export function repoConfigPath(fileName: string): string {
  return join(import.meta.dirname, '..', '..', '..', 'config', fileName);
}

/** See this module's doc comment. RULING 1, not §8.2's literal text. */
export const DEFAULT_BOT_KINDS: ReadonlySet<Kind> = new Set<Kind>(['news', 'advisory']);

/**
 * What the bot is told about a source. A strict subset of `Source`: no `url`,
 * no `filters`, no `enrichment`. Those are operator configuration, and every
 * field published here is one a bot could plausibly act on.
 */
export interface BotSource {
  readonly id: string;
  readonly name: string;
  readonly beats: readonly Beat[];
  /**
   * `null` for a source `config/sources.yaml` leaves unclassified. Never
   * defaulted to a kind: the RULING 1 filter would then admit a source nobody
   * classified, which is the one direction this filter must not fail in.
   */
  readonly kind: Kind | null;
  readonly weight: number;
  readonly pollInterval: string;
  readonly enabled: boolean;
}

export function indexSources(sources: readonly Source[]): ReadonlyMap<string, BotSource> {
  const index = new Map<string, BotSource>();
  for (const source of sources) {
    index.set(source.id, {
      id: source.id,
      name: source.name,
      beats: source.beats,
      kind: source.kind ?? null,
      weight: source.weight,
      pollInterval: source.poll_interval,
      enabled: source.enabled,
    });
  }
  return index;
}

export type MarketsUnavailableReason = 'no_markets_source' | 'no_markets_store';

export interface MarketsAvailability {
  /** Always false today. See this module's doc comment — there is no true branch. */
  readonly configured: boolean;
  readonly reason: MarketsUnavailableReason;
  /** Enabled sources carrying the `markets` beat, for the detail sentence. */
  readonly marketsSources: readonly string[];
}

export function marketsAvailability(sources: readonly Source[]): MarketsAvailability {
  const marketsSources = sources.filter((s) => s.enabled && s.beats.includes('markets')).map((s) => s.id);
  return {
    configured: false,
    reason: marketsSources.length === 0 ? 'no_markets_source' : 'no_markets_store',
    marketsSources,
  };
}

/** The real file. Read once at registration; a malformed config is a startup failure. */
export function loadBotSources(): Source[] {
  return loadSourcesFile(repoConfigPath('sources.yaml'));
}
