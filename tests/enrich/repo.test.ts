import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitHubClient } from '../../src/fetch/github.ts';
import {
  MAX_EXCERPT_LENGTH,
  hasNoReadme,
  intrinsicSuppressionReasons,
  type Repo,
} from '../../src/domain/repo.ts';
import {
  MIN_PROSE_CHARS,
  MIN_PROSE_WORDS,
  README_FETCH_LIMITS,
  enrichRepos,
  extractReadmeFirstParagraph,
  fetchReadme,
  isReadmeKnown,
  readmePath,
  type ReadmeOutcome,
  type RepoFacts,
} from '../../src/enrich/repo.ts';

// ---------------------------------------------------------------------------
// Fixtures: REAL, LIVE captures of GET /repos/{owner}/{repo}/readme, replayed
// from a real local http server through the real GitHubClient. No mocks, no
// network. See tests/fixtures/github-readme/_capture.json for provenance,
// including which bodies were truncated to a prefix and why.
//
// These are the whole point of the file. A README-paragraph extractor tested
// only against hand-written Markdown proves nothing: every rule below exists
// because a real README broke a simpler one.
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'github-readme');

interface ReadmeFixture {
  name?: string;
  path?: string;
  size?: number;
  content?: string;
  encoding?: string;
  message?: string;
}

function fixture(name: string): ReadmeFixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')) as ReadmeFixture;
}

function fixtureText(name: string): string {
  const { content } = fixture(name);
  if (content === undefined) throw new Error(`fixture ${name} has no base64 content`);
  return Buffer.from(content, 'base64').toString('utf8');
}

const capture = JSON.parse(readFileSync(join(FIXTURE_DIR, '_capture.json'), 'utf8')) as {
  files: Record<string, { repo: string; first_paragraph?: string; readme_path?: string }>;
};

// ---------------------------------------------------------------------------
// Local server plumbing -- the pattern tests/fetch/github.test.ts established.
// ---------------------------------------------------------------------------

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

/** Rate-limit headers a healthy unauthenticated core response carries. */
function coreHeaders(remaining: number, limit = 60): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-ratelimit-limit': String(limit),
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-used': String(limit - remaining),
    'x-ratelimit-resource': 'core',
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
  };
}

/**
 * Serves one README fixture per `owner/name`, counting requests. A repo with no
 * mapping answers 404 with the real captured Not Found body -- which is exactly
 * what GitHub does for a repo that has no README.
 */
async function readmeServer(byFullName: Record<string, string>): Promise<{
  baseUrl: string;
  paths: string[];
  headersSeen: IncomingHttpHeaders[];
  remaining: () => number;
}> {
  const paths: string[] = [];
  const headersSeen: IncomingHttpHeaders[] = [];
  let used = 0;
  const baseUrl = await serve((req, res) => {
    used += 1;
    paths.push(req.url ?? '');
    headersSeen.push(req.headers);
    const match = /^\/repos\/([^/]+)\/([^/]+)\/readme$/.exec(req.url ?? '');
    const fullName = match ? `${match[1]}/${match[2]}` : '';
    const name = byFullName[fullName];
    if (name === undefined) {
      res.writeHead(404, coreHeaders(60 - used));
      res.end(JSON.stringify(fixture('no-readme-404')));
      return;
    }
    res.writeHead(200, coreHeaders(60 - used));
    res.end(JSON.stringify(fixture(name)));
  });
  return { baseUrl, paths, headersSeen, remaining: () => 60 - used };
}

const NOW = '2026-08-14T12:00:00.000Z';

let nextGithubId = 1;

/** A plausible search-response repo. Only the fields under test ever vary. */
function facts(overrides: Partial<RepoFacts> & Pick<RepoFacts, 'owner' | 'name'>): RepoFacts {
  return {
    githubId: (nextGithubId += 1),
    description: 'a repo',
    language: 'TypeScript',
    licenseSpdxId: 'MIT',
    stars: 100,
    openIssuesAndPullRequests: 5,
    lastCommitAt: '2026-08-13T12:00:00.000Z',
    isFork: false,
    isArchived: false,
    ...overrides,
  };
}

// ===========================================================================
// What "first paragraph" means -- pinned against the real READMEs that broke
// every simpler definition.
// ===========================================================================

describe('extractReadmeFirstParagraph — against real README content', () => {
  // Each expectation below is ALSO recorded in _capture.json, so a fixture and
  // its asserted answer cannot drift apart unnoticed.
  const cases: Array<[fixtureName: string, why: string]> = [
    [
      'mcp-servers',
      'the easy shape: an ATX title, then prose. Everything else on this list is why the easy shape is not the common one.',
    ],
    [
      'llama-cpp',
      'the whole header is `# title`, a raw <img>, an opening <div align="center">, then the tagline in <b> — the first prose is four words long, which is what sets the minimum-length floor.',
    ],
    [
      'langchain',
      'opens with a centred <picture> logo, then <h3>The agent engineering platform.</h3>, then four badge anchors. An HTML <h3> is a heading exactly as `###` is, so it is skipped and the real paragraph wins.',
    ],
    [
      'netbox',
      'the entire banner — logo, tagline, six badges and a nav row — is ONE block with no blank line in it, so blank-line splitting alone returns the whole banner. HTML block boundaries have to segment it.',
    ],
    [
      'garak',
      'an italic subtitle immediately under the title. Emphasis markers are stripped and the text judged on its own merits, so the subtitle wins over the longer paragraph below it.',
    ],
    [
      'llama-index',
      'a 3,952-character badge block, including a shields.io badge whose image URL embeds a base64 data: URI — the case that punishes a lazy image regex.',
    ],
    [
      'scikit-learn-rst',
      'README.rst, not .md: an RST comment, a |substitution| badge row, and a wall of `.. |X| image::` directives before any prose.',
    ],
    [
      'git-consortium',
      'a setext heading (underlined with ===) and a trailing [ref]: definition — neither is prose.',
    ],
    [
      'awesome',
      'the honest limit of the heuristic. Sponsor blurbs are skipped only because they are wholly inside <a> elements; the answer is the first real prose sentence, which is not a description of the project. That is what the README says first, so that is what is reported.',
    ],
    ['dify', 'the one capture whose first paragraph exceeds the 300-character cap.'],
    // The two below were added AFTER the first live run against the real API.
    // Neither shape appeared in the ten fixtures captured up front, and both
    // produced a confidently wrong answer rather than an error.
    [
      'whisper',
      'four [[Label]](url) nav links — a nested-bracket label the inline-link rule did not recognise, so only the bare URL was stripped and "[[Blog]]( [[Paper]](" came back as prose.',
    ],
    [
      'pytorch',
      'a bullet list directly under the opening sentence with NO blank line between them: blank-line splitting alone hands back the sentence and both bullets as one paragraph.',
    ],
  ];

  for (const [name, why] of cases) {
    it(`${name}: ${why}`, () => {
      const expected = capture.files[`${name}.json`]?.first_paragraph;
      expect(expected, `_capture.json must record the expected answer for ${name}`).toBeTypeOf('string');
      expect(extractReadmeFirstParagraph(fixtureText(name))).toBe(expected);
    });
  }

  it('returns null for a real README with no prose in it at all', () => {
    // octocat/Hello-World's README is the literal string "Hello World!". It is
    // a real README file, so a file-existence check would pass it — and the
    // lane would show a repo with nothing to say about itself.
    expect(fixtureText('hello-world-no-extension')).toBe('Hello World!\n');
    expect(extractReadmeFirstParagraph(fixtureText('hello-world-no-extension'))).toBeNull();
  });

  it('publishes the floor it applies, and the floor is low enough for the shortest real answer', () => {
    // llama.cpp's "LLM inference in C/C++" is 22 characters and 4 words. Any
    // stricter floor discards it, and llama.cpp has no other prose above the
    // fold — so this is a measured bound, not a taste.
    expect(MIN_PROSE_WORDS).toBe(4);
    expect(MIN_PROSE_CHARS).toBe(20);
    expect(capture.files['llama-cpp.json']?.first_paragraph).toBe('LLM inference in C/C++');
  });
});

describe('extractReadmeFirstParagraph — mechanics', () => {
  it('skips a fenced code block even when the fence contains a blank line', () => {
    // A blank line inside a fence would otherwise split it into two blocks and
    // the second half would be judged as prose. Real: llama_index's README has
    // exactly this shape.
    const readme = '# t\n\n```python\nfrom a import b\n\nfrom c import d\n```\n\nThis package does a useful thing.';
    expect(extractReadmeFirstParagraph(readme)).toBe('This package does a useful thing.');
  });

  it('skips HTML comments, list blocks, blockquotes and tables', () => {
    const readme = [
      '<!-- a note to maintainers, not to readers -->',
      '',
      '- one bullet point here',
      '- another bullet point here',
      '',
      '> [!NOTE]',
      '> This alert is not the description either.',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      'The library parses widgets quickly.',
    ].join('\n');
    expect(extractReadmeFirstParagraph(readme)).toBe('The library parses widgets quickly.');
  });

  it('rejects a row of text links but keeps prose that merely contains links', () => {
    const nav = '[Documentation](https://e.example) | [Community forum](https://f.example) | [Changelog](https://g.example)';
    const prose = 'Built on [MCP](https://h.example) and designed for local inference.';
    expect(extractReadmeFirstParagraph(nav)).toBeNull();
    expect(extractReadmeFirstParagraph(`${nav}\n\n${prose}`)).toBe(
      'Built on MCP and designed for local inference.',
    );
  });

  it('stops scanning at a fixed prefix, so prose past the horizon is not found', () => {
    // 100 heading blocks of ~1 KiB each: few enough that the block ceiling is
    // not what stops the walk, large enough that the 64 KiB scan window is.
    const heading = `# ${'a'.repeat(1_000)}`;
    const sentence = 'A real sentence lives past the horizon.';
    const far = `${`${heading}\n\n`.repeat(100)}${sentence}`;
    expect(far.length).toBeGreaterThan(64 * 1024);

    expect(extractReadmeFirstParagraph(far)).toBeNull();
    // The same content within the window is found — so it is the position that
    // decided this, not anything about the sentence.
    expect(extractReadmeFirstParagraph(`${heading}\n\n${sentence}`)).toBe(sentence);
  });

  it('bounds what it scans so a pathological README cannot become a pathological scan', () => {
    // 4 MiB, and deliberately a SINGLE block with no blank line in it — the
    // shape the block ceiling cannot help with, because there is only one.
    const filler = `<b>${'x '.repeat(2_500_000)}</b>`;
    expect(filler.length).toBeGreaterThan(4 * 1024 * 1024);
    const startedAt = Date.now();
    extractReadmeFirstParagraph(filler);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('never returns more than a bounded amount of text, whatever the README says', () => {
    // The standing rule is links and short excerpts, never full text. makeRepo
    // caps what is STORED; this bounds what is even returned, so no caller can
    // route a wall of text somewhere the cap does not apply.
    const wall = `word${' word'.repeat(20_000)}.`;
    const got = extractReadmeFirstParagraph(wall);
    expect(got).not.toBeNull();
    expect(got!.length).toBeLessThanOrEqual(4 * MAX_EXCERPT_LENGTH);
  });
});

// ===========================================================================
// The one request this task spends: GET /repos/{owner}/{repo}/readme
// ===========================================================================

describe('fetchReadme', () => {
  it('asks the endpoint that resolves casing and extension, not a guessed README.md path', async () => {
    // Task 3 flagged this: probing for a literal README.md misses README.rst,
    // README with no extension, and readme.md. A false "no README" silently
    // suppresses a good repo, so the resolution has to be GitHub's, not ours.
    expect(readmePath('scikit-learn', 'scikit-learn')).toBe('/repos/scikit-learn/scikit-learn/readme');

    const { baseUrl, paths } = await readmeServer({ 'scikit-learn/scikit-learn': 'scikit-learn-rst' });
    const outcome = await fetchReadme(new GitHubClient({ baseUrl }), 'scikit-learn', 'scikit-learn', {
      minIntervalMs: 0,
    });

    expect(paths).toEqual(['/repos/scikit-learn/scikit-learn/readme']);
    expect(outcome).toEqual({
      kind: 'fetched',
      path: 'README.rst',
      firstParagraph: capture.files['scikit-learn-rst.json']?.first_paragraph,
    });
  });

  it('resolves a README with no extension at all', async () => {
    const { baseUrl } = await readmeServer({ 'octocat/Hello-World': 'hello-world-no-extension' });
    const outcome = await fetchReadme(new GitHubClient({ baseUrl }), 'octocat', 'Hello-World', {
      minIntervalMs: 0,
    });
    expect(outcome).toEqual({ kind: 'fetched', path: 'README', firstParagraph: null });
  });

  it('reports a 404 as `absent` — a definite answer, not an error', async () => {
    // Captured live from octocat/octocat.github.io, a repo that really exists
    // (1,145 stars, not a fork, not archived) and really has no README.
    const { baseUrl } = await readmeServer({});
    const outcome = await fetchReadme(new GitHubClient({ baseUrl }), 'octocat', 'octocat.github.io', {
      minIntervalMs: 0,
    });
    expect(outcome).toEqual({ kind: 'absent' });
    expect(isReadmeKnown(outcome)).toBe(true);
  });

  it('sends no conditional request headers, because a 304 is not free', async () => {
    // Measured by task 1: replaying a valid ETag unauthenticated still drove
    // x-ratelimit-used 1 -> 2 -> 3 -> 4. Revalidating N READMEs therefore costs
    // exactly what refetching N READMEs costs, so the saving has to come from
    // not sending the request at all (see the cache-and-skip test below).
    const { baseUrl, headersSeen } = await readmeServer({ 'a/b': 'mcp-servers' });
    await fetchReadme(new GitHubClient({ baseUrl }), 'a', 'b', { minIntervalMs: 0 });
    expect(headersSeen[0]?.['if-none-match']).toBeUndefined();
    expect(headersSeen[0]?.['if-modified-since']).toBeUndefined();
  });

  it('reports an oversized README as unreadable rather than as absent', async () => {
    // GitHub answers 200 with `encoding: "none"` and empty content for a file
    // over 1 MB. Reading that as "no README" would suppress the repo on the
    // strength of a README that exists and is merely large.
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200, coreHeaders(59));
      res.end(JSON.stringify({ name: 'README.md', path: 'README.md', size: 2_000_000, content: '', encoding: 'none' }));
    });
    const outcome = await fetchReadme(new GitHubClient({ baseUrl }), 'a', 'b', { minIntervalMs: 0 });
    expect(outcome).toEqual({ kind: 'unreadable', why: 'encoding' });
    expect(isReadmeKnown(outcome)).toBe(false);
  });

  it('reports a body it cannot decode as unreadable, not as an empty README', async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200, coreHeaders(59));
      res.end(JSON.stringify({ name: 'README.md', encoding: 'base64' }));
    });
    const outcome = await fetchReadme(new GitHubClient({ baseUrl }), 'a', 'b', { minIntervalMs: 0 });
    expect(outcome).toEqual({ kind: 'unreadable', why: 'malformed' });
  });

  it('reports a server failure as an error, and never as "no README"', async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(503, coreHeaders(59));
      res.end('{}');
    });
    const outcome = await fetchReadme(new GitHubClient({ baseUrl }), 'a', 'b', { minIntervalMs: 0 });
    expect(outcome.kind).toBe('error');
    expect(isReadmeKnown(outcome)).toBe(false);
  });

  it('decodes GitHub\'s 60-column-wrapped base64 exactly', async () => {
    expect(fixture('git-consortium').content).toContain('\n');
    const { baseUrl } = await readmeServer({ 'octocat/git-consortium': 'git-consortium' });
    const outcome = await fetchReadme(new GitHubClient({ baseUrl }), 'octocat', 'git-consortium', {
      minIntervalMs: 0,
    });
    expect(outcome).toMatchObject({
      kind: 'fetched',
      firstParagraph: capture.files['git-consortium.json']?.first_paragraph,
    });
  });
});

// ===========================================================================
// The budget policy -- the judgement this task exists to make
// ===========================================================================

describe('enrichRepos — the README budget policy', () => {
  it('spends exactly one core request per enriched repo and nothing else', async () => {
    // Everything else §4 asks for -- language, license, stars, last-commit
    // date, open issue count -- is already in the search response. The README
    // is the only field that costs a request, which is why it is the only
    // thing this module fetches.
    const { baseUrl, paths } = await readmeServer({ 'a/one': 'mcp-servers', 'a/two': 'netbox' });
    const result = await enrichRepos(
      new GitHubClient({ baseUrl }),
      [facts({ owner: 'a', name: 'one' }), facts({ owner: 'a', name: 'two' })],
      { now: NOW, minIntervalMs: 0 },
    );

    expect(paths).toEqual(['/repos/a/one/readme', '/repos/a/two/readme']);
    expect(result.report.fetched).toBe(2);
    expect(result.repos.map((r) => r.repo.fullName)).toEqual(['a/one', 'a/two']);
    expect(result.repos[0]?.repo.language).toBe('TypeScript');
    expect(result.repos[0]?.repo.stars).toBe(100);
    expect(result.repos[0]?.repo.openIssuesAndPullRequests).toBe(5);
  });

  it('defaults to a far smaller cap unauthenticated than authenticated, because the ceilings differ 83x', async () => {
    expect(README_FETCH_LIMITS.unauthenticated).toBeLessThanOrEqual(10);
    expect(README_FETCH_LIMITS.authenticated).toBeGreaterThan(README_FETCH_LIMITS.unauthenticated);

    const many = Array.from({ length: 20 }, (_v, i) => facts({ owner: 'a', name: `r${i}` }));
    const { baseUrl, paths } = await readmeServer(
      Object.fromEntries(many.map((f) => [`a/${f.name}`, 'mcp-servers'])),
    );

    const result = await enrichRepos(new GitHubClient({ baseUrl }), many, { now: NOW, minIntervalMs: 0 });

    expect(result.report.mode).toBe('unauthenticated');
    expect(result.report.limit).toBe(README_FETCH_LIMITS.unauthenticated);
    expect(paths).toHaveLength(README_FETCH_LIMITS.unauthenticated);
    expect(result.report.skipped['over-limit']).toBe(20 - README_FETCH_LIMITS.unauthenticated);
  });

  it('never spends a request on a fork or an archived repo', async () => {
    // Both are readable from the search response for free, so the request is
    // avoidable in full. §4 suppresses them either way.
    const { baseUrl, paths } = await readmeServer({ 'a/good': 'mcp-servers' });
    const result = await enrichRepos(
      new GitHubClient({ baseUrl }),
      [
        facts({ owner: 'a', name: 'forked', isFork: true }),
        facts({ owner: 'a', name: 'dead', isArchived: true }),
        facts({ owner: 'a', name: 'good' }),
      ],
      { now: NOW, minIntervalMs: 0 },
    );

    expect(paths).toEqual(['/repos/a/good/readme']);
    expect(result.repos[0]?.readme).toEqual({ kind: 'skipped', why: 'suppressed' });
    expect(intrinsicSuppressionReasons(result.repos[0]!.repo)).toContain('fork');
    expect(intrinsicSuppressionReasons(result.repos[1]!.repo)).toContain('archived');
  });

  it('never spends a request on a repo the owner already dismissed', async () => {
    const { baseUrl, paths } = await readmeServer({ 'a/kept': 'mcp-servers', 'a/binned': 'netbox' });
    const dismissed = new Set(['a/binned']);
    const result = await enrichRepos(
      new GitHubClient({ baseUrl }),
      [facts({ owner: 'a', name: 'binned' }), facts({ owner: 'a', name: 'kept' })],
      { now: NOW, minIntervalMs: 0, isDismissed: (repo: Repo) => dismissed.has(repo.fullName) },
    );

    expect(paths).toEqual(['/repos/a/kept/readme']);
    expect(result.repos[0]?.readme).toEqual({ kind: 'skipped', why: 'dismissed' });
  });

  it('cache-and-skip means not sending the request, not revalidating it', async () => {
    const { baseUrl, paths } = await readmeServer({ 'a/known': 'mcp-servers', 'a/new': 'netbox' });
    const result = await enrichRepos(
      new GitHubClient({ baseUrl }),
      [facts({ owner: 'a', name: 'known' }), facts({ owner: 'a', name: 'new' })],
      {
        now: NOW,
        minIntervalMs: 0,
        cachedReadmeFirstParagraph: (f) => (f.name === 'known' ? 'A previously stored paragraph about it.' : undefined),
      },
    );

    expect(paths).toEqual(['/repos/a/new/readme']);
    expect(result.repos[0]?.readme).toEqual({
      kind: 'cached',
      firstParagraph: 'A previously stored paragraph about it.',
    });
    expect(result.repos[0]?.repo.readmeExcerpt).toBe('A previously stored paragraph about it.');
    expect(result.report.cached).toBe(1);
  });

  it('stops on an exhausted budget and marks the remainder skipped, never absent', async () => {
    // The failure this prevents is the dangerous one: a budget-skipped repo
    // whose README was never read looks exactly like a repo with no README,
    // and §4 suppresses the second. Conflating them would silently delete good
    // repos from the lane whenever the hourly budget ran short.
    let served = 0;
    const baseUrl = await serve((_req, res) => {
      served += 1;
      // Two healthy responses, then a budget with nothing left in it.
      const remaining = served >= 2 ? 0 : 59;
      res.writeHead(200, coreHeaders(remaining));
      res.end(JSON.stringify(fixture('mcp-servers')));
    });

    const many = Array.from({ length: 5 }, (_v, i) => facts({ owner: 'a', name: `r${i}` }));
    const result = await enrichRepos(new GitHubClient({ baseUrl }), many, { now: NOW, minIntervalMs: 0 });

    expect(served).toBe(2);
    expect(result.report.skipped.budget).toBe(3);
    for (const enriched of result.repos.slice(2)) {
      expect(enriched.readme).toEqual({ kind: 'skipped', why: 'budget' });
      expect(enriched.readmeKnown).toBe(false);
    }
  });

  it('holds back a reserve so enrichment cannot drain the budget other work needs', async () => {
    let served = 0;
    const baseUrl = await serve((_req, res) => {
      served += 1;
      res.writeHead(200, coreHeaders(10 - served));
      res.end(JSON.stringify(fixture('mcp-servers')));
    });

    const many = Array.from({ length: 8 }, (_v, i) => facts({ owner: 'a', name: `r${i}` }));
    const result = await enrichRepos(new GitHubClient({ baseUrl }), many, {
      now: NOW,
      minIntervalMs: 0,
      reserve: 6,
    });

    // `remaining` reported after each response runs 9, 8, 7, 6 -- and the
    // fourth is the first that is not strictly above the reserve, so the run
    // stops there with six requests still notionally available.
    expect(served).toBe(4);
    expect(result.report.skipped.budget).toBe(4);
    expect(result.report.coreRemaining).toBe(6);
  });

  it('degrades instead of throwing when the budget is already gone before it starts', async () => {
    let served = 0;
    const baseUrl = await serve((_req, res) => {
      served += 1;
      res.writeHead(200, coreHeaders(0));
      res.end(JSON.stringify(fixture('mcp-servers')));
    });

    const client = new GitHubClient({ baseUrl });
    // Spend the budget elsewhere first, exactly as a poll would.
    await client.request('/repos/x/y', { minIntervalMs: 0 });
    expect(served).toBe(1);

    const result = await enrichRepos(client, [facts({ owner: 'a', name: 'one' })], {
      now: NOW,
      minIntervalMs: 0,
    });

    expect(served).toBe(1);
    expect(result.repos[0]?.readme).toEqual({ kind: 'skipped', why: 'budget' });
  });
});

// ===========================================================================
// "Unknown" is not "absent" -- the distinction the whole policy rests on
// ===========================================================================

describe('enrichRepos — an unread README is unknown, not missing', () => {
  it('marks a definite answer known and an unspent one unknown, while both look README-less to Task 3', async () => {
    const many = Array.from({ length: 12 }, (_v, i) => facts({ owner: 'a', name: `r${i}` }));
    const { baseUrl } = await readmeServer({ 'a/r0': 'hello-world-no-extension' });
    const result = await enrichRepos(new GitHubClient({ baseUrl }), many, { now: NOW, minIntervalMs: 0 });

    const proseless = result.repos[0]!; // real README, no prose in it
    const missing = result.repos[1]!; // real 404 — genuinely has no README
    const unspent = result.repos[11]!; // past the cap — never looked at

    // All three are indistinguishable through the domain predicate alone...
    expect(hasNoReadme(proseless.repo)).toBe(true);
    expect(hasNoReadme(missing.repo)).toBe(true);
    expect(hasNoReadme(unspent.repo)).toBe(true);

    // ...and this is the flag that separates the verdicts from the guess.
    expect(proseless.readmeKnown).toBe(true);
    expect(missing.readmeKnown).toBe(true);
    expect(unspent.readmeKnown).toBe(false);
  });

  it('isReadmeKnown is true only for outcomes that actually decided the question', () => {
    const known: ReadmeOutcome[] = [
      { kind: 'fetched', path: 'README.md', firstParagraph: null },
      { kind: 'cached', firstParagraph: 'Some stored prose about the project.' },
      { kind: 'absent' },
    ];
    const unknown: ReadmeOutcome[] = [
      { kind: 'unreadable', why: 'encoding' },
      { kind: 'skipped', why: 'budget' },
      { kind: 'skipped', why: 'over-limit' },
      { kind: 'skipped', why: 'dismissed' },
      { kind: 'skipped', why: 'suppressed' },
      { kind: 'error', status: 503, message: 'boom' },
    ];
    for (const outcome of known) expect(isReadmeKnown(outcome)).toBe(true);
    for (const outcome of unknown) expect(isReadmeKnown(outcome)).toBe(false);
  });
});

// ===========================================================================
// The standing rules this module has to keep
// ===========================================================================

describe('enrichRepos — storage and clock discipline', () => {
  it('caps a real over-long first paragraph at the standing excerpt limit', async () => {
    const { baseUrl } = await readmeServer({ 'langgenius/dify': 'dify' });
    const result = await enrichRepos(new GitHubClient({ baseUrl }), [facts({ owner: 'langgenius', name: 'dify' })], {
      now: NOW,
      minIntervalMs: 0,
    });

    const full = capture.files['dify.json']?.first_paragraph ?? '';
    expect(full).toHaveLength(318);
    const excerpt = result.repos[0]!.repo.readmeExcerpt;
    expect(excerpt).toBe(
      'Dify is an open-source LLM app development platform. Its intuitive interface combines AI workflow, ' +
        'RAG pipeline, agent capabilities, model management, observability features (including Opik, Langfuse, ' +
        "and Arize Phoenix) and more, letting you quickly go from prototype to production. Here's a list of",
    );
    expect(excerpt!.length).toBeLessThanOrEqual(MAX_EXCERPT_LENGTH);
  });

  it('derives last-commit age from the injected now, never from the wall clock', async () => {
    const { baseUrl } = await readmeServer({ 'a/one': 'mcp-servers' });
    const client = new GitHubClient({ baseUrl });
    const candidate = facts({ owner: 'a', name: 'one', lastCommitAt: '2026-08-13T12:00:00.000Z' });

    const atNoon = await enrichRepos(client, [candidate], { now: NOW, minIntervalMs: 0 });
    expect(atNoon.repos[0]?.lastCommitAgeMs).toBe(24 * 60 * 60 * 1000);

    // A `now` BEFORE the commit yields a negative age. Only an injected clock
    // can do that; Date.now() could never produce it, so this is proof rather
    // than assertion.
    const inThePast = await enrichRepos(client, [candidate], {
      now: '2026-08-12T12:00:00.000Z',
      minIntervalMs: 0,
    });
    expect(inThePast.repos[0]?.lastCommitAgeMs).toBe(-24 * 60 * 60 * 1000);
  });

  it('reports a never-pushed repo as null age rather than a confident zero', async () => {
    const { baseUrl } = await readmeServer({ 'a/one': 'mcp-servers' });
    const result = await enrichRepos(
      new GitHubClient({ baseUrl }),
      [facts({ owner: 'a', name: 'one', lastCommitAt: null })],
      { now: NOW, minIntervalMs: 0 },
    );
    expect(result.repos[0]?.lastCommitAgeMs).toBeNull();
  });

  it('keeps NOASSERTION out of the license field and keeps the issue count honestly named', async () => {
    const { baseUrl } = await readmeServer({ 'a/one': 'mcp-servers' });
    const result = await enrichRepos(
      new GitHubClient({ baseUrl }),
      [facts({ owner: 'a', name: 'one', licenseSpdxId: 'NOASSERTION', openIssuesAndPullRequests: 93 })],
      { now: NOW, minIntervalMs: 0 },
    );
    expect(result.repos[0]?.repo.licenseSpdxId).toBeNull();
    expect(result.repos[0]?.repo.openIssuesAndPullRequests).toBe(93);
  });

  it('reports what it spent, so a live run can be audited rather than guessed at', async () => {
    const { baseUrl } = await readmeServer({ 'a/one': 'mcp-servers' });
    const result = await enrichRepos(
      new GitHubClient({ baseUrl }),
      [
        facts({ owner: 'a', name: 'one' }),
        facts({ owner: 'a', name: 'gone' }),
        facts({ owner: 'a', name: 'forked', isFork: true }),
      ],
      { now: NOW, minIntervalMs: 0 },
    );

    expect(result.report).toMatchObject({
      mode: 'unauthenticated',
      limit: README_FETCH_LIMITS.unauthenticated,
      requested: 2,
      fetched: 1,
      absent: 1,
      cached: 0,
      errors: 0,
    });
    expect(result.report.skipped.suppressed).toBe(1);
    expect(result.report.coreRemaining).toBe(58);
  });
});
