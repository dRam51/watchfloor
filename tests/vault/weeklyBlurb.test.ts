import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLlmConfig } from '../../src/enrich/llm/config.ts';
import { WATCHFLOOR_BEGIN_MARKER } from '../../src/vault/frontmatter.ts';
import {
  BLURB_QUESTIONS,
  BLURB_SYSTEM,
  BLURB_TASK_ID,
  buildBlurbPrompt,
  classifyEvidence,
  validateBlurbText,
  type EvidenceInput,
} from '../../src/vault/weekly.ts';

/**
 * §8.1 asks for three things — *"what the piece argues, why it's worth the
 * time, estimated read time"* — and the task brief is explicit that **"a model
 * that returns a restated headline for all three has not done the job."**
 *
 * So they are three separate mechanisms here, not one prompt hoping for three
 * answers. The read time is arithmetic (`estimateReadTime`, never a model).
 * The other two are **two separate calls**, which costs twice the tokens and
 * buys three things worth more than that:
 *
 *  1. No parsing. A single call returning two labelled lines has to be split,
 *     and both local models dropped their own labels on real items — checked
 *     2026-08-15, `llama3.1:8b` twice, `llama3.2` once out of eight. A
 *     mis-split blurb is a wrong blurb rendered confidently.
 *  2. Independent failure. If "why it's worth the time" comes back empty, the
 *     note still has "what it argues" rather than neither.
 *  3. Independent cache keys. `src/enrich/cacheKey.ts` keys on the bytes sent,
 *     so rewording one question does not retire the other's answers.
 */

function fixture(name: string): EvidenceInput & { sourceId: string; url: string } {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), 'tests', 'fixtures', 'corpus', `${name}.json`), 'utf8'),
  ) as {
    sourceId: string;
    title: string;
    summaryRaw: string | null;
    rawJson: string;
    url: string;
  };
  return {
    sourceId: raw.sourceId,
    title: raw.title,
    summaryRaw: raw.summaryRaw,
    rawJson: raw.rawJson,
    url: raw.url,
  };
}

describe('the two questions are asked separately', () => {
  it('has one task id per question, and they differ', () => {
    expect(BLURB_QUESTIONS).toEqual(['argues', 'worth']);
    expect(BLURB_TASK_ID.argues).not.toBe(BLURB_TASK_ID.worth);
    // The task is part of the cache key (src/enrich/cacheKey.ts), so two
    // questions about one item must never share a row.
    for (const question of BLURB_QUESTIONS) {
      expect(BLURB_TASK_ID[question]).toMatch(/^weekly_blurb_/);
    }
  });

  it('asks each question with its own system message', () => {
    expect(BLURB_SYSTEM.argues).not.toBe(BLURB_SYSTEM.worth);
    expect(BLURB_SYSTEM.argues).toMatch(/claims|establishes/i);
    expect(BLURB_SYSTEM.worth).toMatch(/worth|pay/i);
  });
});

describe('buildBlurbPrompt', () => {
  const item = fixture('krebs-tracking');

  it('carries the material, the headline, and the source', () => {
    const prompt = buildBlurbPrompt(item, classifyEvidence(item));
    expect(prompt).toContain(item.title);
    expect(prompt).toContain('krebs');
    expect(prompt).toContain('DecryptAds');
  });

  it('says so when the material is only the opening of a longer piece', () => {
    const prompt = buildBlurbPrompt(item, classifyEvidence(item));
    expect(prompt).toMatch(/opening|continues/i);
  });

  it('fits inside the configured prompt ceiling, with the system message', () => {
    // config/llm.yaml's backend THROWS above max_prompt_chars rather than
    // truncating (LlmPromptTooLargeError), and that throw is not one of
    // completeEnrichment's four outcomes -- it would abort the week's note.
    const limits = parseLlmConfig(
      readFileSync(join(process.cwd(), 'config', 'llm.yaml'), 'utf8'),
    ).limits;
    for (const name of ['krebs-tracking', 'talos-jwr', 'arxiv-car', 'hackernews-mcp']) {
      const each = fixture(name);
      const prompt = buildBlurbPrompt(each, classifyEvidence(each));
      for (const question of BLURB_QUESTIONS) {
        expect(BLURB_SYSTEM[question].length + prompt.length).toBeLessThan(limits.maxPromptChars);
      }
    }
  });

  it('refuses to build a prompt at the headline level', () => {
    // There is no honest prompt to build: see weeklyEvidence.test.ts for what
    // both models produced when one was built anyway.
    const bare = fixture('apnews-michigan');
    expect(() => buildBlurbPrompt(bare, classifyEvidence(bare))).toThrow(/headline/i);
  });
});

describe('validateBlurbText', () => {
  // Verbatim output from the live daemon, 2026-08-15, llama3.1:8b, for the
  // Krebs and Talos fixtures. Real text, so the guards below are exercised
  // against what the model actually writes rather than against a caricature.
  const REAL_ARGUES =
    'DecryptAds is a free service that aggregates and correlates publicly available data ' +
    'from websites and apps to reveal entities tracking users. The service can help identify ' +
    'malicious ads, ad networks located in adversarial nations, and AI-generated "slop" ' +
    'websites and apps.';

  it('accepts a real generated blurb', () => {
    const result = validateBlurbText('Who’s Tracking You? Use This New Service to Find Out', REAL_ARGUES);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe(REAL_ARGUES);
  });

  it('rejects a restatement of the headline', () => {
    const result = validateBlurbText(
      'Attackers Exploit SharePoint Authentication Bypass After Public PoC Release',
      'Attackers exploit a SharePoint authentication bypass after a public PoC release.',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('restated_headline');
  });

  it('rejects text carrying a watchfloor block marker', () => {
    // Model output is written into a MANAGED file. A marker inside it would
    // let generated text decide where the managed block ends --
    // src/vault/frontmatter.ts refuses it, and refusing here names the item.
    const result = validateBlurbText(
      'Some headline about nothing in particular',
      `A genuinely different sentence about caching strategies. ${WATCHFLOOR_BEGIN_MARKER}`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('contains_marker');
  });

  it('collapses multi-line output to one line', () => {
    // A blurb spanning lines could open a heading or a `---` fence inside the
    // note. Blurbs are one or two sentences; a line break in one is noise.
    const result = validateBlurbText('A headline', 'First sentence here.\n\n---\n# Heading\nSecond.');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).not.toContain('\n');
      expect(result.text).toBe('First sentence here. --- # Heading Second.');
    }
  });

  it('strips a label the model emitted despite being told not to', () => {
    // Observed on both models: llama3.1:8b dropped its labels twice and
    // llama3.2 added one once, in the same eight-item run.
    const result = validateBlurbText(
      'A headline',
      'ARGUES: The paper shows that reranking by confidence beats reranking by relevance.',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text.startsWith('ARGUES:')).toBe(false);
  });

  it('rejects an empty completion', () => {
    // `''` on the ok branch means "the model had nothing to say" -- a real
    // answer that must not be rendered as a blurb.
    const result = validateBlurbText('A headline', '   \n  ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty');
  });
});
