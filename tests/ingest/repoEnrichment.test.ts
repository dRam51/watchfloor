import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem } from '../../src/domain/item.ts';
import { dismissItem } from '../../src/domain/itemState.ts';
import { GitHubClient } from '../../src/fetch/github.ts';
import { isReadmeKnown, type ReadmeOutcome } from '../../src/enrich/repo.ts';
import {
  ANSWER_FRESH_FOR_MS,
  NO_README_FRESH_FOR_MS,
  enrichRepoReadmes,
  readmeObservationFor,
  repoSourceWasDue,
} from '../../src/ingest/repoEnrichment.ts';
import {
  getRepoReadme,
  isReadmeAnswered,
  recordRepoReadme,
} from '../../src/db/repoReadmes.ts';
import type { Source } from '../../src/sources/load.ts';

// ---------------------------------------------------------------------------
// Real temp-file SQLite, real local http server replaying task 6's real
// captures. No mocks, no network. TZ is pinned where it appears at all -- this
// module deliberately has no timezone (see its doc comment), and one test
// below asserts exactly that.
// ---------------------------------------------------------------------------

const open: Array<ReturnType<typeof openDb>> = [];
function migratedDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}

const openServers: Server[] = [];
async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo from an ephemeral TCP listener');
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  while (open.length) closeDb(open.pop()!);
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'github-readme');
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8'));
}

function coreHeaders(remaining: number): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-ratelimit-limit': '60',
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-used': String(60 - remaining),
    'x-ratelimit-resource': 'core',
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
  };
}

/** One README fixture per `owner/name`; anything unmapped 404s, as GitHub does. */
async function readmeServer(byFullName: Record<string, string>): Promise<{
  baseUrl: string;
  paths: string[];
}> {
  const paths: string[] = [];
  let used = 0;
  const baseUrl = await serve((req, res) => {
    used += 1;
    paths.push(req.url ?? '');
    const match = /^\/repos\/([^/]+)\/([^/]+)\/readme$/.exec(req.url ?? '');
    const name = byFullName[match ? `${match[1]}/${match[2]}` : ''];
    if (name === undefined) {
      res.writeHead(404, coreHeaders(60 - used));
      res.end(JSON.stringify(fixture('no-readme-404')));
      return;
    }
    res.writeHead(200, coreHeaders(60 - used));
    res.end(JSON.stringify(fixture(name)));
  });
  return { baseUrl, paths };
}

const NOW = '2026-08-14T12:00:00.000Z';

function searchSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'github-topics',
    name: 'GitHub Topic Search',
    type: 'github_search',
    url: 'https://api.github.com/search/repositories',
    beats: ['repos'],
    weight: 1.0,
    poll_interval: '13m',
    enabled: true,
    enrichment: true,
    filters: { topics: ['llm'] },
    ...overrides,
  } as Source;
}

function rssSource(): Source {
  return {
    id: 'krebs',
    name: 'Krebs',
    type: 'rss',
    url: 'https://krebsonsecurity.com/feed/',
    beats: ['cyber'],
    weight: 1.0,
    poll_interval: '1h',
    enabled: true,
    enrichment: true,
  } as Source;
}

/** A plausible pruned search entry -- the shape that really sits in raw_json. */
function searchEntry(opts: {
  id: number;
  owner: string;
  name: string;
  stars?: number;
  fork?: boolean;
  archived?: boolean;
}): Record<string, unknown> {
  return {
    id: opts.id,
    name: opts.name,
    full_name: `${opts.owner}/${opts.name}`,
    owner: { login: opts.owner },
    description: 'a repo',
    language: 'TypeScript',
    license: { spdx_id: 'MIT' },
    stargazers_count: opts.stars ?? 100,
    open_issues_count: 5,
    pushed_at: '2026-08-13T12:00:00Z',
    fork: opts.fork ?? false,
    archived: opts.archived ?? false,
  };
}

let seq = 0;
function insertRepoItem(
  db: ReturnType<typeof openDb>,
  opts: {
    id: number;
    owner: string;
    name: string;
    stars?: number;
    fork?: boolean;
    archived?: boolean;
    sourceId?: string;
    fetchedAt?: string;
    url?: string;
    rawJson?: string;
  },
): string {
  seq += 1;
  const url = opts.url ?? `https://github.com/${opts.owner}/${opts.name}`;
  const fetchedAt = opts.fetchedAt ?? '2026-08-14T11:00:00.000Z';
  insertItem(db, {
    url,
    canonicalUrl: url,
    title: `${opts.owner}/${opts.name}`,
    sourceId: opts.sourceId ?? 'github-topics',
    itemType: 'analysis',
    beats: ['repos'],
    entities: [],
    publishedAt: fetchedAt,
    fetchedAt,
    summaryRaw: null,
    rawJson: opts.rawJson ?? JSON.stringify(searchEntry(opts)),
  });
  return url;
}

function run(
  db: ReturnType<typeof openDb>,
  sources: Source[],
  baseUrl: string,
  opts: { now?: string; maxReadmeFetches?: number; reserve?: number } = {},
) {
  return enrichRepoReadmes(db, sources, {
    now: opts.now ?? NOW,
    client: new GitHubClient({ baseUrl }),
    minIntervalMs: 0,
    ...(opts.maxReadmeFetches !== undefined ? { maxReadmeFetches: opts.maxReadmeFetches } : {}),
    ...(opts.reserve !== undefined ? { reserve: opts.reserve } : {}),
  });
}

// ===========================================================================
// The gap this module closes
// ===========================================================================

describe('enrichRepoReadmes — reading and storing what task 6 could only fetch', () => {
  it('reads a stored repo README and records the first paragraph', async () => {
    const db = migratedDb();
    insertRepoItem(db, { id: 101, owner: 'modelcontextprotocol', name: 'servers' });
    const { baseUrl, paths } = await readmeServer({ 'modelcontextprotocol/servers': 'mcp-servers' });

    const sweep = await run(db, [searchSource()], baseUrl);

    expect(paths).toEqual(['/repos/modelcontextprotocol/servers/readme']);
    expect(sweep.examined).toBe(1);
    expect(sweep.answered).toBe(1);
    const record = getRepoReadme(db, 101);
    expect(record?.outcome).toBe('present');
    expect(record?.firstParagraph).toMatch(/^This repository is a collection of reference implementations/);
    expect(record?.readmePath).toBe('README.md');
  });

  it('records a 404 as an ANSWER, which is what makes §4 no_readme enforceable', async () => {
    const db = migratedDb();
    insertRepoItem(db, { id: 202, owner: 'octocat', name: 'octocat.github.io' });
    const { baseUrl } = await readmeServer({});

    await run(db, [searchSource()], baseUrl);

    const record = getRepoReadme(db, 202);
    expect(record?.outcome).toBe('absent');
    expect(isReadmeAnswered(record)).toBe(true);
  });

  it("records a README that exists but says nothing as 'no_prose', not 'absent'", async () => {
    // octocat/Hello-World's entire README is the string `Hello World!`. The
    // file exists; there is nothing to say about the repo. §4 treats both as
    // README-less, and an operator asking why deserves to know which it was.
    const db = migratedDb();
    insertRepoItem(db, { id: 303, owner: 'octocat', name: 'Hello-World' });
    const { baseUrl } = await readmeServer({ 'octocat/Hello-World': 'hello-world-no-extension' });

    await run(db, [searchSource()], baseUrl);

    const record = getRepoReadme(db, 303);
    expect(record?.outcome).toBe('no_prose');
    expect(record?.firstParagraph).toBeNull();
    expect(isReadmeAnswered(record)).toBe(true);
  });

  it('NEVER records an answer for a request that failed', async () => {
    // The failure that would silently delete a good repo from the lane.
    const db = migratedDb();
    insertRepoItem(db, { id: 404, owner: 'acme', name: 'flaky' });
    const baseUrl = await serve((_req, res) => {
      res.writeHead(503, coreHeaders(59));
      res.end('{"message":"Server Error"}');
    });

    const sweep = await enrichRepoReadmes(db, [searchSource()], {
      now: NOW,
      client: new GitHubClient({ baseUrl }),
      minIntervalMs: 0,
    });

    expect(sweep.answered).toBe(0);
    expect(sweep.failed).toBe(1);
    const record = getRepoReadme(db, 404);
    expect(record?.outcome).toBeNull();
    expect(record?.attemptFailure).toBe('error');
    expect(isReadmeAnswered(record)).toBe(false);
  });

  it('records NOTHING for a repo the budget never reached, so it is retried and never suppressed', async () => {
    const db = migratedDb();
    insertRepoItem(db, { id: 101, owner: 'a', name: 'first', stars: 900 });
    insertRepoItem(db, { id: 202, owner: 'a', name: 'second', stars: 100 });
    const { baseUrl, paths } = await readmeServer({ 'a/first': 'mcp-servers', 'a/second': 'netbox' });

    await run(db, [searchSource()], baseUrl, { maxReadmeFetches: 1 });

    expect(paths).toHaveLength(1);
    // The one that was not reached has NO row at all -- not a blank answer.
    expect(getRepoReadme(db, 202)).toBeNull();
  });
});

// ===========================================================================
// Cache-and-skip: the property that makes 60 requests/hour cover 359 repos
// ===========================================================================

describe('enrichRepoReadmes — coverage compounds across polls', () => {
  it('sends no request at all for a repo whose README is already stored', async () => {
    const db = migratedDb();
    insertRepoItem(db, { id: 101, owner: 'modelcontextprotocol', name: 'servers' });
    const { baseUrl, paths } = await readmeServer({ 'modelcontextprotocol/servers': 'mcp-servers' });

    await run(db, [searchSource()], baseUrl);
    const second = await run(db, [searchSource()], baseUrl, { now: '2026-08-14T13:00:00.000Z' });

    expect(paths).toHaveLength(1); // not two, and not a revalidation either
    expect(second.report?.cached).toBe(1);
    expect(second.report?.requested).toBe(0);
  });

  it('covers three repos in three one-request sweeps instead of restarting each time', async () => {
    // The whole point. A pass with no storage behind it would re-fetch the
    // same top-N forever and repos 2 and 3 would never be read.
    const db = migratedDb();
    insertRepoItem(db, { id: 101, owner: 'a', name: 'one', stars: 300 });
    insertRepoItem(db, { id: 202, owner: 'a', name: 'two', stars: 200 });
    insertRepoItem(db, { id: 303, owner: 'a', name: 'three', stars: 100 });
    const { baseUrl, paths } = await readmeServer({
      'a/one': 'mcp-servers',
      'a/two': 'netbox',
      'a/three': 'garak',
    });

    for (const hour of ['12', '13', '14']) {
      await run(db, [searchSource()], baseUrl, {
        now: `2026-08-14T${hour}:00:00.000Z`,
        maxReadmeFetches: 1,
      });
    }

    expect(paths).toEqual([
      '/repos/a/one/readme',
      '/repos/a/two/readme',
      '/repos/a/three/readme',
    ]);
    expect([101, 202, 303].map((id) => getRepoReadme(db, id)?.outcome)).toEqual([
      'present',
      'present',
      'present',
    ]);
  });

  it('re-reads an answer once it is stale, so a repo that gains a README stops being suppressed', async () => {
    const db = migratedDb();
    insertRepoItem(db, { id: 101, owner: 'a', name: 'one' });
    const { baseUrl, paths } = await readmeServer({ 'a/one': 'mcp-servers' });

    recordRepoReadme(db, { repoId: 101, fullName: 'a/one', observedAt: NOW, outcome: 'absent' });

    const fresh = new Date(Date.parse(NOW) + NO_README_FRESH_FOR_MS - 60_000).toISOString();
    await run(db, [searchSource()], baseUrl, { now: fresh });
    expect(paths).toHaveLength(0);

    const stale = new Date(Date.parse(NOW) + NO_README_FRESH_FOR_MS + 60_000).toISOString();
    await run(db, [searchSource()], baseUrl, { now: stale });
    expect(paths).toEqual(['/repos/a/one/readme']);
    expect(getRepoReadme(db, 101)?.outcome).toBe('present');
  });

  it('holds a POSITIVE answer far longer than a negative one, because only the negative one hides a repo', async () => {
    expect(ANSWER_FRESH_FOR_MS).toBeGreaterThan(NO_README_FRESH_FOR_MS);

    const db = migratedDb();
    insertRepoItem(db, { id: 101, owner: 'a', name: 'one' });
    const { baseUrl, paths } = await readmeServer({ 'a/one': 'mcp-servers' });
    recordRepoReadme(db, {
      repoId: 101,
      fullName: 'a/one',
      observedAt: NOW,
      outcome: 'present',
      firstParagraph: 'A previously stored description of it.',
    });

    // Well past the negative window, still inside the positive one.
    const later = new Date(Date.parse(NOW) + NO_README_FRESH_FOR_MS * 2).toISOString();
    await run(db, [searchSource()], baseUrl, { now: later });
    expect(paths).toHaveLength(0);
  });

  it('prefers a never-attempted repo over one that has already failed once', async () => {
    // Otherwise a handful of permanently-failing repos consume the whole
    // hourly budget on every poll, forever, and nothing new is ever covered.
    const db = migratedDb();
    insertRepoItem(db, { id: 101, owner: 'a', name: 'failed-before', stars: 9000 });
    insertRepoItem(db, { id: 202, owner: 'a', name: 'never-tried', stars: 10 });
    recordRepoReadme(db, {
      repoId: 101,
      fullName: 'a/failed-before',
      observedAt: NOW,
      outcome: 'failed',
      failure: 'error',
      detail: 'HTTP 503',
    });
    const { baseUrl, paths } = await readmeServer({
      'a/failed-before': 'mcp-servers',
      'a/never-tried': 'netbox',
    });

    await run(db, [searchSource()], baseUrl, {
      now: '2026-08-14T13:00:00.000Z',
      maxReadmeFetches: 1,
    });

    expect(paths).toEqual(['/repos/a/never-tried/readme']);
  });
});

// ===========================================================================
// Budget: every request avoided is one the lane can spend elsewhere
// ===========================================================================

describe('enrichRepoReadmes — free refusals before paid ones', () => {
  it('never spends a request on a repo the owner already dismissed', async () => {
    const db = migratedDb();
    const url = insertRepoItem(db, { id: 101, owner: 'a', name: 'binned' });
    insertRepoItem(db, { id: 202, owner: 'a', name: 'kept' });
    const { baseUrl, paths } = await readmeServer({ 'a/binned': 'mcp-servers', 'a/kept': 'netbox' });

    dismissItem(db, keyFor(url), '2026-08-14T10:00:00.000Z');

    await run(db, [searchSource()], baseUrl);

    expect(paths).toEqual(['/repos/a/kept/readme']);
    expect(getRepoReadme(db, 101)).toBeNull();
  });

  it('never spends a request on a fork or an archived repo', async () => {
    const db = migratedDb();
    insertRepoItem(db, { id: 101, owner: 'a', name: 'forked', fork: true });
    insertRepoItem(db, { id: 202, owner: 'a', name: 'dead', archived: true });
    insertRepoItem(db, { id: 303, owner: 'a', name: 'good' });
    const { baseUrl, paths } = await readmeServer({ 'a/good': 'mcp-servers' });

    await run(db, [searchSource()], baseUrl);

    expect(paths).toEqual(['/repos/a/good/readme']);
  });

  it('asks for one repo once even when a rename gave it two item_keys', async () => {
    const db = migratedDb();
    insertRepoItem(db, { id: 101, owner: 'old', name: 'name', fetchedAt: '2026-08-13T11:00:00.000Z' });
    insertRepoItem(db, { id: 101, owner: 'new', name: 'name', fetchedAt: '2026-08-14T11:00:00.000Z' });
    const { baseUrl, paths } = await readmeServer({ 'new/name': 'mcp-servers', 'old/name': 'netbox' });

    const sweep = await run(db, [searchSource()], baseUrl);

    expect(paths).toEqual(['/repos/new/name/readme']); // the newer name wins
    expect(sweep.examined).toBe(1);
  });
});

// ===========================================================================
// Contract with the rest of the system
// ===========================================================================

describe('enrichRepoReadmes — scope and shape', () => {
  it('ignores sources that are not github_search', async () => {
    const db = migratedDb();
    insertRepoItem(db, { id: 101, owner: 'a', name: 'one', sourceId: 'krebs' });
    const { baseUrl, paths } = await readmeServer({ 'a/one': 'mcp-servers' });

    const sweep = await run(db, [rssSource()], baseUrl);

    expect(sweep.examined).toBe(0);
    expect(paths).toHaveLength(0);
  });

  it('returns an all-zero sweep and no report when no github_search source is configured', async () => {
    const db = migratedDb();
    const sweep = await enrichRepoReadmes(db, [rssSource()], { now: NOW });
    expect(sweep).toEqual({ examined: 0, unusable: 0, answered: 0, failed: 0, report: null });
  });

  it('counts an unreadable raw_json instead of failing the cycle', async () => {
    const db = migratedDb();
    insertRepoItem(db, { id: 101, owner: 'a', name: 'bad', rawJson: 'not json at all' });
    insertRepoItem(db, { id: 202, owner: 'a', name: 'good' });
    const { baseUrl, paths } = await readmeServer({ 'a/good': 'mcp-servers' });

    const sweep = await run(db, [searchSource()], baseUrl);

    expect(sweep.unusable).toBe(1);
    expect(paths).toEqual(['/repos/a/good/readme']);
  });

  it('behaves identically whatever the host timezone is -- it has no calendar semantics', async () => {
    const original = process.env.TZ;
    const results: Array<string | null | undefined> = [];
    try {
      for (const tz of ['America/New_York', 'Asia/Tokyo', 'UTC']) {
        process.env.TZ = tz;
        const db = migratedDb();
        insertRepoItem(db, { id: 101, owner: 'a', name: 'one' });
        const { baseUrl } = await readmeServer({ 'a/one': 'mcp-servers' });
        await run(db, [searchSource()], baseUrl);
        results.push(getRepoReadme(db, 101)?.answeredAt);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    expect(results).toEqual([NOW, NOW, NOW]);
  });
});

// ===========================================================================
// Cadence. The scheduler ticks every 60s by DEFAULT, but task 6 sized its
// 8-requests-per-sweep cap against "an hourly poll ... 13% of the budget".
// Running the sweep on every tick spends the whole 60/hour Core budget in
// about six minutes and then holds it at the reserve floor for the rest of the
// hour -- which is precisely what task 6 says enrichment must never do:
// "it must never be the reason something else cannot run."
// ===========================================================================

describe('repoSourceWasDue — ties the enrichment cadence to the repo source poll_interval', () => {
  const outcome = (kind: string, sourceId = 'github-topics') => ({ sourceId, kind });

  it('is true when a github_search source was actually polled', () => {
    expect(repoSourceWasDue([searchSource()], [outcome('success')])).toBe(true);
  });

  it('is true when the SEARCH failed -- a README is a different endpoint and a different budget', () => {
    // Core and search have separate ceilings and separate reset windows
    // (src/fetch/github.ts). A search outage is no reason to stop reading
    // READMEs for repos already stored.
    expect(repoSourceWasDue([searchSource()], [outcome('failure')])).toBe(true);
  });

  it('is false when the source was not due this tick', () => {
    expect(repoSourceWasDue([searchSource()], [outcome('not-due')])).toBe(false);
  });

  it('is false when the source is in backoff or disabled', () => {
    expect(repoSourceWasDue([searchSource()], [outcome('backoff')])).toBe(false);
    expect(repoSourceWasDue([searchSource()], [outcome('skipped')])).toBe(false);
  });

  it('ignores a non-github_search source that WAS polled', () => {
    expect(repoSourceWasDue([searchSource(), rssSource()], [outcome('not-due'), outcome('success', 'krebs')])).toBe(false);
  });

  it('is false when no github_search source is configured at all', () => {
    expect(repoSourceWasDue([rssSource()], [outcome('success', 'krebs')])).toBe(false);
  });
});

// ===========================================================================
// The anti-drift tie between task 6's union and this module's storage
// ===========================================================================

describe('readmeObservationFor — every ReadmeOutcome maps to the right knownness', () => {
  const outcomes: ReadmeOutcome[] = [
    { kind: 'fetched', path: 'README.md', firstParagraph: 'A description of the repository.' },
    { kind: 'fetched', path: 'README', firstParagraph: null },
    { kind: 'cached', firstParagraph: 'Something stored earlier.' },
    { kind: 'cached', firstParagraph: null },
    { kind: 'absent' },
    { kind: 'unreadable', why: 'encoding' },
    { kind: 'unreadable', why: 'malformed' },
    { kind: 'skipped', why: 'budget' },
    { kind: 'skipped', why: 'over-limit' },
    { kind: 'skipped', why: 'dismissed' },
    { kind: 'skipped', why: 'suppressed' },
    { kind: 'error', status: 503, message: 'Server Error' },
  ];

  it('records an ANSWER exactly when src/enrich/repo.ts calls the outcome known', () => {
    // The one rule this task must not break, tied to its source rather than
    // restated. `cached` is known but records nothing NEW -- it came from this
    // very table -- so it is excluded explicitly rather than by omission.
    for (const outcome of outcomes) {
      const observation = readmeObservationFor(outcome, {
        repoId: 1,
        fullName: 'a/b',
        observedAt: NOW,
      });
      const recordsAnAnswer = observation !== null && observation.outcome !== 'failed';
      const expected = isReadmeKnown(outcome) && outcome.kind !== 'cached';
      expect([outcome.kind, recordsAnAnswer]).toEqual([outcome.kind, expected]);
    }
  });

  it('records nothing at all for a skipped or cached outcome', () => {
    for (const outcome of outcomes.filter((o) => o.kind === 'skipped' || o.kind === 'cached')) {
      expect(readmeObservationFor(outcome, { repoId: 1, fullName: 'a/b', observedAt: NOW })).toBeNull();
    }
  });

  it('records a failure -- never an answer -- for unreadable and error', () => {
    for (const outcome of outcomes.filter((o) => o.kind === 'unreadable' || o.kind === 'error')) {
      const observation = readmeObservationFor(outcome, { repoId: 1, fullName: 'a/b', observedAt: NOW });
      expect(observation?.outcome).toBe('failed');
    }
  });
});

function keyFor(url: string): string {
  // sha256(canonicalUrl), exactly as src/domain/item.ts derives it.
  return createHash('sha256').update(url).digest('hex');
}
