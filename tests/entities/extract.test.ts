import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { extractEntities, PATTERN_EXTRACTORS } from '../../src/entities/extract.ts';
import { loadEntityRules, loadEntityRulesFile, type EntityRuleset } from '../../src/entities/rules.ts';
import type { Beat } from '../../src/domain/item.ts';

const SHIPPED = loadEntityRulesFile(join(process.cwd(), 'config', 'entities.yaml'));

// ---------------------------------------------------------------------------
// REAL rows, copied verbatim from data/wf.db (the live corpus, 7,267 items).
// Never invented: this project has repeatedly found that only real rows expose
// the truth, and every claim below about what the extractor does -- including
// what it gets WRONG -- is a claim about text a real feed actually published.
// The database itself is never opened by this file.
// ---------------------------------------------------------------------------

interface Row {
  title: string;
  summaryRaw: string | null;
  canonicalUrl: string;
  beats: Beat[];
}

/** cisa-kev. Its CVE id exists NOWHERE but the canonical URL's query string. */
const KEV_CISCO: Row = {
  title:
    'Cisco Secure Firewall Adaptive Security Appliance (ASA) and Secure Firewall Threat Defense (FTD) Heap Inspection Vulnerability',
  summaryRaw:
    'Cisco Secure Firewall Adaptive Security Appliance (ASA) and Secure Firewall Threat Defense (FTD) contain a heap inspection vulnerability that could allow an unauthenticated, remote attacker to cause the device to reload unexpectedly, resulting in a denial of service (DoS) condition.',
  canonicalUrl: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2026-20349',
  beats: ['cyber'],
};

/** cisa-kev, and the reason `iOS` must be matched case-sensitively. */
const KEV_CISCO_IOS: Row = {
  title: 'Cisco IOS Cross-Site Request Forgery Vulnerability',
  summaryRaw:
    'Cisco IOS 12.4 contains multiple cross-site forgery vulnerabilities that allows remote attackers to execute arbitrary commands via (1) a certain "show privilege" command to the /level/15/exec/- URI.',
  canonicalUrl: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2008-4128',
  beats: ['cyber'],
};

/** ap-news. The measured false positive that `beats:` exists to close. */
const AP_APACHE_HELICOPTER: Row = {
  title: 'Army pauses Apache helicopter training missions after crash',
  summaryRaw: null,
  canonicalUrl:
    'https://apnews.com/article/army-texas-helicopter-crash-pilots-identified-e4f5d04809363878d0b988d8344797ca',
  beats: ['usnews'],
};

/** nvd-cve. The id is the title AND the URL -- the dedup case. */
const NVD_PROMPT_INJECTION: Row = {
  title: 'CVE-2026-73487',
  summaryRaw:
    'Flowise before 3.1.3 contains a regex-based Python code validator bypass in CSV and Airtable Agent nodes that allows unauthenticated attackers to inject malicious code via prompt injection.',
  canonicalUrl: 'https://nvd.nist.gov/vuln/detail/CVE-2026-73487',
  beats: ['cyber'],
};

/** cisa-advisories. Multiple CVE ids inside one escaped-HTML summary. */
const CISA_ADVISORY: Row = {
  title: 'CISA Adds Three Known Exploited Vulnerabilities to Catalog',
  summaryRaw:
    '<p>CISA has added three new vulnerabilities to its <a href="https://www.cisa.gov/known-exploited-vulnerabilities-catalog">Known Exploited Vulnerabilities (KEV) Catalog</a>, based on evidence of active exploitation. &nbsp;</p>\n<ul>\n<li><a href="https://www.cve.org/CVERecord?id=CVE-2026-20349"',
  canonicalUrl: 'https://cisa.gov/news-events/alerts/2026/08/11/cisa-adds-three-known-exploited-vulnerabilities-catalog',
  beats: ['cyber'],
};

/** huggingface-blog. A null summary, and an org only the title names. */
const HF_NVIDIA: Row = {
  title: 'Build Low-Latency Multilingual Voice Agents: Open Weights & Full Deployment Control with NVIDIA Magpie TTS',
  summaryRaw: null,
  canonicalUrl: 'https://huggingface.co/blog/nvidia/magpie-tts-multilingual-voice-agents',
  beats: ['ai'],
};

function run(row: Row, ruleset: EntityRuleset = SHIPPED): string[] {
  return extractEntities(row, ruleset);
}

describe('identifier patterns', () => {
  it('reads the CVE id out of the canonical URL, which is the only place cisa-kev states it', () => {
    // 1,665 of 7,267 live items are cisa-kev rows shaped exactly like this.
    // Title-and-summary-only extraction finds 1,694 CVE-bearing items; adding
    // the URL finds 3,307, and 2,538 distinct ids rather than 931.
    expect(run(KEV_CISCO)).toContain('CVE-2026-20349');
  });

  it('emits an id ONCE when the title, summary and URL all carry it', () => {
    const got = run(NVD_PROMPT_INJECTION);
    expect(got.filter((e) => e === 'CVE-2026-73487')).toHaveLength(1);
  });

  it('finds every distinct id in one summary', () => {
    expect(run(CISA_ADVISORY)).toContain('CVE-2026-20349');
  });

  it('normalises id case upward, so one CVE is one entity', () => {
    const rules = loadEntityRules('patterns: [cve]\nentities: []\n');
    expect(
      extractEntities(
        { title: 'cve-2026-1234 and CVE-2026-1234 and Cve-2026-1234', summaryRaw: null, canonicalUrl: 'https://e.test/', beats: ['cyber'] },
        rules,
      ),
    ).toEqual(['CVE-2026-1234']);
  });

  it('will not match an id embedded in a longer token', () => {
    const rules = loadEntityRules('patterns: [cve, cwe]\nentities: []\n');
    expect(
      extractEntities(
        { title: 'xCVE-2026-1234 CVE-2026-1234x NOTCWE-79 CWE-79z', summaryRaw: null, canonicalUrl: 'https://e.test/', beats: ['cyber'] },
        rules,
      ),
    ).toEqual([]);
  });

  it('extracts CWE ids, which is how vulnerability CLASSES enter the system', () => {
    const rules = loadEntityRules('patterns: [cwe]\nentities: []\n');
    expect(
      extractEntities(
        { title: 'CWE-79 and CWE-1321', summaryRaw: null, canonicalUrl: 'https://e.test/', beats: ['cyber'] },
        rules,
      ),
    ).toEqual(['CWE-1321', 'CWE-79']);
  });

  it('runs NO pattern that the ruleset did not enable', () => {
    const rules = loadEntityRules('patterns: []\nentities: []\n');
    expect(run(KEV_CISCO, rules)).toEqual([]);
  });

  it('has an implementation for every declarable pattern name', () => {
    // A pattern name that loads but has no extractor is a rule that silently
    // never fires -- the shape of gap this milestone keeps finding.
    for (const name of ['cve', 'cwe'] as const) {
      expect(PATTERN_EXTRACTORS[name], `no extractor for ${name}`).toBeTypeOf('function');
    }
  });
});

describe('the gazetteer', () => {
  it('attributes vendors named only in a real KEV title', () => {
    const got = run(KEV_CISCO);
    expect(got).toContain('Cisco');
  });

  it('reads a null summary without throwing, and still uses the title', () => {
    expect(run(HF_NVIDIA)).toContain('NVIDIA');
  });

  it('matches loose aliases across the headline capitalisation of a real item', () => {
    expect(run(NVD_PROMPT_INJECTION)).toContain('Prompt injection');
  });

  it('emits the CANONICAL name, never the alias that matched', () => {
    const rules = loadEntityRules(`
patterns: []
entities:
  - { name: NVIDIA, type: org, aliases: [NVIDIA, Nvidia, NVDA] }
`);
    for (const spelling of ['NVIDIA', 'Nvidia', 'NVDA']) {
      expect(
        extractEntities(
          { title: `${spelling} ships something`, summaryRaw: null, canonicalUrl: 'https://e.test/', beats: ['ai'] },
          rules,
        ),
      ).toEqual(['NVIDIA']);
    }
  });
});

describe('the gazetteer does NOT read the URL -- and that is load-bearing', () => {
  it('does not attribute Hugging Face to a huggingface.co URL whose text never says it', () => {
    // A hostname is a fact about the SOURCE, not a claim about the content.
    // Reading it would attribute OpenAI to all 1,129 openai-blog items.
    expect(run(HF_NVIDIA)).not.toContain('Hugging Face');
  });

  it('still lets an identifier pattern read the URL, which is the whole point of the split', () => {
    expect(run(KEV_CISCO)).toContain('CVE-2026-20349');
  });
});

describe('case sensitivity -- measured, not assumed', () => {
  it('does NOT attribute the iOS product to a real Cisco IOS advisory', () => {
    // 47 real live-corpus items match a loose `iOS`; every one is Cisco IOS or
    // IOS XE router software.
    expect(run(KEV_CISCO_IOS)).not.toContain('iOS');
  });

  it('DOES attribute iOS where Apple own casing appears', () => {
    expect(
      run({
        title: 'Apple iOS and iPadOS Use-After-Free Vulnerability',
        summaryRaw: null,
        canonicalUrl: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2026-1',
        beats: ['cyber'],
      }),
    ).toContain('iOS');
  });

  it('does not read the common noun "progress" as Progress Software', () => {
    expect(
      run({
        title: 'Diffusion models have achieved remarkable progress in image generation',
        summaryRaw: null,
        canonicalUrl: 'https://arxiv.org/abs/2608.1',
        beats: ['ai'],
      }),
    ).not.toContain('Progress Software');
  });

  it('does not read "meta-learning" as Meta', () => {
    expect(
      run({ title: 'On first-order meta-learning algorithms', summaryRaw: null, canonicalUrl: 'https://openai.com/x', beats: ['ai'] }),
    ).not.toContain('Meta');
  });

  it('a loose alias still ignores word boundaries the same way an exact one does', () => {
    const rules = loadEntityRules(`
patterns: []
entities:
  - { name: Ransomware, type: concept, aliases: [{ term: ransomware, match: loose }] }
`);
    expect(
      extractEntities({ title: 'antiransomwarey tooling', summaryRaw: null, canonicalUrl: 'https://e.test/', beats: ['cyber'] }, rules),
    ).toEqual([]);
    expect(
      extractEntities({ title: 'Anti-Ransomware tooling', summaryRaw: null, canonicalUrl: 'https://e.test/', beats: ['cyber'] }, rules),
    ).toEqual(['Ransomware']);
  });
});

describe('beat scope', () => {
  it('does not call an Army Apache helicopter the Apache Software Foundation', () => {
    // The measured false positive: two real live-corpus items, both usnews,
    // both capitalised, so case cannot separate them.
    expect(run(AP_APACHE_HELICOPTER)).not.toContain('Apache Software Foundation');
  });

  it('still attributes Apache on the beats where the vendor is the only reading', () => {
    expect(
      run({
        title: 'Apache Tomcat Missing Encryption of Sensitive Data Vulnerability',
        summaryRaw: null,
        canonicalUrl: 'https://cisa.gov/known-exploited-vulnerabilities-catalog?field_cve=CVE-2026-2',
        beats: ['cyber'],
      }),
    ).toContain('Apache Software Foundation');
  });

  it('needs only ONE of the item beats to be in scope', () => {
    const rules = loadEntityRules(`
patterns: []
entities:
  - { name: Apache Software Foundation, type: org, beats: [cyber], aliases: [Apache] }
`);
    expect(
      extractEntities({ title: 'Apache thing', summaryRaw: null, canonicalUrl: 'https://e.test/', beats: ['usnews', 'cyber'] }, rules),
    ).toEqual(['Apache Software Foundation']);
  });

  it('never scopes an identifier pattern by beat -- an id means the same thing everywhere', () => {
    expect(run(AP_APACHE_HELICOPTER)).toEqual([]);
    expect(
      run({ ...AP_APACHE_HELICOPTER, title: 'Army pauses Apache helicopter flights, CVE-2026-9999 unrelated' }),
    ).toContain('CVE-2026-9999');
  });
});

describe('output shape', () => {
  it('is sorted by codepoint and deduplicated, always', () => {
    // Codepoint, never localeCompare: src/vault/entities.ts makes the same
    // choice for the same reason -- localeCompare is host-ICU dependent, and
    // these strings end up in a note whose bytes M5 acceptance compares.
    const got = run(KEV_CISCO);
    expect(got).toEqual([...new Set(got)]);
    expect(got).toEqual([...got].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('returns [] rather than null for an item with nothing in it', () => {
    expect(
      run({ title: 'Local weather remains mild', summaryRaw: null, canonicalUrl: 'https://e.test/x', beats: ['usnews'] }),
    ).toEqual([]);
  });

  it('is a pure function of its input -- two calls agree exactly', () => {
    expect(run(KEV_CISCO)).toEqual(run(KEV_CISCO));
  });
});

describe('what the shipped ruleset actually pulls out of real headlines', () => {
  it('KEV Cisco firewall advisory', () => {
    expect(run(KEV_CISCO)).toEqual(['CVE-2026-20349', 'Cisco']);
  });

  it('NVD Flowise prompt-injection record', () => {
    expect(run(NVD_PROMPT_INJECTION)).toEqual(['CVE-2026-73487', 'Prompt injection']);
  });

  it('CISA advisory announcing KEV additions', () => {
    expect(run(CISA_ADVISORY)).toEqual(['CISA', 'CVE-2026-20349']);
  });

  it('Hugging Face NVIDIA voice-agent post', () => {
    expect(run(HF_NVIDIA)).toEqual(['NVIDIA', 'Open weights']);
  });
});
