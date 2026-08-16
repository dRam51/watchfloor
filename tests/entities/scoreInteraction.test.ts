import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadInterestsFile, matchProfile } from '../../src/interests/load.ts';
import { loadEntityRulesFile } from '../../src/entities/rules.ts';
import { buildScoringText } from '../../src/score/mechanical.ts';

/**
 * EXTRACTED ENTITIES CHANGE STORED SCORES, and this file is the check on that.
 *
 * `buildScoringText` folds an item's entities into the same text
 * `matchProfile` runs the interest profile over, so every entity name is
 * effectively appended to every headline it appears on. `src/score/
 * mechanical.ts`'s own header predicted this: *"an entity extractor landing
 * later makes entity matches count automatically, no code change needed
 * here."* It has now landed, so the interaction is real rather than
 * hypothetical, and `item_scores` is append-only -- a score written from a bad
 * interaction cannot be corrected in place.
 *
 * Two configs are involved and neither knows about the other. This is where
 * they are checked against each other.
 */

const INTERESTS = loadInterestsFile(join(process.cwd(), 'config', 'interests.yaml'));
const ENTITIES = loadEntityRulesFile(join(process.cwd(), 'config', 'entities.yaml'));

describe('entity names against the interest profile', () => {
  it('NO entity name matches a SUPPRESSION term', () => {
    // A suppression matched by an entity name would crush the score of every
    // item carrying that entity -- and `suppress_gain > boost_gain`
    // (config/scoring.yaml), so it crushes harder than a boost lifts. The
    // hazard is concrete: "Oscar", "All-Star", "NFT" and "bitcoin" are all
    // real suppression terms and all plausible entity names.
    const offenders = ENTITIES.entities
      .map((e) => ({ name: e.name, hits: matchProfile(e.name, INTERESTS).suppressions.map((s) => s.term) }))
      .filter((r) => r.hits.length > 0);
    expect(offenders).toEqual([]);
  });

  it('the boost matches it DOES create are the three intended ones, named', () => {
    // Not asserted to be empty: this is the mechanism mechanical.ts designed
    // for. Asserted to be an exact, small, reviewed set, so a future config
    // edit that widens it has to come here and say so.
    const boosting = ENTITIES.entities
      .map((e) => [e.name, matchProfile(e.name, INTERESTS).boosts.map((b) => b.term)] as const)
      .filter(([, hits]) => hits.length > 0)
      .map(([name]) => name)
      .sort();
    expect(boosting).toEqual(['Juniper Networks', 'Ollama', 'Prompt injection']);
  });

  it('an identifier is inert against the interest profile', () => {
    // 2,567 of the 2,674 entities the live corpus produces are CVE/CWE ids.
    // If an id form ever matched an interest term, it would move the score of
    // roughly half the corpus at once.
    const matches = matchProfile('CVE-2026-20349 CVE-2014-6271 CWE-79 CWE-1321', INTERESTS);
    expect(matches.boosts).toEqual([]);
    expect(matches.suppressions).toEqual([]);
  });

  it('an entity genuinely widens a match the title alone would miss', () => {
    // The intended effect, shown rather than asserted abstractly. "ScreenOS"
    // is a real Juniper product named in a real cisa-kev title and it is NOT an
    // interests.yaml term -- but the entity it produces is. That is the
    // entity-match half of the spec's signal_score, and it is why
    // config/entities.yaml carries aliases the interest profile does not.
    const title = 'ScreenOS Improper Authentication Vulnerability';
    expect(matchProfile(buildScoringText(title, null, []), INTERESTS).boosts).toEqual([]);
    expect(
      matchProfile(buildScoringText(title, null, ['Juniper Networks']), INTERESTS).boosts.map((b) => b.term),
    ).toEqual(['Juniper']);
  });
});
