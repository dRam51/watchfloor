/**
 * §8.2 asks for query logging explicitly (M5 task 10). What it does not say is
 * *what* to log, and that turns out to be the interesting half.
 *
 * The choice made here: **argument NAMES and a digest of the values, never the
 * values.** The reasoning, and the residual, are in src/mcp/log.ts's header.
 * This file pins it, including the two things that must never appear in a log
 * line under any setting: the credential, and anything from `_meta`.
 */

import { describe, it, expect } from 'vitest';
import { createQueryLog, digestArguments, redactMeta } from '../../src/mcp/log.ts';
import { MCP_TOKEN_META_KEY } from '../../src/mcp/auth.ts';

const TOKEN = 'bot-token-value-000000002';

function capture(includeArguments = false) {
  const lines: string[] = [];
  const log = createQueryLog({ write: (line) => lines.push(line), includeArguments });
  return { lines, log, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('createQueryLog', () => {
  it('writes one line per record', () => {
    const { lines, log } = capture();
    log.record({ at: '2026-08-16T00:00:00.000Z', id: 1, method: 'tools/list', tool: null, outcome: 'ok', durationMs: 3 });
    log.record({ at: '2026-08-16T00:00:01.000Z', id: 2, method: 'tools/call', tool: 'get_items_for_entity', outcome: 'ok', durationMs: 12 });
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.includes('\n')).toBe(false);
  });

  it('records the facts an operator needs', () => {
    const { log, parsed } = capture();
    log.record({
      at: '2026-08-16T00:00:00.000Z',
      id: 7,
      method: 'tools/call',
      tool: 'get_source_health',
      outcome: 'ok',
      durationMs: 41,
      resultRows: 28,
      clientName: 'ExampleBot',
      protocolVersion: '2026-07-28',
    });
    expect(parsed()[0]).toMatchObject({
      at: '2026-08-16T00:00:00.000Z',
      id: 7,
      method: 'tools/call',
      tool: 'get_source_health',
      outcome: 'ok',
      durationMs: 41,
      resultRows: 28,
      clientName: 'ExampleBot',
      protocolVersion: '2026-07-28',
    });
  });

  it('records an error outcome with its code', () => {
    const { log, parsed } = capture();
    log.record({ at: '2026-08-16T00:00:00.000Z', id: 1, method: 'tools/call', tool: 'x', outcome: 'error', code: -32602, durationMs: 1 });
    expect(parsed()[0]).toMatchObject({ outcome: 'error', code: -32602 });
  });
});

describe('what a log line says about the bot arguments', () => {
  const args = { entity: 'Cl0p', asOf: '2026-08-01T00:00:00.000Z', limit: 20 };

  it('records the argument NAMES, sorted', () => {
    const { log, parsed } = capture();
    log.record({ at: '2026-08-16T00:00:00.000Z', id: 1, method: 'tools/call', tool: 't', outcome: 'ok', durationMs: 1, args });
    expect(parsed()[0]!.argKeys).toEqual(['asOf', 'entity', 'limit']);
  });

  // The strategy question, decided: an argument value is what the bot is
  // watching and when it is backtesting. The names answer every operational
  // question ("what did it call, how often, did it fail"); the values answer
  // "what is it trading", which this process has no business accumulating.
  it('does NOT record the argument values by default', () => {
    const { lines, log } = capture();
    log.record({ at: '2026-08-16T00:00:00.000Z', id: 1, method: 'tools/call', tool: 't', outcome: 'ok', durationMs: 1, args });
    expect(lines[0]).not.toContain('Cl0p');
    expect(lines[0]).not.toContain('2026-08-01');
  });

  it('records a digest instead, so repeats are still countable', () => {
    const { log, parsed } = capture();
    log.record({ at: '2026-08-16T00:00:00.000Z', id: 1, method: 'tools/call', tool: 't', outcome: 'ok', durationMs: 1, args });
    log.record({ at: '2026-08-16T00:00:01.000Z', id: 2, method: 'tools/call', tool: 't', outcome: 'ok', durationMs: 1, args: { ...args } });
    const [first, second] = parsed();
    expect(first!.argDigest).toBe(second!.argDigest);
    expect(String(first!.argDigest)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('gives a different digest for different arguments', () => {
    expect(digestArguments({ entity: 'Cl0p' })).not.toBe(digestArguments({ entity: 'LockBit' }));
  });

  it('is insensitive to key order, so the same query digests the same either way', () => {
    expect(digestArguments({ a: 1, b: 2 })).toBe(digestArguments({ b: 2, a: 1 }));
    expect(digestArguments({ outer: { a: 1, b: 2 } })).toBe(digestArguments({ outer: { b: 2, a: 1 } }));
  });

  it('distinguishes an absent argument from a null one', () => {
    expect(digestArguments({ asOf: null })).not.toBe(digestArguments({}));
  });

  it('logs the values when the operator explicitly opts in', () => {
    const { lines, log } = capture(true);
    log.record({ at: '2026-08-16T00:00:00.000Z', id: 1, method: 'tools/call', tool: 't', outcome: 'ok', durationMs: 1, args });
    expect(lines[0]).toContain('Cl0p');
  });
});

describe('what can never reach a log line', () => {
  it('strips _meta even in the opted-in verbose mode — the credential lives there', () => {
    const { lines, log } = capture(true);
    log.record({
      at: '2026-08-16T00:00:00.000Z',
      id: 1,
      method: 'tools/call',
      tool: 't',
      outcome: 'ok',
      durationMs: 1,
      args: { entity: 'Cl0p', _meta: { [MCP_TOKEN_META_KEY]: TOKEN } },
    });
    expect(lines[0]).not.toContain(TOKEN);
    expect(lines[0]).toContain('Cl0p');
  });

  it('strips a nested _meta too', () => {
    const stripped = redactMeta({ a: { b: { _meta: { [MCP_TOKEN_META_KEY]: TOKEN } }, c: 1 } });
    expect(JSON.stringify(stripped)).not.toContain(TOKEN);
    expect(stripped).toEqual({ a: { b: {}, c: 1 } });
  });

  it('keeps _meta out of argKeys and out of the digest input', () => {
    const { log, parsed } = capture();
    log.record({
      at: '2026-08-16T00:00:00.000Z',
      id: 1,
      method: 'tools/call',
      tool: 't',
      outcome: 'ok',
      durationMs: 1,
      args: { entity: 'Cl0p', _meta: { [MCP_TOKEN_META_KEY]: TOKEN } },
    });
    expect(parsed()[0]!.argKeys).toEqual(['entity']);
    expect(parsed()[0]!.argDigest).toBe(digestArguments({ entity: 'Cl0p' }));
  });

  it('digests _meta out too, so two calls differing only in credential are one query', () => {
    expect(digestArguments({ q: 1, _meta: { [MCP_TOKEN_META_KEY]: TOKEN } })).toBe(
      digestArguments({ q: 1 }),
    );
  });
});
