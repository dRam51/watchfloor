import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EntityRulesError,
  loadEntityRules,
  loadEntityRulesFile,
  rulesetVersion,
} from '../../src/entities/rules.ts';

const CONFIG_PATH = join(process.cwd(), 'config', 'entities.yaml');

function yaml(body: string): string {
  return body;
}

const MINIMAL = yaml(`
patterns: [cve]
entities:
  - name: Microsoft
    type: org
    aliases: [Microsoft, MSFT]
`);

describe('loadEntityRules -- shape', () => {
  it('loads a minimal file, defaulting every alias to exact matching', () => {
    const rules = loadEntityRules(MINIMAL);
    expect(rules.patterns).toEqual(['cve']);
    expect(rules.entities).toHaveLength(1);
    expect(rules.entities[0]).toMatchObject({ name: 'Microsoft', type: 'org', beats: null });
    expect(rules.entities[0]!.aliases).toEqual([
      { term: 'Microsoft', match: 'exact' },
      { term: 'MSFT', match: 'exact' },
    ]);
  });

  it('accepts the object alias form and its explicit match mode', () => {
    const rules = loadEntityRules(`
patterns: []
entities:
  - name: Prompt injection
    type: concept
    aliases:
      - { term: "prompt injection", match: loose }
      - "PI-attack"
`);
    expect(rules.entities[0]!.aliases).toEqual([
      { term: 'prompt injection', match: 'loose' },
      { term: 'PI-attack', match: 'exact' },
    ]);
  });

  it('accepts an optional beat scope and rejects an unknown beat', () => {
    const scoped = loadEntityRules(`
patterns: []
entities:
  - name: Apache Software Foundation
    type: org
    beats: [cyber, ai]
    aliases: [Apache]
`);
    expect(scoped.entities[0]!.beats).toEqual(['cyber', 'ai']);
    expect(() =>
      loadEntityRules(`
patterns: []
entities:
  - name: X
    type: org
    beats: [sports]
    aliases: [X]
`),
    ).toThrow(EntityRulesError);
  });

  it('rejects an unknown pattern name rather than ignoring it', () => {
    // An ignored pattern is an extractor that silently never runs -- the exact
    // shape of failure this milestone keeps finding.
    expect(() => loadEntityRules('patterns: [cve, sbom]\nentities: []\n')).toThrow(/sbom/);
  });

  it('rejects an entity with no aliases -- it could never match anything', () => {
    expect(() =>
      loadEntityRules('patterns: []\nentities:\n  - name: X\n    type: org\n    aliases: []\n'),
    ).toThrow(EntityRulesError);
  });
});

describe('loadEntityRules -- the cross-module constraints', () => {
  it('refuses two entity names differing only by case', () => {
    // src/vault/entities.ts groupEntities SKIPS BOTH members of a case
    // collision, so a config that allows one silently produces two entities
    // that never get a note.
    expect(() =>
      loadEntityRules(`
patterns: []
entities:
  - { name: OpenAI, type: org, aliases: [OpenAI] }
  - { name: Openai, type: org, aliases: [Openai] }
`),
    ).toThrow(/differ only by case/i);
  });

  it('refuses a name that is not already NFC-normalised', () => {
    // Same reason: groupEntities merges NFC-equal spellings, so a
    // decomposed name in config is a name that arrives pre-merged with
    // something else and stops being the string the author wrote.
    const decomposed = 'Café AI';
    expect(() =>
      loadEntityRules(
        `patterns: []\nentities:\n  - { name: "${decomposed}", type: org, aliases: [Cafe] }\n`,
      ),
    ).toThrow(/NFC/);
  });

  it('refuses a name a vault path layer would have to reject anyway', () => {
    for (const bad of ['../Architecture', 'a/b', 'a\\b', '.hidden', 'a:b', 'a<b', 'a|b']) {
      expect(() =>
        loadEntityRules(
          `patterns: []\nentities:\n  - { name: ${JSON.stringify(bad)}, type: org, aliases: [zz] }\n`,
        ),
        `accepted ${JSON.stringify(bad)}`,
      ).toThrow(EntityRulesError);
    }
  });

  it('caps the name well inside the 200-byte vault filename budget', () => {
    const long = 'A'.repeat(101);
    expect(() =>
      loadEntityRules(`patterns: []\nentities:\n  - { name: ${long}, type: org, aliases: [zz] }\n`),
    ).toThrow(EntityRulesError);
  });

  it('refuses the same alias term claimed by two entities', () => {
    expect(() =>
      loadEntityRules(`
patterns: []
entities:
  - { name: Meta, type: org, aliases: [Meta] }
  - { name: Metadata, type: concept, aliases: [Meta] }
`),
    ).toThrow(/claimed by/i);
  });

  it('refuses a blank or untrimmed alias term', () => {
    for (const bad of ['" "', '" Meta"', '"Meta "', '""']) {
      expect(() =>
        loadEntityRules(`patterns: []\nentities:\n  - { name: M, type: org, aliases: [${bad}] }\n`),
      ).toThrow(EntityRulesError);
    }
  });
});

describe('rulesetVersion', () => {
  it('is stable across two loads of identical text', () => {
    expect(rulesetVersion(loadEntityRules(MINIMAL))).toBe(rulesetVersion(loadEntityRules(MINIMAL)));
  });

  it('is insensitive to formatting but sensitive to every rule field', () => {
    const base = rulesetVersion(loadEntityRules(MINIMAL));
    // Reflowed YAML, same rules.
    expect(
      rulesetVersion(
        loadEntityRules(`
patterns:
  - cve

entities:
  - name: Microsoft
    type: org
    aliases:
      - Microsoft
      - MSFT
`),
      ),
    ).toBe(base);

    const changed = [
      MINIMAL.replace('[cve]', '[cve, cwe]'), // pattern set
      MINIMAL.replace('type: org', 'type: product'), // type
      MINIMAL.replace('[Microsoft, MSFT]', '[Microsoft]'), // alias removed
      MINIMAL.replace('[Microsoft, MSFT]', '[Microsoft, MSFT, Redmond]'), // alias added
      MINIMAL.replace('name: Microsoft', 'name: Microsoft Corporation'), // name
      MINIMAL + '    beats: [cyber]\n', // beat scope
      `${MINIMAL}  - { name: Cisco, type: org, aliases: [Cisco] }\n`, // new entity
    ];
    for (const text of changed) {
      expect(rulesetVersion(loadEntityRules(text)), text).not.toBe(base);
    }
  });

  it('is a short lowercase hex digest, not a hand-maintained number', () => {
    // Hand-maintained versions go stale silently; this one cannot.
    expect(rulesetVersion(loadEntityRules(MINIMAL))).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does NOT change when alias order changes -- the rules are a set', () => {
    expect(rulesetVersion(loadEntityRules(MINIMAL.replace('[Microsoft, MSFT]', '[MSFT, Microsoft]')))).toBe(
      rulesetVersion(loadEntityRules(MINIMAL)),
    );
  });
});

describe('the shipped config/entities.yaml', () => {
  it('loads', () => {
    expect(() => loadEntityRulesFile(CONFIG_PATH)).not.toThrow();
  });

  it('has a canonical name for every entity that no OTHER entity claims as an alias', () => {
    const rules = loadEntityRulesFile(CONFIG_PATH);
    const owner = new Map<string, string>();
    for (const e of rules.entities) for (const a of e.aliases) owner.set(a.term, e.name);
    for (const e of rules.entities) {
      const claimant = owner.get(e.name);
      if (claimant !== undefined) expect(claimant).toBe(e.name);
    }
  });

  it('documents its own matching rules in the file header', () => {
    // config/interests.yaml's precedent: the reasoning lives beside the data,
    // because adding a term is a config edit and the next editor is the owner.
    const text = readFileSync(CONFIG_PATH, 'utf8');
    expect(text).toMatch(/exact/);
    expect(text).toMatch(/loose/);
  });

  it('ships both identifier patterns enabled', () => {
    expect(loadEntityRulesFile(CONFIG_PATH).patterns).toEqual(expect.arrayContaining(['cve', 'cwe']));
  });
});
