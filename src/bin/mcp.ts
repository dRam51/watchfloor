/**
 * The read-only MCP server (M5 task 10):
 *
 *   npm run mcp
 *
 * A **separate process**, per §8.2, launched by the bot's MCP client rather
 * than by a person — the client writes JSON-RPC to this process's stdin and
 * reads it from stdout. A conforming client entry looks like:
 *
 *   {
 *     "mcpServers": {
 *       "watchfloor": {
 *         "command": "node",
 *         "args": ["src/bin/mcp.ts"],
 *         "cwd": "<repo>",
 *         "env": { "WF_DB_PATH": "data/wf.db", "WF_MCP_TOKEN": "<the bot's own token>" }
 *       }
 *     }
 *   }
 *
 * Note what is NOT in that block: `WF_API_TOKEN`. See src/mcp/env.ts.
 *
 * ---------------------------------------------------------------------------
 * Everything printed here goes to stderr
 * ---------------------------------------------------------------------------
 * The stdio binding: *"The server MUST NOT write anything to its `stdout` that
 * is not a valid MCP message."* There is no banner, no "listening on" line, no
 * `console.log` anywhere in this file or under `src/mcp/` — one would corrupt
 * the protocol mid-session for a client that is already parsing. Every other
 * `src/bin/*.ts` in this repository opens with a friendly startup line; this
 * one deliberately does not, and tests/mcp/bin.test.ts asserts stdout is
 * protocol-only.
 *
 * ---------------------------------------------------------------------------
 * Exit codes
 * ---------------------------------------------------------------------------
 * `0` when stdin closes — *"Servers SHOULD exit promptly when their standard
 * input is closed ... This is the primary graceful-shutdown signal and the
 * only portable one."* `1` for every refusal to start: a missing or shared
 * credential, an absolute `WF_DB_PATH`, an unopenable database, or pending
 * migrations.
 */

import { join } from 'node:path';
import { loadMcpEnv } from '../mcp/env.ts';
import { openReadOnlyCorpus } from '../mcp/readonly.ts';
import { assertCorpusMigrationsUpToDate } from '../mcp/migrations.ts';
import { createQueryLog } from '../mcp/log.ts';
import { ToolRegistry } from '../mcp/registry.ts';
import { registerBotTools } from '../mcp/tools.ts';
import { createMcpServer } from '../mcp/server.ts';
import { serveStdio } from '../mcp/stdio.ts';

// Resolved relative to this module, not the process cwd: an MCP client spawns
// servers from wherever it happens to be running. Matches every other bin/*.ts.
const repoRoot = join(import.meta.dirname, '..', '..');

try {
  const env = loadMcpEnv();

  // Read-only from the first byte. There is no writable handle anywhere in
  // this process, not even transiently at boot -- which is why the migration
  // check below is src/mcp/migrations.ts's read-only variant rather than the
  // shared `assertMigrationsUpToDate`, whose bookkeeping-table creation and
  // checksum backfill are both writes.
  const corpus = openReadOnlyCorpus(env.dbPath);

  const log = createQueryLog({
    write: (line) => process.stderr.write(`${line}\n`),
    includeArguments: env.logArguments,
  });

  try {
    const state = assertCorpusMigrationsUpToDate(corpus, join(repoRoot, 'db', 'migrations'));
    if (state.unverifiable.length > 0) {
      // Reported, never repaired: a read-only process may not backfill a
      // checksum, and pretending otherwise would be a claim it has no standing
      // to make. `npm run migrate` fixes it.
      process.stderr.write(
        `${JSON.stringify({
          at: new Date().toISOString(),
          event: 'startup',
          warning: 'migrations applied with no recorded checksum; drift cannot be detected for them',
          versions: state.unverifiable,
          remedy: 'run npm run migrate (this process cannot write)',
        })}\n`,
      );
    }

    const registry = new ToolRegistry();
    registerBotTools(registry);

    const server = createMcpServer({ corpus, token: env.token, registry, log });
    await serveStdio({ input: process.stdin, output: process.stdout, server });
  } finally {
    corpus.close();
  }

  process.exit(0);
} catch (err) {
  // McpCredentialError, EnvError, DatabaseOpenError and CorpusMigrationError
  // all carry messages written to name the offending variable, path or
  // migration -- a raw stack trace buries exactly that. None of them contains
  // a credential; src/mcp/auth.ts is responsible for that and is tested for it.
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}
