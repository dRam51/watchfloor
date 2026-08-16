/**
 * The bot's credential (M5 task 10).
 *
 * §8.2: *"Isolation that still holds: separate process, **separate
 * credential**, separate DB user (read-only role)."*
 *
 * ---------------------------------------------------------------------------
 * Where a credential bites on stdio, and where it does not
 * ---------------------------------------------------------------------------
 * The MCP base specification is explicit that its HTTP authorization framework
 * does not apply here: *"Implementations using STDIO transport SHOULD NOT
 * follow this specification, and instead retrieve credentials from the
 * environment."* And separately: *"clients and servers MAY negotiate their own
 * custom authentication and authorization strategies."*
 *
 * So the credential does two jobs, and they are worth separating because only
 * one of them is a security boundary today:
 *
 * 1. **A deployment gate (real today).** The process refuses to start without
 *    `WF_MCP_TOKEN`, and refuses to start if it equals `WF_API_TOKEN`. That is
 *    what makes "separate credential" a fact rather than a naming convention:
 *    the bot's configuration carries a secret the dashboard's does not, so
 *    revoking one does not revoke the other, and a leaked bot credential
 *    cannot be replayed against the HTTP API.
 * 2. **A per-request gate (real on every transport).** The 2026-07-28 revision
 *    is stateless — *"all the information needed to process a request is
 *    contained in the request itself"* — so the credential travels in every
 *    request's `_meta`, and `src/mcp/server.ts` checks it before any tool runs.
 *    The tools capability section blesses exactly this: *"The set MAY vary by
 *    the authorization presented on the request — since credentials are
 *    per-request input, not connection state."*
 *
 * **Stated plainly:** over stdio, (2) is not a defence against an attacker who
 * can already spawn this process, because that attacker can read its
 * environment. Its value is that the check lives at the boundary now, so a
 * future socket or HTTP transport inherits a working per-request gate instead
 * of having one retrofitted — and (1) holds regardless.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

export const MCP_TOKEN_ENV = 'WF_MCP_TOKEN';
export const API_TOKEN_ENV = 'WF_API_TOKEN';

/**
 * Where the credential travels on a request.
 *
 * The `_meta` key rules for this revision: an optional prefix of dot-separated
 * labels ending in `/`, reverse-DNS by convention, where *"any prefix where the
 * second label is `modelcontextprotocol` or `mcp` is reserved"*; and a name
 * that begins and ends with an alphanumeric character. `io.github.dram51/` is
 * the reverse-DNS form of a namespace the repository owner actually controls,
 * and its second label is `github`, so it is not reserved.
 */
export const MCP_TOKEN_META_KEY = 'io.github.dram51/watchfloor-token';

/**
 * Long enough that guessing is not a strategy, short enough that a hand-typed
 * value is practical. `WF_API_TOKEN` uses 8 (src/config/env.ts); this is
 * higher because the API token is behind a loopback bind and a Tailscale
 * network, while this process is spawned by a third-party client.
 */
export const MIN_TOKEN_LENGTH = 16;

export class McpCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpCredentialError';
  }
}

/**
 * The configured credential, or a refusal to boot.
 *
 * Every message below names the variable and the rule, and **none of them
 * contains a credential value** — this repository is public, and a process
 * that prints its own secret into a terminal or a supervisor log has already
 * lost. Pinned by tests/mcp/auth.test.ts.
 */
export function resolveMcpToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = (env[MCP_TOKEN_ENV] ?? '').trim();
  if (token.length === 0) {
    throw new McpCredentialError(
      `${MCP_TOKEN_ENV} is not set. The MCP server is a separate process with a separate ` +
        `credential (§8.2); set ${MCP_TOKEN_ENV} in .env to a value of at least ${MIN_TOKEN_LENGTH} ` +
        `characters that is NOT ${API_TOKEN_ENV}.`,
    );
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new McpCredentialError(
      `${MCP_TOKEN_ENV} must be at least ${MIN_TOKEN_LENGTH} characters; it is ${token.length}.`,
    );
  }

  const apiToken = (env[API_TOKEN_ENV] ?? '').trim();
  if (apiToken.length > 0 && token === apiToken) {
    throw new McpCredentialError(
      `${MCP_TOKEN_ENV} is the same value as ${API_TOKEN_ENV}. §8.2 requires a **separate ` +
        `credential**: sharing one means revoking the bot also revokes the dashboard, and a ` +
        `leaked bot credential opens the HTTP API. Generate a second value.`,
    );
  }

  return token;
}

/**
 * Constant-time comparison, by the same fixed-length-digest route
 * `src/api/auth.ts` documents at length: `timingSafeEqual` throws on
 * length-mismatched buffers, and catching that throw reintroduces a smaller
 * version of the timing leak (instant rejection on a wrong length, full
 * comparison otherwise). Hashing both sides first means every call — right
 * value, wrong value, wrong length, empty, not a string at all — takes the
 * same path.
 *
 * Duplicated rather than imported from `src/api/auth.ts` on purpose: that
 * module imports Fastify types, and this process must not depend on the HTTP
 * server it is isolated from. Twelve lines is a cheaper price than a shared
 * module that drags the API into the bot's process.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Whether the value presented on a request matches the configured credential.
 *
 * `presented` is `unknown` because it arrives off the wire. Every non-string —
 * absent, null, a number, an object shaped like a credential — collapses to
 * the empty string and takes the same comparison as a wrong value, so the
 * response cannot distinguish "you sent nothing" from "you sent the wrong
 * thing". Same reasoning as src/api/auth.ts's single 401.
 */
export function isAuthorized(presented: unknown, token: string): boolean {
  return constantTimeEqual(typeof presented === 'string' ? presented : '', token);
}
