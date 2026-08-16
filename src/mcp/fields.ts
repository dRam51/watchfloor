/**
 * The one list of things §8.2 says may never cross the boundary — and the
 * word-segmenting normaliser that makes matching it precise rather than
 * approximate (M5 task 10).
 *
 * §8.2, verbatim:
 *
 * > *"What Watchfloor must never expose or compute: sentiment scores,
 * > directional labels (bullish/bearish), price targets, conviction ratings,
 * > trade signals, position sizing, or any field whose name implies a
 * > recommendation."*
 * > *"The bot sees `signal_score` only — never `read_score`."*
 *
 * ## Why ONE list, consumed by two layers
 *
 * `src/mcp/readonly.ts` refuses SQL that names any of these identifiers, so a
 * forbidden value never enters the process. `src/mcp/serialize.ts` refuses a
 * response payload carrying any of them as a field name, so a value obtained
 * some other way still cannot leave. Two independent layers, one definition:
 * a token added here tightens both at once, and neither can drift from the
 * other by being edited alone.
 *
 * ## Why matching is on WORDS, not substrings
 *
 * A naive `name.includes('rating')` also matches `operating_system`, and a
 * guard with false positives is a guard people route around. So a name is
 * segmented into words first — `read_score`, `readScore`, `READ_SCORE`,
 * `read-score` and `"Read Score"` all become `read score` — and a rule matches
 * only whole words in sequence. `operating` is one word and is not `rating`.
 *
 * The direction of failure is still deliberately harsh: a match is a REFUSAL,
 * never a silent strip. See src/mcp/serialize.ts for why.
 */

/**
 * Lowercased, space-separated words. The single normal form both layers
 * compare against.
 *
 * Boundaries are inserted at every non-alphanumeric character and at every
 * lower-to-upper transition, with acronym runs handled so `HTTPStatus` reads
 * as `http status` rather than `h t t p status`. Digits stay attached to the
 * word they follow (`score2` is one word), because a trailing digit is a
 * version marker, not a new concept.
 */
export function normalizeFieldName(name: string): string {
  return name
    .replace(/[^A-Za-z0-9]+/g, ' ')
    // `HTTPStatus` -> `HTTP Status`: an uppercase run followed by a
    // capitalised word breaks before the last capital.
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    // `readScore` -> `read Score`, `score2Read` -> `score2 Read`.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Every word sequence that may not appear in a field name or a SQL identifier.
 *
 * Each entry is matched as a whole-word phrase against a normalised name, so
 * `price target` catches `priceTarget`, `price_target` and `TARGET price`'s
 * sibling `targetPrice` (listed separately — word ORDER is not commuted, on
 * purpose: guessing at reorderings would make the rule unpredictable, while an
 * explicit list is auditable).
 *
 * Variants are spelled out rather than stemmed for the same reason. A stemmer
 * is a second thing that can be wrong, and this list is short enough to read.
 */
export const FORBIDDEN_FIELD_PHRASES: readonly string[] = [
  // "The bot sees signal_score only -- never read_score."
  'read score',
  'reading score',
  // "sentiment scores"
  'sentiment',
  // "directional labels (bullish/bearish)"
  'bullish',
  'bearish',
  'direction',
  'directional',
  // "price targets"
  'price target',
  'target price',
  // "conviction ratings"
  'conviction',
  'rating',
  'ratings',
  // "trade signals"
  'trade signal',
  'trade signals',
  'buy signal',
  'sell signal',
  'entry signal',
  'exit signal',
  // "position sizing"
  'position size',
  'position sizing',
  'allocation',
  'overweight',
  'underweight',
  // "any field whose name implies a recommendation"
  'recommend',
  'recommends',
  'recommended',
  'recommendation',
  'recommendations',
  'advice',
  'suggested trade',
  'stop loss',
  'take profit',
  'upside',
  'downside',
] as const;

/**
 * The phrase that forbids `name`, or `null` if none does.
 *
 * Returns the offending phrase rather than a boolean so a refusal can say
 * WHICH rule it broke — a guard whose message is only "forbidden" gets
 * disabled by the next person who trips it and cannot tell why.
 */
export function forbiddenPhraseFor(name: string): string | null {
  const padded = ` ${normalizeFieldName(name)} `;
  for (const phrase of FORBIDDEN_FIELD_PHRASES) {
    if (padded.includes(` ${phrase} `)) return phrase;
  }
  return null;
}
