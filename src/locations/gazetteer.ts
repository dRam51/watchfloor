import { buildTermRegex } from '../interests/load.ts';
import type { GazetteerConfig, JurisdictionRule, LocationRule } from './load.ts';

/**
 * The gazetteer matcher: item text in, located claims out.
 *
 * ## The rule that decides everything else in this file
 *
 * **An operator name alone never geolocates an item.**
 *
 * "NVIDIA announces Q3 results" is not news about Santa Clara. "Microsoft
 * patches Exchange" is not news about Boydton, Virginia. A gazetteer that
 * treats a company mention as a location match turns this into a map of who
 * was in the headlines, plotted at their head offices -- which is precisely
 * the "news globe" §7.2 opens by saying not to build, and it would be *worse*
 * than useless because it would look busy and informative while encoding
 * nothing but company-mention frequency.
 *
 * The operator is therefore only ever HALF of a match. The other half must be
 * a place: the site's own distinctive name, or its city.
 *
 * ## Confidence tiers, and why the numbers live where they do
 *
 * | tier | what matched | confidence |
 * | --- | --- | --- |
 * | site alias | a spelling declared to attribute this site | the alias's own, from config |
 * | operator + place | the operator entity AND the site's city, in one text | 0.8 |
 * | city alone | the site's city with no operator | **not a match** |
 * | operator alone | **not a match, ever** | — |
 * | country | a country name or demonym | the alias's own, default 0.9 x 0.7 |
 *
 * The per-alias number comes from config rather than from this module because
 * only the person writing the row knows whether a spelling is distinctive.
 * "Veldhoven" is a near-certain reference to ASML's site; "Fab 18" is not,
 * because more than one company numbers a fab 18; "Abilene" is a city that
 * also has a well-known college and a Kansas namesake. This module may LOWER a
 * declared confidence and never raises it.
 *
 * ## Country confidence is deliberately discounted
 *
 * A country name in a headline is a much weaker claim than a facility name --
 * "US lawmakers propose export bill" mentions a country without being about a
 * place in it, and that is the common case rather than the exception. Country
 * matches are scaled by `COUNTRY_DISCOUNT` so they land near the plotting
 * threshold rather than comfortably above it, which keeps the choropleth
 * honest: a country lights up when items are genuinely about it, not whenever
 * its name appears.
 */

// ---------------------------------------------------------------------------
// Tunables, stated rather than scattered
// ---------------------------------------------------------------------------

/**
 * An operator entity plus the site's city in the same text. High, but below a
 * distinctive site alias: "Intel" and "Chandler" together is strong evidence
 * and still weaker than a source writing "Ocotillo".
 */
export const OPERATOR_PLUS_PLACE_CONFIDENCE = 0.8;

/**
 * Applied to every country match. See the module doc: a country name is a
 * weak locative claim, and this is what stops the choropleth from becoming a
 * word-frequency chart.
 */
export const COUNTRY_DISCOUNT = 0.7;

/**
 * A match found only in the summary, never in the title, is discounted.
 *
 * Summaries are up to ~300 characters of source-written prose (the brief caps
 * excerpt storage there) and routinely carry incidental geography -- a
 * dateline, a boilerplate "the Santa Clara-based company" clause. A title is
 * what the item is *about*. This is the same distinction M2's clustering
 * learned the hard way when formulaic body text chained 1,543 unrelated CVEs
 * into one cluster.
 */
export const SUMMARY_ONLY_DISCOUNT = 0.85;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GazetteerInput {
  title: string;
  summaryRaw: string | null;
}

export type LocationEvidence = 'site_alias' | 'operator_and_place';

export interface LocationMatch {
  locationId: string;
  confidence: number;
  /** Which tier produced this, carried through so a low pin can be explained. */
  evidence: LocationEvidence;
  /** The exact spelling that matched, for the same reason. */
  matchedTerm: string;
}

export interface CountryMatch {
  countryCode: string;
  confidence: number;
  matchedTerm: string;
}

export interface GazetteerMatches {
  locations: LocationMatch[];
  countries: CountryMatch[];
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

interface CompiledTerm {
  /** The location id or country code this spelling attributes. */
  key: string;
  term: string;
  confidence: number;
  re: RegExp;
}

interface CompiledSite {
  locationId: string;
  /** Regexes for every entity name that means this site's operator. */
  operators: RegExp[];
  /** The site's city, compiled. Null when the row has no city. */
  city: { term: string; re: RegExp } | null;
}

interface Compiled {
  siteAliases: CompiledTerm[];
  countryAliases: CompiledTerm[];
  sites: CompiledSite[];
}

// Compiling ~42 sites plus ~25 countries per item would dominate the cost of a
// 16,570-item sweep, so a config is compiled once and memoised against the
// config OBJECT via a WeakMap -- no cache to invalidate, no key to get wrong,
// and a discarded config takes its compilation with it. Same mechanism, same
// reasoning, as src/entities/extract.ts's `compiled`.
const compiledCache = new WeakMap<GazetteerConfig, Compiled>();

function compileLocationTerms(locations: readonly LocationRule[]): CompiledTerm[] {
  const out: CompiledTerm[] = [];
  for (const loc of locations) {
    for (const alias of loc.aliases) {
      out.push({
        key: loc.locationId,
        term: alias.term,
        confidence: alias.confidence,
        re: buildTermRegex(alias.term, { caseSensitive: alias.match === 'exact' }),
      });
    }
  }
  return out;
}

function compileCountryTerms(jurisdictions: readonly JurisdictionRule[]): CompiledTerm[] {
  const out: CompiledTerm[] = [];
  for (const j of jurisdictions) {
    for (const alias of j.aliases) {
      out.push({
        key: j.code,
        term: alias.term,
        confidence: alias.confidence * COUNTRY_DISCOUNT,
        re: buildTermRegex(alias.term, { caseSensitive: alias.match === 'exact' }),
      });
    }
  }
  return out;
}

function compileSites(locations: readonly LocationRule[]): CompiledSite[] {
  return locations.map((loc) => ({
    locationId: loc.locationId,
    // Operator matching is case-INSENSITIVE on purpose. The entity gazetteer
    // needs case sensitivity because it carries ordinary words as entity names
    // ("Meta", "Progress"); here the operator term is only ever half a match,
    // gated behind a city co-occurrence, so the false-positive pressure that
    // justifies exact-casing there does not apply.
    operators: loc.entities.map((name) => buildTermRegex(name)),
    city: loc.city === null ? null : { term: loc.city, re: buildTermRegex(loc.city) },
  }));
}

function compile(config: GazetteerConfig): Compiled {
  const cached = compiledCache.get(config);
  if (cached !== undefined) return cached;

  const built: Compiled = {
    siteAliases: compileLocationTerms(config.locations),
    countryAliases: compileCountryTerms(config.jurisdictions),
    sites: compileSites(config.locations),
  };
  compiledCache.set(config, built);
  return built;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Keep the strongest claim per key.
 *
 * Two spellings can attribute the same place in one item -- "Hsinchu Science
 * Park" and "Baoshan" both mean `tsmc-hsinchu`. That is one claim about one
 * place made twice, not two independent claims, so the confidences are NOT
 * combined. Adding them would manufacture certainty out of a source's
 * vocabulary: an item that names a site three ways is not three times more
 * likely to be about it, and a scheme that says otherwise pushes verbose
 * sources over the plotting threshold ahead of precise ones.
 */
function keepStrongest<T extends { confidence: number }>(
  candidates: readonly (T & { key: string })[],
): Map<string, T> {
  const best = new Map<string, T & { key: string }>();
  for (const c of candidates) {
    const existing = best.get(c.key);
    if (existing === undefined || c.confidence > existing.confidence) best.set(c.key, c);
  }
  return best;
}

export function matchGazetteer(input: GazetteerInput, config: GazetteerConfig): GazetteerMatches {
  const compiled = compile(config);

  const title = input.title;
  const summary = input.summaryRaw ?? '';
  const full = summary === '' ? title : `${title} ${summary}`;

  // A term found in the title keeps its declared confidence; one found only in
  // the summary is discounted. `titleHit` is checked first so the cheap case
  // (most matches are in the title) does one test rather than two.
  const scoreIn = (re: RegExp, base: number): number | null => {
    if (re.test(title)) return base;
    if (summary !== '' && re.test(summary)) return base * SUMMARY_ONLY_DISCOUNT;
    return null;
  };

  const locationCandidates: Array<LocationMatch & { key: string }> = [];

  // --- Tier 1: a spelling declared to attribute a specific site -------------
  for (const alias of compiled.siteAliases) {
    const confidence = scoreIn(alias.re, alias.confidence);
    if (confidence === null) continue;
    locationCandidates.push({
      key: alias.key,
      locationId: alias.key,
      confidence,
      evidence: 'site_alias',
      matchedTerm: alias.term,
    });
  }

  // --- Tier 2: operator AND place, together ---------------------------------
  // Never operator alone. See this module's doc comment -- that single
  // restriction is what separates an infrastructure map from a news globe.
  for (const site of compiled.sites) {
    if (site.city === null || site.operators.length === 0) continue;
    if (!site.city.re.test(full)) continue;

    const operator = site.operators.find((re) => re.test(full));
    if (operator === undefined) continue;

    // THE CITY MUST BE IN THE TITLE. Not discounted-if-only-in-the-summary --
    // required.
    //
    // This was a discount at first, and the discount was not enough. Checked
    // against the shape it exists to stop:
    //
    //   title:   "Nvidia announces Q3 earnings beat"
    //   summary: "The Santa Clara company posted record revenue."
    //
    // 0.8 x 0.85 = 0.68, comfortably over the 0.6 threshold, and an earnings
    // story pins to a campus it is not about. "The {city}-based company" is
    // standard newswire provenance boilerplate, so this is not a rare edge --
    // it is the single most common way a city name reaches a summary, and it
    // would have made the compute layer a map of who reported earnings.
    //
    // A headline that names the town is making a locative claim; a summary
    // that names it usually is not. The cost is real and is stated rather than
    // hidden: "Micron to build DRAM fab" / "The Boise-based memory maker said
    // the site would open in 2027" is a genuine location claim and is now
    // missed. Precision is the right side to err on here, because §7.2's whole
    // `verified_at` contract is about being able to TRUST a pin -- a missing
    // pin is a gap, a wrong pin is a lie, and only one of those is visible.
    //
    // The site_alias tier above still accepts summary matches, discounted: a
    // distinctive name like "Veldhoven" or "Ocotillo" in a summary is a real
    // claim, because nobody writes it as provenance boilerplate.
    if (!site.city.re.test(title)) continue;

    locationCandidates.push({
      key: site.locationId,
      locationId: site.locationId,
      confidence: OPERATOR_PLUS_PLACE_CONFIDENCE,
      evidence: 'operator_and_place',
      matchedTerm: site.city.term,
    });
  }

  // --- Countries ------------------------------------------------------------
  const countryCandidates: Array<CountryMatch & { key: string }> = [];
  for (const alias of compiled.countryAliases) {
    const confidence = scoreIn(alias.re, alias.confidence);
    if (confidence === null) continue;
    countryCandidates.push({
      key: alias.key,
      countryCode: alias.key,
      confidence,
      matchedTerm: alias.term,
    });
  }

  // A matched site implies its country, at the site's own confidence -- a
  // stronger and more reliable route than the country name appearing in the
  // text. "TSMC breaks ground at Ocotillo" says United States without using
  // the words, and the choropleth should count it.
  const countryOf = new Map(config.locations.map((l) => [l.locationId, l.country]));
  for (const loc of locationCandidates) {
    const code = countryOf.get(loc.locationId);
    if (code === undefined) continue;
    countryCandidates.push({
      key: code,
      countryCode: code,
      confidence: loc.confidence,
      matchedTerm: `(implied by ${loc.locationId})`,
    });
  }

  const locations = [...keepStrongest(locationCandidates).values()].map(
    ({ locationId, confidence, evidence, matchedTerm }): LocationMatch => ({
      locationId,
      confidence,
      evidence,
      matchedTerm,
    }),
  );
  const countries = [...keepStrongest(countryCandidates).values()].map(
    ({ countryCode, confidence, matchedTerm }): CountryMatch => ({
      countryCode,
      confidence,
      matchedTerm,
    }),
  );

  // Sorted for determinism: these are written to a database whose ledger is
  // meant to be reproducible, and iteration order of a Map is insertion order,
  // which depends on config order. Descending confidence, then key.
  const byStrength = (a: { confidence: number }, b: { confidence: number }) =>
    b.confidence - a.confidence;
  locations.sort((a, b) => byStrength(a, b) || (a.locationId < b.locationId ? -1 : 1));
  countries.sort((a, b) => byStrength(a, b) || (a.countryCode < b.countryCode ? -1 : 1));

  return { locations, countries };
}

/**
 * §7.2: *"Never plot below the threshold."*
 *
 * Applied on the read path as well as the write path, deliberately. The sweep
 * stores every match it finds, including weak ones, because a stored weak
 * match is a fact we recorded and is evidence when tuning the gazetteer; the
 * threshold decides what gets DRAWN. Lowering `min_confidence` in config
 * therefore changes the map without re-running an extraction.
 */
export function plottable<T extends { confidence: number }>(
  matches: readonly T[],
  minConfidence: number,
): T[] {
  return matches.filter((m) => m.confidence >= minConfidence);
}
