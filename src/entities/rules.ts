/**
 * The entity ruleset: `config/entities.yaml` -> a validated, versioned
 * `EntityRuleset` (M5 task 16).
 *
 * ## Why this file exists at all
 * `select count(*) from item_entities` returned **0 across 7,267 live items**
 * because `src/normalize/item.ts` wrote `entities: []` and no extractor
 * existed anywhere in the tree. Five modules read that table. The gap had
 * been visible in `src/score/overrides.ts`'s own comment since M2 and was
 * owned by nobody, which is why it survived three milestones.
 *
 * ## Adding an entity is a CONFIG edit, never a code change
 * Same rule `config/sources.yaml` and `config/interests.yaml` follow, and for
 * the same reason: the person who knows which vendors matter is the owner, not
 * whoever is next in this file. Everything below is validation, so a malformed
 * entry stops the process while someone is watching instead of loading
 * silently and never firing.
 *
 * ## The one thing that is code, not config: the alias MATCH MODE
 * `match: exact` (the default) is case-sensitive; `match: loose` is not.
 * The default is exact because **entity names are proper nouns and product
 * identifiers where capitalisation IS the identity**, and that is measured
 * rather than asserted -- against `data/wf.db` (7,267 items):
 *
 *   | alias      | loose | exact | what the loose-only matches actually were |
 *   | ---------- | ----- | ----- | ----------------------------------------- |
 *   | `iOS`      |   139 |    92 | 47x Cisco **IOS** / IOS XE router software |
 *   | `Progress` |    44 |    13 | 31x "in progress", "remarkable progress"   |
 *   | `Meta`     |    24 |    16 | 8x "meta-learning", "meta tags"            |
 *   | `SEC`      |     6 |     1 | "Sec-WebSocket-Key", "20 sec", "claudit-sec" |
 *
 * Loose stays available per alias because it is right for ordinary
 * multi-word vocabulary, where Title Case in a headline is orthography and not
 * meaning: `prompt injection` matches 2 items exact and 28 loose, and it is
 * the brief's own worked example of an entity.
 *
 * ## Two constraints here exist because of code in OTHER modules
 * Both are enforced at load rather than left to be discovered later:
 *
 *  - **No two names may differ only by case**, and every name must already be
 *    NFC. `groupEntities` in `src/vault/entities.ts` *skips both* members of a
 *    case collision (they are one file on macOS and two on Linux) and merges
 *    NFC-equal spellings. A config that allows either produces entities that
 *    silently never get a note.
 *  - **Names are refused, never sanitised**, and capped at 100 characters.
 *    Task 7 established that sanitising `../../Architecture` yields a request
 *    the vault path layer is then *right* to accept, and that the real
 *    filename budget is 200 bytes rather than 255 (`atomicWrite`'s temp prefix
 *    costs 24+). 100 is well inside it with room for the `.md` and any future
 *    prefix.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { BEATS, type Beat } from '../domain/item.ts';

export class EntityRulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityRulesError';
  }
}

/**
 * What kind of thing an entity is. Deliberately four values, and deliberately
 * NOT stored in `item_entities` -- see this module's companion note in
 * `./extract.ts` and task-16-report.md. The type is a property of the ENTITY,
 * not of the (item, entity) pair, so config is its natural home; nothing reads
 * a type today (§7.4's graph view does not exist) and an unread column is the
 * pattern this milestone keeps finding.
 *
 *  - `org`        companies, agencies, labs, foundations (Microsoft, CISA, OpenAI)
 *  - `product`    named software, hardware, models (Windows, iOS, Llama)
 *  - `concept`    techniques and research topics (prompt injection, RAG)
 *  - `identifier` pattern-extracted external ids (CVE-*, CWE-*); never from
 *                 the gazetteer, so it never appears in config/entities.yaml
 */
export const ENTITY_TYPES = ['org', 'product', 'concept', 'identifier'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * The identifier grammars, by name. These are code and not config because they
 * are *grammars* rather than vocabulary: "a CVE id" is a shape, and a config
 * file that let anyone paste a regex would be a config file that can hang the
 * ingest loop on a catastrophic backtrack. Enabling one is still config.
 */
export const PATTERN_NAMES = ['cve', 'cwe'] as const;
export type PatternName = (typeof PATTERN_NAMES)[number];

export type AliasMatch = 'exact' | 'loose';

export interface EntityAlias {
  term: string;
  match: AliasMatch;
}

export interface EntityRule {
  /** The canonical string written to `item_entities` and used as the vault note name. */
  name: string;
  type: EntityType;
  /** Every spelling that attributes this entity. The name is NOT implicitly one. */
  aliases: EntityAlias[];
  /**
   * Beats this entity can be attributed on, or `null` for every beat.
   *
   * Exists because of a measured, otherwise-unfixable false positive: the live
   * corpus carries *"Army pauses Apache helicopter training missions after
   * crash"* (ap-news) and a PBS variant. Both are `usnews`, both capitalise
   * `Apache`, so case-sensitivity does not separate them from the 62 Apache
   * Software Foundation matches. Scoping the entry to the beats where the
   * software vendor is the only plausible reading does, and it is data.
   */
  beats: Beat[] | null;
}

export interface EntityRuleset {
  entities: EntityRule[];
  patterns: PatternName[];
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// Matches config/interests.yaml's own MAX_TERM_LENGTH: an alias is meant to be
// a word or short phrase that can appear verbatim in a headline.
const MAX_ALIAS_LENGTH = 100;
// See this module's doc comment -- the vault filename budget, not 255.
const MAX_NAME_LENGTH = 100;

const trimmedNonEmpty = (label: string, max: number) =>
  z
    .string()
    .min(1, `${label} must not be empty`)
    .max(max, `${label} must be ${max} characters or fewer`)
    .refine((s) => s.trim() === s && s.length > 0, `${label} must not be blank or have leading/trailing whitespace`);

const AliasSchema = z.union([
  trimmedNonEmpty('alias', MAX_ALIAS_LENGTH).transform((term): EntityAlias => ({ term, match: 'exact' })),
  z
    .object({
      term: trimmedNonEmpty('alias term', MAX_ALIAS_LENGTH),
      match: z.enum(['exact', 'loose']).default('exact'),
    })
    .transform((a): EntityAlias => ({ term: a.term, match: a.match })),
]);

const EntitySchema = z.object({
  name: trimmedNonEmpty('name', MAX_NAME_LENGTH),
  // 'identifier' is deliberately NOT accepted here: identifiers come from a
  // pattern extractor, so a gazetteer entry claiming to be one would be an
  // entity nothing could ever produce a second spelling of.
  type: z.enum(['org', 'product', 'concept']),
  aliases: z.array(AliasSchema).min(1, 'aliases must have at least one entry'),
  beats: z.array(z.enum(BEATS)).min(1, 'beats, if present, must list at least one beat').optional(),
});

const FileSchema = z.object({
  patterns: z.array(z.enum(PATTERN_NAMES)),
  entities: z.array(EntitySchema),
});

// ---------------------------------------------------------------------------
// Name validation -- refused, never sanitised
// ---------------------------------------------------------------------------

// Path separators, filename metacharacters, and the `<`/`>` that open a vault
// managed-block marker. Spaces and hyphens are deliberately ALLOWED -- "Palo
// Alto Networks", "Hugging Face", "D-Link" and "Zero-day" are all real entity
// names, and forbidding them would force sanitising, which task 7 established
// must never happen.
const NAME_FORBIDDEN = /[ -/\\<>:"|?*]/;

function assertUsableName(name: string): void {
  if (name.normalize('NFC') !== name) {
    throw new EntityRulesError(
      `entity name ${JSON.stringify(name)} is not NFC-normalised; write the precomposed form ` +
        `(src/vault/entities.ts merges NFC-equal spellings, so a decomposed name silently becomes another entity)`,
    );
  }
  if (NAME_FORBIDDEN.test(name)) {
    throw new EntityRulesError(
      `entity name ${JSON.stringify(name)} contains a character a vault filename cannot carry; ` +
        `names are refused, never sanitised`,
    );
  }
  if (name.startsWith('.')) {
    throw new EntityRulesError(`entity name ${JSON.stringify(name)} must not start with a dot`);
  }
  if (name === '..' || name.includes('..')) {
    throw new EntityRulesError(`entity name ${JSON.stringify(name)} must not contain '..'`);
  }
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

export function loadEntityRules(yamlText: string): EntityRuleset {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (cause) {
    throw new EntityRulesError(`could not parse YAML: ${(cause as Error).message}`);
  }

  const result = FileSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new EntityRulesError(`invalid entities config:\n${lines.join('\n')}`);
  }

  const entities: EntityRule[] = result.data.entities.map((e) => ({
    name: e.name,
    type: e.type,
    aliases: e.aliases,
    beats: e.beats ?? null,
  }));

  const byFoldedName = new Map<string, string>();
  const aliasOwner = new Map<string, string>();
  for (const entity of entities) {
    assertUsableName(entity.name);

    const folded = entity.name.toLowerCase();
    const existing = byFoldedName.get(folded);
    if (existing !== undefined) {
      throw new EntityRulesError(
        `entity names ${JSON.stringify(existing)} and ${JSON.stringify(entity.name)} differ only by case; ` +
          `src/vault/entities.ts skips BOTH members of a case collision, so neither would ever get a note`,
      );
    }
    byFoldedName.set(folded, entity.name);

    const seenHere = new Set<string>();
    for (const alias of entity.aliases) {
      if (seenHere.has(alias.term)) {
        throw new EntityRulesError(`duplicate alias ${JSON.stringify(alias.term)} on entity ${JSON.stringify(entity.name)}`);
      }
      seenHere.add(alias.term);

      const owner = aliasOwner.get(alias.term);
      if (owner !== undefined && owner !== entity.name) {
        throw new EntityRulesError(
          `alias ${JSON.stringify(alias.term)} is claimed by both ${JSON.stringify(owner)} and ` +
            `${JSON.stringify(entity.name)}; one spelling cannot attribute two entities`,
        );
      }
      aliasOwner.set(alias.term, entity.name);
    }
  }

  return { entities, patterns: result.data.patterns };
}

export function loadEntityRulesFile(path: string): EntityRuleset {
  return loadEntityRules(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// rulesetVersion
// ---------------------------------------------------------------------------

/**
 * A content digest of the ruleset, used as the extraction ledger's key.
 *
 * This is the mechanism that makes a config edit REACH THE EXISTING CORPUS.
 * Without it, adding an entity to `config/entities.yaml` would only ever
 * affect items ingested afterwards, and the 7,267 items already stored would
 * keep whatever the rules said the day they arrived -- silent by construction,
 * and the exact shape of gap this milestone keeps finding.
 *
 * Derived, never hand-maintained, for the same reason `db/migrations`
 * checksums its own files: a version someone has to remember to bump is a
 * version that is eventually wrong while looking right.
 *
 * Order-insensitive within a rule set (entities and aliases are sorted before
 * hashing) so reordering the config for readability does not trigger a
 * full re-extraction, but sensitive to every field that can change what is
 * extracted.
 */
export function rulesetVersion(ruleset: EntityRuleset): string {
  const canonical = {
    patterns: [...ruleset.patterns].sort(),
    entities: [...ruleset.entities]
      .map((e) => ({
        name: e.name,
        type: e.type,
        beats: e.beats === null ? null : [...e.beats].sort(),
        aliases: [...e.aliases].map((a) => [a.term, a.match]).sort((x, y) => (x[0]! < y[0]! ? -1 : x[0]! > y[0]! ? 1 : 0)),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex').slice(0, 16);
}
