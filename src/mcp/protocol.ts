/**
 * The MCP constants this server speaks (M5 task 10).
 *
 * ---------------------------------------------------------------------------
 * One version, and why
 * ---------------------------------------------------------------------------
 * `2026-07-28` is the current revision and it is a **modern** one in the
 * specification's own terminology: stateless, with the protocol version,
 * client identity and client capabilities carried in every request's `_meta`
 * rather than agreed once in an `initialize` handshake. Revisions `2025-11-25`
 * and earlier are **legacy** and handshake-based.
 *
 * This server supports the modern revision only. Supporting a legacy one means
 * implementing a second era — a handshake, per-connection session state, and
 * an `initialize`/`notifications/initialized` lifecycle — which is a second
 * server, not a second constant. What it does implement is the one thing the
 * specification asks of a modern-only server meeting a legacy client:
 *
 * > *"A server that supports only modern versions **SHOULD** name the protocol
 * > versions it supports in any error it returns to an `initialize` request,
 * > on any transport: legacy clients have no fall-forward mechanism, and this
 * > message may be the only diagnostic they can surface to users."*
 *
 * See src/mcp/server.ts's `initialize` branch.
 *
 * The stateless model is also what makes this project's credential design
 * work: because every request carries its own `_meta`, the credential check in
 * src/mcp/server.ts is genuinely per-request, exactly like src/api/auth.ts's
 * `onRequest` hook — rather than a handshake whose result the rest of the
 * connection inherits.
 */

export const LATEST_PROTOCOL_VERSION = '2026-07-28';

/**
 * Every version this server will serve, newest first. `server/discover`
 * publishes this list verbatim, and an `UnsupportedProtocolVersionError`
 * carries it so a client can retry with something mutually supported.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [LATEST_PROTOCOL_VERSION];

// The reserved `io.modelcontextprotocol/*` request and response metadata keys.
export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/** Methods this server implements. `server/discover` is a MUST for every server. */
export const METHOD_DISCOVER = 'server/discover';
export const METHOD_TOOLS_LIST = 'tools/list';
export const METHOD_TOOLS_CALL = 'tools/call';
/** Not implemented — handled only to emit the legacy diagnostic described above. */
export const METHOD_LEGACY_INITIALIZE = 'initialize';

export interface Implementation {
  readonly name: string;
  readonly version: string;
}

export const DEFAULT_SERVER_INFO: Implementation = { name: 'watchfloor', version: '0.0.0' };

/**
 * The `instructions` string on `server/discover`: *"Optional natural-language
 * guidance for LLMs on how to use this server effectively."*
 *
 * Used here to make the boundary visible to the model on the other side rather
 * than only to the operator. §8.2's prohibitions are enforced mechanically
 * whatever this says — but a bot that has been told the corpus carries no
 * directional view is a bot that stops asking for one, and every refused
 * request is a log line an operator has to read.
 */
export const SERVER_INSTRUCTIONS =
  'Watchfloor is a read-only situational-awareness corpus: news, security advisories, ' +
  'research and repository activity, with a mechanical relevance score (`signalScore`) and ' +
  'point-in-time (`asOf`) reads over an append-only store. It holds no market view of any ' +
  'kind. It does not compute or expose sentiment, directional labels, price targets, ' +
  'conviction ratings, trade signals or position sizing, and requests for them are refused ' +
  'rather than approximated. Treat every result as evidence to reason over, never as a ' +
  'recommendation.';
