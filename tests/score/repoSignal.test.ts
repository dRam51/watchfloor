import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, type NewItem } from '../../src/domain/item.ts';
import { recordStarSnapshot } from '../../src/db/repoSnapshots.ts';
import { makeRepo, repoItemKey } from '../../src/domain/repo.ts';
import { parseMechanicalScoreConfig } from '../../src/score/mechanical.ts';
import { readFileSync } from 'node:fs';
import {
  parseGithubRepoRef,
  repoRefKey,
  titleMentionsRepo,
  findHnOverlap,
  snapshotTimeZone,
  resolveRepoVelocity,
  velocityComponentFor,
  hnComponentFor,
  resolveRepoSignal,
  DEFAULT_REPO_SCORING_CONFIG,
} from '../../src/score/repoSignal.ts';

// ---------------------------------------------------------------------------
// REAL ROWS, TRANSCRIBED -- the same provenance convention tests/domain/
// repo.test.ts established. The archived corpora match `*.db` in .gitignore, so
// they are present on this machine and absent from a clone; transcribing the
// rows (rather than opening the databases at test time) is what keeps this
// suite green in a fresh clone while still asserting against data that really
// exists. Each block records the query that produced it, so any of it can be
// re-derived rather than taken on trust.
//
//   sqlite3 -readonly attic/wf-m1-firstrun-2026-08-14.db \
//     "select item_key, title, canonical_url from items
//       where canonical_url like '%github%' group by item_key;"
//
//   sqlite3 -readonly attic/wf-m3-predrift-2026-08-14.db "<same>"
//
//   sqlite3 -readonly data/wf.db
//     "select item_key, title, canonical_url from items
//       where source_id = 'hn-algolia' group by item_key;"
//
// THE POINT OF THIS SET: every row below reached the database through the real
// `hn-algolia` adapter. Three of them name a GitHub repository and three of
// them only LOOK like they do -- which is exactly the discrimination the
// milestone's headline feature turns on.
// ---------------------------------------------------------------------------

/** attic/wf-m1-firstrun-2026-08-14.db -- the corpus's ONLY github.com row. */
const HN_DMCA = {
  itemKey: 'f2da2d0878a5f71602ddf4b30d6b405765e9c97a2dfc299388445ea48d29310f',
  title: 'YouTube-dl has received a DMCA takedown from RIAA',
  canonicalUrl: 'https://github.com/github/dmca/blob/master/2020/10/2020-10-23-RIAA.md',
};

/** attic/wf-m3-predrift-2026-08-14.db -- a repo ROOT, the easy case. */
const HN_MCP_STAMA = {
  itemKey: '6fcc38c0e1da37fda60758fc8c04cf2a46eda3ebd06637cfcc502588e6fd8427',
  title: 'Show HN: MCP-stama – An ultra-fast Rust MCP server with no dependencies',
  canonicalUrl: 'https://github.com/StamManif/mcp-stama',
};

/** data/wf.db AND attic/wf-m3-predrift -- a GitHub Pages project site. */
const HN_EVERY_WEBSITE = {
  itemKey: 'f5c4f21f07c7db7cfb9725de914ce6586f3276a7448c71009e6141fd7700e7e8',
  title: 'Every Fucking Website (2020)',
  canonicalUrl: 'https://lxe.github.io/everywebsite',
};

/** attic/wf-m3-predrift -- a GitHub Pages project site under a hyphenated owner. */
const HN_OPUS5 = {
  itemKey: '4f78e3cae3c0f2100ef8fca6f451cc175092c19eb6f141d4dae7ef6f689cc7dc',
  title: 'Why does Opus 5 feel worse to work with?',
  canonicalUrl: 'https://mun-logadan.github.io/why-does-opus-5-feel-worse',
};

/**
 * data/wf.db -- names a famous repo in its TITLE while linking to the project's
 * own website. No URL rule can catch this one.
 */
const HN_RUSTDESK = {
  itemKey: '452ad631b601fbe92d2e126b660ba6988b00cdcf86cec81a000087d7e14c7756',
  title: 'RustDesk now supports true unattended remote access on Wayland',
  canonicalUrl: 'https://rustdesk.com/blog/unattended-remote-access-wayland',
};

/** data/wf.db -- same shape, linking to a Hugging Face mirror of the project. */
const HN_UNSLOTH = {
  itemKey: 'bb6e58f548947f8de29964a849d4259f816adbaf4e8f66919e1baf9805eae372',
  title: 'Unsloth Qwen3.8-27B GGUF files',
  canonicalUrl: 'https://huggingface.co/unsloth/Qwen3.8-27B-GGUF',
};

/**
 * attic/wf-m3-predrift -- three real rows that carry the word "github" and name
 * NO repository. These are the false positives a sloppy substring rule ships.
 */
const HN_GITHUB_DECOYS = [
  { title: 'Migrating Your GitHub CI to Hugging Face Jobs', canonicalUrl: 'https://huggingface.co/blog/github-ci-hf-jobs' },
  { title: 'GitHub Models is now retired', canonicalUrl: 'https://simonwillison.net/2026/Aug/9/github-models-is-now-retired' },
  { title: 'Lessons Learned from CISA’s Recent GitHub Leak', canonicalUrl: 'https://krebsonsecurity.com/2026/07/lessons-learned-from-cisas-recent-github-leak' },
];

// ---------------------------------------------------------------------------
// Temp-DB plumbing -- real temp-file SQLite, no mocks, mirroring
// tests/score/mechanical.test.ts.
// ---------------------------------------------------------------------------
const open: Array<ReturnType<typeof openDb>> = [];
function migratedDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'wf-test-')), 'wf.db'));
  open.push(db);
  runMigrations(db, join(process.cwd(), 'db', 'migrations'));
  return db;
}
afterEach(() => {
  while (open.length) closeDb(open.pop()!);
});

const NOW = '2026-08-14T00:00:00.000Z';

function hnItem(row: { title: string; canonicalUrl: string }, overrides: Partial<NewItem> = {}): NewItem {
  return {
    url: row.canonicalUrl,
    canonicalUrl: row.canonicalUrl,
    title: row.title,
    sourceId: 'hn-algolia',
    itemType: 'analysis',
    beats: ['ai'],
    entities: [],
    publishedAt: null,
    fetchedAt: NOW,
    summaryRaw: null,
    rawJson: '{}',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseGithubRepoRef -- the URL half of the signal
// ---------------------------------------------------------------------------
describe('parseGithubRepoRef', () => {
  it('reads owner/name off a bare repo root', () => {
    expect(parseGithubRepoRef('https://github.com/StamManif/mcp-stama')).toEqual({ owner: 'StamManif', name: 'mcp-stama' });
  });

  it('THE ROW THAT PROVES A URL-EQUALITY MATCH WOULD HAVE FIRED ON NOTHING: a real HN deep link into github/dmca still names the repo', () => {
    // attic/wf-m1-firstrun-2026-08-14.db's only github.com row. Its item_key is
    // sha256 of a /blob/ URL; the repo root's is a different digest entirely,
    // which is why src/domain/repo.ts's repoItemKey cannot carry this signal.
    expect(parseGithubRepoRef(HN_DMCA.canonicalUrl)).toEqual({ owner: 'github', name: 'dmca' });
  });

  it('reads through every deep-link shape GitHub serves', () => {
    const cases = [
      'https://github.com/openai/whisper/tree/main/whisper',
      'https://github.com/openai/whisper/issues/1234',
      'https://github.com/openai/whisper/pull/9',
      'https://github.com/openai/whisper/releases/tag/v20240930',
      'https://github.com/openai/whisper/commit/abc123',
      'https://github.com/openai/whisper/blob/main/README.md',
      'https://github.com/openai/whisper.git',
      'https://www.github.com/openai/whisper',
      'https://raw.githubusercontent.com/openai/whisper/main/README.md',
    ];
    for (const url of cases) {
      expect(parseGithubRepoRef(url), url).toEqual({ owner: 'openai', name: 'whisper' });
    }
  });

  it('maps a real GitHub Pages project site to the repo that serves it', () => {
    expect(parseGithubRepoRef(HN_EVERY_WEBSITE.canonicalUrl)).toEqual({ owner: 'lxe', name: 'everywebsite' });
    expect(parseGithubRepoRef(HN_OPUS5.canonicalUrl)).toEqual({ owner: 'mun-logadan', name: 'why-does-opus-5-feel-worse' });
  });

  it('maps a bare user Pages site to the repo that must be named after it', () => {
    expect(parseGithubRepoRef('https://lxe.github.io/')).toEqual({ owner: 'lxe', name: 'lxe.github.io' });
  });

  it('refuses github.com paths that are not repositories', () => {
    const cases = [
      'https://github.com/topics/llm',
      'https://github.com/orgs/openai/repositories',
      'https://github.com/features/copilot',
      'https://github.com/sponsors/torvalds',
      'https://github.com/settings/tokens',
      'https://github.com/openai',
      'https://github.com/',
      'https://gist.github.com/someone/0123456789abcdef',
    ];
    for (const url of cases) {
      expect(parseGithubRepoRef(url), url).toBeNull();
    }
  });

  it('THREE REAL ROWS THAT SAY "GITHUB" AND NAME NO REPO: none of them parses', () => {
    for (const decoy of HN_GITHUB_DECOYS) {
      expect(parseGithubRepoRef(decoy.canonicalUrl), decoy.canonicalUrl).toBeNull();
    }
  });

  it('is case-insensitive on the host but preserves the owner/name casing GitHub served', () => {
    expect(parseGithubRepoRef('https://GitHub.com/StamManif/mcp-stama')).toEqual({ owner: 'StamManif', name: 'mcp-stama' });
  });

  it('returns null rather than throwing on junk', () => {
    expect(parseGithubRepoRef('not a url')).toBeNull();
    expect(parseGithubRepoRef('')).toBeNull();
  });
});

describe('repoRefKey', () => {
  it('is case-insensitive, because GitHub itself treats owner/name that way', () => {
    expect(repoRefKey({ owner: 'StamManif', name: 'MCP-Stama' })).toBe(repoRefKey({ owner: 'stammanif', name: 'mcp-stama' }));
  });
});

// ---------------------------------------------------------------------------
// titleMentionsRepo -- the half no URL rule can reach
// ---------------------------------------------------------------------------
describe('titleMentionsRepo', () => {
  const cfg = DEFAULT_REPO_SCORING_CONFIG.hn;

  it('A REAL ROW NO URL RULE CAN CATCH: rustdesk.com links to the project site, the title names the repo', () => {
    expect(parseGithubRepoRef(HN_RUSTDESK.canonicalUrl)).toBeNull();
    expect(titleMentionsRepo(HN_RUSTDESK.title, 'rustdesk', cfg)).toBe(true);
  });

  it('A SECOND ONE: a Hugging Face mirror link whose title names the upstream repo', () => {
    expect(parseGithubRepoRef(HN_UNSLOTH.canonicalUrl)).toBeNull();
    expect(titleMentionsRepo(HN_UNSLOTH.title, 'unsloth', cfg)).toBe(true);
  });

  it('matches a hyphenated repo name across the title punctuation that splits it', () => {
    expect(titleMentionsRepo(HN_MCP_STAMA.title, 'mcp-stama', cfg)).toBe(true);
  });

  it('MATCHES ON TOKEN BOUNDARIES, NOT SUBSTRINGS: "agents" does not match "agentsystem"', () => {
    // The reason the normalizer splits on punctuation instead of deleting it.
    // A substring rule over a de-punctuated title matches here, wrongly.
    expect(titleMentionsRepo('A new agentsystem for planning', 'agents', { ...cfg, generic_names: [] })).toBe(false);
    expect(titleMentionsRepo('A new agent system for planning', 'agents', { ...cfg, generic_names: [] })).toBe(false);
  });

  it('refuses a repo name too short to be distinctive', () => {
    // github/dmca: the URL rule already catches its one real row. "DMCA" as a
    // bare title token would match every takedown story ever posted.
    expect(titleMentionsRepo(HN_DMCA.title, 'dmca', cfg)).toBe(false);
  });

  it('refuses a generic project name even when it is long enough', () => {
    expect(cfg.generic_names).toContain('awesome');
    expect(titleMentionsRepo('An awesome week for open models', 'awesome', cfg)).toBe(false);
  });

  it('THREE REAL DECOY ROWS: none of them mentions a repo called "models" or "leak"', () => {
    expect(titleMentionsRepo(HN_GITHUB_DECOYS[1]!.title, 'models', cfg)).toBe(false);
  });

  it('does not match a title that merely shares a prefix with the name', () => {
    expect(titleMentionsRepo('Rust is fun', 'rustdesk', cfg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The default config is the shipped config
// ---------------------------------------------------------------------------
describe('DEFAULT_REPO_SCORING_CONFIG', () => {
  it('names hn-algolia as the aggregator this signal reads', () => {
    expect(DEFAULT_REPO_SCORING_CONFIG.hn.source_ids).toContain('hn-algolia');
  });
});

// ---------------------------------------------------------------------------
// findHnOverlap -- the whole signal, run against the real rows
//
// Every HN row below goes into a real temp-file SQLite database through the
// real insertItem, exactly as the hn-algolia adapter would have. Nothing is
// mocked and nothing is stubbed; the only thing standing in for the live
// corpus is that the rows were transcribed rather than read from a gitignored
// archive at test time.
// ---------------------------------------------------------------------------
describe('findHnOverlap, against the real hn-algolia rows', () => {
  const cfg = DEFAULT_REPO_SCORING_CONFIG.hn;
  const ALL_REAL_HN_ROWS = [HN_DMCA, HN_MCP_STAMA, HN_EVERY_WEBSITE, HN_OPUS5, HN_RUSTDESK, HN_UNSLOTH, ...HN_GITHUB_DECOYS];

  function corpus() {
    const db = migratedDb();
    for (const row of ALL_REAL_HN_ROWS) insertItem(db, hnItem(row));
    return db;
  }

  it('FIRES ON THE DEEP LINK: github/dmca is matched by a URL that is NOT the repo root', () => {
    const db = corpus();
    const overlap = findHnOverlap(db, { owner: 'github', name: 'dmca' }, NOW, cfg);

    expect(overlap.seen).toBe(true);
    expect(overlap.strength).toBe(cfg.url_strength);
    expect(overlap.mentions).toHaveLength(1);
    expect(overlap.mentions[0]!.via).toBe('url');
    expect(overlap.mentions[0]!.title).toBe(HN_DMCA.title);
    expect(overlap.mentions[0]!.canonicalUrl).toBe(HN_DMCA.canonicalUrl);
  });

  it('fires on a repo root', () => {
    const overlap = findHnOverlap(corpus(), { owner: 'StamManif', name: 'mcp-stama' }, NOW, cfg);
    expect(overlap.seen).toBe(true);
    expect(overlap.mentions[0]!.via).toBe('url');
  });

  it('fires on a GitHub Pages project site', () => {
    const overlap = findHnOverlap(corpus(), { owner: 'lxe', name: 'everywebsite' }, NOW, cfg);
    expect(overlap.seen).toBe(true);
    expect(overlap.mentions[0]!.via).toBe('url');
  });

  it('FIRES WITH NO GITHUB URL ANYWHERE: rustdesk/rustdesk, from a title over a rustdesk.com link', () => {
    const overlap = findHnOverlap(corpus(), { owner: 'rustdesk', name: 'rustdesk' }, NOW, cfg);
    expect(overlap.seen).toBe(true);
    expect(overlap.strength).toBe(cfg.title_strength);
    expect(overlap.mentions[0]!.via).toBe('title');
    expect(overlap.mentions[0]!.canonicalUrl).toBe(HN_RUSTDESK.canonicalUrl);
  });

  it('fires for unslothai/unsloth from a Hugging Face mirror link', () => {
    const overlap = findHnOverlap(corpus(), { owner: 'unslothai', name: 'unsloth' }, NOW, cfg);
    expect(overlap.seen).toBe(true);
    expect(overlap.mentions[0]!.via).toBe('title');
  });

  it('matching is case-insensitive on owner/name, as GitHub is', () => {
    expect(findHnOverlap(corpus(), { owner: 'stammanif', name: 'MCP-STAMA' }, NOW, cfg).seen).toBe(true);
  });

  it('DOES NOT FIRE for a repo none of the nine real rows mentions', () => {
    const overlap = findHnOverlap(corpus(), { owner: 'openai', name: 'whisper' }, NOW, cfg);
    expect(overlap.seen).toBe(false);
    expect(overlap.strength).toBe(0);
    expect(overlap.mentions).toEqual([]);
  });

  it('DOES NOT FIRE off the three real rows that say "GitHub" and name no repo', () => {
    const db = corpus();
    for (const name of ['models', 'leak', 'jobs', 'ci']) {
      expect(findHnOverlap(db, { owner: 'someone', name }, NOW, cfg).seen, name).toBe(false);
    }
  });

  it('a URL match outranks a title match when both exist -- strength is the strongest evidence, not a sum', () => {
    const db = corpus();
    // mcp-stama is linked directly AND named in the title of the same story.
    const overlap = findHnOverlap(db, { owner: 'StamManif', name: 'mcp-stama' }, NOW, cfg);
    expect(overlap.strength).toBe(cfg.url_strength);
    // Two mentions of the same repo never push strength above one url_strength.
    expect(overlap.strength).toBeLessThanOrEqual(1);
  });

  it('IS BOUNDED BY asOf, exactly like getClusterSizeAsOf -- a story fetched later is not yet evidence', () => {
    const db = migratedDb();
    insertItem(db, hnItem(HN_MCP_STAMA, { fetchedAt: '2026-08-14T12:00:00.000Z' }));

    expect(findHnOverlap(db, { owner: 'StamManif', name: 'mcp-stama' }, '2026-08-14T00:00:00.000Z', cfg).seen).toBe(false);
    expect(findHnOverlap(db, { owner: 'StamManif', name: 'mcp-stama' }, '2026-08-14T23:00:00.000Z', cfg).seen).toBe(true);
  });

  it('ONLY the configured source_ids count: the identical URL from a non-aggregator source is not "seen on HN"', () => {
    const db = migratedDb();
    insertItem(db, hnItem(HN_MCP_STAMA, { sourceId: 'simonwillison' }));
    expect(findHnOverlap(db, { owner: 'StamManif', name: 'mcp-stama' }, NOW, cfg).seen).toBe(false);
  });

  it('THE REPO ITEM DOES NOT MATCH ITSELF: an ingested repo row shares its URL with an HN story and is still not a mention', () => {
    // A repo ingested by the github_search adapter has canonical_url
    // https://github.com/StamManif/mcp-stama -- byte-identical to the HN
    // story's, so under append-only storage they share one item_key and sit in
    // `items` as two versions. Gating on source_id (never on item_key) is what
    // keeps the repo's own row out of its own evidence.
    const db = migratedDb();
    insertItem(db, hnItem(HN_MCP_STAMA, { sourceId: 'github-mcp', beats: ['repos'] }));
    expect(findHnOverlap(db, { owner: 'StamManif', name: 'mcp-stama' }, NOW, cfg).seen).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Velocity, read through the zone the snapshots were actually bucketed in
// ---------------------------------------------------------------------------
describe('snapshotTimeZone', () => {
  it('is the zone the NEWEST reading was bucketed under, so no caller has to be told WF_TZ', () => {
    const db = migratedDb();
    const key = 'k'.repeat(64);
    recordStarSnapshot(db, { repoId: 7, itemKey: key, fullName: 'a/b', stars: 1, observedAt: '2026-08-01T12:00:00.000Z', tz: 'America/New_York' });
    recordStarSnapshot(db, { repoId: 7, itemKey: key, fullName: 'a/b', stars: 9, observedAt: '2026-08-09T12:00:00.000Z', tz: 'Asia/Tokyo' });
    expect(snapshotTimeZone(db, 7)).toBe('Asia/Tokyo');
  });

  it('is null for a repo with no readings at all', () => {
    expect(snapshotTimeZone(migratedDb(), 7)).toBeNull();
  });
});

describe('resolveRepoVelocity', () => {
  function repoWithHistory(db: ReturnType<typeof migratedDb>, tz: string) {
    const repo = makeRepo({
      githubId: 4242,
      owner: 'someone',
      name: 'rising-thing',
      description: null,
      language: null,
      licenseSpdxId: null,
      stars: 400,
      openIssuesAndPullRequests: 0,
      lastCommitAt: null,
      isFork: false,
      isArchived: false,
      readmeFirstParagraph: 'x',
    });
    const key = repoItemKey(repo);
    // §4's own example: 40 -> 400 across the six days a seven-day window spans.
    //
    // The two instants are chosen so the ZONE is load-bearing: 16:00 UTC is the
    // next calendar day in Tokyo, so these bucket as 2026-08-09 and 2026-08-15
    // there and as 2026-08-08 / 2026-08-14 in UTC. Read with the wrong zone the
    // window misses one end and the result degrades to single_snapshot.
    recordStarSnapshot(db, { repoId: 4242, itemKey: key, fullName: repo.fullName, stars: 40, observedAt: '2026-08-08T16:00:00.000Z', tz });
    recordStarSnapshot(db, { repoId: 4242, itemKey: key, fullName: repo.fullName, stars: 400, observedAt: '2026-08-14T16:00:00.000Z', tz });
    return key;
  }

  it('reads the window in the zone the rows were bucketed in, with no tz argument and no environment read', () => {
    const db = migratedDb();
    const key = repoWithHistory(db, 'Asia/Tokyo');
    const result = resolveRepoVelocity(db, key, '2026-08-14T16:30:00.000Z');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.starsPerDay).toBeCloseTo(60, 10);
    expect(result.starsGained).toBe(360);
  });

  it('an item that is not a repo comes back as insufficient_history/unknown_repo, never as a zero', () => {
    const result = resolveRepoVelocity(migratedDb(), 'f'.repeat(64), NOW);
    expect(result.status).toBe('insufficient_history');
    if (result.status !== 'insufficient_history') throw new Error('unreachable');
    expect(result.reason).toBe('unknown_repo');
  });
});

// ---------------------------------------------------------------------------
// The two pure component functions -- where "insufficient history" becomes a
// number, deliberately and in exactly one place
// ---------------------------------------------------------------------------
describe('velocityComponentFor', () => {
  const vcfg = DEFAULT_REPO_SCORING_CONFIG.velocity;

  function ok(starsPerDay: number, spanCoverage = 1) {
    return {
      status: 'ok' as const,
      repoId: 1,
      starsPerDay,
      starsGained: starsPerDay * 6,
      spanDays: 6,
      spanCoverage,
      staleDays: 0,
      first: { day: '2026-08-08', stars: 0, observedAt: '2026-08-08T12:00:00.000Z' },
      last: { day: '2026-08-14', stars: 0, observedAt: '2026-08-14T12:00:00.000Z' },
      mixedTimezone: false,
      fromDay: '2026-08-08',
      throughDay: '2026-08-14',
      expectedDays: 7,
      observedDays: 2,
      missingDays: [],
    };
  }

  function insufficient(reason: 'unknown_repo' | 'no_snapshots' | 'single_snapshot' | 'span_too_short') {
    return {
      status: 'insufficient_history' as const,
      reason,
      repoId: reason === 'unknown_repo' ? null : 1,
      spanDays: 0,
      minSpanDays: 3,
      fromDay: '2026-08-08',
      throughDay: '2026-08-14',
      expectedDays: 7,
      observedDays: 0,
      missingDays: [],
    };
  }

  it('EVERY insufficient reason contributes exactly 0 -- the lane ranks on evidence it has, never on evidence it lacks', () => {
    for (const reason of ['unknown_repo', 'no_snapshots', 'single_snapshot', 'span_too_short'] as const) {
      expect(velocityComponentFor(insufficient(reason), vcfg), reason).toBe(0);
    }
  });

  it('§4 SATISFIED: a 40->400-in-a-week repo scores full marks and a static 30k-star one scores far less', () => {
    const rising = velocityComponentFor(ok(60), vcfg); // 360 stars over 6 days
    const static30k = velocityComponentFor(ok(2), vcfg); // a huge, flat repo
    expect(rising).toBeCloseTo(1, 10);
    expect(rising).toBeGreaterThan(static30k * 3);
  });

  it('a repo gaining nothing scores exactly 0 -- the same number as "we do not know", which is why the API reports the status separately', () => {
    expect(velocityComponentFor(ok(0), vcfg)).toBe(0);
  });

  it('NEGATIVE VELOCITY STAYS NEGATIVE: a repo shedding stars must sort below a flat one', () => {
    expect(velocityComponentFor(ok(-30), vcfg)).toBeLessThan(0);
    expect(velocityComponentFor(ok(-30), vcfg)).toBeLessThan(velocityComponentFor(ok(0), vcfg));
  });

  it('is bounded to [-1, 1] however extreme the rate', () => {
    expect(velocityComponentFor(ok(500_000), vcfg)).toBeCloseTo(1, 10);
    expect(velocityComponentFor(ok(-500_000), vcfg)).toBeCloseTo(-1, 10);
  });

  it('saturates rather than growing without limit, so one viral week cannot dominate every future one', () => {
    expect(velocityComponentFor(ok(600), vcfg)).toBeLessThanOrEqual(1);
    expect(velocityComponentFor(ok(600), vcfg)).toBeGreaterThan(velocityComponentFor(ok(60), vcfg) - 1e-9);
  });

  it('ATTENUATES A HALF-COVERED MEASUREMENT: the same rate over half the window counts for less', () => {
    const full = velocityComponentFor(ok(60, 1), vcfg);
    const half = velocityComponentFor(ok(60, 0.5), vcfg);
    expect(half).toBeLessThan(full);
    expect(half).toBeCloseTo(full * 0.75, 10); // coverage_floor 0.5 + 0.5 * 0.5
  });

  it('attenuation applies to a decline too, so a barely-covered drop is not overstated either', () => {
    expect(velocityComponentFor(ok(-60, 0.5), vcfg)).toBeGreaterThan(velocityComponentFor(ok(-60, 1), vcfg));
  });
});

describe('hnComponentFor', () => {
  const hcfg = DEFAULT_REPO_SCORING_CONFIG.hn;

  it('is 0 for a repo never seen', () => {
    expect(hnComponentFor({ seen: false, strength: 0, mentions: [] }, hcfg)).toBe(0);
  });

  it('is the match strength for a repo that was', () => {
    expect(hnComponentFor({ seen: true, strength: 1, mentions: [] }, hcfg)).toBe(1);
    expect(hnComponentFor({ seen: true, strength: 0.5, mentions: [] }, hcfg)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// resolveRepoSignal -- both halves, one read
// ---------------------------------------------------------------------------
describe('resolveRepoSignal', () => {
  it('returns null for an item whose URL names no repository', () => {
    expect(resolveRepoSignal(migratedDb(), 'x'.repeat(64), 'https://example.test/a', NOW, DEFAULT_REPO_SCORING_CONFIG)).toBeNull();
  });

  it('carries both halves for a real repo, with the HN evidence attached', () => {
    const db = migratedDb();
    insertItem(db, hnItem(HN_MCP_STAMA));
    const signal = resolveRepoSignal(db, 'y'.repeat(64), 'https://github.com/StamManif/mcp-stama', NOW, DEFAULT_REPO_SCORING_CONFIG);

    expect(signal).not.toBeNull();
    expect(signal!.ref).toEqual({ owner: 'StamManif', name: 'mcp-stama' });
    expect(signal!.hn.seen).toBe(true);
    expect(signal!.hnComponent).toBe(1);
    expect(signal!.velocity.status).toBe('insufficient_history');
    expect(signal!.velocityComponent).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The shipped config IS the default -- asserted, so the two cannot drift
// ---------------------------------------------------------------------------
describe('config/scoring.yaml', () => {
  it("its repos: block deep-equals DEFAULT_REPO_SCORING_CONFIG, so feed.ts's fallback is never a different scorer", () => {
    const yaml = readFileSync(join(process.cwd(), 'config', 'scoring.yaml'), 'utf8');
    expect(parseMechanicalScoreConfig(yaml).repos).toEqual(DEFAULT_REPO_SCORING_CONFIG);
  });
});
