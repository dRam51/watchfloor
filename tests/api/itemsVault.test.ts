import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb, closeDb, type Db } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { buildServer } from '../../src/api/server.ts';
import { loadEnv, type Env } from '../../src/config/env.ts';
import { loadSourcesFile } from '../../src/sources/load.ts';
import { loadDecayConfig } from '../../src/score/decay.ts';
import { loadOverridesConfig } from '../../src/score/overrides.ts';
import { insertItem, type NewItem } from '../../src/domain/item.ts';
import { createFixtureVault, digestTree, listTree, EXISTING_SAVED_PATH } from '../vault/fixture.ts';
import { VAULT_TEMP_PREFIX } from '../../src/vault/session.ts';

/**
 * §8.1's `saved/` promotion, wired to the save route (M5 task 15).
 *
 * **Built through `buildServer`, not through a hand-assembled Fastify
 * instance.** Every other route test in this project builds its own local
 * server, and that convention is right for testing a route's behaviour — but
 * it is exactly wrong for testing *wiring*. A hand-built server would pass
 * whether or not `src/api/server.ts` actually threads the vault into
 * `registerItems`, which is the M4a defect one level up: the call site exists,
 * and the composition root never reaches it.
 *
 * So these go through the real composition root, with the real `/api` prefix
 * and the real auth hook, and the only thing substituted is `WF_VAULT_ROOT` —
 * always a `mkdtemp` fixture vault, never the owner's.
 */

const TOKEN = 'a-real-token-that-is-long-enough';
const AUTH = { authorization: `Bearer ${TOKEN}` };

const open: Db[] = [];
afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

function migratedDb(): Db {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-items-vault-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}

/** A real, validated Env — the shape `src/bin/api.ts` hands to buildServer. */
function envWith(vaultRoot: string | undefined): Env {
  return loadEnv({
    WF_DB_PATH: 'data/wf.db',
    WF_TZ: 'America/New_York',
    WF_API_TOKEN: TOKEN,
    ...(vaultRoot === undefined ? {} : { WF_VAULT_ROOT: vaultRoot }),
  });
}

function server(db: Db, vaultRoot: string | undefined): FastifyInstance {
  const root = process.cwd();
  return buildServer({
    db,
    env: envWith(vaultRoot),
    sources: loadSourcesFile(join(root, 'config', 'sources.yaml')),
    decayConfig: loadDecayConfig(join(root, 'config', 'decay.yaml')),
    overridesConfig: loadOverridesConfig(join(root, 'config', 'overrides.yaml')),
  });
}

let n = 0;
function fixtureItem(overrides: Partial<NewItem> = {}): NewItem {
  n += 1;
  const url = `https://example.test/saved-promotion-${n}`;
  return {
    url,
    canonicalUrl: url,
    title: `A piece worth keeping ${n}`,
    sourceId: 'plain-source',
    itemType: 'analysis',
    beats: ['usnews'],
    entities: [],
    publishedAt: '2026-08-14T00:00:00.000Z',
    fetchedAt: '2026-08-14T00:00:00.000Z',
    summaryRaw: 'A paragraph worth keeping.',
    rawJson: '{}',
    ...overrides,
  };
}

/**
 * The notes in `saved/`, excluding task 4's leftover temp links.
 *
 * `saved/` writes with `link(2)` rather than `rename(2)` — that is what makes
 * write-once *structural*, since `link` fails with EEXIST instead of replacing
 * — and the never-delete rule means the temp entry is never unlinked. So every
 * promoted note leaves **two directory entries pointing at one inode**, a
 * documented consequence task 9's `vault prune` exists to clean up. It is
 * pinned as its own assertion below rather than hidden inside this filter.
 */
function savedNotes(root: string): string[] {
  return listTree(root).filter(
    (p) =>
      p.startsWith('saved') &&
      p !== EXISTING_SAVED_PATH &&
      !basename(p).startsWith(VAULT_TEMP_PREFIX),
  );
}

describe('POST /api/items/:itemKey/save promotes into the vault', () => {
  it('writes the saved note, at save time', async () => {
    const db = migratedDb();
    const item = insertItem(db, fixtureItem());
    const vault = createFixtureVault();
    const api = server(db, vault.root);

    const res = await api.inject({
      method: 'POST',
      url: `/api/items/${item.item_key}/save`,
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().savedAt).not.toBeNull();

    const written = savedNotes(vault.root);
    expect(written.length).toBe(1);
    const note = readFileSync(join(vault.root, written[0]!), 'utf8');
    expect(note).toContain(`item_key: ${item.item_key}`);
    // The note's own stamp is `saved_at`, never the sync's clock.
    expect(note).toContain(`saved_at: ${res.json().savedAt}`);
    await api.close();
  });

  it('names the file by the day in WF_TZ, not the host zone', async () => {
    // The save instant is chosen by the route from its own clock, so this
    // asserts the SHAPE rather than a fixed day: what matters is that the
    // filename is a day label plus the item-key suffix task 8 made
    // unconditional after finding 185 slug-collision groups in the corpus.
    const db = migratedDb();
    const item = insertItem(db, fixtureItem());
    const vault = createFixtureVault();
    const api = server(db, vault.root);

    await api.inject({ method: 'POST', url: `/api/items/${item.item_key}/save`, headers: AUTH });

    const written = savedNotes(vault.root)[0]!;
    expect(written).toMatch(/^saved\/\d{4}-\d{2}-\d{2}-a-piece-worth-keeping-\d+-[0-9a-f]{12}\.md$/);
    expect(written).toContain(item.item_key.slice(0, 12));
    await api.close();
  });

  it('is idempotent — a second save does not write a second note', async () => {
    const db = migratedDb();
    const item = insertItem(db, fixtureItem());
    const vault = createFixtureVault();
    const api = server(db, vault.root);

    await api.inject({ method: 'POST', url: `/api/items/${item.item_key}/save`, headers: AUTH });
    const afterFirst = digestTree(vault.root);
    const second = await api.inject({
      method: 'POST',
      url: `/api/items/${item.item_key}/save`,
      headers: AUTH,
    });

    expect(second.statusCode).toBe(200);
    // §8.1: written once at creation, then never touched again by any job.
    // Not even to rewrite identical bytes — the digest is unchanged.
    expect(digestTree(vault.root)).toEqual(afterFirst);
    await api.close();
  });

  it('touches nothing else in the vault', async () => {
    const db = migratedDb();
    const item = insertItem(db, fixtureItem());
    const vault = createFixtureVault();
    const before = digestTree(vault.anchor);
    const api = server(db, vault.root);

    await api.inject({ method: 'POST', url: `/api/items/${item.item_key}/save`, headers: AUTH });

    const after = digestTree(vault.anchor);
    for (const [path, digest] of before) {
      expect(after.get(path), path).toBe(digest);
    }
    // What appeared is the note and its leftover temp link, both inside
    // `Watchfloor/saved/` and nowhere else.
    const appeared = [...after.keys()].filter((p) => !before.has(p));
    expect(appeared).toHaveLength(2);
    for (const path of appeared) {
      expect(path.startsWith(join('Watchfloor', 'saved'))).toBe(true);
    }
    await api.close();
  });

  it('leaves ONE inode behind under two names, not a second copy', async () => {
    // Task 4's documented consequence of the never-delete rule, asserted at
    // the level that actually produces it. If this ever becomes two inodes,
    // every saved note has silently doubled in size.
    const db = migratedDb();
    const item = insertItem(db, fixtureItem());
    const vault = createFixtureVault();
    const api = server(db, vault.root);

    await api.inject({ method: 'POST', url: `/api/items/${item.item_key}/save`, headers: AUTH });

    const entries = listTree(vault.root).filter((p) => p.startsWith('saved') && p !== EXISTING_SAVED_PATH);
    expect(entries).toHaveLength(2);
    expect(entries.filter((p) => basename(p).startsWith(VAULT_TEMP_PREFIX))).toHaveLength(1);
    const [a, b] = entries.map((p) => statSync(join(vault.root, p)));
    expect(a!.ino).toBe(b!.ino);
    expect(a!.nlink).toBe(2);
    await api.close();
  });

  it('does not promote on read or dismiss, only on save', async () => {
    const db = migratedDb();
    const item = insertItem(db, fixtureItem());
    const vault = createFixtureVault();
    const api = server(db, vault.root);

    await api.inject({ method: 'POST', url: `/api/items/${item.item_key}/read`, headers: AUTH });
    await api.inject({ method: 'POST', url: `/api/items/${item.item_key}/dismiss`, headers: AUTH });

    expect(savedNotes(vault.root)).toEqual([]);
    await api.close();
  });

  it('does not un-write the note when the item is un-saved', async () => {
    // `saved/` is written once and never touched again by any job — including
    // the job that would "clean up" after an un-save. The dashboard state is
    // reversible; the record of having saved it is not.
    const db = migratedDb();
    const item = insertItem(db, fixtureItem());
    const vault = createFixtureVault();
    const api = server(db, vault.root);

    await api.inject({ method: 'POST', url: `/api/items/${item.item_key}/save`, headers: AUTH });
    const afterSave = digestTree(vault.root);
    const unsaved = await api.inject({
      method: 'DELETE',
      url: `/api/items/${item.item_key}/save`,
      headers: AUTH,
    });

    expect(unsaved.json().savedAt).toBeNull();
    expect(digestTree(vault.root)).toEqual(afterSave);
    await api.close();
  });
});

describe('a vault refusal must not fail the HTTP request', () => {
  it('saves normally when no vault is configured — the shipped configuration', async () => {
    const db = migratedDb();
    const item = insertItem(db, fixtureItem());
    const api = server(db, undefined);

    const res = await api.inject({
      method: 'POST',
      url: `/api/items/${item.item_key}/save`,
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().savedAt).not.toBeNull();
    await api.close();
  });

  it('returns 200 when the vault is configured and unmounted', async () => {
    // The save already succeeded. An unmounted vault is not the caller's
    // problem, and turning it into a 500 would make an action that worked look
    // like one that failed — and, in §7's keyboard flow, invite a retry that
    // cannot help.
    const db = migratedDb();
    const item = insertItem(db, fixtureItem());
    const parent = mkdtempSync(join(tmpdir(), 'wf-gone-'));
    const root = join(parent, 'not-mounted', 'watchfloor');
    const api = server(db, root);

    const res = await api.inject({
      method: 'POST',
      url: `/api/items/${item.item_key}/save`,
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().savedAt).not.toBeNull();
    // And no shadow tree was created on the way.
    expect(existsSync(join(parent, 'not-mounted'))).toBe(false);
    await api.close();
  });

  it('still records the save in the database when the vault refuses', async () => {
    const db = migratedDb();
    const item = insertItem(db, fixtureItem());
    const parent = mkdtempSync(join(tmpdir(), 'wf-gone-'));
    const api = server(db, join(parent, 'not-mounted', 'watchfloor'));

    await api.inject({ method: 'POST', url: `/api/items/${item.item_key}/save`, headers: AUTH });
    const state = await api.inject({
      method: 'GET',
      url: `/api/items/${item.item_key}/state`,
      headers: AUTH,
    });

    expect(state.json().savedAt).not.toBeNull();
    await api.close();
  });

  it('returns 200 for a key with no item at all', async () => {
    // The route deliberately does not check that an item_key exists, so
    // promotion has to survive `readSavedItem` returning null.
    const db = migratedDb();
    const vault = createFixtureVault();
    const api = server(db, vault.root);

    const res = await api.inject({
      method: 'POST',
      url: `/api/items/${'a'.repeat(64)}/save`,
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(savedNotes(vault.root)).toEqual([]);
    await api.close();
  });

  it('rejects a malformed itemKey before it reaches the vault', async () => {
    const db = migratedDb();
    const vault = createFixtureVault();
    const api = server(db, vault.root);

    const res = await api.inject({ method: 'POST', url: '/api/items/nope/save', headers: AUTH });

    expect(res.statusCode).toBe(400);
    expect(savedNotes(vault.root)).toEqual([]);
    await api.close();
  });
});
