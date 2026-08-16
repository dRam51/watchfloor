/**
 * The stdio transport (M5 task 10), over real streams.
 *
 * The binding's rules are short and this file is mostly them:
 *
 * > *"Messages are delimited by newlines, and **MUST NOT** contain embedded
 * > newlines."*
 * > *"The server **MUST NOT** write anything to its `stdout` that is not a
 * > valid MCP message."*
 * > *"Servers **SHOULD** exit promptly when their standard input is closed."*
 */

import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { openReadOnlyCorpus, type ReadOnlyCorpus } from '../../src/mcp/readonly.ts';
import { createQueryLog } from '../../src/mcp/log.ts';
import { defineTool, ToolRegistry, type McpTool } from '../../src/mcp/registry.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { serveStdio } from '../../src/mcp/stdio.ts';
import { authedRequest, request, seedCorpus, TEST_MCP_TOKEN } from './fixture.ts';

const corpora: ReadOnlyCorpus[] = [];
afterEach(() => {
  while (corpora.length) corpora.pop()!.close();
});

/** A tool whose answer contains newlines, which is what makes framing a real question. */
const echoTitles = defineTool({
  name: 'echo_titles',
  description: 'Returns titles with hard newlines in them.',
  inputSchema: z.object({}),
  run: () => ({ structured: { note: 'line one\nline two\r\nline three' } }),
}) as unknown as McpTool<never>;

function transport() {
  const corpus = openReadOnlyCorpus(seedCorpus());
  corpora.push(corpus);
  const registry = new ToolRegistry();
  registry.register(echoTitles);
  const server = createMcpServer({
    corpus,
    token: TEST_MCP_TOKEN,
    registry,
    log: createQueryLog({ write: () => {} }),
    now: () => '2026-08-16T00:00:00.000Z',
  });

  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));

  const done = serveStdio({ input, output, server });
  return { input, output, written, done, lines: () => written.join('').split('\n').filter((l) => l.length > 0) };
}

describe('serveStdio', () => {
  it('answers one line per request', async () => {
    const t = transport();
    t.input.write(`${authedRequest('tools/list')}\n`);
    t.input.write(`${authedRequest('server/discover', { id: 2 })}\n`);
    t.input.end();
    await t.done;

    expect(t.lines()).toHaveLength(2);
    expect(t.lines().map((l) => JSON.parse(l).id)).toEqual([1, 2]);
  });

  it('keeps a newline-laden payload on ONE line', async () => {
    const t = transport();
    t.input.write(`${authedRequest('tools/call', { params: { name: 'echo_titles', arguments: {} } })}\n`);
    t.input.end();
    await t.done;

    expect(t.lines()).toHaveLength(1);
    const parsed = JSON.parse(t.lines()[0]!);
    expect(parsed.result.structuredContent.note).toBe('line one\nline two\r\nline three');
  });

  it('handles a request split across two chunks', async () => {
    const t = transport();
    const line = authedRequest('tools/list');
    t.input.write(line.slice(0, 20));
    t.input.write(line.slice(20));
    t.input.write('\n');
    t.input.end();
    await t.done;
    expect(t.lines()).toHaveLength(1);
  });

  it('handles two requests arriving in one chunk', async () => {
    const t = transport();
    t.input.write(`${authedRequest('tools/list')}\n${authedRequest('server/discover', { id: 2 })}\n`);
    t.input.end();
    await t.done;
    expect(t.lines()).toHaveLength(2);
  });

  it('tolerates CRLF, which a Windows-side client may send', async () => {
    const t = transport();
    t.input.write(`${authedRequest('tools/list')}\r\n`);
    t.input.end();
    await t.done;
    expect(JSON.parse(t.lines()[0]!).error).toBeUndefined();
  });

  it('ignores blank lines rather than answering them with a parse error', async () => {
    const t = transport();
    t.input.write(`\n   \n${authedRequest('tools/list')}\n\n`);
    t.input.end();
    await t.done;
    expect(t.lines()).toHaveLength(1);
  });

  it('writes nothing at all for a notification', async () => {
    const t = transport();
    t.input.write('{"jsonrpc":"2.0","method":"notifications/cancelled"}\n');
    t.input.end();
    await t.done;
    expect(t.written.join('')).toBe('');
  });

  it('answers a malformed line and keeps reading the next one', async () => {
    const t = transport();
    t.input.write(`{not json\n${authedRequest('tools/list', { id: 9 })}\n`);
    t.input.end();
    await t.done;

    const [bad, good] = t.lines().map((l) => JSON.parse(l));
    expect(bad.error.code).toBe(-32700);
    expect(good.id).toBe(9);
  });

  it('resolves when the input stream ends — the graceful-shutdown signal', async () => {
    const t = transport();
    t.input.end();
    await expect(t.done).resolves.toBeUndefined();
  });

  it('answers a trailing line with no terminator, rather than swallowing it', async () => {
    const t = transport();
    t.input.end(authedRequest('tools/list'));
    await t.done;
    expect(t.lines()).toHaveLength(1);
  });

  function cappedTransport(maxLineBytes: number) {
    const corpus = openReadOnlyCorpus(seedCorpus());
    corpora.push(corpus);
    const server = createMcpServer({
      corpus,
      token: TEST_MCP_TOKEN,
      registry: new ToolRegistry(),
      log: createQueryLog({ write: () => {} }),
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
    const done = serveStdio({ input, output, server, maxLineBytes });
    return { input, done, lines: () => chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
  }

  // Two distinct paths, and the first draft only closed the second: an
  // oversized line that ARRIVES COMPLETE was split off before the buffer check
  // ever ran, so it reached the dispatcher and came back as a parse error
  // rather than a refusal.
  it('refuses an oversized line that arrives complete, and keeps serving', async () => {
    const t = cappedTransport(1024);
    t.input.write(`${'x'.repeat(4000)}\n`);
    t.input.write(`${authedRequest('tools/list', { id: 5 })}\n`);
    t.input.end();
    await t.done;

    expect(t.lines()[0].error.code).toBe(-32600);
    expect(t.lines()[0].error.message).toMatch(/too long/);
    expect(t.lines()[1].id).toBe(5);
  });

  it('refuses an unterminated flood instead of buffering it forever', async () => {
    const t = cappedTransport(1024);
    t.input.write('x'.repeat(4000)); // no newline: the hang case
    t.input.write(`\n${authedRequest('tools/list', { id: 5 })}\n`);
    t.input.end();
    await t.done;

    expect(t.lines()[0].error.message).toMatch(/too long/);
    expect(t.lines().at(-1).id).toBe(5);
  });

  it('every byte it writes to output is a JSON-RPC message', async () => {
    const t = transport();
    t.input.write(`${authedRequest('tools/list')}\n`);
    t.input.write(`${request('tools/list', { id: 2, token: null })}\n`);
    t.input.write('{not json\n');
    t.input.end();
    await t.done;

    for (const line of t.lines()) {
      expect(JSON.parse(line).jsonrpc).toBe('2.0');
    }
  });
});
