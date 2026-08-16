/**
 * JSON-RPC 2.0 framing for the stdio transport (M5 task 10).
 *
 * The MCP stdio binding is emphatic about the two rules this file pins:
 *
 * > *"Messages are delimited by newlines, and **MUST NOT** contain embedded
 * > newlines."*
 * > *"The server **MUST NOT** write anything to its `stdout` that is not a
 * > valid MCP message."*
 *
 * Both are easy to break by accident with a corpus whose summaries contain
 * newlines, so both are asserted rather than assumed.
 */

import { describe, it, expect } from 'vitest';
import {
  parseMessage,
  encodeMessage,
  errorResponse,
  resultResponse,
  RPC_PARSE_ERROR,
  RPC_INVALID_REQUEST,
  WF_UNAUTHORIZED,
  WF_FORBIDDEN_FIELD,
  MCP_UNSUPPORTED_PROTOCOL_VERSION,
} from '../../src/mcp/jsonrpc.ts';

describe('parseMessage', () => {
  it('reads a request', () => {
    const parsed = parseMessage('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}');
    expect(parsed.kind).toBe('request');
    if (parsed.kind !== 'request') throw new Error('unreachable');
    expect(parsed.request.id).toBe(1);
    expect(parsed.request.method).toBe('tools/list');
  });

  it('reads a string id, which JSON-RPC allows', () => {
    const parsed = parseMessage('{"jsonrpc":"2.0","id":"discover-1","method":"server/discover"}');
    expect(parsed.kind).toBe('request');
    if (parsed.kind !== 'request') throw new Error('unreachable');
    expect(parsed.request.id).toBe('discover-1');
  });

  it('reads a notification as a notification, not a request with a missing id', () => {
    const parsed = parseMessage('{"jsonrpc":"2.0","method":"notifications/cancelled"}');
    expect(parsed.kind).toBe('notification');
  });

  it('reports malformed JSON as a parse error with a null id', () => {
    const parsed = parseMessage('{not json');
    expect(parsed).toMatchObject({ kind: 'invalid', id: null, code: RPC_PARSE_ERROR });
  });

  it('refuses a null id, which base JSON-RPC allows and MCP does not', () => {
    const parsed = parseMessage('{"jsonrpc":"2.0","id":null,"method":"tools/list"}');
    expect(parsed).toMatchObject({ kind: 'invalid', code: RPC_INVALID_REQUEST });
  });

  it('refuses a batch — MCP removed batching before this revision', () => {
    const parsed = parseMessage('[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]');
    expect(parsed).toMatchObject({ kind: 'invalid', id: null, code: RPC_INVALID_REQUEST });
  });

  it('refuses a wrong jsonrpc version', () => {
    const parsed = parseMessage('{"jsonrpc":"1.0","id":1,"method":"tools/list"}');
    expect(parsed).toMatchObject({ kind: 'invalid', code: RPC_INVALID_REQUEST });
  });

  it('refuses a missing method', () => {
    const parsed = parseMessage('{"jsonrpc":"2.0","id":1}');
    expect(parsed).toMatchObject({ kind: 'invalid', code: RPC_INVALID_REQUEST });
  });

  it('keeps the id on an otherwise-invalid request so the client can correlate the error', () => {
    const parsed = parseMessage('{"jsonrpc":"2.0","id":7,"method":123}');
    expect(parsed).toMatchObject({ kind: 'invalid', id: 7, code: RPC_INVALID_REQUEST });
  });

  it('refuses a response — the client MUST NOT write responses to our stdin', () => {
    const parsed = parseMessage('{"jsonrpc":"2.0","id":1,"result":{}}');
    expect(parsed).toMatchObject({ kind: 'invalid', code: RPC_INVALID_REQUEST });
  });
});

describe('encodeMessage', () => {
  it('emits exactly one line for a payload full of newlines', () => {
    const line = encodeMessage(
      resultResponse(1, { text: 'first line\nsecond line\r\nthird' }),
    );
    expect(line.includes('\n')).toBe(false);
    expect(line.includes('\r')).toBe(false);
    expect(JSON.parse(line).result.text).toBe('first line\nsecond line\r\nthird');
  });

  it('round-trips a unicode payload', () => {
    const line = encodeMessage(resultResponse('x', { text: 'Świątek vence a Rybakina — 🛰' }));
    expect(JSON.parse(line).result.text).toBe('Świątek vence a Rybakina — 🛰');
  });
});

describe('resultResponse', () => {
  it('stamps resultType, which the 2026-07-28 revision requires on every result', () => {
    expect(resultResponse(1, { tools: [] })).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { resultType: 'complete', tools: [] },
    });
  });
});

describe('error codes', () => {
  it('builds an error response', () => {
    expect(errorResponse(3, RPC_PARSE_ERROR, 'nope')).toEqual({
      jsonrpc: '2.0',
      id: 3,
      error: { code: RPC_PARSE_ERROR, message: 'nope' },
    });
  });

  it('carries data when given', () => {
    const res = errorResponse(3, MCP_UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
      supported: ['2026-07-28'],
      requested: '1900-01-01',
    });
    expect(res.error.data).toEqual({ supported: ['2026-07-28'], requested: '1900-01-01' });
  });

  // The 2026-07-28 spec partitions the JSON-RPC implementation-defined range:
  // -32000..-32019 is legacy and MUST NOT be used by new implementations,
  // -32020..-32099 is reserved for the specification itself, and new
  // application codes SHOULD be allocated OUTSIDE -32768..-32000 entirely.
  it('allocates Watchfloor codes outside the JSON-RPC reserved range', () => {
    for (const code of [WF_UNAUTHORIZED, WF_FORBIDDEN_FIELD]) {
      expect(code, String(code)).toBeGreaterThan(-32000);
    }
  });

  it('uses the specification code for an unsupported protocol version', () => {
    expect(MCP_UNSUPPORTED_PROTOCOL_VERSION).toBe(-32022);
  });
});
