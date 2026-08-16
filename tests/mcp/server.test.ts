/**
 * The dispatcher (M5 task 10) — where the credential is checked, where the
 * §8.2 serializer runs, and where every query is logged.
 *
 * The two suites that matter most are at the bottom:
 *
 * - **"default protection"** registers a tool the auth code has never heard of
 *   and proves it is unreachable without the credential, and that its `run`
 *   never executes. That is the same property src/api/auth.ts's root-instance
 *   hook has, and the same test shape M3 task 1 used to pin it.
 * - **"the leaking tool"** is the mutation the task brief asks for: a tool that
 *   genuinely tries to return `read_score`, registered against the real
 *   dispatcher, refused by the real guard.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { openReadOnlyCorpus, type ReadOnlyCorpus } from '../../src/mcp/readonly.ts';
import { createQueryLog } from '../../src/mcp/log.ts';
import { defineTool, ToolRegistry, type McpTool } from '../../src/mcp/registry.ts';
import { createMcpServer, type McpServer } from '../../src/mcp/server.ts';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '../../src/mcp/protocol.ts';
import { WF_UNAUTHORIZED, WF_FORBIDDEN_FIELD, MCP_UNSUPPORTED_PROTOCOL_VERSION } from '../../src/mcp/jsonrpc.ts';
import { authedRequest, decode, request, seedCorpus, TEST_MCP_TOKEN } from './fixture.ts';

const corpora: ReadOnlyCorpus[] = [];
afterEach(() => {
  while (corpora.length) corpora.pop()!.close();
});

interface Harness {
  server: McpServer;
  logLines: string[];
  logged: () => Array<Record<string, unknown>>;
}

function harness(tools: Array<McpTool<never>> = []): Harness {
  const corpus = openReadOnlyCorpus(seedCorpus());
  corpora.push(corpus);
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  const logLines: string[] = [];
  const server = createMcpServer({
    corpus,
    token: TEST_MCP_TOKEN,
    registry,
    log: createQueryLog({ write: (line) => logLines.push(line) }),
    now: () => '2026-08-16T00:00:00.000Z',
  });
  return { server, logLines, logged: () => logLines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

/** A real tool that reads the real corpus through the real read-only handle. */
const countItems = defineTool({
  name: 'count_items',
  description: 'How many items the corpus holds.',
  inputSchema: z.object({ sourceId: z.string().optional() }),
  run: (args: { sourceId?: string }, ctx) => {
    const row = args.sourceId
      ? ctx.corpus.get('select count(*) as n from items where source_id = ?', args.sourceId)
      : ctx.corpus.get('select count(*) as n from items');
    // `Number(...)` rather than `row?.n ?? 0`: a corpus row's values are
    // `unknown`, and `McpToolResult.structured` is typed `JsonValue`, so the
    // compiler makes a tool convert rather than assume. That is the type doing
    // real work -- it caught this line in `npm run typecheck`.
    return { structured: { count: Number(row?.n ?? 0), asOf: ctx.now } };
  },
}) as unknown as McpTool<never>;

describe('server/discover', () => {
  it('answers with supported versions, capabilities and identity', async () => {
    const { server } = harness();
    const res = decode(await server.handle(request('server/discover')));
    expect(res.result).toMatchObject({
      resultType: 'complete',
      supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      capabilities: { tools: { listChanged: false } },
    });
    expect((res.result?._meta as Record<string, unknown>)['io.modelcontextprotocol/serverInfo']).toMatchObject({
      name: 'watchfloor',
    });
  });

  it('is reachable WITHOUT the credential — the analogue of /health being public', async () => {
    const { server } = harness();
    const res = decode(await server.handle(request('server/discover', { token: null })));
    expect(res.error).toBeUndefined();
  });

  it('carries instructions that state the boundary', async () => {
    const { server } = harness();
    const res = decode(await server.handle(request('server/discover')));
    expect(String(res.result?.instructions)).toMatch(/read-only/i);
  });
});

describe('protocol version negotiation', () => {
  it('refuses an unsupported version with the specification code and the supported list', async () => {
    const { server } = harness();
    const res = decode(await server.handle(request('tools/list', { protocolVersion: '1900-01-01' })));
    expect(res.error?.code).toBe(MCP_UNSUPPORTED_PROTOCOL_VERSION);
    expect(res.error?.data).toEqual({ supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: '1900-01-01' });
  });

  it('refuses a request with no _meta at all — the required fields are required', async () => {
    const { server } = harness();
    const res = decode(await server.handle(request('tools/list', { omitMeta: true })));
    expect(res.error?.code).toBe(-32602);
  });

  it('refuses a request missing clientCapabilities specifically', async () => {
    const { server } = harness();
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': LATEST_PROTOCOL_VERSION } },
    });
    const res = decode(await server.handle(line));
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toMatch(/clientCapabilities/);
  });

  // The spec's one instruction for a modern-only server meeting a legacy
  // client: "A server that supports only modern versions SHOULD name the
  // protocol versions it supports in any error it returns to an `initialize`
  // request: legacy clients have no fall-forward mechanism, and this message
  // may be the only diagnostic they can surface to users."
  it('answers a legacy initialize with a diagnostic naming the supported versions', async () => {
    const { server } = harness();
    const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    const res = decode(await server.handle(line));
    expect(res.error).toBeDefined();
    expect(res.error?.message).toContain(LATEST_PROTOCOL_VERSION);
    expect(res.error?.data).toMatchObject({ supported: [...SUPPORTED_PROTOCOL_VERSIONS] });
  });
});

describe('tools/list and tools/call', () => {
  it('lists the registered tool with its schema', async () => {
    const { server } = harness([countItems]);
    const res = decode(await server.handle(authedRequest('tools/list')));
    expect(res.result?.tools).toEqual([
      {
        name: 'count_items',
        description: 'How many items the corpus holds.',
        inputSchema: {
          type: 'object',
          properties: { sourceId: { type: 'string' } },
          additionalProperties: false,
        },
      },
    ]);
  });

  it('calls a tool against the real corpus', async () => {
    const { server } = harness([countItems]);
    const res = decode(
      await server.handle(authedRequest('tools/call', { params: { name: 'count_items', arguments: {} } })),
    );
    expect(res.result?.structuredContent).toEqual({ count: 2, asOf: '2026-08-16T00:00:00.000Z' });
    expect(res.result?.isError).toBe(false);
  });

  it('passes arguments through', async () => {
    const { server } = harness([countItems]);
    const res = decode(
      await server.handle(
        authedRequest('tools/call', { params: { name: 'count_items', arguments: { sourceId: 'cisa-kev' } } }),
      ),
    );
    expect(res.result?.structuredContent).toMatchObject({ count: 1 });
  });

  it('also returns the payload as text, for backwards compatibility', async () => {
    const { server } = harness([countItems]);
    const res = decode(await server.handle(authedRequest('tools/call', { params: { name: 'count_items', arguments: {} } })));
    const content = res.result?.content as Array<{ type: string; text: string }>;
    expect(content[0]!.type).toBe('text');
    expect(JSON.parse(content[0]!.text)).toEqual({ count: 2, asOf: '2026-08-16T00:00:00.000Z' });
  });

  it('reports an unknown tool as a protocol error', async () => {
    const { server } = harness([countItems]);
    const res = decode(await server.handle(authedRequest('tools/call', { params: { name: 'nope', arguments: {} } })));
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain('nope');
  });

  // The spec puts input validation on the tool-execution side: those errors
  // "contain actionable feedback that language models can use to self-correct
  // and retry with adjusted parameters".
  it('reports bad arguments as a tool EXECUTION error, so the model can retry', async () => {
    const { server } = harness([countItems]);
    const res = decode(
      await server.handle(authedRequest('tools/call', { params: { name: 'count_items', arguments: { sourceId: 42 } } })),
    );
    expect(res.error).toBeUndefined();
    expect(res.result?.isError).toBe(true);
    expect(String((res.result?.content as Array<{ text: string }>)[0]!.text)).toMatch(/sourceId/);
  });

  it('refuses an argument the schema did not declare, rather than ignoring it', async () => {
    const { server } = harness([countItems]);
    const res = decode(
      await server.handle(
        authedRequest('tools/call', { params: { name: 'count_items', arguments: { sourceId: 'x', beat: 'cyber' } } }),
      ),
    );
    expect(res.result?.isError).toBe(true);
  });

  it('reports an unknown METHOD as method-not-found', async () => {
    const { server } = harness();
    const res = decode(await server.handle(authedRequest('resources/list')));
    expect(res.error?.code).toBe(-32601);
  });

  it('returns nothing at all for a notification', async () => {
    const { server } = harness();
    expect(await server.handle('{"jsonrpc":"2.0","method":"notifications/cancelled"}')).toBeNull();
  });

  it('answers a malformed line with a parse error rather than crashing', async () => {
    const { server } = harness();
    const res = decode(await server.handle('{not json'));
    expect(res.error?.code).toBe(-32700);
    expect(res.id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Default protection
// ---------------------------------------------------------------------------
describe('default protection', () => {
  it('refuses tools/list without the credential', async () => {
    const { server } = harness([countItems]);
    const res = decode(await server.handle(request('tools/list', { token: null })));
    expect(res.error?.code).toBe(WF_UNAUTHORIZED);
  });

  it('refuses a wrong credential identically to a missing one', async () => {
    const { server } = harness([countItems]);
    const missing = decode(await server.handle(request('tools/list', { token: null })));
    const wrong = decode(await server.handle(request('tools/list', { token: 'not-the-right-token-x' })));
    expect(wrong.error).toEqual(missing.error);
  });

  // The property, not an instance of it: a tool the dispatcher has never heard
  // of is protected because protection lives at the boundary, not in the tool.
  it('protects a brand-new tool nobody wired anything for, and never runs it', async () => {
    let ran = 0;
    const newcomer = defineTool({
      name: 'a_tool_added_later',
      description: 'Registered by a future task that did nothing auth-related.',
      inputSchema: z.object({}),
      run: () => {
        ran += 1;
        return { structured: { ok: true } };
      },
    }) as unknown as McpTool<never>;

    const { server } = harness([newcomer]);
    const res = decode(
      await server.handle(request('tools/call', { token: null, params: { name: 'a_tool_added_later', arguments: {} } })),
    );
    expect(res.error?.code).toBe(WF_UNAUTHORIZED);
    expect(ran).toBe(0);
  });

  it('never echoes the credential back, on success or failure', async () => {
    const { server, logLines } = harness([countItems]);
    const good = await server.handle(authedRequest('tools/call', { params: { name: 'count_items', arguments: {} } }));
    const bad = await server.handle(request('tools/list', { token: 'not-the-right-token-x' }));
    for (const line of [good, bad, ...logLines]) {
      expect(String(line)).not.toContain(TEST_MCP_TOKEN);
      expect(String(line)).not.toContain('not-the-right-token-x');
    }
  });
});

// ---------------------------------------------------------------------------
// The mutation the brief asks for
// ---------------------------------------------------------------------------
describe('the leaking tool', () => {
  // Named `mutation_probe` and not `leak_read_score` because the FIRST draft
  // was called `leak_read_score` and the registry refused to register it --
  // `forbiddenPhraseFor` matched the tool's own name (§8.2's rule applies to
  // the tool's shape, not only its output). The second layer fired before the
  // third could be tested. Renamed so this suite exercises the serializer
  // specifically; tests/mcp/registry.test.ts covers the name rule.
  /** A tool that genuinely tries to hand the bot `read_score`. */
  const leaky = defineTool({
    name: 'mutation_probe',
    description: 'Deliberately returns the one field §8.2 forbids.',
    inputSchema: z.object({}),
    run: () => ({ structured: { items: [{ itemKey: 'aaa', signalScore: 4.5, readScore: 9.25 }] } }),
  }) as unknown as McpTool<never>;

  it('is refused by the dispatcher, not by the tool remembering', async () => {
    const { server } = harness([leaky]);
    const res = decode(await server.handle(authedRequest('tools/call', { params: { name: 'mutation_probe', arguments: {} } })));
    expect(res.error?.code).toBe(WF_FORBIDDEN_FIELD);
    expect(res.error?.message).toContain('readScore');
  });

  it('does not leak the VALUE in the refusal', async () => {
    const { server } = harness([leaky]);
    const line = await server.handle(authedRequest('tools/call', { params: { name: 'mutation_probe', arguments: {} } }));
    expect(String(line)).not.toContain('9.25');
  });

  it('is refused even under a snake_case spelling', async () => {
    const snake = defineTool({
      name: 'leak_snake',
      description: 'Same leak, different spelling.',
      inputSchema: z.object({}),
      run: () => ({ structured: { read_score: 9.25 } }),
    }) as unknown as McpTool<never>;
    const { server } = harness([snake]);
    const res = decode(await server.handle(authedRequest('tools/call', { params: { name: 'leak_snake', arguments: {} } })));
    expect(res.error?.code).toBe(WF_FORBIDDEN_FIELD);
  });

  it('is refused at the DATA plane too, when the tool asks SQL for it', async () => {
    const sqlLeak = defineTool({
      name: 'leak_via_sql',
      description: 'Asks the database directly.',
      inputSchema: z.object({}),
      run: (_args: unknown, ctx) => ({ structured: { rows: ctx.corpus.all('select read_score from item_scores') as never } }),
    }) as unknown as McpTool<never>;
    const { server } = harness([sqlLeak]);
    const res = decode(await server.handle(authedRequest('tools/call', { params: { name: 'leak_via_sql', arguments: {} } })));
    expect(res.error?.code).toBe(WF_FORBIDDEN_FIELD);
    expect(res.error?.message).toMatch(/read_score/);
  });

  it('is refused when the tool reaches for `select *` to smuggle it', async () => {
    const starLeak = defineTool({
      name: 'leak_via_star',
      description: 'Never names the column.',
      inputSchema: z.object({}),
      run: (_args: unknown, ctx) => ({ structured: { rows: ctx.corpus.all('select * from item_scores') as never } }),
    }) as unknown as McpTool<never>;
    const { server } = harness([starLeak]);
    const res = decode(await server.handle(authedRequest('tools/call', { params: { name: 'leak_via_star', arguments: {} } })));
    expect(res.error).toBeDefined();
    expect(String(res.error?.message)).toMatch(/star_result_column/);
  });
});

describe('query logging through the dispatcher', () => {
  it('logs one line per request', async () => {
    const { server, logged } = harness([countItems]);
    await server.handle(authedRequest('tools/list'));
    await server.handle(authedRequest('tools/call', { id: 2, params: { name: 'count_items', arguments: { sourceId: 'cisa-kev' } } }));
    expect(logged()).toHaveLength(2);
    expect(logged()[1]).toMatchObject({ method: 'tools/call', tool: 'count_items', outcome: 'ok', argKeys: ['sourceId'] });
  });

  it('logs the client name and protocol version it was told', async () => {
    const { server, logged } = harness([countItems]);
    await server.handle(authedRequest('tools/list', { clientName: 'BacktestRunner' }));
    expect(logged()[0]).toMatchObject({ clientName: 'BacktestRunner', protocolVersion: LATEST_PROTOCOL_VERSION });
  });

  it('logs an unauthorized attempt — the one an operator most needs to see', async () => {
    const { server, logged } = harness([countItems]);
    await server.handle(request('tools/list', { token: null }));
    expect(logged()[0]).toMatchObject({ method: 'tools/list', outcome: 'unauthorized', code: WF_UNAUTHORIZED });
  });

  // Found by reading a real session's stderr rather than by an assertion: the
  // `unauthorized` and `initialize` lines carried `code`, and the unknown-tool
  // line did not. An operator filtering the log by error code would have had a
  // silent gap in it.
  it('logs a code on EVERY non-ok outcome, including a tools/call error', async () => {
    const { server, logged } = harness([countItems]);
    await server.handle(authedRequest('tools/call', { params: { name: 'nope', arguments: {} } }));
    await server.handle(authedRequest('tools/call', { id: 2, params: { name: 'count_items', arguments: { sourceId: 42 } } }));
    for (const entry of logged()) {
      expect(entry.outcome, JSON.stringify(entry)).not.toBe('ok');
      expect(entry.code, JSON.stringify(entry)).toBe(-32602);
    }
  });

  it('logs a refused leak as `refused`, not as a generic error', async () => {
    const leaky = defineTool({
      name: 'leaky',
      description: 'leaks',
      inputSchema: z.object({}),
      run: () => ({ structured: { readScore: 1 } }),
    }) as unknown as McpTool<never>;
    const { server, logged } = harness([leaky]);
    await server.handle(authedRequest('tools/call', { params: { name: 'leaky', arguments: {} } }));
    expect(logged()[0]).toMatchObject({ outcome: 'refused', code: WF_FORBIDDEN_FIELD });
  });

  it('does not log the argument values', async () => {
    const { server, logLines } = harness([countItems]);
    await server.handle(authedRequest('tools/call', { params: { name: 'count_items', arguments: { sourceId: 'cisa-kev' } } }));
    expect(logLines[0]).not.toContain('cisa-kev');
    expect(logLines[0]).toContain('argDigest');
  });
});
