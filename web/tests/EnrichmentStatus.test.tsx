// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mount, flush, fetchRouter, typeInto, type Mounted } from './testUtils.tsx';
import { App } from '../src/App.tsx';
import {
  EnrichmentStatus,
  type EnrichmentStatusData,
  type EnrichmentSpendData,
} from '../src/components/EnrichmentStatus.tsx';

/**
 * §15's third clause (M5 task 14): *"the dashboard shows the feature as off."*
 *
 * The hard part is not showing it — it is showing it as **configuration**.
 * The M5 plan's RULING 2 has the owner choosing Ollama deliberately and
 * Anthropic shipping hard-disabled, so a paid path that is off is the
 * intended, correct, permanent state of this system. Rendering it in the
 * colour reserved for a broken feed would train its only operator to ignore
 * that colour.
 *
 * Three facts, three lines, and the tests below exist mostly to stop any two
 * of them becoming one:
 *
 *   1. the paid path is **off by cost policy** — quiet, expected;
 *   2. today's spend is a **measured $0** — a guarantee, not an absence;
 *   3. the local backend is **unreachable** — a genuine fault.
 */

let current: Mounted | null = null;

afterEach(() => {
  current?.unmount();
  current = null;
});

function makeStatus(overrides: Partial<EnrichmentStatusData> = {}): EnrichmentStatusData {
  return {
    backend: {
      name: 'ollama',
      model: 'llama3.2:latest',
      serviceId: 'ollama-local',
      costClass: 'free-forever',
      spendCategory: null,
      state: 'enabled',
    },
    paidPaths: [
      {
        category: 'anthropic',
        flag: 'WF_ALLOW_PAID_ANTHROPIC',
        state: 'disabled_by_cost_policy',
        selected: false,
      },
      {
        category: 'marketdata',
        flag: 'WF_ALLOW_PAID_MARKETDATA',
        state: 'disabled_by_cost_policy',
        selected: false,
      },
    ],
    reachability: {
      status: 'unknown',
      day: '2026-08-16',
      attempts: 0,
      reached: 0,
      unreached: 0,
      costPolicyRefusals: 0,
      reason: null,
      detail: 'nothing tried to reach a backend on 2026-08-16.',
    },
    asOf: '2026-08-16T12:00:00.000Z',
    note: 'config/llm.yaml selects the ollama backend.',
    ...overrides,
  };
}

function makeSpend(overrides: Partial<EnrichmentSpendData> = {}): EnrichmentSpendData {
  return {
    amountUsd: 0,
    measured: true,
    asOf: '2026-08-16T12:00:00.000Z',
    note: 'no enrichment calls were made today.',
    ...overrides,
  };
}

function render(
  status: EnrichmentStatusData | null = makeStatus(),
  spend: EnrichmentSpendData | null = makeSpend(),
): HTMLDivElement {
  current = mount(<EnrichmentStatus status={status} spend={spend} />);
  return current.container;
}

function text(container: HTMLDivElement, selector: string): string {
  const el = container.querySelector(selector);
  expect(el, `${selector} did not render`).not.toBeNull();
  return el!.textContent ?? '';
}

// ---------------------------------------------------------------------------
// Fact 1 -- the paid path, off by choice
// ---------------------------------------------------------------------------

describe('the paid path reads as configuration, not as a fault', () => {
  it('names the backend that IS running before saying what is off', () => {
    // "Off" on its own invites the reader to wonder what broke. The line
    // above it says a free local model is doing the work.
    const el = render();
    expect(text(el, '.enrichment__backend')).toContain('ollama');
    expect(text(el, '.enrichment__backend')).toContain('llama3.2:latest');
    expect(text(el, '.enrichment__backend')).toContain('free-forever');
  });

  it('shows the paid path as off and names the flag that would enable it', () => {
    const el = render();
    const paid = text(el, '.enrichment__paid');
    expect(paid).toMatch(/off/i);
    expect(paid).toContain('WF_ALLOW_PAID_ANTHROPIC');
    expect(paid).toMatch(/cost policy/i);
  });

  it('never calls it an error, a failure, or a problem', () => {
    // The words matter as much as the colour: this is the shipped, chosen
    // state of the system (M5 plan RULING 2), not an incident.
    const el = render();
    expect(text(el, '.enrichment__paid')).not.toMatch(/error|fail|broken|problem|unavailable/i);
  });

  it('carries a modifier class distinct from the fault one', () => {
    // jsdom parses no stylesheet, so the class is the only checkable proxy
    // for "these two states do not look alike". The stylesheet agreement
    // tests at the bottom are the other half.
    const el = render();
    const paid = el.querySelector('.enrichment__paid')!;
    expect(paid.classList.contains('enrichment__paid--off')).toBe(true);
    expect(paid.classList.contains('enrichment__paid--fault')).toBe(false);
  });

  it('says the feature is enabled when the flag is set', () => {
    const el = render(
      makeStatus({
        paidPaths: [
          {
            category: 'anthropic',
            flag: 'WF_ALLOW_PAID_ANTHROPIC',
            state: 'enabled',
            selected: true,
          },
        ],
      }),
    );
    const paid = text(el, '.enrichment__paid');
    expect(paid).toMatch(/\bon\b/i);
    expect(el.querySelector('.enrichment__paid')!.classList.contains('enrichment__paid--on')).toBe(
      true,
    );
  });
});

describe('a configured backend that is itself disabled is a louder state', () => {
  it('says enrichment cannot run at all, and how to fix it', () => {
    // Different from "a paid path is off while a free backend works": here
    // the backend enrichment was TOLD to use is the hard-disabled one, so
    // nothing is being enriched.
    const el = render(
      makeStatus({
        backend: {
          name: 'anthropic',
          model: 'claude-opus-5',
          serviceId: 'anthropic-api',
          costClass: 'paid',
          spendCategory: 'anthropic',
          state: 'disabled_by_cost_policy',
        },
      }),
    );
    const backend = el.querySelector('.enrichment__backend')!;
    expect(backend.classList.contains('enrichment__backend--disabled')).toBe(true);
    expect(backend.textContent).toMatch(/disabled by cost policy/i);
  });

  it('does not claim a disabled backend is running', () => {
    const el = render(makeStatus());
    expect(
      el.querySelector('.enrichment__backend')!.classList.contains('enrichment__backend--disabled'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fact 2 -- spend
// ---------------------------------------------------------------------------

describe('spend is its own line, and measured is not the same as zero', () => {
  it('renders a measured zero as a figure', () => {
    const el = render();
    expect(text(el, '.enrichment__spend')).toContain('$0.00');
    expect(
      el.querySelector('.enrichment__spend')!.classList.contains('enrichment__spend--measured'),
    ).toBe(true);
  });

  it('renders an unmeasured day as unknown, never as zero', () => {
    // The distinction the field was built for: `measured: false` means
    // UNKNOWN. Printing $0.00 there is a placeholder masquerading as a
    // measurement.
    const el = render(makeStatus(), makeSpend({ amountUsd: null, measured: false }));
    const spend = text(el, '.enrichment__spend');
    expect(spend).toMatch(/unknown|unmeasured/i);
    expect(spend).not.toContain('$0.00');
  });
});

// ---------------------------------------------------------------------------
// Fact 3 -- reachability
// ---------------------------------------------------------------------------

describe('an unreachable backend is a genuine fault and looks like one', () => {
  it('names the backend and the reason', () => {
    const el = render(
      makeStatus({
        reachability: {
          status: 'unreachable',
          day: '2026-08-16',
          attempts: 3,
          reached: 0,
          unreached: 3,
          costPolicyRefusals: 0,
          reason: 'not_running',
          detail: 'the last attempt could not reach ollama/llama3.2:latest: not_running.',
        },
      }),
    );
    const reach = el.querySelector('.enrichment__reach')!;
    expect(reach.classList.contains('enrichment__reach--unreachable')).toBe(true);
    expect(reach.textContent).toMatch(/not_running|unreachable|not running/i);
  });

  it('renders unknown as neither healthy nor broken', () => {
    // A day with no enrichment call is ordinary on the vault cadence. It is
    // not evidence of health, and it is not a fault.
    const el = render();
    const reach = el.querySelector('.enrichment__reach')!;
    expect(reach.classList.contains('enrichment__reach--unknown')).toBe(true);
    expect(reach.classList.contains('enrichment__reach--unreachable')).toBe(false);
    expect(reach.classList.contains('enrichment__reach--reachable')).toBe(false);
  });

  it('renders reachable when the last attempt got through', () => {
    const el = render(
      makeStatus({
        reachability: {
          status: 'reachable',
          day: '2026-08-16',
          attempts: 24,
          reached: 24,
          unreached: 0,
          costPolicyRefusals: 0,
          reason: null,
          detail: 'the last attempt reached ollama/llama3.2:latest.',
        },
      }),
    );
    expect(
      el.querySelector('.enrichment__reach')!.classList.contains('enrichment__reach--reachable'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The collapse this component exists to prevent
// ---------------------------------------------------------------------------

describe('the three states are on screen at once and stay apart', () => {
  it('renders a shut gate, a measured $0 and a dead daemon as three separate lines', () => {
    const el = render(
      makeStatus({
        reachability: {
          status: 'unreachable',
          day: '2026-08-16',
          attempts: 1,
          reached: 0,
          unreached: 1,
          costPolicyRefusals: 4,
          reason: 'not_running',
          detail: 'the last attempt could not reach ollama/llama3.2:latest: not_running.',
        },
      }),
      makeSpend(),
    );

    // One line PER paid category -- the fixture has two, and a dashboard that
    // silently reported only the first would hide M4b's market-data path the
    // day it lands.
    expect(el.querySelectorAll('.enrichment__paid--off')).toHaveLength(2);
    expect(el.querySelectorAll('.enrichment__spend--measured')).toHaveLength(1);
    expect(el.querySelectorAll('.enrichment__reach--unreachable')).toHaveLength(1);
    // ...and the cost-gate refusals never inflate the failure count.
    expect(text(el, '.enrichment__reach')).not.toContain('4 ');
  });

  it('renders nothing at all before the header has loaded', () => {
    // An absent response is not a report of "off" -- guessing here is how a
    // loading spinner becomes a claim about cost policy.
    const el = render(null, null);
    expect(el.querySelector('.enrichment')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §7.1: design tokens in ONE place, and the stylesheet agrees with the markup
// ---------------------------------------------------------------------------

function readWebSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const COMPONENT = '../src/components/EnrichmentStatus.tsx';
const STYLESHEET = '../src/components/EnrichmentStatus.css';

describe('§7.1 -- no component may hardcode a colour', () => {
  it('neither the component nor its stylesheet contains a colour literal', () => {
    for (const rel of [COMPONENT, STYLESHEET]) {
      const source = readWebSource(rel);
      expect(source, `${rel} must not contain a hex colour`).not.toMatch(
        /#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b/,
      );
      expect(source, `${rel} must not contain an rgb()/hsl() literal`).not.toMatch(
        /\b(rgba?|hsla?)\(/,
      );
    }
  });

  it('every --color-* token the stylesheet reads is defined in tokens.css', () => {
    const tokens = readWebSource('../src/styles/tokens.css');
    const used = new Set(readWebSource(STYLESHEET).match(/--(?:color|space|text|radius)-[a-z-]+/g) ?? []);
    expect(used.size).toBeGreaterThan(3);
    for (const name of used) {
      expect(tokens, `${name} is read by the stylesheet but never defined`).toContain(`${name}:`);
    }
  });
});

/** Every `enrichment*` class the component really emits, across every branch. */
function emittedClasses(): Set<string> {
  const emitted = new Set<string>();
  const variants: Array<[EnrichmentStatusData, EnrichmentSpendData]> = [
    [makeStatus(), makeSpend()],
    [
      makeStatus({
        backend: {
          name: 'anthropic',
          model: 'claude-opus-5',
          serviceId: 'anthropic-api',
          costClass: 'paid',
          spendCategory: 'anthropic',
          state: 'disabled_by_cost_policy',
        },
        paidPaths: [
          {
            category: 'anthropic',
            flag: 'WF_ALLOW_PAID_ANTHROPIC',
            state: 'enabled',
            selected: true,
          },
        ],
        reachability: {
          status: 'unreachable',
          day: '2026-08-16',
          attempts: 1,
          reached: 0,
          unreached: 1,
          costPolicyRefusals: 0,
          reason: 'not_running',
          detail: 'not_running',
        },
      }),
      makeSpend({ amountUsd: null, measured: false }),
    ],
    [
      makeStatus({
        backend: null,
        reachability: {
          status: 'reachable',
          day: '2026-08-16',
          attempts: 2,
          reached: 2,
          unreached: 0,
          costPolicyRefusals: 0,
          reason: null,
          detail: 'reached',
        },
      }),
      makeSpend(),
    ],
  ];

  for (const [status, spend] of variants) {
    const container = render(status, spend);
    for (const el of container.querySelectorAll('*')) {
      for (const cls of el.classList) if (cls.startsWith('enrichment')) emitted.add(cls);
    }
    current!.unmount();
    current = null;
  }
  return emitted;
}

describe('the component and the stylesheet agree on every name', () => {
  it('every .enrichment* selector in the stylesheet matches a class the component renders', () => {
    // jsdom parses no stylesheet at all, so a rule for a class nobody emits
    // styles nothing and no test above notices -- M5 task 8's bidirectional
    // check, applied here.
    const emitted = emittedClasses();
    const selectors = new Set(readWebSource(STYLESHEET).match(/\.enrichment[a-z0-9_-]*/g) ?? []);
    expect(selectors.size).toBeGreaterThan(5);
    for (const selector of selectors) {
      expect(emitted, `${selector} is styled but no rendered element carries it`).toContain(
        selector.slice(1),
      );
    }
  });

  it('every STATE MODIFIER the component renders has a rule', () => {
    // The other direction: a modifier nothing styles is a state the UI claims
    // to distinguish and does not -- which is exactly the collapse this whole
    // component exists to prevent.
    const css = readWebSource(STYLESHEET);
    const modifiers = [...emittedClasses()].filter((cls) => cls.includes('--'));
    expect(modifiers.length).toBeGreaterThan(4);
    for (const cls of modifiers) {
      expect(css, `.${cls} is a state modifier with no rule -- it distinguishes nothing`).toContain(
        `.${cls}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The wiring. Every test above passes with this component mounted nowhere --
// CLAUDE.md's characteristic defect, and `registerItems` is number one in its
// table for exactly this reason.
// ---------------------------------------------------------------------------

describe('the dashboard actually mounts it', () => {
  it('renders the enrichment block from the real header response', async () => {
    const { fn } = fetchRouter([
      {
        match: (url) => url.startsWith('/api/dashboard/header'),
        body: {
          beats: {},
          failingSources: 0,
          enrichmentSpend: makeSpend(),
          enrichment: makeStatus(),
        },
      },
      { match: (url) => url.startsWith('/api/dashboard/layout'), body: { lanes: [] } },
      {
        match: () => true,
        body: {
          items: [],
          beat: null,
          profile: 'signal',
          now: '2026-08-16T12:00:00.000Z',
          total: 0,
          nextCursor: null,
        },
      },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<App />);
    const el = current.container;
    typeInto(el.querySelector('#wf-token') as HTMLInputElement, 'a-test-token');
    act(() => {
      el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(el.querySelector('.enrichment')).not.toBeNull();
    expect(el.querySelector('.enrichment__paid--off')).not.toBeNull();
    vi.unstubAllGlobals();
  });
});
