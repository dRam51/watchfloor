/**
 * The dispatcher (M5 task 10) — the one place a bot-facing request is
 * authorised, routed, serialized and logged.
 *
 * `handle(line) -> line | null` is the whole surface. A transport's job is to
 * split a stream on newlines, hand each line here, and write back what comes
 * out; src/mcp/stdio.ts does exactly that in about forty lines, and a socket
 * or HTTP transport later would too. Keeping the protocol logic stream-free is
 * also what makes every property below testable without a process.
 *
 * ---------------------------------------------------------------------------
 * The gate, and why it is here rather than in the tools
 * ---------------------------------------------------------------------------
 * `PUBLIC_METHODS` below is an **EXEMPTION list, not a protection list**, and
 * the direction is the whole design — the same one src/api/auth.ts spells out
 * for the HTTP API:
 *
 * > *"every route registered on this server instance is protected by the
 * > onRequest hook below unless its path is named here. A task author who adds
 * > a new route and does nothing auth-related gets a protected route by
 * > default (fails closed)."*
 *
 * Task 11 registers five tools and writes no auth code. A tool added in M6
 * inherits the same gate. tests/mcp/server.test.ts's "default protection"
 * suite registers a tool the dispatcher has never heard of and proves both
 * that it answers `unauthorized` and that the tool's `run` never executed.
 *
 * `server/discover` is the one exemption, and it is the exact analogue of
 * `/health` being public: a client that cannot discover the server's supported
 * protocol versions cannot form a valid request at all, and the response
 * carries versions, capability names and a self-reported identity — nothing
 * from the corpus.
 *
 * ---------------------------------------------------------------------------
 * The order of checks, stated because it is a decision
 * ---------------------------------------------------------------------------
 *   1. parse            malformed line -> -32700 / -32600, id preserved if readable
 *   2. legacy initialize -> a diagnostic naming our versions (spec SHOULD)
 *   3. required `_meta` -> -32602, as the spec requires for a missing field
 *   4. protocol version -> -32022 with the supported list
 *   5. THE CREDENTIAL   -> -31001, identical for missing and wrong
 *   6. route
 *
 * Version before credential is deliberate: a client that cannot speak our
 * revision cannot meaningfully authenticate, and telling it so leaks nothing
 * that `server/discover` does not already publish to anyone.
 *
 * ---------------------------------------------------------------------------
 * §8.2 runs on the way OUT, unconditionally
 * ---------------------------------------------------------------------------
 * Every tool result passes through `sealBotPayload` before it is serialized.
 * A forbidden field is a **protocol error**, not a tool execution error and
 * not a silent strip: it is a server bug, no model can self-correct it, and a
 * quietly-scrubbed response would read to the bot as "Watchfloor has no
 * opinion", which is indistinguishable from a correct answer.
 */

import {
  encodeMessage,
  errorResponse,
  parseMessage,
  resultResponse,
  MCP_UNSUPPORTED_PROTOCOL_VERSION,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  WF_FORBIDDEN_FIELD,
  WF_UNAUTHORIZED,
  type RpcId,
  type RpcResponse,
} from './jsonrpc.ts';
import {
  DEFAULT_SERVER_INFO,
  LATEST_PROTOCOL_VERSION,
  METHOD_DISCOVER,
  METHOD_LEGACY_INITIALIZE,
  METHOD_TOOLS_CALL,
  METHOD_TOOLS_LIST,
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  SERVER_INSTRUCTIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  type Implementation,
} from './protocol.ts';
import { isAuthorized, MCP_TOKEN_META_KEY } from './auth.ts';
import { ForbiddenFieldError, sealBotPayload, UnserializableValueError } from './serialize.ts';
import { SqlRefusedError, type ReadOnlyCorpus } from './readonly.ts';
import type { ToolRegistry } from './registry.ts';
import type { QueryLog, QueryOutcome } from './log.ts';

/** See the exemption-list note in this file's header. */
const PUBLIC_METHODS: ReadonlySet<string> = new Set([METHOD_DISCOVER]);

export interface McpServerDeps {
  readonly corpus: ReadOnlyCorpus;
  readonly token: string;
  readonly registry: ToolRegistry;
  readonly log: QueryLog;
  /** Injectable clock, per this codebase's "now is a parameter" convention. */
  readonly now?: () => string;
  readonly serverInfo?: Implementation;
  readonly instructions?: string;
}

export interface McpServer {
  /** One raw line in; one raw line out, or `null` for a notification. */
  handle(line: string): Promise<string | null>;
}

interface Meta {
  readonly protocolVersion: string;
  readonly clientName: string | null;
  readonly token: unknown;
}

function readMeta(params: Record<string, unknown>): Meta | { error: string } {
  const raw = params._meta;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: `params._meta is required and must be an object (${META_PROTOCOL_VERSION}, ${META_CLIENT_CAPABILITIES})` };
  }
  const meta = raw as Record<string, unknown>;

  const version = meta[META_PROTOCOL_VERSION];
  if (typeof version !== 'string' || version.length === 0) {
    return { error: `params._meta[${JSON.stringify(META_PROTOCOL_VERSION)}] is required and must be a string` };
  }
  // "Required: Yes" in the per-request protocol fields table, and a server
  // "MUST NOT rely on capabilities the client has not declared" -- so an
  // absent declaration is a malformed request, not an empty one.
  const capabilities = meta[META_CLIENT_CAPABILITIES];
  if (typeof capabilities !== 'object' || capabilities === null || Array.isArray(capabilities)) {
    return { error: `params._meta[${JSON.stringify(META_CLIENT_CAPABILITIES)}] is required and must be an object` };
  }

  const info = meta[META_CLIENT_INFO];
  const clientName =
    typeof info === 'object' && info !== null && typeof (info as Record<string, unknown>).name === 'string'
      ? ((info as Record<string, unknown>).name as string)
      : null;

  return { protocolVersion: version, clientName, token: meta[MCP_TOKEN_META_KEY] };
}

export function createMcpServer(deps: McpServerDeps): McpServer {
  const nowFn = deps.now ?? (() => new Date().toISOString());
  const serverInfo = deps.serverInfo ?? DEFAULT_SERVER_INFO;
  const instructions = deps.instructions ?? SERVER_INSTRUCTIONS;

  /** Every result carries the server identity the spec asks for. */
  const ok = (id: RpcId, result: Record<string, unknown>): RpcResponse =>
    resultResponse(id, { ...result, _meta: { [META_SERVER_INFO]: serverInfo } });

  function discover(id: RpcId): RpcResponse {
    return ok(id, {
      supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      // `listChanged: false` is honest rather than modest: the tool set is
      // fixed at composition time (src/bin/mcp.ts), so there is no event that
      // could ever fire a notifications/tools/list_changed.
      capabilities: { tools: { listChanged: false } },
      instructions,
    });
  }

  async function callTool(
    id: RpcId,
    params: Record<string, unknown>,
    now: string,
  ): Promise<{
    response: RpcResponse;
    outcome: QueryOutcome;
    tool: string | null;
    /** Threaded so EVERY non-ok log line carries a code -- a real session's stderr showed this gap. */
    code?: number;
    rows?: number;
    args?: Record<string, unknown>;
  }> {
    const name = params.name;
    if (typeof name !== 'string') {
      return {
        response: errorResponse(id, RPC_INVALID_PARAMS, 'params.name must be a string'),
        outcome: 'error',
        code: RPC_INVALID_PARAMS,
        tool: null,
      };
    }
    const tool = deps.registry.get(name);
    if (tool === undefined) {
      // The spec's own example for this case uses -32602 and puts it on the
      // protocol side: "Unknown tool" is not something a model fixes by
      // adjusting parameters.
      return {
        response: errorResponse(id, RPC_INVALID_PARAMS, `Unknown tool: ${name}`),
        outcome: 'error',
        code: RPC_INVALID_PARAMS,
        tool: name,
      };
    }

    const rawArgs = params.arguments;
    const args = typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};

    // `.strict()` HERE, not left to each tool author -- and this line exists
    // because a test caught the drift it closes. `src/mcp/schema.ts` publishes
    // `additionalProperties: false` unconditionally (a bot-facing tool that
    // silently ignores an argument it does not understand is a bot that thinks
    // it filtered when it did not), but a plain `z.object({...})` STRIPS
    // unknown keys instead of rejecting them. So the advertised contract said
    // "no extra arguments" while the validator quietly accepted them: exactly
    // the advertised-versus-enforced drift src/mcp/schema.ts exists to
    // prevent, reintroduced one layer down. Calling `.strict()` at the single
    // point of validation makes the two agree by construction rather than by
    // every tool author remembering. It is a no-op on an already-strict
    // schema.
    const parsed = tool.inputSchema.strict().safeParse(args);
    if (!parsed.success) {
      // A tool EXECUTION error, deliberately: "Input validation errors (e.g.,
      // date in wrong format, value out of range)" are listed as the case a
      // model can self-correct and retry.
      const message = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
      return {
        response: ok(id, { content: [{ type: 'text', text: `invalid arguments: ${message}` }], isError: true }),
        outcome: 'error',
        // A tool EXECUTION error carries no JSON-RPC code on the wire -- it is
        // a successful response with `isError: true`. The LOG still records
        // the code an operator would filter by, so "the bot sent bad
        // arguments" and "the bot named a tool that does not exist" sort
        // together rather than one of them having a blank column.
        code: RPC_INVALID_PARAMS,
        tool: name,
        args,
      };
    }

    const result = await tool.run(parsed.data as never, { corpus: deps.corpus, now });

    // §8.2, on the way out. See this file's header for why a violation is a
    // protocol error rather than a scrubbed field.
    const structured = sealBotPayload(result.structured);
    const text = result.text ?? JSON.stringify(structured);

    return {
      response: ok(id, {
        content: [{ type: 'text', text }],
        structuredContent: structured,
        isError: result.isError ?? false,
      }),
      outcome: 'ok',
      tool: name,
      ...(result.rows === undefined ? {} : { rows: result.rows }),
      args,
    };
  }

  return {
    async handle(line: string): Promise<string | null> {
      const startedAt = Date.now();
      const parsed = parseMessage(line);

      // A notification carries no query and expects no answer. Not logged:
      // the query log answers "what did the bot ask", and a cancellation is
      // not an ask.
      if (parsed.kind === 'notification') return null;

      if (parsed.kind === 'invalid') {
        return encodeMessage(errorResponse(parsed.id, parsed.code, parsed.message));
      }

      const { id, method, params } = parsed.request;
      const now = nowFn();

      const finish = (
        response: RpcResponse,
        outcome: QueryOutcome,
        extras: { tool?: string | null; code?: number; rows?: number; args?: Record<string, unknown>; meta?: Meta } = {},
      ): string => {
        deps.log.record({
          at: now,
          id,
          method,
          tool: extras.tool ?? null,
          outcome,
          durationMs: Date.now() - startedAt,
          ...(extras.code === undefined ? {} : { code: extras.code }),
          ...(extras.rows === undefined ? {} : { resultRows: extras.rows }),
          ...(extras.meta === undefined ? {} : { clientName: extras.meta.clientName, protocolVersion: extras.meta.protocolVersion }),
          ...(extras.args === undefined ? {} : { args: extras.args }),
        });
        return encodeMessage(response);
      };

      // 2. A legacy client, which has no fall-forward mechanism. Answered
      //    before the `_meta` check on purpose -- an initialize request has no
      //    modern `_meta`, so the generic -32602 would fire first and bury the
      //    one diagnostic the spec asks us to give it.
      if (method === METHOD_LEGACY_INITIALIZE) {
        return finish(
          errorResponse(
            id,
            RPC_METHOD_NOT_FOUND,
            `this server implements only the stateless MCP revisions ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}, ` +
              `which have no \`initialize\` handshake. Send requests with ` +
              `params._meta[${JSON.stringify(META_PROTOCOL_VERSION)}] = ${JSON.stringify(LATEST_PROTOCOL_VERSION)}.`,
            { supported: [...SUPPORTED_PROTOCOL_VERSIONS] },
          ),
          'error',
          { code: RPC_METHOD_NOT_FOUND },
        );
      }

      // 3.
      const meta = readMeta(params);
      if ('error' in meta) {
        return finish(errorResponse(id, RPC_INVALID_PARAMS, meta.error), 'error', { code: RPC_INVALID_PARAMS });
      }

      // 4.
      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(meta.protocolVersion)) {
        return finish(
          errorResponse(id, MCP_UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
            supported: [...SUPPORTED_PROTOCOL_VERSIONS],
            requested: meta.protocolVersion,
          }),
          'error',
          { code: MCP_UNSUPPORTED_PROTOCOL_VERSION, meta },
        );
      }

      // 5. The gate. Deliberately minimal and identical for "no credential"
      //    and "wrong credential": src/api/auth.ts's reasoning applies
      //    unchanged -- a response that distinguishes them is an oracle.
      if (!PUBLIC_METHODS.has(method) && !isAuthorized(meta.token, deps.token)) {
        return finish(errorResponse(id, WF_UNAUTHORIZED, 'unauthorized'), 'unauthorized', {
          code: WF_UNAUTHORIZED,
          meta,
        });
      }

      // 6.
      try {
        if (method === METHOD_DISCOVER) {
          return finish(discover(id), 'ok', { meta });
        }
        if (method === METHOD_TOOLS_LIST) {
          const tools = deps.registry.list();
          return finish(ok(id, { tools }), 'ok', { rows: tools.length, meta });
        }
        if (method === METHOD_TOOLS_CALL) {
          const called = await callTool(id, params, now);
          return finish(called.response, called.outcome, {
            tool: called.tool,
            ...(called.code === undefined ? {} : { code: called.code }),
            ...(called.rows === undefined ? {} : { rows: called.rows }),
            ...(called.args === undefined ? {} : { args: called.args }),
            meta,
          });
        }
        return finish(errorResponse(id, RPC_METHOD_NOT_FOUND, `unknown method: ${method}`), 'error', {
          code: RPC_METHOD_NOT_FOUND,
          meta,
        });
      } catch (cause) {
        // A §8.2 violation, from either layer. `refused` rather than `error`
        // in the log, because an operator scanning for "did the boundary
        // hold" should not have to distinguish it from a bad argument.
        if (cause instanceof ForbiddenFieldError) {
          return finish(errorResponse(id, WF_FORBIDDEN_FIELD, cause.message), 'refused', {
            code: WF_FORBIDDEN_FIELD,
            tool: typeof params.name === 'string' ? params.name : null,
            meta,
          });
        }
        if (cause instanceof SqlRefusedError && cause.reason === 'forbidden_identifier') {
          return finish(errorResponse(id, WF_FORBIDDEN_FIELD, cause.message), 'refused', {
            code: WF_FORBIDDEN_FIELD,
            tool: typeof params.name === 'string' ? params.name : null,
            meta,
          });
        }
        // Everything else is our bug. The message goes out because both ends
        // of this connection are the owner's own processes, and a bot that is
        // told "internal error" and nothing else cannot report anything
        // useful. Values never reach here: SqlRefusedError and
        // UnserializableValueError both carry a path or a statement, not a row.
        const detail = cause instanceof SqlRefusedError || cause instanceof UnserializableValueError
          ? cause.message
          : `internal error: ${(cause as Error).message}`;
        return finish(errorResponse(id, RPC_INTERNAL_ERROR, detail), 'error', {
          code: RPC_INTERNAL_ERROR,
          tool: typeof params.name === 'string' ? params.name : null,
          meta,
        });
      }
    },
  };
}
