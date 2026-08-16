/**
 * JSON-RPC 2.0 framing, as the MCP stdio binding specifies it (M5 task 10).
 *
 * ---------------------------------------------------------------------------
 * Why this is hand-written and there is no SDK in package.json
 * ---------------------------------------------------------------------------
 * `@modelcontextprotocol/sdk@1.30.0` declares 17 direct dependencies and
 * resolves to **93 packages**. This project's entire production tree today —
 * fastify, zod, yaml, fast-xml-parser and everything under them — is **59**.
 * Taking the SDK would more than double it, and what it adds is the part this
 * server explicitly does not want: two HTTP server frameworks (express, hono),
 * an OAuth/JOSE stack (`jose`, `pkce-challenge`), an SSE client
 * (`eventsource`), and a process spawner (`cross-spawn`).
 *
 * §8.2's requirement is *"separate process, separate credential ... the bot
 * gets no write path"*. A dependency set whose headline features are "serve
 * HTTP" and "spawn processes" is the opposite of that, and M5 task 2 already
 * rejected the Anthropic SDK on the neighbouring ground: an SDK brings its own
 * transport, which widens what a safety proof has to cover, into
 * `node_modules` where this repository's own tripwires cannot see it.
 *
 * What we give up is real and worth naming: the SDK tracks the specification,
 * and this file does not. The mitigation is that the surface is four methods
 * and one framing rule, all pinned by tests written against the published
 * revision. See the task report for the full accounting.
 *
 * ---------------------------------------------------------------------------
 * The framing rules, verbatim from the stdio binding
 * ---------------------------------------------------------------------------
 * > *"Messages are delimited by newlines, and **MUST NOT** contain embedded
 * > newlines."*
 * > *"The server **MUST NOT** write anything to its `stdout` that is not a
 * > valid MCP message."*
 *
 * `JSON.stringify` escapes every newline inside a string, so an item summary
 * containing one cannot break the frame — but that is a property worth
 * asserting rather than assuming, and tests/mcp/jsonrpc.test.ts does.
 */

export const JSONRPC_VERSION = '2.0';

/** MCP forbids the `null` id that base JSON-RPC allows. */
export type RpcId = string | number;

export interface RpcRequest {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: RpcId;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface RpcNotification {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface RpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface RpcResultResponse {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: RpcId;
  readonly result: Record<string, unknown>;
}

export interface RpcErrorResponse {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: RpcId | null;
  readonly error: RpcErrorBody;
}

export type RpcResponse = RpcResultResponse | RpcErrorResponse;

// -- Standard JSON-RPC 2.0 ---------------------------------------------------
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

// -- Defined by the MCP specification in its reserved -32020..-32099 block ---
export const MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022;

// -- Watchfloor's own -------------------------------------------------------
// The 2026-07-28 revision partitions the implementation-defined range: -32000
// to -32019 is legacy and new implementations SHOULD NOT use it at all,
// -32020 to -32099 belongs to the specification, and "new error codes for
// purposes not defined by this specification SHOULD be allocated outside the
// JSON-RPC reserved range (-32768 to -32000)". Hence -31xxx: recognisably an
// error code, provably not a squat on a reserved one.
export const WF_UNAUTHORIZED = -31001;
export const WF_FORBIDDEN_FIELD = -31002;

export type ParsedMessage =
  | { readonly kind: 'request'; readonly request: RpcRequest }
  | { readonly kind: 'notification'; readonly notification: RpcNotification }
  | { readonly kind: 'invalid'; readonly id: RpcId | null; readonly code: number; readonly message: string };

function invalid(id: RpcId | null, message: string, code = RPC_INVALID_REQUEST): ParsedMessage {
  return { kind: 'invalid', id, code, message };
}

function asParams(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * One line in, one classified message out. Never throws: a malformed line from
 * the client is an ordinary answer (`kind: 'invalid'`), not an exception the
 * transport has to catch, because the transport's job is to keep reading.
 */
export function parseMessage(line: string): ParsedMessage {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    return invalid(null, `could not parse message: ${(cause as Error).message}`, RPC_PARSE_ERROR);
  }

  // Batching was added in 2025-03-26 and removed again before this revision.
  // Refusing it explicitly beats letting an array fall through to "not an
  // object" and reporting something less useful.
  if (Array.isArray(value)) return invalid(null, 'JSON-RPC batching is not supported');
  if (typeof value !== 'object' || value === null) return invalid(null, 'message must be a JSON object');

  const message = value as Record<string, unknown>;

  // Read the id first, so an id-carrying but otherwise-broken request still
  // produces an error the client can correlate rather than an orphan.
  const rawId = message.id;
  const hasId = 'id' in message;
  const id: RpcId | null = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;

  if (message.jsonrpc !== JSONRPC_VERSION) return invalid(id, `jsonrpc must be "${JSONRPC_VERSION}"`);

  // The stdio binding: "The client MUST NOT write JSON-RPC responses." A
  // response arriving on our stdin is a confused peer, not a request.
  if ('result' in message || 'error' in message) {
    return invalid(id, 'a response is not a valid message on the server stdin');
  }

  if (typeof message.method !== 'string' || message.method.length === 0) {
    return invalid(id, 'method must be a non-empty string');
  }

  if (!hasId) {
    return { kind: 'notification', notification: { jsonrpc: JSONRPC_VERSION, method: message.method, params: asParams(message.params) } };
  }

  // "Unlike base JSON-RPC, the ID MUST NOT be null."
  if (id === null) return invalid(null, 'id must be a string or a number, and must not be null');

  return { kind: 'request', request: { jsonrpc: JSONRPC_VERSION, id, method: message.method, params: asParams(message.params) } };
}

/**
 * A successful result, stamped with the `resultType` the 2026-07-28 revision
 * requires on every result: *"The `result` **MUST** include a `resultType`
 * field."* Stamping it here rather than at each call site is what stops one
 * handler from forgetting.
 */
export function resultResponse(id: RpcId, result: Record<string, unknown>): RpcResultResponse {
  return { jsonrpc: JSONRPC_VERSION, id, result: { resultType: 'complete', ...result } };
}

export function errorResponse(id: RpcId | null, code: number, message: string, data?: unknown): RpcErrorResponse {
  const error: RpcErrorBody = data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

/** One message, one line. See the framing note in this file's header. */
export function encodeMessage(message: RpcResponse): string {
  return JSON.stringify(message);
}
