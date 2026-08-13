import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { buildServer } from '../../src/api/server.ts';
import { loadEnv } from '../../src/config/env.ts';
import { loadSourcesFile } from '../../src/sources/load.ts';

const open: Array<ReturnType<typeof openDb>> = [];
const env = loadEnv({
  WF_DB_PATH: './data/wf.db',
  WF_DATA_DIR: './data',
  WF_LOG_DIR: './logs',
  WF_TZ: 'America/New_York',
  WF_API_TOKEN: 'test-token-value',
});

function migratedDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

describe('GET /health', () => {
  it('reports ok, the configured timezone, and applied migrations', async () => {
    const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
    const res = await server.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
    expect(body.tz).toBe('America/New_York');
    expect(body.migrations).toBeGreaterThan(0);
    await server.close();
  });

  it('surfaces the source count, making a valid boot-time config observable', async () => {
    // The entrypoint loads and validates config/sources.yaml before building
    // the server, so a non-zero count here is evidence the config parsed —
    // not just that the process is alive.
    const sourceCount = loadSourcesFile(join(process.cwd(), 'config', 'sources.yaml')).length;
    expect(sourceCount).toBeGreaterThan(0);

    const server = buildServer({ db: migratedDb(), env, sourceCount });
    const res = await server.inject({ method: 'GET', url: '/health' });

    expect(res.json().sources).toBe(sourceCount);
    await server.close();
  });

  it('shows cost-gated features as disabled so an off feature is visibly off', async () => {
    const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
    const res = await server.inject({ method: 'GET', url: '/health' });

    expect(res.json().costGates).toEqual({
      anthropic: 'disabled (cost policy)',
      marketdata: 'disabled (cost policy)',
    });
    await server.close();
  });
});
