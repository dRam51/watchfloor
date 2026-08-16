/**
 * `get_items_for_entity` (M5 task 11) — §8.2's *"news matching a ticker or a
 * `related_entities` key"*, and the only one of the five §8.2 tools with a real
 * data source behind it.
 *
 * ---------------------------------------------------------------------------
 * The default filter is RULING 1's, not §8.2's literal text
 * ---------------------------------------------------------------------------
 * §8.2 says `item_type in (event)`. The owner ruled otherwise, and
 * `./sources.ts` carries the full reasoning: measured against 3,325 real items,
 * `event` is exactly four government feeds, so the literal default would hide
 * every wire story and every vendor advisory from the bot. The default here is
 * **`kind in (news, advisory)`**, and `kinds` widens it — §8.2's *"available
 * only on explicit request"*, applied to the axis that works.
 *
 * ---------------------------------------------------------------------------
 * Point in time, on THREE axes
 * ---------------------------------------------------------------------------
 * `./asOf.ts` does the reading; this module's job is not to undo it. Two
 * consequences worth stating where a reader will meet them:
 *
 *  - **`since` filters on `firstSeenAt`, not `published_at`.** It is tempting
 *    to read "news since Tuesday" as a publication-date question, and that is
 *    the exact mistake: `published_at` is null for 1,715 of the archived
 *    corpus's 3,325 items, so a `published_at`-keyed `since` silently drops
 *    half the corpus, and it is feed-controlled besides. `firstSeenAt` is
 *    total, is what this system can actually vouch for, and is on the same
 *    axis as `as_of`. `publishedAt` is still returned on every item, so a
 *    caller who genuinely wants the publisher's date can filter on it
 *    knowingly.
 *  - **Decay is applied from the reading instant.** CLAUDE.md: *"Recency decay
 *    applied at read time, never stored."* `signalScoreStored` is the
 *    decay-invariant component the database holds; `signalScore` is that number
 *    multiplied by this read's own factor. A backtest at `as_of` therefore sees
 *    what a reader would have seen then, not what the row looks like today.
 *
 * ---------------------------------------------------------------------------
 * An unscored item is REPORTED, not dropped
 * ---------------------------------------------------------------------------
 * `src/score/rank.ts` skips items with no score row, which is right for a
 * ranked lane. It is wrong here. The archived first-run corpus holds 3,325
 * items and **zero** `item_scores` rows, so a tool that required a score would
 * answer "no news about anything" for a corpus full of news, with no error —
 * the silent-by-construction failure this project keeps rediscovering. So an
 * unscored item comes back with `signalScore: null` and is counted in
 * `unscored`.
 *
 * It IS excluded when the caller asks for `minSignalScore`, because no
 * unscored item can satisfy a floor — and that exclusion is reported as
 * `unscoredExcluded` rather than left to be inferred from a smaller list.
 *
 * ---------------------------------------------------------------------------
 * `min_score` is spelled `minSignalScore`
 * ---------------------------------------------------------------------------
 * A deliberate rename of §8.2's parameter. "Score" unqualified invites the
 * reader to wonder which one, and there is only ever one: *"the bot sees
 * `signal_score` only — never `read_score`."* The name says the axis. It is
 * also the only §8.2 parameter name changed anywhere in this task.
 */

import { z } from 'zod';
import { defineTool, type McpTool, type McpToolResult } from '../registry.ts';
import type { ReadOnlyCorpus } from '../readonly.ts';
import { computeDecayFactor, type DecayConfig } from '../../score/decay.ts';
import { KINDS, type Kind } from '../../sources/load.ts';
import type { Beat } from '../../domain/item.ts';
import type { BotToolDeps } from './deps.ts';
import { DEFAULT_BOT_KINDS, indexSources, type BotSource } from './sources.ts';
import {
  readBeatsAsOf,
  readItemsAsOf,
  readSignalScoresAsOf,
  withReadInstant,
  type ItemVersionAsOf,
} from './asOf.ts';

export const DEFAULT_ITEM_LIMIT = 50;
export const MAX_ITEM_LIMIT = 200;

/**
 * Every `item_key` carrying `entity` on at least one version visible at
 * `asOf`.
 *
 * Attribution is per VERSION (`item_entities` is keyed on `item_id`), and an
 * entity found on any visible version counts for the item — the union rule
 * `src/domain/itemEntities.ts` exists to enforce, scoped to the instant.
 *
 * Matching is exact and case-sensitive. M5 task 16 measured the alternative:
 * folding case merges `iOS` (139 items) with **Cisco IOS** (47 of them), and
 * `Meta` with `meta`. An entity is a name, not a search term.
 */
function entityCandidatesAsOf(corpus: ReadOnlyCorpus, entity: string, asOf: string): string[] {
  return corpus
    .all(
      `select distinct i.item_key as item_key
       from item_entities e
       join items i on i.item_id = e.item_id
       where e.entity = ? and i.fetched_at <= ?`,
      entity,
      asOf,
    )
    .map((row) => String(row.item_key));
}

interface Candidate {
  readonly item: ItemVersionAsOf;
  readonly source: BotSource | undefined;
  readonly beats: readonly Beat[];
  readonly beat: Beat | null;
  readonly signalScoreStored: number | null;
  readonly decayFactor: number | null;
  readonly signalScore: number | null;
  readonly scoredAt: string | null;
  readonly scorerVersion: string | null;
}

/**
 * The beat an item is reported under: the one it scores highest in, of the
 * beats it carries.
 *
 * An item can be in two lanes at once (CLAUDE.md records a cross-listed arXiv
 * paper appearing in both), and a single answer has to pick one. Highest
 * decayed score is the same rule `src/vault/weekly.ts` uses, and it is the
 * beat a reader would have met the item in. `beats` is returned alongside so
 * nothing is hidden by the choice.
 */
function pickBeat(
  item: ItemVersionAsOf,
  beats: readonly Beat[],
  scores: Map<Beat, { signalScore: number; scorerVersion: string; computedAt: string }> | undefined,
  readAt: string,
  decayConfig: DecayConfig,
): Pick<Candidate, 'beat' | 'signalScoreStored' | 'decayFactor' | 'signalScore' | 'scoredAt' | 'scorerVersion'> {
  let best: Candidate | null = null;
  for (const [beat, score] of scores ?? []) {
    const factor = computeDecayFactor(
      { publishedAt: item.publishedAt, firstFetchedAt: item.firstSeenAt, beat, itemType: item.itemType },
      // 'signal' is the ONLY profile this file may pass. `read` is not
      // reachable from here, and `read_score` is not readable at all -- the
      // corpus handle refuses SQL naming it.
      'signal',
      readAt,
      decayConfig,
    );
    const decayed = score.signalScore * factor;
    if (best === null || decayed > best.signalScore!) {
      best = {
        item,
        source: undefined,
        beats,
        beat,
        signalScoreStored: score.signalScore,
        decayFactor: factor,
        signalScore: decayed,
        scoredAt: score.computedAt,
        scorerVersion: score.scorerVersion,
      };
    }
  }
  if (best !== null) {
    return {
      beat: best.beat,
      signalScoreStored: best.signalScoreStored,
      decayFactor: best.decayFactor,
      signalScore: best.signalScore,
      scoredAt: best.scoredAt,
      scorerVersion: best.scorerVersion,
    };
  }
  return {
    // Unscored: the item's first beat is still a fact about it, so it is
    // reported -- but every score field is null rather than zero. A zero would
    // read as "scored, and worthless".
    beat: beats[0] ?? null,
    signalScoreStored: null,
    decayFactor: null,
    signalScore: null,
    scoredAt: null,
    scorerVersion: null,
  };
}

/**
 * Sort: scored items by decayed signal descending, then unscored by first-seen
 * descending, ties broken by `item_key` **codepoint order**.
 *
 * Not `localeCompare`: the M5 ledger flags `sortRanked`'s use of it as a latent
 * portability bug, because collation depends on the host's ICU build and ties
 * are common (the live cyber top five are five NVD rows at exactly 0.100). A
 * bot comparing two runs on two machines must not see a different order.
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  const aScored = a.signalScore !== null;
  const bScored = b.signalScore !== null;
  if (aScored !== bScored) return aScored ? -1 : 1;
  if (aScored && bScored && a.signalScore !== b.signalScore) return b.signalScore! - a.signalScore!;
  if (a.item.firstSeenAt !== b.item.firstSeenAt) return a.item.firstSeenAt < b.item.firstSeenAt ? 1 : -1;
  return a.item.itemKey < b.item.itemKey ? -1 : a.item.itemKey > b.item.itemKey ? 1 : 0;
}

export function createItemsForEntityTool(deps: BotToolDeps): McpTool<never> {
  const index = indexSources(deps.sources);

  return defineTool({
    name: 'get_items_for_entity',
    title: 'Items for an entity',
    description:
      'News and advisories mentioning an entity — a company, product, technology or CVE as named in ' +
      'the corpus. Exact, case-sensitive match. Defaults to sources whose kind is news or advisory; ' +
      'pass `kinds` to widen. Every item carries the signal score with this read\'s recency decay ' +
      'already applied, plus the stored component and the factor, so the number can be reproduced. ' +
      'Pass `asOf` for a point-in-time answer: only items this system had fetched by that instant ' +
      'are returned, and their scores are the ones that existed then. `since` filters on when ' +
      'Watchfloor first saw an item, not on the publisher\'s date, which is missing for a large ' +
      'part of the corpus.',
    inputSchema: z.object({
      entity: z.string().min(1).describe('The entity name, exactly as the corpus spells it (case-sensitive).'),
      asOf: z
        .string()
        .optional()
        .describe('Point-in-time boundary, canonical UTC (YYYY-MM-DDTHH:mm:ss.sssZ). Only items with fetched_at <= asOf are returned.'),
      since: z
        .string()
        .optional()
        .describe('Earliest first-seen instant to include, canonical UTC. Filters on firstSeenAt, never on publishedAt.'),
      minSignalScore: z
        .number()
        .optional()
        .describe('Floor on the DECAYED signal score. Excludes unscored items, which is reported as unscoredExcluded.'),
      kinds: z
        .array(z.enum(KINDS))
        .optional()
        .describe('Source content kinds to include. Defaults to news + advisory.'),
      limit: z.number().int().min(1).max(MAX_ITEM_LIMIT).optional().describe(`Maximum items to return (default ${DEFAULT_ITEM_LIMIT}).`),
    }),
    run: (
      args: { entity: string; asOf?: string; since?: string; minSignalScore?: number; kinds?: Kind[]; limit?: number },
      ctx,
    ): McpToolResult =>
      withReadInstant(args.asOf, ctx, { checkRetention: true }, (instant) => {
        const readAt = instant.readAt;
        const kinds: ReadonlySet<Kind> = args.kinds === undefined ? DEFAULT_BOT_KINDS : new Set(args.kinds);
        const limit = args.limit ?? DEFAULT_ITEM_LIMIT;

        const candidateKeys = entityCandidatesAsOf(ctx.corpus, args.entity, readAt);
        const items = readItemsAsOf(ctx.corpus, candidateKeys, readAt);
        const beats = readBeatsAsOf(ctx.corpus, candidateKeys, readAt);
        const scores = readSignalScoresAsOf(ctx.corpus, candidateKeys, readAt);

        const decayConfig = deps.decayConfig;
        if (decayConfig === undefined) {
          throw new Error('get_items_for_entity requires a decay config; see src/mcp/tools/deps.ts');
        }

        let unscored = 0;
        let unscoredExcluded = 0;
        const candidates: Candidate[] = [];

        for (const key of candidateKeys) {
          const item = items.get(key);
          if (item === undefined) continue;
          const source = index.get(item.sourceId);

          // A source we cannot classify is one we cannot promise is news, so
          // it is excluded by a kind filter rather than admitted by default --
          // the same direction `src/vault/weekly.ts` chose.
          if (source?.kind === undefined || source.kind === null || !kinds.has(source.kind)) continue;
          if (args.since !== undefined && item.firstSeenAt < args.since) continue;

          const itemBeats = beats.get(key) ?? [];
          const scored = pickBeat(item, itemBeats, scores.get(key), readAt, decayConfig);

          if (scored.signalScore === null) {
            unscored += 1;
            if (args.minSignalScore !== undefined) {
              unscoredExcluded += 1;
              unscored -= 1;
              continue;
            }
          } else if (args.minSignalScore !== undefined && scored.signalScore < args.minSignalScore) {
            continue;
          }

          candidates.push({ item, source, beats: itemBeats, ...scored });
        }

        candidates.sort(compareCandidates);
        const page = candidates.slice(0, limit);

        return {
          structured: {
            status: 'ok',
            entity: args.entity,
            // Known AS OF the instant asked about: an entity whose only items
            // arrive later did not exist then, and saying otherwise would be a
            // fact from the future.
            entityKnown: candidateKeys.length > 0,
            asOf: readAt,
            asOfProvided: instant.asOfProvided,
            since: args.since ?? null,
            sinceAxis: 'firstSeenAt',
            minSignalScore: args.minSignalScore ?? null,
            filter: {
              axis: 'kind',
              kinds: [...kinds].sort(),
              default: args.kinds === undefined,
              ruling:
                'RULING 1 (M5 plan): the bot default is kind in (news, advisory), not §8.2\'s literal ' +
                'item_type in (event) — measured, item_type is effectively binary and `event` means ' +
                'exactly four government sources.',
            },
            candidates: candidateKeys.length,
            matched: candidates.length,
            returned: page.length,
            unscored,
            unscoredExcluded,
            items: page.map((candidate) => ({
              itemKey: candidate.item.itemKey,
              title: candidate.item.title,
              url: candidate.item.url,
              sourceId: candidate.item.sourceId,
              sourceName: candidate.source?.name ?? null,
              sourceKind: candidate.source?.kind ?? null,
              sourceWeight: candidate.source?.weight ?? null,
              itemType: candidate.item.itemType,
              beat: candidate.beat,
              beats: [...candidate.beats],
              publishedAt: candidate.item.publishedAt,
              firstSeenAt: candidate.item.firstSeenAt,
              versionFetchedAt: candidate.item.versionFetchedAt,
              signalScore: candidate.signalScore,
              signalScoreStored: candidate.signalScoreStored,
              decayFactor: candidate.decayFactor,
              scoredAt: candidate.scoredAt,
              scorerVersion: candidate.scorerVersion,
            })),
          },
          rows: page.length,
        };
      }),
  }) as McpTool<never>;
}
