/**
 * Item state writes — the HTTP surface over src/domain/itemState.ts.
 *
 * Builds its own local server (Fastify + registerAuth + registerItems),
 * matching the convention every other M3 route test follows: the `/api`
 * prefix is a property of how src/api/server.ts composes routes, not of the
 * routes themselves, so these exercise bare paths.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { registerAuth } from '../../src/api/auth.ts';
import { registerItems } from '../../src/api/routes/items.ts';
import { insertItem, deriveItemKey, type NewItem } from '../../src/domain/item.ts';
import { getDismissalSignals } from '../../src/domain/itemState.ts';

const TOKEN = 'a-real-token-that-is-long-enough';
const T0 = '2026-08-14T00:00:00.000Z';
const T1 = '2026-08-14T01:00:00.000Z';

const open: Db[] = [];
function migratedDb(): Db {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-items-test-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}
afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

let n = 0;
function fixture(overrides: Partial<NewItem> = {}): NewItem {
  n += 1;
  const url = `https://example.test/items-fixture-${n}`;
  return {
    url,
    canonicalUrl: url,
    title: `Fixture ${n}`,
    sourceId: 'plain-source',
    itemType: 'analysis',
    beats: ['usnews'],
    entities: [],
    publishedAt: T0,
    fetchedAt: T0,
    summaryRaw: null,
    rawJson: '{}',
    ...overrides,
  };
}

function buildTestServer(db: Db, now: () => string = () => T0): FastifyInstance {
  const server = Fastify({ logger: false });
  registerAuth(server, TOKEN);
  registerItems(server, { db, now });
  return server;
}

const AUTH = { authorization: `Bearer ${TOKEN}` };

describe('item state writes', () => {
  it('marks read, and reports the three flags with explicit nulls', async () => {
    const db = migratedDb();
    const item = insertItem(db, fixture());
    const server = buildTestServer(db);

    const res = await server.inject({
      method: 'POST',
      url: `/items/${item.item_key}/read`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ readAt: T0, savedAt: null, dismissedAt: null });
    await server.close();
  });

  it('saves and un-saves, since saving is reversible', async () => {
    const db = migratedDb();
    const item = insertItem(db, fixture());
    const server = buildTestServer(db);

    const saved = await server.inject({
      method: 'POST',
      url: `/items/${item.item_key}/save`,
      headers: AUTH,
    });
    expect(saved.json().savedAt).toBe(T0);

    const unsaved = await server.inject({
      method: 'DELETE',
      url: `/items/${item.item_key}/save`,
      headers: AUTH,
    });
    expect(unsaved.json().savedAt).toBeNull();
    await server.close();
  });

  it('dismisses irreversibly, and exposes NO route that would undo it', async () => {
    const db = migratedDb();
    const item = insertItem(db, fixture());
    const server = buildTestServer(db);

    const res = await server.inject({
      method: 'POST',
      url: `/items/${item.item_key}/dismiss`,
      headers: AUTH,
    });
    expect(res.json().dismissedAt).toBe(T0);

    // §7: "Dismissed items never come back." The domain layer has no
    // undismiss, and the URL space must not imply one — the asymmetry with
    // DELETE .../save is the point, not an oversight.
    const undo = await server.inject({
      method: 'DELETE',
      url: `/items/${item.item_key}/dismiss`,
      headers: AUTH,
    });
    expect(undo.statusCode).toBe(404);
    await server.close();
  });

  it('is idempotent, because held keys and double-taps are ordinary in a keyboard UI', async () => {
    const db = migratedDb();
    const item = insertItem(db, fixture());
    let clock = T0;
    const server = buildTestServer(db, () => clock);

    await server.inject({ method: 'POST', url: `/items/${item.item_key}/dismiss`, headers: AUTH });
    clock = T1;
    const again = await server.inject({
      method: 'POST',
      url: `/items/${item.item_key}/dismiss`,
      headers: AUTH,
    });

    // The second dismiss must not re-stamp to T1 — and must not log a second
    // negative interest signal, or a leaned-on `x` key would skew the profile
    // it feeds.
    expect(again.json().dismissedAt).toBe(T0);
    expect(getDismissalSignals(db, item.item_key)).toHaveLength(1);
    await server.close();
  });

  it('rejects a malformed itemKey rather than creating state under it', async () => {
    const db = migratedDb();
    const server = buildTestServer(db);

    const res = await server.inject({
      method: 'POST',
      url: '/items/not-a-sha256/read',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/hex digest/);
    await server.close();
  });

  it('is protected by the shared bearer-auth hook by default', async () => {
    const db = migratedDb();
    const item = insertItem(db, fixture());
    const server = buildTestServer(db);

    const res = await server.inject({ method: 'POST', url: `/items/${item.item_key}/read` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
    await server.close();
  });

  it('keys state to item_key, so it survives re-delivery as a new version', async () => {
    const db = migratedDb();
    const url = 'https://example.test/re-delivered';
    const v1 = insertItem(db, fixture({ url, canonicalUrl: url }));
    const server = buildTestServer(db);

    await server.inject({ method: 'POST', url: `/items/${v1.item_key}/save`, headers: AUTH });

    // The source re-delivers the same canonical url: a new row, a new
    // item_id, the same item_key.
    const v2 = insertItem(db, fixture({ url, canonicalUrl: url, fetchedAt: T1 }));
    expect(v2.item_id).not.toBe(v1.item_id);
    expect(v2.item_key).toBe(deriveItemKey(url));

    const res = await server.inject({
      method: 'GET',
      url: `/items/${v2.item_key}/state`,
      headers: AUTH,
    });
    expect(res.json().savedAt).toBe(T0);
    await server.close();
  });
});
