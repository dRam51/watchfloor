import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BODY_WORDS_MIN,
  EXCERPT_NOVEL_WORDS_MIN,
  MAX_MATERIAL_CHARS,
  WORDS_PER_MINUTE,
  classifyEvidence,
  estimateReadTime,
  type EvidenceInput,
} from '../../src/vault/weekly.ts';

/**
 * What we actually hold about a piece decides whether a blurb about it can be
 * honest — and it is the only thing that can.
 *
 * Every fixture below is a **real row** lifted out of the live corpus
 * (`data/wf.db`, `VACUUM INTO` copy, 2026-08-15): the source's own stored
 * payload, the derived ~300-character excerpt, and the title, exactly as the
 * database holds them. Invented fixtures cannot fail the way these do — the
 * cases that matter here are a feed that looks like it carries an article and
 * does not, and a "summary" that is a tagline.
 *
 * ## The case this whole classification exists for
 *
 * `latent-space-ainews.json` is the item that decided the design. Its stored
 * payload is 5,934 bytes of `content:encoded`, which looks like a full post
 * and strips to **40 words** of prose — the rest is images and links. Its
 * excerpt is the eighteen characters *"Down, but not out!"*.
 *
 * Given only that, both local models fabricated confidently and wrongly, on
 * 2026-08-15 against the real daemon:
 *
 *   llama3.2:latest — "the resurgence of GDM (Graphics Display Manager)
 *                      technology ... interested in low-level system management"
 *   llama3.1:8b     — "brings back a previously downgraded feature called GDM
 *                      (Gemini Desktop Manager) ... worth reading for Linux users"
 *
 * GDM is Google DeepMind. Neither model was lying; neither had anything to
 * work from. So the gate is not a quality filter, it is a truthfulness one:
 * an item we hold nothing about does not get a blurb at all.
 */

function fixture(name: string): EvidenceInput & { url: string } {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), 'tests', 'fixtures', 'corpus', `${name}.json`), 'utf8'),
  ) as { title: string; summaryRaw: string | null; rawJson: string; url: string };
  return { title: raw.title, summaryRaw: raw.summaryRaw, rawJson: raw.rawJson, url: raw.url };
}

describe('classifyEvidence — body', () => {
  it('reads the full article a full-content feed carries', () => {
    // Krebs syndicates the whole post in `content:encoded`.
    const evidence = classifyEvidence(fixture('krebs-tracking'));
    expect(evidence.level).toBe('body');
    expect(evidence.bodyWords).toBeGreaterThan(2000);
    expect(evidence.material).toContain('DecryptAds');
    // HTML is stripped, not handed to the model as markup.
    expect(evidence.material).not.toContain('<p>');
    expect(evidence.material).not.toContain('&#8217;');
  });

  it('bounds the material it hands the model, and says when it did', () => {
    const evidence = classifyEvidence(fixture('krebs-tracking'));
    expect(evidence.material.length).toBeLessThanOrEqual(MAX_MATERIAL_CHARS);
    expect(evidence.truncated).toBe(true);
    // A PREFIX, never a middle-out cut: config/llm.yaml's own warning is that
    // "cutting the middle out of a document and summarising the remainder
    // yields a confident, wrong blurb".
    expect(evidence.material.startsWith('It can be daunting')).toBe(true);
  });

  it('parses a 311KB stored payload without special-casing it', () => {
    // Real: cisco-talos stores 311,714 bytes of raw JSON for one post, and
    // project-zero averages 1.3 MB. A size ceiling that silently downgraded
    // these would remove exactly the pieces most worth reading.
    const evidence = classifyEvidence(fixture('talos-jwr'));
    expect(evidence.level).toBe('body');
    expect(evidence.bodyWords).toBeGreaterThan(3000);
  });
});

describe('classifyEvidence — excerpt', () => {
  it('accepts a real abstract as material', () => {
    const evidence = classifyEvidence(fixture('arxiv-car'));
    expect(evidence.level).toBe('excerpt');
    expect(evidence.material).toContain('reranking');
    expect(evidence.novelWords).toBeGreaterThanOrEqual(EXCERPT_NOVEL_WORDS_MIN);
  });

  it('accepts a wire lead that says more than its headline', () => {
    const evidence = classifyEvidence(fixture('hackernews-mcp'));
    expect(evidence.level).toBe('excerpt');
  });

  it('does not promote a short body to `body` — a 65-word teaser is not an article', () => {
    // the-hacker-news carries a ~300-character `description` and nothing else.
    // Counting it as a body would produce "1 min read" for a piece whose real
    // length we do not know.
    const evidence = classifyEvidence(fixture('hackernews-mcp'));
    expect(evidence.bodyWords).not.toBeNull();
    expect(evidence.bodyWords!).toBeLessThan(BODY_WORDS_MIN);
    expect(evidence.level).toBe('excerpt');
  });
});

describe('classifyEvidence — headline', () => {
  it('refuses the item both local models hallucinated about', () => {
    const evidence = classifyEvidence(fixture('latent-space-ainews'));
    expect(evidence.level).toBe('headline');
    expect(evidence.material).toBe('');
    // Two content words -- "down" and "out" -- neither of which says anything.
    expect(evidence.novelWords).toBeLessThan(EXCERPT_NOVEL_WORDS_MIN);
  });

  it('refuses an item whose feed carries only a headline', () => {
    // ap-news: `summary_raw` is null and the sitemap payload has no body.
    const evidence = classifyEvidence(fixture('apnews-michigan'));
    expect(evidence.level).toBe('headline');
    expect(evidence.bodyWords).toBeNull();
  });

  it('refuses an excerpt that merely repeats the headline', () => {
    // 24 real rows have a summary with ZERO content words the title lacks.
    // A length check passes those; a novelty check is what catches them.
    const evidence = classifyEvidence({
      title: 'Introducing Gemini 3.7 Flash',
      summaryRaw: 'Introducing Gemini 3.7 Flash.',
      rawJson: '{}',
    });
    expect(evidence.level).toBe('headline');
    expect(evidence.novelWords).toBe(0);
  });

  it('falls back rather than throwing on an unreadable payload', () => {
    // A stored payload we cannot parse must degrade to a lower evidence
    // level, never abort the week's note.
    const evidence = classifyEvidence({
      title: 'Something happened',
      summaryRaw: null,
      rawJson: 'not json at all',
    });
    expect(evidence.level).toBe('headline');
  });
});

describe('estimateReadTime', () => {
  it('is computed from the words the feed actually carries', () => {
    const evidence = classifyEvidence(fixture('krebs-tracking'));
    const estimate = estimateReadTime(evidence);
    expect(estimate.minutes).toBe(Math.round(evidence.bodyWords! / WORDS_PER_MINUTE));
    expect(estimate.basis).toContain(String(evidence.bodyWords));
    expect(estimate.basis).toContain(String(WORDS_PER_MINUTE));
  });

  it('is unknown — never a number — when we hold no body', () => {
    // "This project stores links and ~300-character excerpts, never full
    // text." A minute count invented from an excerpt would look exactly as
    // authoritative as one counted from an article.
    for (const name of ['arxiv-car', 'apnews-michigan', 'latent-space-ainews']) {
      const estimate = estimateReadTime(classifyEvidence(fixture(name)));
      expect(estimate.minutes).toBeNull();
      expect(estimate.basis).toMatch(/excerpt|headline|no .*text/i);
    }
  });

  it('never reports zero minutes', () => {
    const estimate = estimateReadTime({
      level: 'body',
      material: 'x',
      truncated: false,
      bodyWords: BODY_WORDS_MIN,
      novelWords: 99,
      basis: 'test',
    });
    expect(estimate.minutes).toBeGreaterThanOrEqual(1);
  });
});
