/**
 * What the §8.2 bot tools need beyond the read-only corpus (M5 task 11).
 *
 * Two config files, injected rather than read inside a tool:
 *
 *  - **`config/sources.yaml`** — RULING 1's `kind` axis lives there, and so
 *    does everything `get_source_health` reports that is not in
 *    `source_fetch_state` (name, beats, cadence, enabled). §7's health page
 *    already works this way; a source's definition is config, not a table.
 *  - **`config/decay.yaml`** — CLAUDE.md: *"Recency decay applied at read time,
 *    never stored."* A bot handed the stored, decay-invariant number and
 *    nothing else would rank a five-month-old advisory alongside this hour's.
 *
 * Injected because a function that reads a file is one a test can only
 * exercise by writing files, and because a malformed config must fail at
 * `src/bin/mcp.ts`'s startup — while an operator is watching — rather than on
 * the first `tools/call` of a live session.
 *
 * `loadBotToolDeps()` is the production default and reads both files once.
 * Nothing here reads `config/portfolio.yaml`; see `./markets.ts`.
 */

import type { Source } from '../../sources/load.ts';
import { loadDecayConfig, type DecayConfig } from '../../score/decay.ts';
import { loadBotSources, repoConfigPath } from './sources.ts';

export interface BotToolDeps {
  readonly sources: readonly Source[];
  /**
   * Optional so the three M4b-deferred tools — which need no decay — can be
   * constructed in a test without one. Every tool that ranks requires it.
   */
  readonly decayConfig?: DecayConfig;
}

export interface LoadedBotToolDeps extends BotToolDeps {
  readonly decayConfig: DecayConfig;
}

export function loadBotToolDeps(): LoadedBotToolDeps {
  return {
    sources: loadBotSources(),
    decayConfig: loadDecayConfig(repoConfigPath('decay.yaml')),
  };
}
