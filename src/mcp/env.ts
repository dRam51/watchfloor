/**
 * The MCP server's own, deliberately minimal environment (M5 task 10).
 *
 * ---------------------------------------------------------------------------
 * Why this exists instead of a `loadEnv()` call
 * ---------------------------------------------------------------------------
 * `loadEnv` (src/config/env.ts) requires `WF_API_TOKEN` — reasonably, since
 * every other entrypoint serves or feeds the HTTP API. This process must not.
 *
 * An MCP client launches its servers with an explicit environment block, so
 * whatever this entrypoint requires ends up written into the **bot's**
 * configuration. Requiring `WF_API_TOKEN` would put the dashboard's credential
 * there, and §8.2's *"separate process, separate credential"* would be
 * satisfied only on paper: one leak, both systems. tests/mcp/bin.test.ts boots
 * the real process with no `WF_API_TOKEN` at all to keep that honest.
 *
 * So the surface is three variables and no more:
 *
 *   WF_DB_PATH        required, relative — the rule is IMPORTED from
 *                     src/config/env.ts rather than restated, so it cannot drift
 *   WF_MCP_TOKEN      required, 16+, and must differ from WF_API_TOKEN if that
 *                     happens to be present (src/mcp/auth.ts)
 *   WF_MCP_LOG_ARGS   optional; `1` opts into logging argument VALUES
 *
 * `WF_TZ` is absent on purpose. It exists so day boundaries are derived from
 * configuration rather than the host clock; nothing here has a day boundary —
 * `as_of` is an instant and every timestamp on this wire is canonical UTC.
 * Requiring it would be one more line in the bot's config for no behaviour.
 */

import { z } from 'zod';
import { EnvError, relativePath } from '../config/env.ts';
import { resolveMcpToken } from './auth.ts';

export interface McpEnv {
  readonly dbPath: string;
  readonly token: string;
  /** `WF_MCP_LOG_ARGS=1`. See src/mcp/log.ts for what this does and does not change. */
  readonly logArguments: boolean;
}

const McpEnvSchema = z.object({
  WF_DB_PATH: relativePath,
});

export function loadMcpEnv(source: NodeJS.ProcessEnv = process.env): McpEnv {
  const parsed = McpEnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new EnvError(`invalid environment:\n${lines.join('\n')}`);
  }

  return {
    dbPath: parsed.data.WF_DB_PATH,
    // Read through its own resolver rather than the schema, exactly as
    // WF_ANTHROPIC_API_KEY is: the credential rules (length, and inequality
    // with WF_API_TOKEN) are behaviour, not shape.
    token: resolveMcpToken(source),
    logArguments: source.WF_MCP_LOG_ARGS === '1',
  };
}
