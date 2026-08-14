import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { buildServer } from '../../src/api/server.ts';
import { loadEnv } from '../../src/config/env.ts';

const TOKEN = 'a-real-token-that-is-long-enough';

const open: Array<ReturnType<typeof openDb>> = [];
const env = loadEnv({
  WF_DB_PATH: './data/wf.db',
  WF_DATA_DIR: './data',
  WF_LOG_DIR: './logs',
  WF_TZ: 'America/New_York',
  WF_API_TOKEN: TOKEN,
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

describe('bearer token auth', () => {
  describe('default protection (the real deliverable)', () => {
    it('protects a brand-new route that nobody added to any allowlist', async () => {
      const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
      // Registered AFTER buildServer returns, by a hypothetical future task
      // author who did nothing auth-related. If this route is reachable
      // without a token, default-protection is broken.
      server.get('/some-brand-new-route-nobody-remembered-to-protect', () => ({ ok: true }));

      const unauth = await server.inject({
        method: 'GET',
        url: '/some-brand-new-route-nobody-remembered-to-protect',
      });
      expect(unauth.statusCode).toBe(401);

      const auth = await server.inject({
        method: 'GET',
        url: '/some-brand-new-route-nobody-remembered-to-protect',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(auth.statusCode).toBe(200);
      expect(auth.json()).toEqual({ ok: true });

      await server.close();
    });

    it('protects a brand-new route registered before any request has ever been made', async () => {
      // Same as above but proves the hook does not depend on request
      // ordering or lazy initialization triggered by an earlier request.
      const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
      server.post('/another-new-route', () => ({ created: true }));

      const res = await server.inject({ method: 'POST', url: '/another-new-route' });
      expect(res.statusCode).toBe(401);
      await server.close();
    });
  });

  describe('/health stays open', () => {
    it('serves /health with no Authorization header', async () => {
      const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
      const res = await server.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      await server.close();
    });
  });

  describe('failure indistinguishability', () => {
    it('returns 401 with no token supplied', async () => {
      const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
      server.get('/protected-probe', () => ({ ok: true }));
      const res = await server.inject({ method: 'GET', url: '/protected-probe' });
      expect(res.statusCode).toBe(401);
      await server.close();
    });

    it('returns 401 with a wrong token supplied', async () => {
      const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
      server.get('/protected-probe', () => ({ ok: true }));
      const res = await server.inject({
        method: 'GET',
        url: '/protected-probe',
        headers: { authorization: 'Bearer definitely-the-wrong-token' },
      });
      expect(res.statusCode).toBe(401);
      await server.close();
    });

    it('produces byte-identical responses for missing vs wrong token', async () => {
      const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
      server.get('/protected-probe', () => ({ ok: true }));

      const missing = await server.inject({ method: 'GET', url: '/protected-probe' });
      const wrong = await server.inject({
        method: 'GET',
        url: '/protected-probe',
        headers: { authorization: 'Bearer nope-not-it' },
      });

      expect(missing.statusCode).toBe(wrong.statusCode);
      expect(missing.body).toBe(wrong.body);
      expect(missing.headers['content-type']).toBe(wrong.headers['content-type']);
      await server.close();
    });

    it('does not throw when the supplied token is a different length than the real one', async () => {
      // crypto.timingSafeEqual throws RangeError on length mismatch if you
      // hand it two differently-sized buffers directly. A naive
      // implementation would either 500 here or short-circuit before the
      // constant-time comparison runs, both of which are bugs this test
      // exists to catch.
      const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
      server.get('/protected-probe', () => ({ ok: true }));
      const res = await server.inject({
        method: 'GET',
        url: '/protected-probe',
        headers: { authorization: 'Bearer x' },
      });
      expect(res.statusCode).toBe(401);
      await server.close();
    });

    it('never includes the configured token anywhere in a 401 response', async () => {
      const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
      server.get('/protected-probe', () => ({ ok: true }));
      const res = await server.inject({
        method: 'GET',
        url: '/protected-probe',
        headers: { authorization: 'Bearer wrong' },
      });
      expect(res.body.includes(TOKEN)).toBe(false);
      await server.close();
    });
  });

  describe('accepted request shape', () => {
    it('accepts the standard "Bearer <token>" form', async () => {
      const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
      server.get('/protected-probe', () => ({ ok: true }));
      const res = await server.inject({
        method: 'GET',
        url: '/protected-probe',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      await server.close();
    });

    it('accepts a lowercase "bearer" scheme', async () => {
      const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
      server.get('/protected-probe', () => ({ ok: true }));
      const res = await server.inject({
        method: 'GET',
        url: '/protected-probe',
        headers: { authorization: `bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      await server.close();
    });

    it('accepts a mixed-case "BeArEr" scheme', async () => {
      const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
      server.get('/protected-probe', () => ({ ok: true }));
      const res = await server.inject({
        method: 'GET',
        url: '/protected-probe',
        headers: { authorization: `BeArEr ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      await server.close();
    });

    it('accepts extra whitespace between scheme and token', async () => {
      const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
      server.get('/protected-probe', () => ({ ok: true }));
      const res = await server.inject({
        method: 'GET',
        url: '/protected-probe',
        headers: { authorization: `Bearer   ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      await server.close();
    });

    it('rejects a "Basic" scheme even with the right credential value', async () => {
      const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
      server.get('/protected-probe', () => ({ ok: true }));
      const res = await server.inject({
        method: 'GET',
        url: '/protected-probe',
        headers: { authorization: `Basic ${TOKEN}` },
      });
      expect(res.statusCode).toBe(401);
      await server.close();
    });

    it('rejects the bare token with no scheme at all', async () => {
      const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
      server.get('/protected-probe', () => ({ ok: true }));
      const res = await server.inject({
        method: 'GET',
        url: '/protected-probe',
        headers: { authorization: TOKEN },
      });
      expect(res.statusCode).toBe(401);
      await server.close();
    });

    it('rejects "Bearer" with no token after it', async () => {
      const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
      server.get('/protected-probe', () => ({ ok: true }));
      const res = await server.inject({
        method: 'GET',
        url: '/protected-probe',
        headers: { authorization: 'Bearer' },
      });
      expect(res.statusCode).toBe(401);
      await server.close();
    });

    it('rejects an empty Authorization header', async () => {
      const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
      server.get('/protected-probe', () => ({ ok: true }));
      const res = await server.inject({
        method: 'GET',
        url: '/protected-probe',
        headers: { authorization: '' },
      });
      expect(res.statusCode).toBe(401);
      await server.close();
    });
  });

  describe('the token itself is never logged or leaked', () => {
    it('does not echo the token back on a successful authenticated request', async () => {
      const server = buildServer({ db: migratedDb(), env, sourceCount: 1 });
      server.get('/protected-probe', () => ({ ok: true }));
      const res = await server.inject({
        method: 'GET',
        url: '/protected-probe',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.body.includes(TOKEN)).toBe(false);
      await server.close();
    });
  });
});
