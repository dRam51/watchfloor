// @vitest-environment jsdom
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepoRow } from '../src/components/RepoRow.tsx';
import type { FeedItemRepo, FeedItemVelocity } from '../src/api/types.ts';
import { actClick, makeFeedItem, makeRepo, mount, type Mounted } from './testUtils.tsx';

let current: Mounted | null = null;
afterEach(() => {
  current?.unmount();
  current = null;
});

const noop = () => {};

function renderRepo(repo: Partial<FeedItemRepo> = {}, itemOverrides = {}) {
  const full = makeRepo(repo);
  const item = makeFeedItem({ representativeBeat: 'repos', beats: ['repos'], repo: full, ...itemOverrides });
  current = mount(
    <RepoRow
      item={item}
      repo={full}
      dismissing={false}
      focused={false}
      tabIndex={-1}
      onFocusRow={noop}
      onOpen={noop}
      onToggleSave={noop}
      onDismiss={noop}
    />,
  );
  return current.container;
}

function expand(container: HTMLElement): string {
  actClick(container.querySelector<HTMLButtonElement>('.item-row__toggle')!);
  return container.textContent!;
}

// ---------------------------------------------------------------------------

describe('RepoRow -- §7: "repo name, one-line description, language, stars + velocity arrow, last-commit age"', () => {
  it('renders all five, on one line at rest', () => {
    const container = renderRepo({
      fullName: 'langchain-ai/langgraph',
      description: 'Build resilient language agents as graphs.',
      language: 'Python',
      stars: 12345,
      lastCommitAt: '2026-08-11T12:00:00.000Z',
      velocity: {
        status: 'ok',
        starsPerDay: 61.2,
        starsGained: 366,
        spanDays: 5.98,
        spanCoverage: 0.99,
        staleDays: 0,
        observedDays: 7,
        expectedDays: 7,
      },
    });
    const text = container.textContent!;
    expect(text).toContain('langchain-ai/langgraph');
    expect(text).toContain('Build resilient language agents as graphs.');
    expect(text).toContain('Python');
    expect(container.querySelector('.repo-row__stars')!.textContent).toContain('12,345');
    expect(container.querySelector('.repo-row__velocity')!.textContent).toContain('+61.2/d');
    // "last-commit age" -- an age, not a timestamp.
    const age = container.querySelector('.repo-row__pushed')!.textContent!;
    expect(age).toMatch(/ago$|^just now$/);
    expect(age).not.toContain('2026-08-11');
  });

  it('is a DIFFERENT component from the news row -- no news-row-only furniture', () => {
    const container = renderRepo();
    // The repo row carries no source id or cluster count; those are news-row
    // facts. It carries repo facts instead.
    expect(container.querySelector('.item-row__source')).toBeNull();
    expect(container.querySelector('.repo-row__name')).not.toBeNull();
    // ...but it IS a row in the same lane container: the shared row chrome
    // classes Lane.tsx/global.css style and focus are all present.
    expect(container.querySelector('li.item-row.repo-row')).not.toBeNull();
    expect(container.querySelector('.item-row__toggle')).not.toBeNull();
    expect(container.querySelectorAll('.item-row__action')).toHaveLength(3);
  });

  it('a repo with no description says so, rather than rendering a blank gap', () => {
    const container = renderRepo({ description: null });
    expect(container.querySelector('.repo-row__description')!.textContent).toContain('no description');
  });

  it('a repo GitHub detected no language for says so, rather than showing an empty chip', () => {
    const container = renderRepo({ language: null });
    expect(container.querySelector('.repo-row__language')!.textContent).toBe('no language');
  });

  it('a repo that has never been pushed to reads as "never pushed", not "undated"', () => {
    const container = renderRepo({ lastCommitAt: null });
    expect(container.querySelector('.repo-row__pushed')!.textContent).toContain('never pushed');
    expect(container.textContent).not.toContain('undated');
  });

  it('stars are exact and locale-independent -- never abbreviated away, never Intl-formatted', () => {
    expect(renderRepo({ stars: 240152 }).querySelector('.repo-row__stars')!.textContent).toContain('240,152');
    current!.unmount();
    current = null;
    expect(renderRepo({ stars: 7 }).querySelector('.repo-row__stars')!.textContent).toContain('7');
  });
});

// ---------------------------------------------------------------------------
// FORBIDDEN FALSEHOOD 2
// ---------------------------------------------------------------------------

describe('RepoRow -- FORBIDDEN FALSEHOOD 2: open_issues_count is issues AND open PRs', () => {
  // src/domain/repo.ts, verbatim: "GitHub's `open_issues_count` ... is
  // documented by GitHub as the number of open issues AND open pull requests.
  // A busy repo with 3 issues and 90 open PRs reports 93. Calling the field
  // `openIssues` would make every downstream reader (and every glance at the
  // rendered row) quietly wrong in a way nothing would ever flag. Task 8 must
  // not label this bare 'issues'."
  it('never labels the count bare "issues" anywhere in the rendered row', () => {
    const container = renderRepo({ openIssuesAndPullRequests: 93 });
    expand(container);

    // Every occurrence of the word, in any element, must be accompanied by
    // the PR half. Asserted over the DOM rather than one known element, so a
    // later "tidy" that re-labels it somewhere else still trips this.
    const mentions = Array.from(container.querySelectorAll('*')).filter(
      (el) => el.children.length === 0 && /issue/i.test(el.textContent ?? ''),
    );
    expect(mentions.length).toBeGreaterThan(0);
    for (const el of mentions) {
      expect(el.textContent).toMatch(/PR/);
    }

    // And the specific wrong reading -- "93 issues" -- appears nowhere.
    expect(container.textContent).not.toMatch(/93\s*issues(?!\s*\+)/i);
    expect(container.textContent).toContain('93');
  });

  it('the accessible/tooltip text spells out why the number is what it is', () => {
    const container = renderRepo({ openIssuesAndPullRequests: 93 });
    expand(container);
    const el = container.querySelector('.repo-row__issues')!;
    expect(el.getAttribute('title')).toMatch(/pull request/i);
  });
});

// ---------------------------------------------------------------------------
// FORBIDDEN FALSEHOOD 3
// ---------------------------------------------------------------------------

describe('RepoRow -- FORBIDDEN FALSEHOOD 3: an UNREAD README is not a MISSING one', () => {
  // src/enrich/repo.ts's carry-forward: "an UNREAD README is indistinguishable
  // from a MISSING one. Both produce readmeExcerpt === null, and §4 suppresses
  // the second... `no_readme` may only be honoured when readmeKnown === true.
  // Task 8 must not render a null excerpt as 'no README' either."
  it('a present excerpt renders verbatim', () => {
    const container = renderRepo({ readmeExcerpt: 'A framework for building stateful agents.', readmeKnown: true });
    expect(expand(container)).toContain('A framework for building stateful agents.');
  });

  it('null + readmeKnown TRUE is the only case that may say the repo has no README', () => {
    const container = renderRepo({ readmeExcerpt: null, readmeKnown: true });
    const text = expand(container);
    expect(text).toMatch(/no README/i);
    expect(container.querySelector('.repo-row__readme--absent')).not.toBeNull();
  });

  it('null + readmeKnown FALSE says the README was NOT READ -- never that there is none', () => {
    const container = renderRepo({ readmeExcerpt: null, readmeKnown: false });
    const text = expand(container);
    // The forbidden rendering, stated as the assertion.
    expect(text).not.toMatch(/no README/i);
    expect(text).toMatch(/not (yet )?read/i);
    expect(container.querySelector('.repo-row__readme--unknown')).not.toBeNull();
    expect(container.querySelector('.repo-row__readme--absent')).toBeNull();
  });

  it('the two null cases are rendered by DIFFERENT elements, so neither can drift into the other', () => {
    const absent = renderRepo({ readmeExcerpt: null, readmeKnown: true }).querySelector('.repo-row__readme')!
      .className;
    current!.unmount();
    current = null;
    const unknown = renderRepo({ readmeExcerpt: null, readmeKnown: false }).querySelector('.repo-row__readme')!
      .className;
    expect(absent).not.toBe(unknown);
  });
});

// ---------------------------------------------------------------------------
// FORBIDDEN FALSEHOOD 4
// ---------------------------------------------------------------------------

const INSUFFICIENT_REASONS = ['unknown_repo', 'no_snapshots', 'single_snapshot', 'span_too_short'] as const;

function insufficient(reason: (typeof INSUFFICIENT_REASONS)[number], observedDays = 2): FeedItemVelocity {
  return {
    status: 'insufficient_history',
    reason,
    observedDays: reason === 'unknown_repo' ? 0 : observedDays,
    expectedDays: 7,
    spanDays: reason === 'span_too_short' ? 2 / 24 : 0,
    minSpanDays: 3,
  };
}

describe('RepoRow -- FORBIDDEN FALSEHOOD 4: the arrow is honest when velocity is unknown', () => {
  it.each(INSUFFICIENT_REASONS)('reason %s renders NO arrow and NO rate', (reason) => {
    const container = renderRepo({ velocity: insufficient(reason) });
    const cell = container.querySelector('.repo-row__velocity')!;
    expect(cell.classList.contains('repo-row__velocity--unknown')).toBe(true);
    const text = cell.textContent!;
    for (const arrow of ['▲', '▼', '→']) expect(text).not.toContain(arrow);
    expect(text).not.toMatch(/[+-]?\d[\d.]*\/d/);
    // The specific lie: a confident zero.
    expect(text).not.toContain('0.0');
  });

  it('THE ZERO-HISTORY DATABASE: a whole lane of fresh repos states its history, not a rate', () => {
    // The plan: "On a fresh database there is no velocity at all, and there
    // will not be for a week... Getting this wrong produces a lane that looks
    // broken for a week and then silently starts working, which is the worst
    // of both."
    const container = renderRepo({ velocity: insufficient('no_snapshots', 0) });
    const cell = container.querySelector('.repo-row__velocity')!;
    expect(cell.textContent).toContain('no rate');
    expect(cell.textContent).toContain('0/7d');
    expect(cell.getAttribute('title')).toMatch(/fresh database/i);
  });

  it('unknown_repo says "not tracked" and never invents a "0 of 7 days" window', () => {
    const container = renderRepo({ velocity: insufficient('unknown_repo') });
    const cell = container.querySelector('.repo-row__velocity')!;
    expect(cell.textContent).toContain('not tracked');
    expect(cell.textContent).not.toContain('0/7d');
  });

  it('the four reasons are distinguishable from each other, not one generic state', () => {
    const titles = INSUFFICIENT_REASONS.map((reason) => {
      const t = renderRepo({ velocity: insufficient(reason) }).querySelector('.repo-row__velocity')!.getAttribute('title')!;
      current!.unmount();
      current = null;
      return t;
    });
    expect(new Set(titles).size).toBe(INSUFFICIENT_REASONS.length);
  });

  it('span_too_short shows the real elapsed span, never the day-label count it straddles', () => {
    const container = renderRepo({ velocity: insufficient('span_too_short') });
    const title = container.querySelector('.repo-row__velocity')!.getAttribute('title')!;
    expect(title).toContain('2.0h');
    expect(title).not.toMatch(/\b2 days?\b/);
  });
});

describe('RepoRow -- a measured rate, in both directions', () => {
  function withRate(starsPerDay: number, starsGained: number, staleDays = 0): HTMLElement {
    return renderRepo({
      velocity: {
        status: 'ok',
        starsPerDay,
        starsGained,
        spanDays: 6,
        spanCoverage: 1,
        staleDays,
        observedDays: 7,
        expectedDays: 7,
      },
    });
  }

  it('a rising repo gets an up arrow', () => {
    const cell = withRate(61.2, 366).querySelector('.repo-row__velocity')!;
    expect(cell.textContent).toContain('▲');
    expect(cell.textContent).toContain('+61.2/d');
    expect(cell.classList.contains('repo-row__velocity--up')).toBe(true);
  });

  it('a FALLING repo gets a down arrow -- a spam-star purge stays visible as a purge', () => {
    // src/score/velocity.ts refuses to clamp negatives precisely so this case
    // reaches the eye. Rendering |rate| would throw the evidence away here.
    const cell = withRate(-42.5, -255).querySelector('.repo-row__velocity')!;
    expect(cell.textContent).toContain('▼');
    expect(cell.textContent).toContain('-42.5/d');
    expect(cell.classList.contains('repo-row__velocity--down')).toBe(true);
    expect(cell.getAttribute('title')).toContain('-255');
  });

  it('a measured-flat repo gets a flat arrow, which is NOT the unknown state', () => {
    const cell = withRate(0, 0).querySelector('.repo-row__velocity')!;
    expect(cell.textContent).toContain('→');
    expect(cell.textContent).toContain('0.0/d');
    expect(cell.classList.contains('repo-row__velocity--flat')).toBe(true);
    expect(cell.classList.contains('repo-row__velocity--unknown')).toBe(false);
  });

  it('a stale measurement still shows its rate, but marked as stale', () => {
    const cell = withRate(61.2, 366, 3).querySelector('.repo-row__velocity')!;
    expect(cell.textContent).toContain('+61.2/d');
    expect(cell.classList.contains('repo-row__velocity--stale')).toBe(true);
    expect(cell.getAttribute('title')).toContain('3 days');
  });
});

// ---------------------------------------------------------------------------
// Parity with the news row: keyboard, actions, dismissal
// ---------------------------------------------------------------------------

describe('RepoRow -- keyboard + action parity with ItemRow', () => {
  it('applies tabIndex to the toggle button verbatim -- roving tabindex stays the lane\'s call', () => {
    const item = makeFeedItem({ repo: makeRepo() });
    current = mount(
      <RepoRow item={item} repo={item.repo!} dismissing={false} focused={false} tabIndex={0} onFocusRow={noop} onOpen={noop} onToggleSave={noop} onDismiss={noop} />,
    );
    expect(current.container.querySelector('.item-row__toggle')!.getAttribute('tabindex')).toBe('0');
  });

  it('reports REAL DOM focus through onFocusRow, and exposes the toggle through toggleRef', () => {
    const onFocusRow = vi.fn();
    let captured: HTMLButtonElement | null = null;
    const item = makeFeedItem({ repo: makeRepo() });
    current = mount(
      <RepoRow
        item={item}
        repo={item.repo!}
        dismissing={false}
        focused={false}
        tabIndex={0}
        onFocusRow={onFocusRow}
        toggleRef={(el) => {
          captured = el;
        }}
        onOpen={noop}
        onToggleSave={noop}
        onDismiss={noop}
      />,
    );
    expect(onFocusRow).not.toHaveBeenCalled();
    // Lane.tsx's focusRowAt() calls .focus() on exactly this element.
    expect(captured).not.toBeNull();
    act(() => captured!.focus());
    expect(document.activeElement).toBe(captured);
    expect(onFocusRow).toHaveBeenCalledOnce();
  });

  it('paints the focus highlight from the `focused` prop, using the shared row class', () => {
    const item = makeFeedItem({ repo: makeRepo() });
    current = mount(
      <RepoRow item={item} repo={item.repo!} dismissing={false} focused={true} tabIndex={0} onFocusRow={noop} onOpen={noop} onToggleSave={noop} onDismiss={noop} />,
    );
    expect(current.container.querySelector('li.item-row')!.classList.contains('item-row--focused')).toBe(true);
  });

  it('open/save/dismiss call the same callbacks with the same item -- `s` and `x` work here too', () => {
    const onOpen = vi.fn();
    const onToggleSave = vi.fn();
    const onDismiss = vi.fn();
    const item = makeFeedItem({ repo: makeRepo() });
    current = mount(
      <RepoRow
        item={item}
        repo={item.repo!}
        dismissing={false}
        focused={false}
        tabIndex={-1}
        onFocusRow={noop}
        onOpen={onOpen}
        onToggleSave={onToggleSave}
        onDismiss={onDismiss}
      />,
    );
    const buttons = Array.from(current.container.querySelectorAll('button.item-row__action'));
    actClick(current.container.querySelector('a.item-row__action')!);
    actClick(buttons.find((b) => b.textContent === 'Save')!);
    actClick(buttons.find((b) => b.textContent === 'Dismiss')!);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(item);
    expect(onToggleSave).toHaveBeenCalledExactlyOnceWith(item);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith(item);
  });

  it('the dismissing state fades and hides the row, and offers NO un-dismiss', () => {
    const item = makeFeedItem({ repo: makeRepo() });
    current = mount(
      <RepoRow item={item} repo={item.repo!} dismissing={true} focused={false} tabIndex={-1} onFocusRow={noop} onOpen={noop} onToggleSave={noop} onDismiss={noop} />,
    );
    const row = current.container.querySelector('li.item-row')!;
    expect(row.classList.contains('item-row--dismissing')).toBe(true);
    expect(row.getAttribute('aria-hidden')).toBe('true');
    // Dismissal is deliberately irreversible.
    expect(current.container.textContent!.toLowerCase()).not.toContain('undo');
    expect(current.container.textContent!.toLowerCase()).not.toContain('un-dismiss');
  });

  it('every affordance is >=44px and always rendered -- none hover-only, same as the news row', () => {
    const container = renderRepo();
    const actions = Array.from(container.querySelectorAll('.item-row__action'));
    expect(actions).toHaveLength(3);
    for (const a of actions) expect(a.classList.contains('touch-target')).toBe(true);
  });

  it('opens the repo\'s canonical URL, in a new tab, safely', () => {
    const item = makeFeedItem({ canonicalUrl: 'https://github.com/langchain-ai/langgraph', repo: makeRepo() });
    current = mount(
      <RepoRow item={item} repo={item.repo!} dismissing={false} focused={false} tabIndex={-1} onFocusRow={noop} onOpen={noop} onToggleSave={noop} onDismiss={noop} />,
    );
    const open = current.container.querySelector('a.item-row__action')!;
    expect(open.getAttribute('href')).toBe('https://github.com/langchain-ai/langgraph');
    expect(open.getAttribute('target')).toBe('_blank');
    expect(open.getAttribute('rel')).toContain('noopener');
  });

  it('expands in place, on the same row, exactly like the news row', () => {
    const container = renderRepo();
    const toggle = container.querySelector<HTMLButtonElement>('.item-row__toggle')!;
    const wrapper = container.querySelector('.item-row__detail-wrapper')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(wrapper.getAttribute('aria-hidden')).toBe('true');
    actClick(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(wrapper.getAttribute('aria-hidden')).toBe('false');
  });

  it('a pinned repo still shows the PINNED badge -- hard overrides are row chrome, not news-only', () => {
    const container = renderRepo(
      {},
      {
        signalScore: 0,
        override: {
          signal: { pinned: true, priority: 1, label: 'Repo override' },
          read: { pinned: false, priority: null, label: null },
        },
      },
    );
    expect(container.textContent).toContain('PINNED');
    expect(container.querySelector('li.item-row')!.classList.contains('item-row--pinned')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §7.1: design tokens in ONE place
// ---------------------------------------------------------------------------

function readWebSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

describe('§7.1 -- no component may hardcode a colour', () => {
  it('tokens.css is the only file in web/src that contains a colour literal', () => {
    // "Design tokens in one place: colors, spacing, type scale as CSS custom
    // properties." Retuning the palette must stay a one-file edit -- CLAUDE.md
    // records that the current palette is a PROPOSAL, so this is load-bearing.
    const roots = ['../src/components/RepoRow.tsx', '../src/components/FeedRow.tsx', '../src/styles/global.css'];
    for (const rel of roots) {
      const source = readWebSource(rel);
      expect(source, `${rel} must not contain a hex colour`).not.toMatch(/#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b/);
      expect(source, `${rel} must not contain an rgb()/hsl() literal`).not.toMatch(/\b(rgba?|hsla?)\(/);
    }
  });

  it('every --color-velocity-* token the stylesheet reads is actually defined in tokens.css', () => {
    const tokens = readWebSource('../src/styles/tokens.css');
    const used = new Set(readWebSource('../src/styles/global.css').match(/--color-velocity-[a-z-]+/g) ?? []);
    expect(used.size).toBe(4); // up, down, flat, unknown -- one per display state
    for (const name of used) {
      expect(tokens, `${name} is read by global.css but never defined`).toContain(`${name}:`);
    }
  });
});

// ---------------------------------------------------------------------------
// The gap jsdom leaves: it parses no stylesheet at all, so every test above
// would pass just as happily against a stylesheet whose selectors are typo'd
// or missing. These two close the specific, silent failure that produces --
// a name that differs between the component and the stylesheet, which loses
// styling with no error anywhere. Neither pretends to judge how the row LOOKS;
// CLAUDE.md is explicit that the palette is a proposal and the "does it read
// like a terminal" question is the owner's call, not a test's.
// ---------------------------------------------------------------------------

/** Every `repo-row*` class the component really emits, across the branches that produce different markup. */
function emittedRepoClasses(): Set<string> {
  const emitted = new Set<string>();
  const variants: Array<Partial<FeedItemRepo>> = [
    { description: null, language: null, lastCommitAt: null, readmeExcerpt: null, readmeKnown: true },
    { readmeExcerpt: null, readmeKnown: false },
    { velocity: { status: 'ok', starsPerDay: 12, starsGained: 72, spanDays: 6, spanCoverage: 1, staleDays: 0, observedDays: 7, expectedDays: 7 } },
    { velocity: { status: 'ok', starsPerDay: -12, starsGained: -72, spanDays: 6, spanCoverage: 1, staleDays: 2, observedDays: 5, expectedDays: 7 } },
    { velocity: { status: 'ok', starsPerDay: 0, starsGained: 0, spanDays: 6, spanCoverage: 1, staleDays: 0, observedDays: 7, expectedDays: 7 } },
    { velocity: insufficient('no_snapshots') },
  ];
  for (const variant of variants) {
    const container = renderRepo(variant);
    expand(container);
    for (const el of container.querySelectorAll('*')) {
      for (const cls of el.classList) if (cls.startsWith('repo-row')) emitted.add(cls);
    }
    current!.unmount();
    current = null;
  }
  return emitted;
}

describe('RepoRow -- the component and the stylesheet agree on every name', () => {
  it('every .repo-row* selector in global.css matches a class the component actually renders', () => {
    // The direction with NO legitimate exceptions, and the one where a typo is
    // invisible: a rule for `.repo-row__velocity--unkown` silently styles
    // nothing, and the row just quietly loses its colour.
    const emitted = emittedRepoClasses();
    const selectors = new Set(readWebSource('../src/styles/global.css').match(/\.repo-row[a-z0-9_-]*/g) ?? []);
    expect(selectors.size).toBeGreaterThan(10);
    for (const selector of selectors) {
      expect(emitted, `${selector} is styled but no rendered element carries it`).toContain(selector.slice(1));
    }
  });

  it('every STATE MODIFIER the component renders has a rule -- a modifier that styles nothing is pointless', () => {
    // The other direction, restricted to the classes whose entire purpose is
    // to look different: `--up`, `--down`, `--stale`, `--missing`, `--absent`,
    // `--unknown`. Base structural classes are exempt because some legitimately
    // exist only as query anchors (`.repo-row__issues`), but a modifier that
    // nothing styles is a state the UI claims to distinguish and does not.
    const css = readWebSource('../src/styles/global.css');
    const modifiers = [...emittedRepoClasses()].filter((cls) => cls.includes('--'));
    expect(modifiers.length).toBeGreaterThan(5);
    for (const cls of modifiers) {
      expect(css, `.${cls} is a state modifier with no rule -- it distinguishes nothing`).toContain(`.${cls}`);
    }
  });
});
