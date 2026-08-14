// GENERATED FROM REAL DATA -- see the module doc comment below and
// .superpowers/sdd/2026-08-14-m2-scoring/task-8-report.md for the exact
// extraction queries. Every field on every entry below is either copied
// verbatim from attic/wf-m1-firstrun-2026-08-14.db (read-only, never
// written to -- see CLAUDE.md), or explicitly marked as hand-corrected with
// the reasoning for the correction inline.
//
// ---------------------------------------------------------------------------
// Why these 21 rows (20 distinct item_keys), out of 3,325 real items
// ---------------------------------------------------------------------------
//
// Each one earns its place by exercising a specific, already-documented,
// verified-against-this-corpus behaviour (M2 plan, M2 progress.md):
//
//   - The only 3-source cluster in the corpus (Mangione: ap-news, npr-news,
//     pbs-newshour) and the only 2-source cluster (West Bank settler siege:
//     npr-news, pbs-newshour) -- both at the shipped 0.10 trigram threshold.
//   - A same-source, same-topic TRAP that must stay OUT of the West Bank
//     cluster (a family-interview angle, not the US-condemnation story).
//   - A near-miss TRAP pair (two different Ukraine-drone stories) that must
//     NOT cluster despite heavy surface overlap.
//   - A real arXiv paper cross-listed in cs.AI and cs.CR under one item_key
//     (M2 task 3's beats-union fix), which also happens to be a real boosted
//     item ("prompt injection" appears verbatim in both title and summary).
//   - Three real interest-profile findings that were WRONG on first guess and
//     corrected by an independent re-derivation script rather than assumed
//     (see the task report): an acronym suppress term (WTA) crosses the
//     English/Spanish boundary as an unmodified loanword, a vocabulary
//     suppress term ("homers") does not (Spanish "jonrones" shares no
//     cognate), and a bare score-recap headline with neither kind of term
//     evades suppression in either language.
//   - Three real cisa-kev rows exercising all three states of the
//     recency-bounded hard override: null published_at (fails closed,
//     unmodified real data), a recent hand-corrected date (fires), and an
//     old hand-corrected date (too old, does not fire) -- all three share the
//     IDENTICAL mechanical score (overrides never touch the stored score),
//     which is the point: only the override's own date logic differs.
//   - One ordinary, non-special cyber item (krebs) as a source-trust-only
//     comparison point.
//   - Two ordinary, non-special ai/aisec items (simonwillison, owasp-genai)
//     that were EXPECTED to risk a false keyword hit ("evaluations" near
//     "eval", "Agentic Security" near "agent security", "Top 10" near the
//     deliberately-excluded listicle category) and verified NOT to trigger
//     one -- each confirms a specific, already-documented design decision
//     rather than merely padding the corpus.
//
// ---------------------------------------------------------------------------
// itemType
// ---------------------------------------------------------------------------
//
// cisa-kev rows are 'event' (isGovernmentPrimary matches the 'cisa-' prefix,
// src/classify/itemType.ts) -- matches what attic itself stored, since this
// classification is unaffected by M2 task 7's refinement. Every other row is
// 'analysis', the current (post-task-7) default for ordinary editorial
// content -- NOT what attic stored for these same rows (attic predates task
// 7 and stamped 'press' via M1's cruder <400-word rule; M2 task 7's report
// found 1,572 of 3,325 real items were exactly this press->analysis
// relabelling). Using 'analysis' here reflects what inserting these same
// real titles through the CURRENT pipeline would produce today.
//
// This field is INERT for every score in this file: src/score/mechanical.ts
// excludes item_type entirely (see that module's header), and
// src/score/decay.ts only branches on item_type for the markets beat (see
// resolveHalfLifeHours) -- and this corpus deliberately has no markets items
// (M1/M2 ingest none). Set faithfully anyway, not as '{}'-style padding.
//
// ---------------------------------------------------------------------------
// now
// ---------------------------------------------------------------------------
//
// Pinned at 2026-08-14T12:00:00.000Z -- the same day as the real corpus's
// own fetched_at (2026-08-14T03:47:10.404Z, a single M1 poll cycle), about
// 8.2 hours later. Chosen to give meaningful but not extreme decay for most
// items while still landing the cisa-kev recency-bound math inside real,
// verifiable ranges (see cisaKevRecent / cisaKevOld above).

import type { Beat, ItemType, NewItem } from '../../../src/domain/item.ts';

export const NOW = '2026-08-14T12:00:00.000Z';

export interface GoldenEntry {
  /** Human-readable handle for this test only -- NOT the real item_key (which insertItem derives from canonicalUrl). */
  slug: string;
  /** One-line provenance / why this item is in the corpus. */
  note: string;
  item: NewItem;
}

export const GOLDEN_CORPUS: GoldenEntry[] = [
  {
    slug: 'mangioneAp',
    note: 'The AP leg of the only 3-source cluster in the M1 corpus.',
    item: {
      url: 'https://apnews.com/article/luigi-mangione-plea-unitedhealthcare-ceo-4fa5e27b6baef00f8465e78243a2d58e',
      canonicalUrl: 'https://apnews.com/article/luigi-mangione-plea-unitedhealthcare-ceo-4fa5e27b6baef00f8465e78243a2d58e',
      title: 'Luigi Mangione expected to plead guilty in killing of UnitedHealthcare CEO',
      author: null,
      sourceId: 'ap-news',
      itemType: 'analysis' as ItemType,
      beats: ['usnews'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2026-08-13T19:15:19.000Z',
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: null,
      rawJson: '{}',
    },
  },
  {
    slug: 'mangioneNpr',
    note: 'The NPR leg of the 3-source Mangione cluster.',
    item: {
      url: 'https://www.npr.org/2026/08/13/nx-s1-5930397/mangione-federal-court-hearing-guilty-plea',
      canonicalUrl: 'https://npr.org/2026/08/13/nx-s1-5930397/mangione-federal-court-hearing-guilty-plea',
      title: 'Mangione could plead guilty in federal case ahead of N.Y. murder trial',
      author: 'Brian Mann',
      sourceId: 'npr-news',
      itemType: 'analysis' as ItemType,
      beats: ['usnews'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2026-08-13T17:29:15.000Z',
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: 'A surprise hearing this Friday in federal court has added to speculation that Luigi Mangione could enter a plea, which could derail a state murder trial.',
      rawJson: '{}',
    },
  },
  {
    slug: 'mangionePbs',
    note: 'The PBS leg of the 3-source Mangione cluster (PBS republishing AP wire copy under its own headline).',
    item: {
      url: 'https://www.pbs.org/newshour/nation/ap-report-luigi-mangione-expected-to-plead-guilty-in-federal-case-over-ceo-killing',
      canonicalUrl: 'https://pbs.org/newshour/nation/ap-report-luigi-mangione-expected-to-plead-guilty-in-federal-case-over-ceo-killing',
      title: 'AP report: Luigi Mangione expected to plead guilty in federal case over CEO killing',
      author: null,
      sourceId: 'pbs-newshour',
      itemType: 'analysis' as ItemType,
      beats: ['usnews'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2026-08-13T19:43:23.000Z',
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: 'Luigi Mangione is expected to plead guilty as early as Friday in the federal case accusing him of stalking and killing UnitedHealthcare CEO Brian Thompson, a person familiar with the matter told The Associated Press.',
      rawJson: '{}',
    },
  },
  {
    slug: 'westbankNpr',
    note: 'One leg of the real 2-source West Bank settler-siege cluster.',
    item: {
      url: 'https://www.npr.org/2026/08/13/g-s1-138574/us-west-bank-settlers',
      canonicalUrl: 'https://npr.org/2026/08/13/g-s1-138574/us-west-bank-settlers',
      title: 'U.S. ambassador calls settler siege of Palestinian homes a \'horrific act of terror\'',
      author: 'The Associated Press',
      sourceId: 'npr-news',
      itemType: 'analysis' as ItemType,
      beats: ['usnews'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2026-08-13T09:58:40.000Z',
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: 'The U.S. Ambassador to Israel Mike Huckabee condemned the actions of Jewish settlers who are besieging the home of an American Palestinian family in the Israeli-occupied West Bank.',
      rawJson: '{}',
    },
  },
  {
    slug: 'westbankPbsActOfTerror',
    note: 'The other leg of the 2-source West Bank cluster.',
    item: {
      url: 'https://www.pbs.org/newshour/show/act-of-terror-u-s-condemns-israeli-settler-siege-of-palestinian-homes-in-west-bank',
      canonicalUrl: 'https://pbs.org/newshour/show/act-of-terror-u-s-condemns-israeli-settler-siege-of-palestinian-homes-in-west-bank',
      title: '\'Act of terror\': U.S. condemns Israeli settler siege of Palestinian homes in West Bank',
      author: null,
      sourceId: 'pbs-newshour',
      itemType: 'analysis' as ItemType,
      beats: ['usnews'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2026-08-13T22:55:39.000Z',
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: 'The U.S. condemned the siege of Palestinian homes by Israeli settlers in the West Bank, where they cut off water, electricity and essential supplies to residents. U.S. Ambassador to Israel Mike Huckabee called the settlers\' actions an "act of terror," adding to American pressure that has prompted',
      rawJson: '{}',
    },
  },
  {
    slug: 'westbankPbsFamilyRecounts',
    note: 'TRAP: same source (pbs-newshour) and same topic as the West Bank cluster, but a genuinely different angle (a family interview, not the US condemnation story) -- must stay a singleton, not join the cluster.',
    item: {
      url: 'https://www.pbs.org/newshour/show/palestinian-american-family-recounts-siege-of-west-bank-home-by-israeli-settlers',
      canonicalUrl: 'https://pbs.org/newshour/show/palestinian-american-family-recounts-siege-of-west-bank-home-by-israeli-settlers',
      title: 'Palestinian American family recounts siege of West Bank home by Israeli settlers',
      author: null,
      sourceId: 'pbs-newshour',
      itemType: 'analysis' as ItemType,
      beats: ['usnews'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2026-08-13T22:54:49.000Z',
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: 'Israeli settlers laid siege to the home of an Palestinian American family in the occupied West Bank, sparking condemnation from the U.S. ambassador and an Israeli military response. Nick Schifrin spoke with Qusai and Ahmed Ridi from the house in Qusra, and Qusai\'s brother, Loui Ridi, who helped',
      rawJson: '{}',
    },
  },
  {
    slug: 'ukraineNprCrimea',
    note: 'TRAP: near-miss pair with ukrainePbsRefinery -- heavy surface overlap (Ukraine, drones, Russia) but a different event. Must NOT cluster.',
    item: {
      url: 'https://www.npr.org/2026/08/13/nx-s1-5904418/ukraine-crimea-russia-drone-strikes',
      canonicalUrl: 'https://npr.org/2026/08/13/nx-s1-5904418/ukraine-crimea-russia-drone-strikes',
      title: 'By sky and sea, Ukraine\'s drone strikes challenge Russia\'s grip on Crimea',
      author: 'Greg Myre',
      sourceId: 'npr-news',
      itemType: 'analysis' as ItemType,
      beats: ['usnews'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2026-08-13T15:18:27.000Z',
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: 'Russia maintained an iron grip on Crimea since seizing it from Ukraine in 2014. Many Russian civilians go there to enjoy the beaches. But now Ukraine is hitting Crimea hard, upending daily life.',
      rawJson: '{}',
    },
  },
  {
    slug: 'ukrainePbsRefinery',
    note: 'TRAP: the other half of the Ukraine-drone near-miss pair. Must NOT cluster with ukraineNprCrimea.',
    item: {
      url: 'https://www.pbs.org/newshour/world/ukrainian-drones-strike-major-oil-refinery-deep-inside-russia-setting-it-ablaze',
      canonicalUrl: 'https://pbs.org/newshour/world/ukrainian-drones-strike-major-oil-refinery-deep-inside-russia-setting-it-ablaze',
      title: 'Ukrainian drones strike major oil refinery deep inside Russia, setting it ablaze',
      author: 'Illia Novikov, Associated Press',
      sourceId: 'pbs-newshour',
      itemType: 'analysis' as ItemType,
      beats: ['usnews'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2026-08-13T20:27:15.000Z',
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: 'Russia is one of the world\'s biggest energy producers, with oil providing an economic mainstay as its military tries to push deeper into Ukraine in a slow and costly advance more than four years after Moscow launched its full-scale invasion.',
      rawJson: '{}',
    },
  },
  {
    slug: 'ionescuAp',
    note: 'Real AP sports headline carried ENTIRELY by team/player names and a bare score -- verified NOT suppressed by the shipped interest profile (documented open gap, M2 progress.md), despite being exactly the kind of content the suppression list exists for.',
    item: {
      url: 'https://apnews.com/article/sparks-liberty-score-f71b5d65a7314988a6f01824e34a984c',
      canonicalUrl: 'https://apnews.com/article/sparks-liberty-score-f71b5d65a7314988a6f01824e34a984c',
      title: 'Ionescu scores 20 points and Liberty avoid record collapse to hold off Sparks',
      author: null,
      sourceId: 'ap-news',
      itemType: 'analysis' as ItemType,
      beats: ['usnews'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2026-08-14T02:21:33.000Z',
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: null,
      rawJson: '{}',
    },
  },
  {
    slug: 'swiatekEnAp',
    note: 'English AP tennis headline -- suppressed via the "WTA" league-acronym term.',
    item: {
      url: 'https://apnews.com/article/iga-swiatek-toronto-tennis-wta-tour-c0687b6392d808206aabe9e0fed9624c',
      canonicalUrl: 'https://apnews.com/article/iga-swiatek-toronto-tennis-wta-tour-c0687b6392d808206aabe9e0fed9624c',
      title: 'Swiatek beats Rybakina in Toronto for her first WTA Tour title of the year',
      author: null,
      sourceId: 'ap-news',
      itemType: 'analysis' as ItemType,
      beats: ['usnews'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2026-08-13T23:50:18.000Z',
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: null,
      rawJson: '{}',
    },
  },
  {
    slug: 'swiatekEsAp',
    note: 'Spanish AP wire copy of the SAME story as swiatekEnAp, different item_key (different URL). Verified this ALSO gets suppressed -- "WTA" is used as an unmodified loanword acronym in Spanish sports writing too, so acronym-shaped suppress terms cross the language boundary even though vocabulary-shaped ones (see filisEsAp) do not.',
    item: {
      url: 'https://apnews.com/article/toronto-wta-swiatek-rybakina-final-de493685b996fbbd6ef433c7d22dec2f',
      canonicalUrl: 'https://apnews.com/article/toronto-wta-swiatek-rybakina-final-de493685b996fbbd6ef433c7d22dec2f',
      title: 'Swiatek vence a Rybakina en Toronto para su primer título de la WTA en el año',
      author: null,
      sourceId: 'ap-news',
      itemType: 'analysis' as ItemType,
      beats: ['usnews'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2026-08-14T00:25:58.000Z',
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: null,
      rawJson: '{}',
    },
  },
  {
    slug: 'philliesEnAp',
    note: 'English AP baseball headline -- suppressed via "homers" (note: NOT via "home run", a different configured term; the title says "3 homers into corn").',
    item: {
      url: 'https://apnews.com/article/phillies-twins-score-field-of-dreams-e356a2eea218ab2b61552406eb8a55d6',
      canonicalUrl: 'https://apnews.com/article/phillies-twins-score-field-of-dreams-e356a2eea218ab2b61552406eb8a55d6',
      title: 'Phillies beat Twins 7-1 at Field of Dreams with 3 homers into corn',
      author: null,
      sourceId: 'ap-news',
      itemType: 'analysis' as ItemType,
      beats: ['usnews'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2026-08-14T02:39:49.000Z',
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: null,
      rawJson: '{}',
    },
  },
  {
    slug: 'filisEsAp',
    note: 'Spanish AP wire copy of the SAME real event as philliesEnAp (different item_key). Verified NOT suppressed -- "jonrones" shares no cognate with "homer(s)", so this is the clean, true demonstration of the documented Spanish-content suppression gap. Also verified NOT clustered with philliesEnAp (word-trigram similarity is exactly 0 across the language boundary) -- the same real story survives as two unrelated-looking items, exactly as M2 progress.md records.',
    item: {
      url: 'https://apnews.com/article/filis-mellizos-campo-suenos-iowa-mlb-75aae415cc40d7de94bead914efd9af8',
      canonicalUrl: 'https://apnews.com/article/filis-mellizos-campo-suenos-iowa-mlb-75aae415cc40d7de94bead914efd9af8',
      title: 'Filis conectan 3 jonrones al maizal de "Campo de los Sueños" y vencen 7-1 a Mellizos',
      author: null,
      sourceId: 'ap-news',
      itemType: 'analysis' as ItemType,
      beats: ['usnews'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2026-08-14T03:27:01.000Z',
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: null,
      rawJson: '{}',
    },
  },
  {
    slug: 'krebsPlain',
    note: 'Ordinary, non-overridden, non-boosted, non-suppressed cyber item -- a source-trust-only comparison point against the cisa-kev entries.',
    item: {
      url: 'https://krebsonsecurity.com/2026/08/microsoft-plugs-nearly-400-security-holes/',
      canonicalUrl: 'https://krebsonsecurity.com/2026/08/microsoft-plugs-nearly-400-security-holes',
      title: 'Microsoft Plugs Nearly 400 Security Holes',
      author: 'BrianKrebs',
      sourceId: 'krebs',
      itemType: 'analysis' as ItemType,
      beats: ['cyber'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2026-08-11T21:28:35.000Z',
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: 'Microsoft today released updates to remedy at least 398 security vulnerabilities in its Windows operating systems and supported software, including one weakness that is already being actively exploited and two others that were publicly detailed prior to today.',
      rawJson: '{}',
    },
  },
  {
    slug: 'browsesafeAi',
    note: 'One of the 18 real arXiv papers cross-listed in cs.AI and cs.CR (M2 task 3\'s beats-union fix). This is the arxiv-cs-ai leg (beat ai). Same item_key as browsesafeCr (same canonical_url). Title AND summary both contain "Prompt Injection" verbatim -- a real boosted item.',
    item: {
      url: 'https://arxiv.org/abs/2511.20597',
      canonicalUrl: 'https://arxiv.org/abs/2511.20597',
      title: 'BrowseSafe: Understanding and Preventing Prompt Injection Within AI Browser Agents',
      author: 'Kaiyuan Zhang, Mark Tenenholtz, Kyle Polley, Jerry Ma, Denis Yarats, Ninghui Li',
      sourceId: 'arxiv-cs-ai',
      itemType: 'analysis' as ItemType,
      beats: ['ai'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2026-08-13T04:00:00.000Z',
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: 'arXiv:2511.20597v2 Announce Type: replace-cross \nAbstract: The integration of artificial intelligence (AI) agents into web browsers introduces security challenges that go beyond traditional web application threat models. Prior work has identified prompt injection as a new attack vector for web',
      rawJson: '{}',
    },
  },
  {
    slug: 'browsesafeCr',
    note: 'The arxiv-cs-cr leg (beat aisec) of the same cross-listed paper as browsesafeAi.',
    item: {
      url: 'https://arxiv.org/abs/2511.20597',
      canonicalUrl: 'https://arxiv.org/abs/2511.20597',
      title: 'BrowseSafe: Understanding and Preventing Prompt Injection Within AI Browser Agents',
      author: 'Kaiyuan Zhang, Mark Tenenholtz, Kyle Polley, Jerry Ma, Denis Yarats, Ninghui Li',
      sourceId: 'arxiv-cs-cr',
      itemType: 'analysis' as ItemType,
      beats: ['aisec'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2026-08-13T04:00:00.000Z',
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: 'arXiv:2511.20597v2 Announce Type: replace-cross \nAbstract: The integration of artificial intelligence (AI) agents into web browsers introduces security challenges that go beyond traditional web application threat models. Prior work has identified prompt injection as a new attack vector for web',
      rawJson: '{}',
    },
  },
  {
    slug: 'simonwillisonPlain',
    note: 'Ordinary ai-beat item. Verified NOT matched by the "eval" boost term -- "evaluations" is correctly excluded by whole-word matching (this is the exact class of collision Task 1\'s Unicode-boundary fix targets, confirmed here on a different real title than the one in task-1-report.md).',
    item: {
      url: 'https://simonwillison.net/2026/Aug/5/third-party-cyber-evaluations/',
      canonicalUrl: 'https://simonwillison.net/2026/Aug/5/third-party-cyber-evaluations',
      title: 'Third-party cyber evaluations involving OpenAI models',
      author: 'Simon Willison',
      sourceId: 'simonwillison',
      itemType: 'analysis' as ItemType,
      beats: ['ai'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2026-08-05T23:45:32.000Z',
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: '<p><strong><a href="https://openai.com/index/third-party-cyber-evaluations-involving-openai-models/">Third-party cyber evaluations involving OpenAI models</a></strong></p>\nAnd <em>another one</em>. I had to create a <a',
      rawJson: '{}',
    },
  },
  {
    slug: 'owaspGenaiTop10',
    note: 'Ordinary aisec-beat item. Verified NOT matched by "agent security" (the title says "Agentic Security", a different word) or by any suppression term -- confirms config/interests.yaml\'s own documented reasoning for deliberately excluding bare "top 10" from the listicle-suppression list.',
    item: {
      url: 'https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/?utm_source=rss&utm_medium=rss&utm_campaign=owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai',
      canonicalUrl: 'https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai',
      title: 'OWASP Top 10 for Agentic Applications – The Benchmark for Agentic Security in the Age of Autonomous AI',
      author: 'John Sotiropoulos',
      sourceId: 'owasp-genai',
      itemType: 'analysis' as ItemType,
      beats: ['aisec'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2025-12-10T07:55:07.000Z',
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: '<p>Introducing the OWASP Top 10 for Agentic AI Applications - our community’s actionable framework for securing autonomous, tool-using AI systems. Built at global scale  informed by real incidents, and based on our work already adopted across industry, this release marks a pivotal moment in turning',
      rawJson: '{}',
    },
  },
  {
    slug: 'cisaKevNull',
    note: 'Real cisa-kev row, published_at left NULL exactly as truly stored (attic predates the bare-YYYY-MM-DD parse fix) -- demonstrates the override\'s fail-closed-on-null rule on genuine, unmodified data.',
    item: {
      url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2026-20349',
      canonicalUrl: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2026-20349',
      title: 'Cisco Secure Firewall Adaptive Security Appliance (ASA) and Secure Firewall Threat Defense (FTD) Heap Inspection Vulnerability',
      author: null,
      sourceId: 'cisa-kev',
      itemType: 'event' as ItemType,
      beats: ['cyber'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: null,
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: 'Cisco Secure Firewall Adaptive Security Appliance (ASA) and Secure Firewall Threat Defense (FTD) contain a heap inspection vulnerability that could allow an unauthenticated, remote attacker to cause the device to reload unexpectedly, resulting in a denial of service (DoS) condition.',
      rawJson: '{"cveID":"CVE-2026-20349","vendorProject":"Cisco","product":"Secure Firewall Adaptive Security Appliance (ASA) and Secure Firewall Threat Defense (FTD) ","vulnerabilityName":"Cisco Secure Firewall Adaptive Security Appliance (ASA) and Secure Firewall Threat Defense (FTD) Heap Inspection Vulnerability","dateAdded":"2026-08-11","shortDescription":"Cisco Secure Firewall Adaptive Security Appliance (ASA) and Secure Firewall Threat Defense (FTD) contain a heap inspection vulnerability that could allow an unauthenticated, remote attacker to cause the device to reload unexpectedly, resulting in a denial of service (DoS) condition.","requiredAction":"Apply mitigations in accordance with vendor instructions, ensuring compliance with CISA’s BOD 26-04 Prioritizing Security Updates Based on Risk (see URL in Notes) guidance and CISA’s “Forensics Triage Requirements” (see URL in Notes). Follow applicable BOD 26-04 guidance for cloud services or discontinue use of the product if mitigations are unavailable. Stakeholders are responsible for evaluating each asset\'s internet exposure and ensuring adherence to BOD 26-04 patching guidelines.","dueDate":"2026-08-14","knownRansomwareCampaignUse":"Unknown","notes":"https://sec.cloudapps.cisco.com/security/center/content/CiscoSecurityAdvisory/cisco-sa-asaftd-vpn-dos-dzv4mQFF ; BOD 26-04: https://www.cisa.gov/news-events/directives/bod-26-04-prioritizing-security-updates-based-risk ; Forensics Triage Requirements: https://www.cisa.gov/news-events/directives/bod-26-04-implementation-guidance-prioritizing-security-updates-based-risk ; https://nvd.nist.gov/vuln/detail/CVE-2026-20349","cwes":["CWE-244"]}',
    },
  },
  {
    slug: 'cisaKevRecent',
    note: 'Real cisa-kev row (title, CVE id, full raw_json all real). published_at is HAND-CORRECTED from this item\'s own real raw_json.dateAdded ("2026-08-11") via the same bare-date-to-UTC-midnight parse already shipped elsewhere in this codebase (src/normalize/item.ts parseDateOnly) -- the attic snapshot predates that fix for cisa-kev specifically, so the real stored row has published_at NULL here too. This is the one item in the corpus that makes the recency-bounded override actually fire.',
    item: {
      url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2026-68820',
      canonicalUrl: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2026-68820',
      title: 'Microsoft Windows Ancillary Function Driver for WinSock Use-After-Free Vulnerability',
      author: null,
      sourceId: 'cisa-kev',
      itemType: 'event' as ItemType,
      beats: ['cyber'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2026-08-11T00:00:00.000Z',  // HAND-CORRECTED from raw_json.dateAdded, see note above
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: 'Microsoft Windows Ancillary Function Driver for WinSock contains a use-after-free vulnerability that allows an authorized attacker to elevate privileges locally.',
      rawJson: '{"cveID":"CVE-2026-68820","vendorProject":"Microsoft","product":"Windows Ancillary Function Driver for WinSock ","vulnerabilityName":"Microsoft Windows Ancillary Function Driver for WinSock Use-After-Free Vulnerability","dateAdded":"2026-08-11","shortDescription":"Microsoft Windows Ancillary Function Driver for WinSock contains a use-after-free vulnerability that allows an authorized attacker to elevate privileges locally.","requiredAction":"Apply mitigations in accordance with vendor instructions, ensuring compliance with CISA’s BOD 26-04 Prioritizing Security Updates Based on Risk (see URL in Notes) guidance and CISA’s “Forensics Triage Requirements” (see URL in Notes). Follow applicable BOD 26-04 guidance for cloud services or discontinue use of the product if mitigations are unavailable. Stakeholders are responsible for evaluating each asset\'s internet exposure and ensuring adherence to BOD 26-04 patching guidelines.","dueDate":"2026-08-25","knownRansomwareCampaignUse":"Unknown","notes":"https://portal.msrc.microsoft.com/en-US/security-guidance/advisory/CVE-2026-68820 ; BOD 26-04: https://www.cisa.gov/news-events/directives/bod-26-04-prioritizing-security-updates-based-risk ; Forensics Triage Requirements: https://www.cisa.gov/news-events/directives/bod-26-04-implementation-guidance-prioritizing-security-updates-based-risk ; https://nvd.nist.gov/vuln/detail/CVE-2026-68820","cwes":["CWE-416"]}',
    },
  },
  {
    slug: 'cisaKevOld',
    note: 'Same treatment as cisaKevRecent, but using dateAdded from the 2021-11-03 backfill spike (287 KEV entries share this exact date in the real corpus) -- demonstrates the override NOT firing once the recency bound (30 days) is exceeded, even though the mechanical score is identical to the other two cisa-kev rows.',
    item: {
      url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2021-27104',
      canonicalUrl: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2021-27104',
      title: 'Accellion FTA OS Command Injection Vulnerability',
      author: null,
      sourceId: 'cisa-kev',
      itemType: 'event' as ItemType,
      beats: ['cyber'] as Beat[],
      entities: [], // item_entities carries 0 real rows in M1 (no extractor yet) -- faithful to real data.
      publishedAt: '2021-11-03T00:00:00.000Z',  // HAND-CORRECTED from raw_json.dateAdded, see note above
      fetchedAt: '2026-08-14T03:47:10.404Z',
      summaryRaw: 'Accellion FTA contains an OS command injection vulnerability exploited via a crafted POST request to various admin endpoints.',
      rawJson: '{"cveID":"CVE-2021-27104","vendorProject":"Accellion","product":"FTA","vulnerabilityName":"Accellion FTA OS Command Injection Vulnerability","dateAdded":"2021-11-03","shortDescription":"Accellion FTA contains an OS command injection vulnerability exploited via a crafted POST request to various admin endpoints.","requiredAction":"Apply updates per vendor instructions.","dueDate":"2021-11-17","knownRansomwareCampaignUse":"Known","notes":"https://nvd.nist.gov/vuln/detail/CVE-2021-27104","cwes":["CWE-20","CWE-78"]}',
    },
  },
];
