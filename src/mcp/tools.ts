/**
 * The composition root for the bot's tool set (M5 task 10) — **and the one
 * function Task 11 edits.**
 *
 * ---------------------------------------------------------------------------
 * THE SEAM
 * ---------------------------------------------------------------------------
 * Task 11 builds §8.2's five tools. To ship one, it:
 *
 *   1. writes it with `defineTool` (src/mcp/registry.ts) — a name, a
 *      description, a zod schema, and a `run(args, ctx)`;
 *   2. adds one `registry.register(...)` line below.
 *
 * That is the whole contract. It writes no auth code, no JSON-RPC, no
 * serializer, no logging and no database opening, because `src/mcp/server.ts`
 * owns all five and a tool cannot opt out of any of them:
 *
 *   - the credential is checked before `run` is reached — and a tool
 *     registered here is protected without its author doing anything, which is
 *     the property tests/mcp/server.test.ts's "default protection" suite pins;
 *   - `ctx.corpus` is the ONLY route to data, and it is read-only by
 *     construction, refuses `read_score` and refuses `select *`;
 *   - `ctx.now` is a canonical instant fixed once per request — use it for
 *     `as_of` defaults rather than `new Date()`, per this codebase's standing
 *     "now is a parameter" rule and the M5 controller ruling on `generatedAt`;
 *   - whatever `run` returns in `structured` is passed through
 *     `sealBotPayload`, so a forbidden field name is a refusal, not a leak;
 *   - the registry refuses a tool whose NAME or whose ARGUMENT names imply a
 *     recommendation, at registration.
 *
 * Two notes carried forward from the M5 plan for Task 11 specifically:
 *
 *   - **RULING 1**: the bot's default filter keys on `kind in (news,
 *     advisory)`, NOT §8.2's literal `item_type in (event)`. The owner ruled on
 *     this; do not "fix" it back.
 *   - **The three M4b-dependent tools** (`get_market_snapshot`,
 *     `get_catalysts`, `get_filings`) must report "not configured" — *"never an
 *     empty array, which a bot would read as 'no catalysts' rather than 'no
 *     data source'"*.
 */

import { z } from 'zod';
import { defineTool, type ToolRegistry } from './registry.ts';
import { FORBIDDEN_FIELD_PHRASES } from './fields.ts';
import { LATEST_PROTOCOL_VERSION } from './protocol.ts';
import { loadBotToolDeps, type BotToolDeps } from './tools/deps.ts';
import { createItemsForEntityTool } from './tools/items.ts';
import { createSourceHealthTool } from './tools/sourceHealth.ts';
import { createMarketTools } from './tools/markets.ts';

/**
 * The skeleton's own diagnostic, and deliberately not one of §8.2's five.
 *
 * It exists so this milestone does not ship an eighth component with no
 * caller: it is registered, reachable, and exercised end to end by
 * tests/mcp/bin.test.ts against a real child process. Between them, one call
 * proves the whole path works — the read-only handle opens and answers, the
 * SQL guard passes a legitimate query, the serializer passes a clean payload,
 * and the transport frames it.
 *
 * It is also useful in its own right. §8.2's prohibitions are enforced
 * mechanically whatever a model believes, but a bot that can *read* the
 * boundary is a bot that stops asking for a price target — and every refused
 * request is a log line an operator has to triage.
 *
 * Note what this returns: the forbidden names as VALUES in a list. That is
 * safe, and it is a live demonstration of the guard's stated limit — the rule
 * is about field names, so a payload that merely *mentions* `read_score`
 * passes, while a field *called* `readScore` does not.
 */
export const describeBoundary = defineTool({
  name: 'describe_boundary',
  title: 'Describe the Watchfloor boundary',
  description:
    'Reports what this server is and what it will never return: it is a read-only corpus with ' +
    'no market view, and it computes no sentiment, directional label, price target, conviction ' +
    'rating, trade signal or position size. Also reports corpus size and schema version, so a ' +
    'caller can tell a configured-but-empty database from a stale one.',
  inputSchema: z.object({}),
  run: (_args: Record<string, never>, ctx) => {
    const items = ctx.corpus.get('select count(*) as n from items');
    const migrations = ctx.corpus.get('select count(*) as n from schema_migrations');
    return {
      structured: {
        server: 'watchfloor',
        protocolVersion: LATEST_PROTOCOL_VERSION,
        readOnly: true,
        asOf: ctx.now,
        exposes: ['signalScore'],
        neverExposes: [...FORBIDDEN_FIELD_PHRASES],
        corpus: {
          items: Number(items?.n ?? 0),
          migrationsApplied: Number(migrations?.n ?? 0),
        },
      },
    };
  },
});

/**
 * Registers every tool this server offers.
 *
 * Called by `src/bin/mcp.ts` and by nothing else, so the set a live client
 * sees is the set written here — there is no second path by which a tool could
 * become reachable. `tests/mcp/tools/registration.test.ts` pins both
 * directions: every factory `src/mcp/tools/` exports is referenced below, and
 * the entrypoint calls this function.
 *
 * `deps` defaults to the real `config/sources.yaml` and `config/decay.yaml`,
 * read once, HERE — at process startup, where a malformed config is a refusal
 * to boot with an operator watching, rather than an error on the first
 * `tools/call` of a live session. The parameter exists so a test can supply its
 * own without writing files.
 *
 * §8.2's five, and where each one's data comes from:
 *
 * | tool | data | status |
 * | --- | --- | --- |
 * | `get_items_for_entity` | `item_entities` + `items` + `item_scores` | real |
 * | `get_source_health` | `source_fetch_state` + `config/sources.yaml` | real |
 * | `get_market_snapshot` | the §7 market ribbon | **M4b — not configured** |
 * | `get_catalysts` | earnings / FOMC / CPI calendar | **M4b — not configured** |
 * | `get_filings` | an EDGAR adapter | **M4b — not configured** |
 *
 * The three deferred ones are registered rather than omitted, and report
 * `status: "not_configured"` with an explicit `null` where the data would be.
 * Omitting them would leave a bot to conclude the capability does not exist;
 * returning `[]` would leave it to conclude the *world* is empty. See
 * `./tools/markets.ts`.
 */
export function registerBotTools(registry: ToolRegistry, deps: BotToolDeps = loadBotToolDeps()): void {
  registry.register(describeBoundary);
  registry.register(createItemsForEntityTool(deps));
  registry.register(createSourceHealthTool(deps));
  for (const tool of createMarketTools(deps)) registry.register(tool);
}
