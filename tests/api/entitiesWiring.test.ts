import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, openDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { buildServer } from '../../src/api/server.ts';
import { insertItem } from '../../src/domain/item.ts';
import { loadDecayConfig } from '../../src/score/decay.ts';
import { loadOverridesConfig } from '../../src/score/overrides.ts';
import type { Env } from '../../src/config/env.ts';

/**
 * **The occurrence-eight test, on the API side** (M5 task 17).
 *
 * `CLAUDE.md` opens with the table: seven times in this project a
 * correctly-built, fully-tested component has shipped **reachable from
 * nothing**. `registerItems` is number one on that list, and it is the closest
 * analogue to this task — a route module that existed, was tested against a
 * locally-built Fastify instance, and was never registered by
 * `src/api/server.ts`, so the dashboard could display state it had no way to
 * change.
 *
 * `tests/api/entities.test.ts` builds its own server, exactly as every other
 * route test in this directory does and for the same good reason (route tests
 * must not depend on the composition root's prefix or its other routes). That
 * is also precisely the blindness: **every one of those tests would stay green
 * with `registerEntities` absent from `server.ts`.** This file is the other
 * half, and it asks the only question that catches the defect — does a request
 * to the REAL server, at the REAL `/api` prefix, reach the route?
 */

const REAL_MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations');
const TOKEN = 'a-real-token-that-is-long-enough';
const open: Db[] = [];

afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

function env(): Env {
  return {
    WF_DB_PATH: './data/wf.db',
    WF_TZ: 'America/New_York',
    WF_API_TOKEN: TOKEN,
    WF_API_PORT: 8787,
  } as unknown as Env;
}

function realServer(): ReturnType<typeof buildServer> {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-entities-wiring-')), 'wf.db'));
  open.push(db);
  runMigrations(db, REAL_MIGRATIONS_DIR);

  for (const [n, entities] of [
    ['1', ['OpenAI', 'ChatGPT']],
    ['2', ['OpenAI', 'ChatGPT']],
  ] as const) {
    insertItem(db, {
      url: `https://example.test/${n}`,
      canonicalUrl: `https://example.test/${n}`,
      title: `Item ${n}`,
      sourceId: 'fixture-source',
      itemType: 'analysis',
      beats: ['ai'],
      entities: [...entities],
      publishedAt: null,
      fetchedAt: `2026-08-01T00:00:0${n}.000Z`,
      summaryRaw: null,
      rawJson: '{}',
    });
  }

  return buildServer({
    db,
    env: env(),
    sources: [],
    decayConfig: loadDecayConfig(join('config', 'decay.yaml')),
    overridesConfig: loadOverridesConfig(join('config', 'overrides.yaml')),
  });
}

const AUTH = { authorization: `Bearer ${TOKEN}` };

describe('the entity graph is reachable from the server every entrypoint builds', () => {
  it('serves GET /api/entities — the prefix is the composition root’s, not the route’s', async () => {
    const server = realServer();
    const res = await server.inject({ method: 'GET', url: '/api/entities', headers: AUTH });
    expect(res.statusCode, 'registerEntities is not wired into src/api/server.ts').toBe(200);
    expect(res.json().entities).toEqual([
      { entity: 'ChatGPT', itemCount: 2 },
      { entity: 'OpenAI', itemCount: 2 },
    ]);
    await server.close();
  });

  it('serves GET /api/entities/graph', async () => {
    const server = realServer();
    const res = await server.inject({
      method: 'GET',
      url: '/api/entities/graph?entity=OpenAI',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().nodes[0].entity).toBe('OpenAI');
    await server.close();
  });

  it('is behind the root auth hook, without its author having done anything', async () => {
    // The property src/api/auth.ts exists for: a route added later is
    // protected by default. Asserted on the REAL server, because that is the
    // only place the root hook is registered.
    const server = realServer();
    for (const url of ['/api/entities', '/api/entities/graph?entity=OpenAI']) {
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
    await server.close();
  });

  it('does not answer at the bare path — everything but /health is under /api', async () => {
    const server = realServer();
    const res = await server.inject({ method: 'GET', url: '/entities', headers: AUTH });
    expect(res.statusCode).toBe(404);
    await server.close();
  });
});
