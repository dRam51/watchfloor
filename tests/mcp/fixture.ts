/**
 * Shared scaffolding for the MCP suite (M5 task 10): a real temp-file corpus
 * and the request lines a real client would send.
 *
 * No mocks anywhere — the corpus is SQLite on disk, the requests are the JSON
 * a client writes to this process's stdin, and `tests/mcp/bin.test.ts` sends
 * these exact lines to a real child process.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { MCP_TOKEN_META_KEY } from '../../src/mcp/auth.ts';
import { LATEST_PROTOCOL_VERSION } from '../../src/mcp/protocol.ts';

export const TEST_MCP_TOKEN = 'bot-token-value-000000002';
export const TEST_API_TOKEN = 'dashboard-token-value-0001';

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'wf-mcp-'));
}

/**
 * A corpus holding both scores, so the `read_score` guards are tested against
 * a column that genuinely exists rather than one whose absence would make them
 * pass vacuously.
 */
export function seedCorpus(): string {
  const path = join(tempDir(), 'corpus.db');
  const writer = openDb(path);
  writer.exec(`
    create table items (
      item_key   text primary key,
      title      text not null,
      source_id  text not null,
      fetched_at text not null
    );
    create table item_scores (
      item_key     text not null,
      beat         text not null,
      signal_score real not null,
      read_score   real not null
    );
    insert into items values
      ('aaa', 'CISA adds a KEV entry', 'cisa-kev', '2026-08-14T10:00:00.000Z'),
      ('bbb', 'Wall Street slips back from its record', 'ap-topnews', '2026-08-15T10:00:00.000Z');
    insert into item_scores values
      ('aaa', 'cyber', 4.5, 9.25),
      ('bbb', 'usnews', 1.5, 8.0);
  `);
  closeDb(writer);
  return path;
}

interface RequestOptions {
  readonly id?: string | number;
  readonly params?: Record<string, unknown>;
  /** Omit to send no credential at all; pass a string to send that value. */
  readonly token?: string | null;
  readonly protocolVersion?: string;
  /** Drop the required `_meta` fields entirely, as a legacy client would. */
  readonly omitMeta?: boolean;
  readonly clientName?: string;
}

/** The JSON a conforming 2026-07-28 client writes to our stdin. */
export function request(method: string, options: RequestOptions = {}): string {
  const params: Record<string, unknown> = { ...(options.params ?? {}) };

  if (!options.omitMeta) {
    const meta: Record<string, unknown> = {
      'io.modelcontextprotocol/protocolVersion': options.protocolVersion ?? LATEST_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: options.clientName ?? 'TestBot', version: '1.0.0' },
    };
    if (options.token !== null && options.token !== undefined) meta[MCP_TOKEN_META_KEY] = options.token;
    params._meta = meta;
  }

  return JSON.stringify({ jsonrpc: '2.0', id: options.id ?? 1, method, params });
}

/** The same, with the credential filled in — the ordinary authorised call. */
export function authedRequest(method: string, options: RequestOptions = {}): string {
  return request(method, { token: TEST_MCP_TOKEN, ...options });
}

export interface DecodedResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export function decode(line: string | null): DecodedResponse {
  if (line === null) throw new Error('expected a response line, got null');
  return JSON.parse(line) as DecodedResponse;
}
