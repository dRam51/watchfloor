/**
 * `npm run mcp`, as a real child process (M5 task 10).
 *
 * This project has now shipped SEVEN components with no caller (M3's
 * `registerItems`; M4a's `github_search` adapter, star snapshots and README
 * enricher; M5's `writeDailyNote`, `promoteSavedItem`, and Wave 1's whole LLM
 * stack). The instruction for this task was explicit: ship an entrypoint in the
 * same change and prove the process starts.
 *
 * So this file starts it — no mocks, no in-process shortcut. It spawns
 * `src/bin/mcp.ts`, speaks JSON-RPC over its real stdin/stdout, and asserts on
 * what actually comes back, including the two properties that only a real
 * process can demonstrate:
 *
 * - **stdout carries protocol and nothing else**, so a stray `console.log`
 *   anywhere in the boot path is a failing test rather than a corrupted
 *   session.
 * - **the query log lands on stderr**, where the binding says it may.
 *
 * It also proves the refusals: no credential, a credential shared with the
 * dashboard, and a database with pending migrations all stop the process
 * before it serves anything.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { authedRequest, request, TEST_API_TOKEN, TEST_MCP_TOKEN } from './fixture.ts';

const repoRoot = join(import.meta.dirname, '..', '..');
const migrationsDir = join(repoRoot, 'db', 'migrations');
const entrypoint = join(repoRoot, 'src', 'bin', 'mcp.ts');

/** A real, fully-migrated database under a relative WF_DB_PATH, as the process requires. */
function workspace(options: { migrate?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'wf-mcp-bin-'));
  mkdirSync(join(dir, 'data'));
  const db = openDb(join(dir, 'data', 'wf.db'));
  if (options.migrate !== false) runMigrations(db, migrationsDir);
  closeDb(db);
  return dir;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  lines: () => Array<Record<string, unknown>>;
}

function run(cwd: string, env: NodeJS.ProcessEnv, input: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint], {
      cwd,
      // A deliberately MINIMAL environment: only PATH and what the process is
      // being told it needs. Anything the entrypoint silently relied on from
      // the ambient shell would fail here.
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        stdout,
        stderr,
        code,
        lines: () => stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
      }),
    );

    for (const line of input) child.stdin.write(`${line}\n`);
    child.stdin.end();
  });
}

const GOOD_ENV = { WF_DB_PATH: 'data/wf.db', WF_MCP_TOKEN: TEST_MCP_TOKEN };

describe('npm run mcp — the process', () => {
  it('starts, serves a full session, and exits 0 when stdin closes', async () => {
    const result = await run(workspace(), GOOD_ENV, [
      request('server/discover', { id: 1 }),
      authedRequest('tools/list', { id: 2 }),
      authedRequest('tools/call', { id: 3, params: { name: 'describe_boundary', arguments: {} } }),
    ]);

    expect(result.code).toBe(0);
    expect(result.lines()).toHaveLength(3);

    const [discover, list, call] = result.lines();
    expect((discover!.result as Record<string, unknown>).supportedVersions).toEqual(['2026-07-28']);
    expect(((list!.result as Record<string, unknown>).tools as Array<{ name: string }>).map((t) => t.name)).toContain(
      'describe_boundary',
    );

    // The call reaches the real read-only handle and the real corpus.
    const structured = (call!.result as Record<string, unknown>).structuredContent as Record<string, unknown>;
    expect(structured.readOnly).toBe(true);
    expect((structured.corpus as Record<string, unknown>).migrationsApplied).toBeGreaterThan(0);
  });

  // The stdio binding's hardest rule to keep by accident.
  it('writes nothing to stdout that is not a JSON-RPC message', async () => {
    const result = await run(workspace(), GOOD_ENV, [
      request('server/discover', { id: 1 }),
      authedRequest('tools/list', { id: 2 }),
    ]);
    for (const line of result.stdout.split('\n').filter(Boolean)) {
      expect(JSON.parse(line).jsonrpc).toBe('2.0');
    }
  });

  it('writes the query log to stderr, one JSON object per line', async () => {
    const result = await run(workspace(), GOOD_ENV, [authedRequest('tools/list', { id: 2 })]);
    const logged = result.stderr
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(logged.some((entry) => entry.method === 'tools/list' && entry.outcome === 'ok')).toBe(true);
  });

  it('never prints the credential, on stdout or stderr', async () => {
    const result = await run(workspace(), GOOD_ENV, [
      authedRequest('tools/list', { id: 1 }),
      request('tools/list', { id: 2, token: 'wrong-token-value-00001' }),
    ]);
    expect(result.stdout).not.toContain(TEST_MCP_TOKEN);
    expect(result.stderr).not.toContain(TEST_MCP_TOKEN);
    expect(result.stdout).not.toContain('wrong-token-value-00001');
    expect(result.stderr).not.toContain('wrong-token-value-00001');
  });

  it('refuses an unauthenticated tools/call and never runs the tool', async () => {
    const result = await run(workspace(), GOOD_ENV, [
      request('tools/call', { id: 1, token: null, params: { name: 'describe_boundary', arguments: {} } }),
    ]);
    expect((result.lines()[0]!.error as Record<string, unknown>).code).toBe(-31001);
    expect(result.lines()[0]!.result).toBeUndefined();
  });

  // The point of a separate credential: the bot's process configuration does
  // not carry the dashboard's. `loadEnv()` requires WF_API_TOKEN, which is
  // exactly why this entrypoint does not call it.
  it('boots with no WF_API_TOKEN in its environment at all', async () => {
    const result = await run(workspace(), GOOD_ENV, [request('server/discover', { id: 1 })]);
    expect(result.code).toBe(0);
    expect(result.lines()[0]!.error).toBeUndefined();
  });
});

describe('npm run mcp — the refusals', () => {
  it('refuses to start with no WF_MCP_TOKEN, naming the variable', async () => {
    const result = await run(workspace(), { WF_DB_PATH: 'data/wf.db' }, [request('server/discover')]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('WF_MCP_TOKEN');
    expect(result.stdout).toBe('');
  });

  it('refuses to start when the bot credential equals the dashboard credential', async () => {
    const result = await run(
      workspace(),
      { WF_DB_PATH: 'data/wf.db', WF_MCP_TOKEN: TEST_API_TOKEN, WF_API_TOKEN: TEST_API_TOKEN },
      [request('server/discover')],
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/separate credential/);
    expect(result.stderr).not.toContain(TEST_API_TOKEN);
  });

  it('refuses to start against a database with pending migrations', async () => {
    const result = await run(workspace({ migrate: false }), GOOD_ENV, [request('server/discover')]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/npm run migrate/);
  });

  it('refuses an absolute WF_DB_PATH, like every other entrypoint', async () => {
    const dir = workspace();
    const result = await run(dir, { WF_DB_PATH: join(dir, 'data', 'wf.db'), WF_MCP_TOKEN: TEST_MCP_TOKEN }, [
      request('server/discover'),
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/relative/);
  });

  it('refuses a database that is not one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wf-mcp-bin-'));
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'wf.db'), 'this is not a database');
    const result = await run(dir, GOOD_ENV, [request('server/discover')]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
  });
});
