/**
 * The three §8.2 bot tools that have no data source (M5 task 11).
 *
 * `get_market_snapshot`, `get_catalysts` and `get_filings` all depend on M4b,
 * which is **deferred, not skipped**: its entire input is
 * `config/portfolio.yaml`, which only the owner can write. There are zero
 * markets sources in `config/sources.yaml`, no catalyst calendar table, no
 * EDGAR adapter, and no market-ribbon snapshot anywhere in the schema.
 *
 * ---------------------------------------------------------------------------
 * Why "not configured" and never `[]`
 * ---------------------------------------------------------------------------
 * The M5 plan states the hazard in one line: *"never an empty array, which a
 * bot would read as 'no catalysts' rather than 'no data source'."* An empty
 * array is a **claim about the world**; `not_configured` is a claim about this
 * system. A backtest fed the first one produces confident, wrong numbers and
 * nothing anywhere reports a fault — which is the same silent-by-construction
 * failure §8.2's point-in-time section exists to prevent, and the same
 * `null`-means-not-applicable discipline `/api/sources` already follows for
 * `everPolled` and `sweep`.
 *
 * So the key the data would live under is present and **explicitly `null`**.
 * `null` is chosen over omission on purpose: a bot reaching for
 * `result.catalysts.length` gets a loud TypeError instead of `undefined`
 * quietly coercing, and a bot iterating it gets a throw rather than zero
 * passes. `src/vault/daily.ts`'s `market_ribbon: not_configured` is the
 * precedent, down to asserting the negative.
 *
 * ---------------------------------------------------------------------------
 * The second state, which is easy to miss
 * ---------------------------------------------------------------------------
 * Adding a markets **source** to `config/sources.yaml` would give this process
 * rows in `items` and still not give it a snapshot, an earnings date or a
 * filing. So `status` stays `not_configured` and only the *reason* moves from
 * `no_markets_source` to `no_markets_store`. Without that second state, a
 * future reader sees `not_configured`, adds a quotes feed, sees
 * `not_configured` again, and concludes the tool is broken. `daily.ts` records
 * the identical distinction for the ribbon.
 *
 * ---------------------------------------------------------------------------
 * What this module deliberately does NOT do
 * ---------------------------------------------------------------------------
 * It never reads `config/portfolio.yaml` — not even to test whether the file
 * exists. The bot must never learn the owner's positions, and an existence bit
 * is itself information about them. The path is named in `blockedOn.needs` as a
 * string, which is all a caller needs to know why the tool is inert.
 *
 * And when M4b does land, whoever fills these in inherits the §8.2 registry
 * guard: a returned field named `positionSize`, `priceTarget` or `sentiment`
 * is refused before the response is framed, and a tool argument by those names
 * is refused at registration. See `src/mcp/fields.ts`.
 */

import { z } from 'zod';
import { defineTool, type McpTool, type McpToolResult } from '../registry.ts';
import type { JsonValue } from '../serialize.ts';
import { marketsAvailability, type MarketsUnavailableReason } from './sources.ts';
import type { BotToolDeps } from './deps.ts';
import { withReadInstant } from './asOf.ts';

/** The one status string all three report. Exported so tests can name it once. */
export const DEFERRED_STATUS = 'not_configured';

const AS_OF_DESCRIPTION =
  'Point-in-time boundary, canonical UTC (YYYY-MM-DDTHH:mm:ss.sssZ). Accepted and validated ' +
  'even though this tool has no data yet, so the interface does not change when M4b lands.';

interface DeferredSpec {
  readonly tool: string;
  /** The key the data would live under. Emitted as an explicit `null`. */
  readonly payloadKey: string;
  readonly reason: MarketsUnavailableReason;
  readonly marketsSources: readonly string[];
  readonly needs: readonly string[];
  readonly detail: string;
  readonly request: Record<string, JsonValue>;
}

function deferredResult(spec: DeferredSpec): McpToolResult {
  return {
    structured: {
      status: DEFERRED_STATUS,
      tool: spec.tool,
      [spec.payloadKey]: null,
      detail: spec.detail,
      blockedOn: {
        milestone: 'M4b',
        reason: spec.reason,
        needs: [...spec.needs],
      },
      marketsSources: [...spec.marketsSources],
      request: spec.request,
    },
    text:
      `${spec.tool}: ${DEFERRED_STATUS}. ${spec.detail} ` +
      `This is NOT an empty result — Watchfloor has no data source for it, so treat it as missing ` +
      `input rather than as evidence of absence.`,
    rows: 0,
  };
}

/**
 * Wording that reflects which of the two unconfigured states we are in. Kept
 * next to the reason it describes so the two cannot drift.
 */
function reasonSentence(reason: MarketsUnavailableReason, marketsSources: readonly string[]): string {
  return reason === 'no_markets_source'
    ? 'No markets source is configured in config/sources.yaml, and the markets beat (M4b) is deferred ' +
        'because its input is the owner-only config/portfolio.yaml.'
    : `A markets source is configured (${marketsSources.join(', ')}), but M4b's data stores do not exist: ` +
        'this corpus holds items, not quotes, calendars or filings.';
}

export function createMarketTools(deps: BotToolDeps): Array<McpTool<never>> {
  const availability = marketsAvailability(deps.sources);
  const common = {
    reason: availability.reason,
    marketsSources: availability.marketsSources,
  };

  const getMarketSnapshot = defineTool({
    name: 'get_market_snapshot',
    title: 'Market snapshot (not configured)',
    description:
      'The index, sector and holding numbers the §7 market ribbon shows, with their timestamps. ' +
      'Reports status "not_configured" today: the markets beat (M4b) is deferred, so there is no ' +
      'ribbon and no stored quote. Returns snapshot: null — never an empty object, which would ' +
      'read as "the market is flat".',
    inputSchema: z.object({
      asOf: z.string().optional().describe(AS_OF_DESCRIPTION),
    }),
    run: (args: { asOf?: string }, ctx) =>
      withReadInstant(args.asOf, ctx, { checkRetention: false }, (instant) => deferredResult({
        ...common,
        tool: 'get_market_snapshot',
        payloadKey: 'snapshot',
        needs: ['config/portfolio.yaml (owner-only; never read by this process)', 'a markets source in config/sources.yaml', 'the §7 market ribbon (M4b)'],
        detail: reasonSentence(availability.reason, availability.marketsSources),
        request: { asOf: instant.readAt, asOfProvided: instant.asOfProvided },
      })),
  });

  const getCatalysts = defineTool({
    name: 'get_catalysts',
    title: 'Scheduled catalysts (not configured)',
    description:
      'Earnings dates, FOMC meetings, CPI/PPI releases and known filing deadlines for the given ' +
      'entities — dates and events only, nothing inferred. Reports status "not_configured" today: ' +
      'no calendar exists in this schema. Returns catalysts: null, NOT [] — an empty list would ' +
      'read as "nothing scheduled this window", which is a claim about the world rather than ' +
      'about Watchfloor.',
    inputSchema: z.object({
      entities: z.array(z.string().min(1)).optional().describe('Tickers or related_entities keys.'),
      window: z.string().optional().describe('Look-ahead window, e.g. "7d" or "1m".'),
      asOf: z.string().optional().describe(AS_OF_DESCRIPTION),
    }),
    run: (args: { entities?: string[]; window?: string; asOf?: string }, ctx) =>
      withReadInstant(args.asOf, ctx, { checkRetention: false }, (instant) => deferredResult({
        ...common,
        tool: 'get_catalysts',
        payloadKey: 'catalysts',
        needs: ['config/portfolio.yaml (owner-only; never read by this process)', 'an earnings/FOMC/CPI calendar source', 'a calendar table (no migration defines one)'],
        detail: `${reasonSentence(availability.reason, availability.marketsSources)} No catalyst calendar table exists in db/migrations.`,
        request: {
          entities: args.entities ?? null,
          window: args.window ?? null,
          asOf: instant.readAt,
          asOfProvided: instant.asOfProvided,
        },
      })),
  });

  const getFilings = defineTool({
    name: 'get_filings',
    title: 'EDGAR filings (not configured)',
    description:
      'EDGAR filing metadata and links for a ticker. Reports status "not_configured" today: there ' +
      'is no EDGAR adapter in this system. Returns filings: null, NOT [] — an empty list would ' +
      'read as "this company has filed nothing".',
    inputSchema: z.object({
      ticker: z.string().min(1).describe('The issuer\'s ticker symbol.'),
      formType: z.string().optional().describe('An EDGAR form type, e.g. "8-K", "10-Q".'),
      since: z.string().optional().describe('Earliest filing date of interest, canonical UTC.'),
      asOf: z.string().optional().describe(AS_OF_DESCRIPTION),
    }),
    run: (args: { ticker: string; formType?: string; since?: string; asOf?: string }, ctx) =>
      withReadInstant(args.asOf, ctx, { checkRetention: false }, (instant) => deferredResult({
        ...common,
        tool: 'get_filings',
        payloadKey: 'filings',
        needs: ['an EDGAR adapter (no source in config/sources.yaml has one)', 'config/portfolio.yaml (owner-only; never read by this process)'],
        detail: `${reasonSentence(availability.reason, availability.marketsSources)} No EDGAR adapter exists in src/adapters.`,
        request: {
          ticker: args.ticker,
          formType: args.formType ?? null,
          since: args.since ?? null,
          asOf: instant.readAt,
          asOfProvided: instant.asOfProvided,
        },
      })),
  });

  return [getMarketSnapshot, getCatalysts, getFilings] as Array<McpTool<never>>;
}
