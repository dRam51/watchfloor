import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../../src/db/connection.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { insertItem, type NewItem } from '../../src/domain/item.ts';
import {
  parseGithubRepoRef,
  repoRefKey,
  titleMentionsRepo,
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
