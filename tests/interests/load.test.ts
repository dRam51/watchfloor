import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  loadInterests,
  loadInterestsFile,
  InterestConfigError,
  termMatches,
  findMatches,
  matchProfile,
  type InterestTerm,
} from '../../src/interests/load.ts';

describe('loadInterests', () => {
  it('parses a valid minimal file', () => {
    const yaml = `
boosts:
  - { term: "prompt injection", weight: 1.8 }
suppressions:
  - { term: "Series A", weight: 1.3 }
`;
    const profile = loadInterests(yaml);
    expect(profile.boosts).toEqual([{ term: 'prompt injection', weight: 1.8 }]);
    expect(profile.suppressions).toEqual([{ term: 'Series A', weight: 1.3 }]);
  });

  it('rejects malformed YAML syntax', () => {
    const bad = `boosts: [\n  - unterminated`;
    expect(() => loadInterests(bad)).toThrow(InterestConfigError);
  });

  it.each([0, -1, 0.05, 2.01, 5])('rejects a weight outside 0.1-2.0 (%s)', (weight) => {
    const yaml = `
boosts:
  - { term: "eval", weight: ${weight} }
suppressions:
  - { term: "Series A", weight: 1.3 }
`;
    expect(() => loadInterests(yaml)).toThrow(InterestConfigError);
  });

  it.each([0.1, 1, 2.0])('accepts weights at and inside the 0.1-2.0 boundary (%s)', (weight) => {
    const yaml = `
boosts:
  - { term: "eval", weight: ${weight} }
suppressions:
  - { term: "Series A", weight: 1.3 }
`;
    expect(() => loadInterests(yaml)).not.toThrow();
  });

  it('rejects a non-number weight', () => {
    const yaml = `
boosts:
  - { term: "eval", weight: "high" }
suppressions:
  - { term: "Series A", weight: 1.3 }
`;
    expect(() => loadInterests(yaml)).toThrow(InterestConfigError);
  });

  it('rejects an empty term', () => {
    const yaml = `
boosts:
  - { term: "", weight: 1.2 }
suppressions:
  - { term: "Series A", weight: 1.3 }
`;
    expect(() => loadInterests(yaml)).toThrow(InterestConfigError);
  });

  it('rejects a whitespace-only term', () => {
    const yaml = `
boosts:
  - { term: "   ", weight: 1.2 }
suppressions:
  - { term: "Series A", weight: 1.3 }
`;
    expect(() => loadInterests(yaml)).toThrow(InterestConfigError);
  });

  it('rejects a term with leading or trailing whitespace', () => {
    const yaml = `
boosts:
  - { term: " eval", weight: 1.2 }
suppressions:
  - { term: "Series A", weight: 1.3 }
`;
    expect(() => loadInterests(yaml)).toThrow(InterestConfigError);
  });

  it('rejects a non-string term', () => {
    const yaml = `
boosts:
  - { term: 42, weight: 1.2 }
suppressions:
  - { term: "Series A", weight: 1.3 }
`;
    expect(() => loadInterests(yaml)).toThrow(InterestConfigError);
  });

  it('rejects a term longer than 100 characters (typo/paste guard)', () => {
    const yaml = `
boosts:
  - { term: "${'x'.repeat(101)}", weight: 1.2 }
suppressions:
  - { term: "Series A", weight: 1.3 }
`;
    expect(() => loadInterests(yaml)).toThrow(InterestConfigError);
  });

  it('rejects a missing boosts key', () => {
    const yaml = `
suppressions:
  - { term: "Series A", weight: 1.3 }
`;
    expect(() => loadInterests(yaml)).toThrow(InterestConfigError);
  });

  it('rejects a missing suppressions key', () => {
    const yaml = `
boosts:
  - { term: "eval", weight: 1.2 }
`;
    expect(() => loadInterests(yaml)).toThrow(InterestConfigError);
  });

  it('rejects an empty boosts array', () => {
    const yaml = `
boosts: []
suppressions:
  - { term: "Series A", weight: 1.3 }
`;
    expect(() => loadInterests(yaml)).toThrow(InterestConfigError);
  });

  it('rejects an empty suppressions array', () => {
    const yaml = `
boosts:
  - { term: "eval", weight: 1.2 }
suppressions: []
`;
    expect(() => loadInterests(yaml)).toThrow(InterestConfigError);
  });

  it('rejects a duplicate term within boosts, case-insensitively', () => {
    const yaml = `
boosts:
  - { term: "MCP", weight: 1.2 }
  - { term: "mcp", weight: 1.4 }
suppressions:
  - { term: "Series A", weight: 1.3 }
`;
    expect(() => loadInterests(yaml)).toThrow(/duplicate term/i);
  });

  it('rejects a duplicate term within suppressions, case-insensitively', () => {
    const yaml = `
boosts:
  - { term: "eval", weight: 1.2 }
suppressions:
  - { term: "NASCAR", weight: 1.5 }
  - { term: "nascar", weight: 1.5 }
`;
    expect(() => loadInterests(yaml)).toThrow(/duplicate term/i);
  });

  it('rejects a term present in both boosts and suppressions, case-insensitively', () => {
    const yaml = `
boosts:
  - { term: "RAG", weight: 1.2 }
suppressions:
  - { term: "rag", weight: 1.0 }
`;
    expect(() => loadInterests(yaml)).toThrow(/both boosts and suppressions/i);
  });

  it('loads the real config/interests.yaml', () => {
    const profile = loadInterestsFile(join(process.cwd(), 'config', 'interests.yaml'));
    expect(profile.boosts.length).toBeGreaterThan(0);
    expect(profile.suppressions.length).toBeGreaterThan(0);
  });

  describe('the real config/interests.yaml', () => {
    const profile = loadInterestsFile(join(process.cwd(), 'config', 'interests.yaml'));
    const boostTerms = profile.boosts.map((t) => t.term);

    // Pinned regression: every seed boost term named in the M2 plan (Task 1,
    // itself quoting the spec's §5) must be present. A future edit that
    // accidentally drops one should fail loudly here, the same way the
    // sources.yaml "has enrichment: false on ap-news" test pins that field.
    it.each([
      'prompt injection',
      'MCP',
      'agent security',
      'Juniper',
      'Junos',
      'BGP',
      'network automation',
      'local inference',
      'Ollama',
      'eval',
      'RAG',
    ])('has the seed boost term "%s"', (term) => {
      expect(boostTerms.some((t) => t.toLowerCase() === term.toLowerCase())).toBe(true);
    });

    it('has no term duplicated across the whole file (belt-and-suspenders)', () => {
      const all = [...profile.boosts, ...profile.suppressions].map((t) => t.term.toLowerCase());
      expect(new Set(all).size).toBe(all.length);
    });

    it('has every weight within the validated 0.1-2.0 bound', () => {
      for (const { term, weight } of [...profile.boosts, ...profile.suppressions]) {
        expect(weight, term).toBeGreaterThanOrEqual(0.1);
        expect(weight, term).toBeLessThanOrEqual(2.0);
      }
    });
  });
});

describe('word/phrase matching', () => {
  // --- The four named false-positive danger classes (task instructions) ---

  describe('does not match "eval" inside a longer word', () => {
    it.each(['evaluation', 'evaluate', 'medieval', 'evaluated', 'evaluator', 'reevaluate'])(
      '%s',
      (word) => {
        expect(termMatches(word, 'eval')).toBe(false);
      },
    );
  });

  describe('does not match "RAG" inside a longer word', () => {
    it.each(['dragging', 'fragment', 'storage', 'ragged', 'paragraph'])('%s', (word) => {
      expect(termMatches(word, 'RAG')).toBe(false);
    });
  });

  describe('does not match "MCP" inside a longer identifier', () => {
    it.each(['MCPClient', 'libMCP', 'McPartlon', 'MCP2515', 'DMCPolicy'])('%s', (word) => {
      expect(termMatches(word, 'MCP')).toBe(false);
    });
  });

  describe('does not match "BGP" inside a longer identifier', () => {
    it.each(['BGPsec', 'WebGPU', 'BGP4', 'ABGPX'])('%s', (word) => {
      expect(termMatches(word, 'BGP')).toBe(false);
    });
  });

  // "AI" is deliberately not a seed term (it is not in the M2 plan's boost
  // list) but the task calls it out explicitly as "same class of problem" --
  // a short, uppercase, high-collision-risk abbreviation. Tested directly at
  // the matcher level rather than through the shipped config.
  describe('does not match "AI" inside a longer word (same class of problem)', () => {
    it.each(['against', 'Taiwan', 'email', 'said', 'maintain', 'Ukraine'])('%s', (word) => {
      expect(termMatches(word, 'AI')).toBe(false);
    });
  });

  // --- True positives: the same terms, as actual whole words ---

  it.each([
    ['eval', 'run npm eval now'],
    ['eval', '(eval)'],
    ['eval', 'eval, then deploy'],
    ['RAG', 'a RAG pipeline'],
    ['RAG', '(RAG)'],
    ['MCP', 'the MCP server'],
    ['MCP', '(MCP)'],
    ['BGP', 'a BGP session'],
    ['BGP', '(BGP)'],
    ['AI', 'an AI system'],
    ['AI', '(AI)'],
  ])('matches "%s" as a genuine whole word in "%s"', (term, text) => {
    expect(termMatches(text, term)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(termMatches('the mcp server', 'MCP')).toBe(true);
    expect(termMatches('the Mcp server', 'MCP')).toBe(true);
    expect(termMatches('the MCP server', 'mcp')).toBe(true);
  });

  // --- Boundary handling: hyphens, slashes, punctuation, possessives ---

  describe('boundary handling', () => {
    it('matches when immediately followed by a hyphenated suffix', () => {
      expect(termMatches('a RAG-based system', 'RAG')).toBe(true);
    });

    it('matches when immediately adjacent to a slash', () => {
      expect(termMatches('eval/test split', 'eval')).toBe(true);
    });

    it('matches inside parentheses', () => {
      expect(termMatches('the protocol (MCP) is new', 'MCP')).toBe(true);
    });

    it('matches a possessive with a straight apostrophe', () => {
      expect(termMatches("Ollama's local models", 'Ollama')).toBe(true);
    });

    it('matches a possessive with a curly apostrophe', () => {
      expect(termMatches('Juniper’s SIRT advisory', 'Juniper')).toBe(true);
    });

    // Deliberate design choice: a hyphen inside a single-token term and the
    // space(s) inside a multi-word phrase are both treated as the same kind
    // of "word separator" -- so a term written either way in config matches
    // either way in real text.
    it('a hyphenated single-token term also matches its space-separated spelling', () => {
      expect(termMatches('Cavalli takes no-hitter into the 7th', 'no-hitter')).toBe(true);
      expect(termMatches('Cavalli takes a no hitter into the 7th', 'no-hitter')).toBe(true);
    });

    it('a space-separated phrase also matches a hyphenated spelling in text', () => {
      expect(termMatches('a new prompt-injection-resistant framework', 'prompt injection')).toBe(true);
      expect(termMatches('prompt injection attacks are rising', 'prompt injection')).toBe(true);
    });

    it('does not match a phrase written with no separator at all', () => {
      expect(termMatches('promptinjection attacks', 'prompt injection')).toBe(false);
    });

    it('does not match a reordered phrase', () => {
      expect(termMatches('injection of a prompt', 'prompt injection')).toBe(false);
    });
  });

  // --- Unicode-aware boundary: a real regression found in the M1 corpus ---

  describe('Unicode-aware boundary (real-corpus regression)', () => {
    // Pinned from attic/wf-m1-firstrun-2026-08-14.db, ap-news: plain ASCII \b
    // treats the accented "ú" as a non-word character, so \beval\b wrongly
    // matched inside this real Spanish headline. See task-1-report.md.
    it('does not match "eval" inside the Spanish word "evalúan"', () => {
      const title = 'Bears evalúan 2 sitios para estadio en Indiana y podrían usar ambos';
      expect(termMatches(title, 'eval')).toBe(false);
    });

    it('does not match "eval" inside other Spanish evaluar-conjugations', () => {
      expect(termMatches('el comité evaluará la propuesta mañana', 'eval')).toBe(false);
      expect(termMatches('siguen evaluando los daños', 'eval')).toBe(false);
    });
  });

  // --- No stemming: documented, deliberate, and tested ---

  describe('no stemming or pluralization (deliberate scope limit)', () => {
    it('"homer" does not match "homers"', () => {
      expect(termMatches('Sal Stewart homers as the Reds hold off the White Sox', 'homer')).toBe(false);
    });

    it('"Hall of Fame" does not match "Hall of Famers"', () => {
      expect(termMatches('Field of Dreams pregame show features 26 Hall of Famers', 'Hall of Fame')).toBe(
        false,
      );
    });

    it('"eval" does not match "evals"', () => {
      expect(termMatches('run the evals before shipping', 'eval')).toBe(false);
    });
  });

  // --- findMatches / matchProfile ---

  describe('findMatches', () => {
    const terms: InterestTerm[] = [
      { term: 'eval', weight: 1.2 },
      { term: 'RAG', weight: 1.2 },
      { term: 'Ollama', weight: 1.4 },
    ];

    it('returns every matching term with its weight', () => {
      const matches = findMatches('a RAG eval of local Ollama models', terms);
      expect(matches).toEqual(
        expect.arrayContaining([
          { term: 'eval', weight: 1.2 },
          { term: 'RAG', weight: 1.2 },
          { term: 'Ollama', weight: 1.4 },
        ]),
      );
      expect(matches).toHaveLength(3);
    });

    it('returns an empty array when nothing matches', () => {
      expect(findMatches('a completely unrelated headline', terms)).toEqual([]);
    });

    it('omits terms that only match as substrings', () => {
      const matches = findMatches('storage evaluation dragging', terms);
      expect(matches).toEqual([]);
    });
  });

  describe('matchProfile', () => {
    it('matches boosts and suppressions independently', () => {
      const profile = {
        boosts: [{ term: 'eval', weight: 1.2 }],
        suppressions: [{ term: 'NASCAR', weight: 1.5 }],
      };
      const result = matchProfile('NASCAR drivers eval new tires', profile);
      expect(result.boosts).toEqual([{ term: 'eval', weight: 1.2 }]);
      expect(result.suppressions).toEqual([{ term: 'NASCAR', weight: 1.5 }]);
    });
  });

  // --- Grounded directly against real titles from the M1 corpus ---

  describe('against real M1 corpus titles (attic/wf-m1-firstrun-2026-08-14.db)', () => {
    it('the real config suppresses a real AP sports headline', () => {
      const profile = loadInterestsFile(join(process.cwd(), 'config', 'interests.yaml'));
      const title = 'Phillies beat Twins 7-1 at Field of Dreams with 3 homers into corn';
      const result = matchProfile(title, profile);
      expect(result.suppressions.map((m) => m.term)).toContain('homers');
    });

    it('the real config boosts a real CISA Juniper/Junos advisory', () => {
      const profile = loadInterestsFile(join(process.cwd(), 'config', 'interests.yaml'));
      const title = 'Juniper Junos OS EX Series and SRX Series PHP External Variable Modification Vulnerability';
      const result = matchProfile(title, profile);
      expect(result.boosts.map((m) => m.term)).toEqual(
        expect.arrayContaining(['Juniper', 'Junos']),
      );
    });

    // The honest, documented gap: a real Spanish-language AP sports headline
    // (track and field) with no English sports loanword in it. No keyword in
    // this file can catch it -- that needs language detection, a separate
    // mechanism this task deliberately does not fake. Pinned here so the gap
    // stays visible instead of silently "fixing itself" the wrong way.
    it('does NOT suppress a real Spanish-language sports headline (documented gap, not a bug)', () => {
      const profile = loadInterestsFile(join(process.cwd(), 'config', 'interests.yaml'));
      const title = 'Werro logra un puesto en la final de 800 m tras caer en semifinal del Europeo';
      const result = matchProfile(title, profile);
      expect(result.suppressions).toEqual([]);
    });

    it('does not suppress genuine hard news that merely mentions a suppressed-adjacent word', () => {
      const profile = loadInterestsFile(join(process.cwd(), 'config', 'interests.yaml'));
      // Real ap-news title: a breach/fraud story that happens to use the bare
      // word "crypto" -- exactly why "crypto" (as opposed to "cryptocurrency")
      // was deliberately excluded from the suppression list. See
      // config/interests.yaml's header and task-1-report.md.
      const title = 'Hackers breach govt webmail while running parallel crypto fraud';
      const result = matchProfile(title, profile);
      expect(result.suppressions).toEqual([]);
    });

    it('does not suppress a real OWASP GenAI aisec headline that contains "Top 10"', () => {
      const profile = loadInterestsFile(join(process.cwd(), 'config', 'interests.yaml'));
      const title = 'OWASP Top 10 for Agentic Applications – The Benchmark for Agentic Security in the Age of Autonomous AI';
      const result = matchProfile(title, profile);
      expect(result.suppressions).toEqual([]);
    });

    it('does not suppress real legitimate ai/aisec headlines that say "AI-powered"', () => {
      const profile = loadInterestsFile(join(process.cwd(), 'config', 'interests.yaml'));
      const titles = [
        'ReXrank: A Public Leaderboard for AI-Powered Radiology Report Generation',
        'SAIR: Accelerating Pharma R&D with AI-Powered Structural Intelligence',
      ];
      for (const title of titles) {
        expect(matchProfile(title, profile).suppressions).toEqual([]);
      }
    });
  });
});
