import { describe, it, expect } from 'vitest';
import {
  classifyItemType,
  isGovernmentPrimary,
  isPressReleaseChurn,
} from '../../src/classify/itemType.ts';
import type { Source } from '../../src/sources/load.ts';

function source(overrides: Partial<Source> = {}): Source {
  return {
    id: 'example-source',
    name: 'Example Source',
    type: 'rss',
    url: 'https://example.test/feed.xml',
    beats: ['ai'],
    weight: 1.0,
    poll_interval: '1h',
    enabled: true,
    enrichment: true,
    ...overrides,
  };
}

describe('isGovernmentPrimary', () => {
  it('is true for every exact id in the government-primary list', () => {
    const ids = ['federal-register', 'whitehouse-actions', 'scotus-slip', 'nws-fl-alerts', 'nvd-cve'];
    for (const id of ids) {
      expect(isGovernmentPrimary(id), `id ${id}`).toBe(true);
    }
  });

  it('is true for any id with the cisa- prefix', () => {
    expect(isGovernmentPrimary('cisa-kev')).toBe(true);
    expect(isGovernmentPrimary('cisa-advisories')).toBe(true);
    expect(isGovernmentPrimary('cisa-anything-else')).toBe(true);
  });

  it('is false for an id that merely contains "cisa" without the prefix', () => {
    expect(isGovernmentPrimary('not-cisa-related')).toBe(false);
  });

  it('is false for an ordinary source id', () => {
    expect(isGovernmentPrimary('huggingface-blog')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPressReleaseChurn: the new structural churn signal.
//
// Grounded against attic/wf-m1-firstrun-2026-08-14.db (3,325 real items, 17
// sources): zero items anywhere in the real corpus match ANY signal below --
// verified directly (grep for PRNewswire/Business Wire/GlobeNewswire tokens,
// "forward-looking statement"/"safe harbor"/"for immediate release" phrases,
// and a dateline-shaped regex, all zero hits). This is expected, not a defect
// in the detector: none of the 17 configured sources are actual press-release
// distribution wires (they are research-lab blogs, practitioner blogs, wire
// news services, academic preprints, security research, government primaries,
// and a community-voted aggregator) -- see task-7-report.md for the full
// per-source breakdown. The fixtures below are therefore deliberately
// CONSTRUCTED, not sampled, for the true-positive cases -- exactly like the
// M2 plan's two hard-override categories with no reachable source, and like
// Task 1's zero-seed-term press-release suppression category: a real
// mechanism is still worth shipping and testing even when today's corpus
// happens to contain no matching content.
// ---------------------------------------------------------------------------
describe('isPressReleaseChurn', () => {
  describe('true positives: constructed press-release-shaped text', () => {
    it('matches the PRNewswire wire-service token', () => {
      const summary =
        'SAN FRANCISCO, Aug. 14, 2026 /PRNewswire/ -- Acme Robotics, a leading provider of ' +
        'industrial automation, today announced a strategic partnership.';
      expect(isPressReleaseChurn('Acme Robotics Announces Strategic Partnership', summary)).toBe(true);
    });

    it('matches "PR Newswire" spelled with a space', () => {
      expect(isPressReleaseChurn('Acme Corp News', 'Distributed via PR Newswire.')).toBe(true);
    });

    it('matches the "Business Wire" wire-service token', () => {
      expect(isPressReleaseChurn('Acme Corp News', 'Released today (Business Wire) --')).toBe(true);
    });

    it('matches "BusinessWire" with no space', () => {
      expect(isPressReleaseChurn('Acme Corp News', 'Distributed via BusinessWire.')).toBe(true);
    });

    it('matches the "GlobeNewswire" wire-service token', () => {
      expect(isPressReleaseChurn('Acme Corp News', 'Released via GlobeNewswire today.')).toBe(true);
    });

    it('matches "Globe Newswire" spelled with a space', () => {
      expect(isPressReleaseChurn('Acme Corp News', 'Released via Globe Newswire today.')).toBe(true);
    });

    it('matches the "forward-looking statements" boilerplate phrase', () => {
      const summary =
        'This press release contains forward-looking statements within the meaning of ' +
        'the Private Securities Litigation Reform Act.';
      expect(isPressReleaseChurn('Acme Corp Reports Q3 Results', summary)).toBe(true);
    });

    it('matches the "safe harbor statement" boilerplate phrase', () => {
      expect(isPressReleaseChurn('Acme Corp News', 'See the safe harbor statement below.')).toBe(true);
    });

    it('matches the "for immediate release" boilerplate phrase', () => {
      expect(isPressReleaseChurn('Acme Corp News', 'FOR IMMEDIATE RELEASE -- Acme Corp today...')).toBe(
        true,
      );
    });

    it('is case-insensitive', () => {
      expect(isPressReleaseChurn('x', 'distributed via PRNEWSWIRE')).toBe(true);
      expect(isPressReleaseChurn('x', 'FOR IMMEDIATE RELEASE')).toBe(true);
    });

    it('matches a token appearing in the title rather than the summary', () => {
      expect(isPressReleaseChurn('Acme Corp News (PRNewswire)', null)).toBe(true);
    });
  });

  describe('false-positive guards: real-corpus-shaped text that must NOT be flagged', () => {
    // Real deepmind-blog/huggingface-blog titles (attic/wf-m1-firstrun-2026-08-14.db):
    // announcement-style verbs ("Introducing", "announces", "unveils") are the
    // HOUSE STYLE for legitimate frontier-model and open-source tool launches in
    // this corpus, not a churn signal -- an earlier design considered exactly
    // this heuristic and rejected it after checking real titles: "Introducing
    // Gemini 3.7 Flash" (deepmind-blog) and 77 separate real huggingface-blog
    // titles beginning "Introducing ..." (e.g. "Introducing AnyLanguageModel: One
    // API for Local and Remote LLMs on Apple Platforms") are exactly the content
    // this dashboard exists to surface. See task-7-report.md.
    it('does not match a real frontier-model launch title using an announcement verb', () => {
      expect(isPressReleaseChurn('Introducing Gemini 3.7 Flash', null)).toBe(false);
    });

    it('does not match a real huggingface-blog "Introducing" title with no summary', () => {
      expect(
        isPressReleaseChurn(
          'Introducing AnyLanguageModel: One API for Local and Remote LLMs on Apple Platforms',
          null,
        ),
      ).toBe(false);
    });

    it('does not match bare "announces"/"unveils" without a wire-service marker', () => {
      expect(isPressReleaseChurn('Google DeepMind and A24 announce first-of-its-kind research partnership', null)).toBe(
        false,
      );
      expect(isPressReleaseChurn('Vendor unveils new product line', 'A short description.')).toBe(false);
    });

    // Real Task 1 finding (task-1-report.md / config/interests.yaml): "AI-powered"
    // matched legitimate ai/aisec research headlines at least as often as actual
    // press releases and was reverted from the interest-profile suppression list.
    // Repeating that exact finding here as a regression guard: this classifier
    // must not reintroduce the same failure through a different mechanism.
    it('does not match on the "AI-powered" topic phrase (Task 1 regression guard)', () => {
      expect(
        isPressReleaseChurn(
          'SAIR: Accelerating Pharma R&D with AI-Powered Structural Intelligence',
          null,
        ),
      ).toBe(false);
    });

    it('does not match the bare word "wire" used in an unrelated technical sense', () => {
      expect(isPressReleaseChurn('Designing an efficient over-the-wire protocol', 'A deep dive into wire formats.')).toBe(
        false,
      );
    });

    it('does not match "safe harbor" alone without the full "safe harbor statement" phrase (avoids the generic legal/tax-policy sense)', () => {
      expect(isPressReleaseChurn('New tax bill', 'The bill introduces new safe harbor provisions for small filers.')).toBe(
        false,
      );
    });

    it('does not match "release" alone without "for immediate release"', () => {
      expect(isPressReleaseChurn('New version release notes', 'This release adds several bug fixes.')).toBe(false);
    });

    // Real arxiv-cs-ai abstract (attic/wf-m1-firstrun-2026-08-14.db, verbatim
    // opening of summary_raw for "Self-evolving network verifiers"): substantive
    // academic content, not churn, despite being short enough to have failed
    // M1's word-count threshold.
    it('does not match a real arXiv abstract opening', () => {
      const summary =
        'arXiv:2608.11340v1 Announce Type: cross \n' +
        'Abstract: Symbolic network verifiers can reason about correctness across ' +
        'vast spaces of routing inputs and failures, but only for the protocols and ' +
        'features an expert has encoded by hand.';
      expect(isPressReleaseChurn('Self-evolving network verifiers', summary)).toBe(false);
    });

    it('does not match a real ap-news wire headline with no summary (ap-news carries no body text in its current news_sitemap feed)', () => {
      expect(
        isPressReleaseChurn('California prisons fail to protect women from sexual abuse, DOJ says', null),
      ).toBe(false);
    });

    it('is false for an ordinary title and null summary', () => {
      expect(isPressReleaseChurn('An ordinary headline', null)).toBe(false);
    });

    it('is false for an ordinary title and an ordinary summary', () => {
      expect(isPressReleaseChurn('An ordinary headline', 'An ordinary summary with no signal at all.')).toBe(
        false,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// classifyItemType: the composed rule.
// ---------------------------------------------------------------------------
describe('classifyItemType', () => {
  it('tier "event" wins outright, regardless of title/summary content', () => {
    const item = classifyItemType(source({ id: 'crypto-prices', tier: 'event' }), 'irrelevant', null);
    expect(item).toBe('event');
  });

  it('tier "analysis" wins outright, regardless of title/summary content', () => {
    const item = classifyItemType(source({ id: 'some-index', tier: 'analysis' }), 'irrelevant', null);
    expect(item).toBe('analysis');
  });

  it('tier "event" wins even when the summary matches the churn signature', () => {
    const item = classifyItemType(
      source({ id: 'crypto-prices', tier: 'event' }),
      'irrelevant',
      'FOR IMMEDIATE RELEASE -- distributed via PRNewswire',
    );
    expect(item).toBe('event');
  });

  it('government-primary source wins outright -> event', () => {
    const item = classifyItemType(source({ id: 'federal-register', tier: undefined }), 'irrelevant', null);
    expect(item).toBe('event');
  });

  it('government-primary (cisa- prefix) wins even when the summary matches the churn signature', () => {
    const item = classifyItemType(
      source({ id: 'cisa-kev', tier: undefined }),
      'irrelevant',
      'FOR IMMEDIATE RELEASE -- distributed via PRNewswire',
    );
    expect(item).toBe('event');
  });

  it('a non-cisa- source that merely contains "cisa" is NOT government-primary and falls through to analysis', () => {
    const item = classifyItemType(source({ id: 'not-cisa-related' }), 'An ordinary title', null);
    expect(item).toBe('analysis');
  });

  it('a genuine press-release signature (no tier, not government-primary) -> press', () => {
    const item = classifyItemType(
      source({ id: 'some-corp-blog' }),
      'Acme Robotics Announces Strategic Partnership',
      'SAN FRANCISCO, Aug. 14, 2026 /PRNewswire/ -- Acme Robotics today announced...',
    );
    expect(item).toBe('press');
  });

  it('default: no tier, not government-primary, no churn signature -> analysis (NOT press)', () => {
    const item = classifyItemType(source({ id: 'some-blog' }), 'An ordinary headline', 'A short summary.');
    expect(item).toBe('analysis');
  });

  it('default holds even with a completely empty summary (null) -- the old rule\'s "no summary -> press" fallthrough is gone', () => {
    const item = classifyItemType(source({ id: 'some-blog' }), 'An ordinary headline', null);
    expect(item).toBe('analysis');
  });

  it('word count no longer plays any role: a very long, ordinary (non-churn) summary is still analysis, not specially distinguished from a short one', () => {
    const longSummary = Array(500).fill('word').join(' ');
    const shortSummary = 'word';
    expect(classifyItemType(source({ id: 'some-blog' }), 'title', longSummary)).toBe('analysis');
    expect(classifyItemType(source({ id: 'some-blog' }), 'title', shortSummary)).toBe('analysis');
  });

  // Real-corpus-grounded integration case: the exact shape of 841
  // huggingface-blog items (a real "Introducing ..." title, always-null
  // summary because that feed carries no description field) must land on
  // analysis, not press -- this is the single largest relabelling this task
  // makes (see task-7-report.md).
  it('real-shape case: a huggingface-blog-style "Introducing X" title with null summary -> analysis, not press', () => {
    const item = classifyItemType(
      source({ id: 'huggingface-blog' }),
      'Introducing Trackio: A Lightweight Experiment Tracking Library from Hugging Face',
      null,
    );
    expect(item).toBe('analysis');
  });
});
