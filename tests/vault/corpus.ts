/**
 * Real rows from the live corpus, for the `saved/` promotion tests (M5 task 8).
 *
 * Provenance, and it matters: every row below was read out of `data/wf.db` —
 * the live corpus at 8 migrations, 5,937 item keys — via `VACUUM INTO` to a
 * scratch copy, which is the only sanctioned way to read it (a `-readonly`
 * open fails while its WAL is hot, and nothing here may ever write to it). The
 * one Spanish-language row is from `attic/wf-m1-firstrun-2026-08-14.db`, the
 * archived first ingest, opened read-only; the AP Spanish copy CLAUDE.md
 * records lives there rather than in the current corpus.
 *
 * The point of copying rows rather than inventing them: a slug function that
 * works on `foo-bar` and breaks on an em dash, a combining accent, an emoji,
 * a slash, or 288 characters is a real class of bug, and every one of those is
 * below. {@link WIN32K_GROUP} is the strongest of them — 24 DIFFERENT CVEs
 * that CISA publishes under one title.
 *
 * Generated once and committed; nothing regenerates it, so it is stable
 * evidence rather than a live query whose answer drifts with the next ingest.
 */

import type { Beat } from '../../src/domain/item.ts';

export interface CorpusRow {
  readonly itemKey: string;
  readonly title: string;
  readonly canonicalUrl: string;
  readonly sourceId: string;
  readonly beats: readonly Beat[];
  readonly entities: readonly string[];
  readonly publishedAt: string | null;
  /** The FIRST `fetched_at` across every version — the immutable one. */
  readonly firstSeenAt: string;
  readonly summaryRaw: string | null;
}

/**
 * The 24 distinct CVEs CISA publishes as "Microsoft Win32k Privilege
 * Escalation Vulnerability" — 23 byte-identical titles and one differing only
 * in the case of the `k` (CVE-2023-29336). Every one is a different
 * `canonical_url` and therefore a different `item_key`, and all 24 share a
 * `fetched_at`, because KEV dumps its whole catalogue on a first poll.
 *
 * The largest of 185 slug-collision groups covering 551 of 5,937 items.
 */
export const WIN32K_GROUP: readonly CorpusRow[] = [
  {
    itemKey: "23ff95736802c630c3600697e3f76cf8008fd10fb285df2374bbba9a1ae3ddd3",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2013-3660",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2022-03-28T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "The EPATHOBJ::pprFlattenRec function in win32k.sys in the kernel-mode drivers in Microsoft does not properly initialize a pointer for the next object in a certain list, which allows local users to gain privileges.",
  },
  {
    itemKey: "086ebc857c5ec9eac9f029843ad135fe676d5a16fecf275769d6ef43b195b03e",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2014-4113",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2022-05-04T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Microsoft Win32k contains an unspecified vulnerability that allows for privilege escalation.",
  },
  {
    itemKey: "ee82d5bdb2168da49b482d90b8c339fb6073dd8add737f235ec7219570e21f47",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2015-1701",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2022-03-03T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "An unspecified vulnerability exists in the Win32k.sys kernel-mode driver in Microsoft Windows Server that allows a local attacker to execute arbitrary code with elevated privileges.",
  },
  {
    itemKey: "6eee1140241e2dd2067bd6e882f56c5225157a2282fcd15200c944853cac4907",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2015-2360",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2022-05-25T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Win32k.sys in the kernel-mode drivers in Microsoft Windows allows local users to gain privileges or cause denial-of-service (DoS).",
  },
  {
    itemKey: "3732669e30b53d4869190f32554acf01e3d3168d9a0bde000b6a184f7e432ac3",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2016-0165",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2023-06-22T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Microsoft Win32k contains an unspecified vulnerability that allows for privilege escalation.",
  },
  {
    itemKey: "300bccf45c75a30fd11891ea53ddd84b237660c5abb0af2d6a71a2195991a808",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2016-0167",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2021-11-03T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Microsoft Win32k contains an unspecified vulnerability that allows for privilege escalation via a crafted application",
  },
  {
    itemKey: "7cd11bf74af46c42ab8be395e291bd8f57cd5c050b189c2af7fc80c93323f043",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2016-7255",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2021-11-03T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Microsoft Win32k kernel-mode driver fails to properly handle objects in memory which allows for privilege escalation. Successful exploitation allows an attacker to run code in kernel mode.",
  },
  {
    itemKey: "1ce9a8bfb1ebd8b37d924c0614dfbf534669e77f273f37cb0cb5e11ef2594ed2",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2017-0263",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2022-02-10T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Microsoft Win32k contains a privilege escalation vulnerability due to the Windows kernel-mode driver failing to properly handle objects in memory.",
  },
  {
    itemKey: "ca51fd0641fa3aa29fc1ef1ece969fe684a777c8b7f0e3997e739b9b9d17d765",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2018-8120",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2022-03-15T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "A privilege escalation vulnerability exists in Windows when the Win32k component fails to properly handle objects in memory.",
  },
  {
    itemKey: "7737abe58631a3ffdbc05bcfaae4fd65206d481a3366f75f8c005345d0f5ddf0",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2018-8453",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2022-01-21T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Microsoft Windows Win32k contains a vulnerability that allows an attacker to escalate privileges.",
  },
  {
    itemKey: "ff0b9eeb88c802e7c1ee3a9cc1f62e27901e187523c6dfdf67d97cc0f42d1459",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2018-8589",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2022-05-23T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "A privilege escalation vulnerability exists when Windows improperly handles calls to Win32k.sys. An attacker who successfully exploited this vulnerability could run remote code in the security context of the local system.",
  },
  {
    itemKey: "9dc64cbb6c44cd80e69dd00abed3f16da6505f925598fdd4fdef5a0e0b39de2b",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2019-0797",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2021-11-03T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Microsoft Win32k contains a privilege escalation vulnerability when the Win32k component fails to properly handle objects in memory. Successful exploitation allows an attacker to execute code in kernel mode.",
  },
  {
    itemKey: "3b3540912f5fa8cf7064808d67c1beaa6197b91b78f62497f458d9df60681809",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2019-0803",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2021-11-03T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Microsoft Win32k contains an unspecified vulnerability due to it failing to properly handle objects in memory causing privilege escalation. Successful exploitation allows an attacker to run code in kernel mode.",
  },
  {
    itemKey: "15c4c7f83ecd486102d135060868b75842cb052afefb023fe5671e1d9b087a87",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2019-0808",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2021-11-03T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Microsoft Win32k contains a privilege escalation vulnerability due to the component failing to properly handle objects in memory. Successful exploitation allows an attacker to run code in kernel mode.",
  },
  {
    itemKey: "5007ac093fe76bb5874229ce3aabe72bc678be34094cdf16d4f4cf17d91ec273",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2019-0859",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2021-11-03T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Microsoft Win32k fails to properly handle objects in memory causing privilege escalation. Successful exploitation allows an attacker to run code in kernel mode.",
  },
  {
    itemKey: "2d4ed86e2f40736ac933a003f083a0d935d9006c692f28c278390cd002e628e0",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2019-1132",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2022-03-15T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "A privilege escalation vulnerability exists in Windows when the Win32k component fails to properly handle objects in memory.",
  },
  {
    itemKey: "64823b451ba0c2135cd3f2d0b752c9f8086549cf06d647462cbd3a5683cbb039",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2019-1458",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2022-01-10T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "A privilege escalation vulnerability exists in Windows when the Win32k component fails to properly handle objects in memory, aka 'Win32k EoP.",
  },
  {
    itemKey: "0a9ea263409e9d29a0047bf7acb68a3843e8c1fc142f29191306aa17f8b10b5c",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2020-1054",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2021-11-03T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Microsoft Win32k contains a privilege escalation vulnerability when the Windows kernel-mode driver fails to properly handle objects in memory. Successful exploitation allows an attacker to execute code in kernel mode.",
  },
  {
    itemKey: "eb84a20d95572bae9fadb0e667ca429c6e6f1127a565cb9c5000f351ee4c3834",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2021-1732",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2021-11-03T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Microsoft Win32k contains an unspecified vulnerability that allows for privilege escalation.",
  },
  {
    itemKey: "92540a886e228707a29fa4d2533574b51e7ea28669014eb222a232cf25abbd88",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2021-28310",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2021-11-03T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Microsoft Windows Win32k contains an unspecified vulnerability that allows for privilege escalation.",
  },
  {
    itemKey: "8ca77cc400e13f86d93e8fb82468964d1de173af1fa304dfb3d5289b2184219b",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2021-40450",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2022-04-25T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Microsoft Win32k contains an unspecified vulnerability that allows for privilege escalation.",
  },
  {
    itemKey: "e382709a6d41aa88b33b6da833b5abe12292085f0180e3e822b137944c0f6005",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2021-41357",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2022-04-25T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Microsoft Win32k contains an unspecified vulnerability that allows for privilege escalation.",
  },
  {
    itemKey: "97a90092c59a341cad669cfd675001e9bcb013ed11342afcf37c677d0f185c57",
    title: "Microsoft Win32k Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2022-21882",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2022-02-04T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Microsoft Win32k contains an unspecified vulnerability that allows for privilege escalation.",
  },
  {
    itemKey: "2b54d52fad49ed5d5be4bb59790d0c409bcdf268a23728ec31423fca344f3db0",
    title: "Microsoft Win32K Privilege Escalation Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2023-29336",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2023-05-09T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Microsoft Win32k contains an unspecified vulnerability that allows for privilege escalation up to SYSTEM privileges.",
  },
];

/** One row per hostile shape: slash, combining accent, emoji, quote, 288 characters, em dash, a cross-listed item with two beats, and Spanish-language wire copy. */
export const HOSTILE_ITEMS: readonly CorpusRow[] = [
  {
    itemKey: "963070ff67bd7da30b8d28507f055f02b97f5f9d6e7d16d84b8bcde4c0f529f6",
    title: "PaperCut NG/MF Improper Authentication Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2023-27351",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2026-04-20T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "PaperCut NG/MF contains an improper authentication vulnerability that could allow remote attackers to bypass authentication on affected installations via the SecurityRequestFilter class.",
  },
  {
    itemKey: "580285896a8530f85a19f00b391e018fa380e0a2c34c6d83eca783d619caaded",
    title: "Dassault Systèmes DELMIA Apriso Code Injection Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2025-6204",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2025-10-28T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "Dassault Systèmes DELMIA Apriso contains a code injection vulnerability that could allow an attacker to execute arbitrary code.",
  },
  {
    itemKey: "e998906a376bd21c7b9f17ea03ca30f46e757971e471785dc50550682e956ebd",
    title: "🤗 Kernels: Major Updates",
    canonicalUrl: "https://huggingface.co/blog/revamped-kernels",
    sourceId: "huggingface-blog",
    beats: ["ai"],
    entities: [],
    publishedAt: "2026-07-06T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: null,
  },
  {
    itemKey: "6a7525ef2774d651fbe8c7012c9b41f6b87a13886f5159e45551f5d56ce5abc6",
    title: "ThinkPHP \"noneCms\" Remote Code Execution Vulnerability",
    canonicalUrl: "https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2018-20062",
    sourceId: "cisa-kev",
    beats: ["cyber"],
    entities: [],
    publishedAt: "2021-11-03T00:00:00.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "ThinkPHP \"noneCms\" contains an unspecified vulnerability that allows for remote code execution through crafted use of the filter parameter.",
  },
  {
    itemKey: "692fd0e34beaa8898fdd050310b49151080d5f1c2262d1b2bac590d2e497d494",
    title: "Actions by the United States in the Investigations under Section 301 of the Trade Act of 1974 of the Acts, Policies, and Practices of 60 Economies Related to the Failure of Each Economy to Impose and Effectively Enforce a Prohibition on the Importation of Goods Produced with Forced Labor",
    canonicalUrl: "https://whitehouse.gov/presidential-actions/2026/07/actions-by-the-united-states-in-the-investigations-under-section-301-of-the-trade-act-of-1974-of-the-acts-policies-and-practices-of-60-economies-related-to-the-failure-of-each-economy-to-impose-and",
    sourceId: "whitehouse-actions",
    beats: ["usnews"],
    entities: [],
    publishedAt: "2026-07-23T22:48:44.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "<p>MEMORANDUM FOR THE UNITED STATES TRADE REPRESENTATIVE Subject:       Actions by the United States in the Investigations under Section 301 of the Trade Act of 1974 of the Acts, Policies, and Practices of 60 Economies Related to the Failure of Each Economy to Impose and Effectively Enforce a",
  },
  {
    itemKey: "87a31c8ab4d5a14fb2392c96f0eb0b144305bcf0321b9628115c47b16cc73e4a",
    title: "[AINews] Jeff, Sanjay, Oriol, and Quoc depart DeepMind; Demis to Chair; Koray to SVP — what is going on at GDM???",
    canonicalUrl: "https://latent.space/p/ainews-jeff-sanjay-oriol-and-quoc",
    sourceId: "latent-space",
    beats: ["ai"],
    entities: [],
    publishedAt: "2026-08-06T04:34:11.000Z",
    firstSeenAt: "2026-08-14T18:38:50.262Z",
    summaryRaw: "The end of an era.",
  },
  {
    itemKey: "04af503b5714c1c91b1ef420b979e8ab76508aca412d5498bd1794fe6b37e428",
    title: "Kimwolf v7 Android Botnet Makes HTTP/2 DDoS Traffic Look Like Legitimate Browsing",
    canonicalUrl: "https://thehackernews.com/2026/08/kimwolf-v7-android-botnet-makes-http2.html",
    sourceId: "the-hacker-news",
    beats: ["aisec","cyber"],
    entities: [],
    publishedAt: "2026-08-11T19:36:37.000Z",
    firstSeenAt: "2026-08-14T20:16:51.233Z",
    summaryRaw: "Cybersecurity researchers have discovered a new version of the Kimwolf/AISURU Android and Internet of Things (IoT) botnet that comes with significant improvements to improve its operational resilience and conduct distributed denial-of-service (DDoS) attacks.\n\nThe new version, tracked as Kimwolf v7,",
  },
  {
    itemKey: "5a63b19c031b4168e32bdd75b1fb7103ac0084f4eabaefa7193dba85c3285f38",
    title: "Swiatek vence a Rybakina en Toronto para su primer título de la WTA en el año",
    canonicalUrl: "https://apnews.com/article/toronto-wta-swiatek-rybakina-final-de493685b996fbbd6ef433c7d22dec2f",
    sourceId: "ap-news",
    beats: ["usnews"],
    entities: [],
    publishedAt: "2026-08-14T00:25:58.000Z",
    firstSeenAt: "2026-08-14T03:47:10.404Z",
    summaryRaw: null,
  },
];

/** Every real row in this file. */
export const REAL_ITEMS: readonly CorpusRow[] = [...WIN32K_GROUP, ...HOSTILE_ITEMS];
