// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ItemRow } from '../src/components/ItemRow.tsx';
import { actClick, makeFeedItem, mount, type Mounted } from './testUtils.tsx';

let current: Mounted | null = null;
afterEach(() => {
  current?.unmount();
  current = null;
});

const noop = () => {};

describe('ItemRow -- at rest', () => {
  it('shows score, title, source, relative time, and beat tag on one line, with no detail visible', () => {
    const item = makeFeedItem({
      title: 'A cyber advisory',
      sourceId: 'cisa-kev',
      representativeBeat: 'cyber',
      publishedAt: '2026-08-14T17:30:00.000Z', // 30 minutes before the fixture "now"
      signalScore: 3.482,
    });
    current = mount(
      <ItemRow item={item} dismissing={false} onOpen={noop} onToggleSave={noop} onDismiss={noop} />,
    );
    const text = current.container.textContent!;
    expect(text).toContain('A cyber advisory');
    expect(text).toContain('cisa-kev');
    expect(text).toContain('3.482');
    expect(text).toContain('Cyber');
    // Relative time renders as a real string, not left blank -- exact
    // wording is deliberately not pinned here (it depends on the real
    // wall clock; web/tests/relativeTime.test.ts covers exact formatting
    // against a fixed clock).
    const timeText = current.container.querySelector('.item-row__time')!.textContent!;
    expect(timeText).toMatch(/ago$|^just now$|^undated$/);
    // The detail panel (the summary) is not VISIBLE at rest. It stays
    // mounted in the DOM -- deliberately, so the grid-track transition
    // (tokens.css var(--motion-base)) has something to animate on first
    // click rather than measuring a freshly-mounted element's height -- but
    // it is taken out of the accessibility tree and visually collapsed to
    // zero height via the (unexpanded) wrapper class, which is the actual
    // contract this asserts rather than raw DOM presence.
    const wrapper = current.container.querySelector('.item-row__detail-wrapper')!;
    expect(wrapper.getAttribute('aria-hidden')).toBe('true');
    expect(wrapper.classList.contains('item-row__detail-wrapper--expanded')).toBe(false);
    expect(current.container.querySelector('.item-row__toggle')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the cluster count only when the item is actually clustered', () => {
    const solo = makeFeedItem({ clusterSize: 1 });
    current = mount(
      <ItemRow item={solo} dismissing={false} onOpen={noop} onToggleSave={noop} onDismiss={noop} />,
    );
    expect(current.container.textContent).not.toContain('×');

    current.unmount();
    const clustered = makeFeedItem({ clusterSize: 4 });
    current = mount(
      <ItemRow item={clustered} dismissing={false} onOpen={noop} onToggleSave={noop} onDismiss={noop} />,
    );
    expect(current.container.textContent).toContain('×4');
  });

  it('provides visible, tappable (>=44px) affordances for open, save, and dismiss -- none hover-only', () => {
    const item = makeFeedItem();
    current = mount(
      <ItemRow item={item} dismissing={false} onOpen={noop} onToggleSave={noop} onDismiss={noop} />,
    );
    const open = current.container.querySelector('a.item-row__action')!;
    const buttons = Array.from(current.container.querySelectorAll('button.item-row__action'));
    expect(open.classList.contains('touch-target')).toBe(true);
    expect(open.getAttribute('href')).toBe(item.canonicalUrl);
    expect(open.getAttribute('target')).toBe('_blank');
    expect(open.getAttribute('rel')).toContain('noopener');
    expect(buttons).toHaveLength(2); // Save, Dismiss
    buttons.forEach((b) => expect(b.classList.contains('touch-target')).toBe(true));
    // Every affordance is a real, always-rendered element (queryable without
    // simulating :hover), not something CSS reveals on hover only.
  });
});

describe('ItemRow -- pinned-at-zero legibility', () => {
  it('renders a pinned item with a 0.000 score as PINNED, not as a low score', () => {
    const item = makeFeedItem({
      title: 'Old KEV entry',
      signalScore: 0,
      override: {
        signal: { pinned: true, priority: 1, label: 'CISA KEV' },
        read: { pinned: false, priority: null, label: null },
      },
    });
    current = mount(
      <ItemRow item={item} dismissing={false} onOpen={noop} onToggleSave={noop} onDismiss={noop} />,
    );
    const text = current.container.textContent!;
    expect(text).toContain('PINNED');
    expect(text).toContain('0.000');
    const row = current.container.querySelector('li.item-row')!;
    expect(row.classList.contains('item-row--pinned')).toBe(true);
    // The score value itself is still present (never hidden), but visually
    // subordinated to the PINNED badge via a distinct modifier class.
    expect(current.container.querySelector('.item-row__score-value--dim')).not.toBeNull();
  });

  it('an unpinned item with the same 0.000 score gets no PINNED badge and no accent', () => {
    const item = makeFeedItem({ signalScore: 0 });
    current = mount(
      <ItemRow item={item} dismissing={false} onOpen={noop} onToggleSave={noop} onDismiss={noop} />,
    );
    expect(current.container.textContent).not.toContain('PINNED');
    expect(current.container.querySelector('li.item-row')!.classList.contains('item-row--pinned')).toBe(false);
  });
});

describe('ItemRow -- summary: null vs empty vs present', () => {
  function expandedTextOf(summary: string | null): string {
    const item = makeFeedItem({ summary });
    current = mount(
      <ItemRow item={item} dismissing={false} onOpen={noop} onToggleSave={noop} onDismiss={noop} />,
    );
    actClick(current.container.querySelector<HTMLButtonElement>('.item-row__toggle')!);
    const text = current.container.textContent!;
    current.unmount();
    current = null;
    return text;
  }

  it('a null summary reads as "no excerpt", never as blank', () => {
    expect(expandedTextOf(null)).toContain('No excerpt available');
  });

  it('an empty-string summary reads as "fetched empty", distinct from null', () => {
    expect(expandedTextOf('')).toContain('Excerpt was empty when fetched');
  });

  it('a real summary is rendered verbatim', () => {
    expect(expandedTextOf('Attackers exploited a zero-day.')).toContain('Attackers exploited a zero-day.');
  });
});

describe('ItemRow -- expand/collapse', () => {
  it('toggles aria-expanded and reveals the detail panel in place, on the same row', () => {
    const item = makeFeedItem({ summary: 'Detail content goes here.' });
    current = mount(
      <ItemRow item={item} dismissing={false} onOpen={noop} onToggleSave={noop} onDismiss={noop} />,
    );
    const toggle = current.container.querySelector<HTMLButtonElement>('.item-row__toggle')!;
    const wrapper = current.container.querySelector('.item-row__detail-wrapper')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(wrapper.getAttribute('aria-hidden')).toBe('true');
    // Content is always present (see the "at rest" test's note on why), so
    // the meaningful assertion at rest is inert-to-assistive-tech, not
    // absent-from-the-DOM. What flips on click is what actually matters.
    expect(current.container.textContent).toContain('Detail content goes here.');

    actClick(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(wrapper.getAttribute('aria-hidden')).toBe('false');
    expect(wrapper.classList.contains('item-row__detail-wrapper--expanded')).toBe(true);
    expect(current.container.textContent).toContain('Detail content goes here.');

    actClick(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(wrapper.getAttribute('aria-hidden')).toBe('true');
    expect(wrapper.classList.contains('item-row__detail-wrapper--expanded')).toBe(false);
  });
});

describe('ItemRow -- actions call the right callback', () => {
  it('open calls onOpen with the item', () => {
    const onOpen = vi.fn();
    const item = makeFeedItem();
    current = mount(
      <ItemRow item={item} dismissing={false} onOpen={onOpen} onToggleSave={noop} onDismiss={noop} />,
    );
    actClick(current.container.querySelector('a.item-row__action')!);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(item);
  });

  it('save calls onToggleSave, and its label/aria-pressed reflect saved state', () => {
    const onToggleSave = vi.fn();
    const unsaved = makeFeedItem();
    current = mount(
      <ItemRow item={unsaved} dismissing={false} onOpen={noop} onToggleSave={onToggleSave} onDismiss={noop} />,
    );
    const saveBtn = Array.from(current.container.querySelectorAll('button.item-row__action')).find(
      (b) => b.textContent === 'Save',
    )!;
    expect(saveBtn.getAttribute('aria-pressed')).toBe('false');
    actClick(saveBtn);
    expect(onToggleSave).toHaveBeenCalledExactlyOnceWith(unsaved);

    current.unmount();
    const saved = makeFeedItem({ state: { readAt: null, savedAt: '2026-08-14T17:00:00.000Z', dismissedAt: null } });
    current = mount(
      <ItemRow item={saved} dismissing={false} onOpen={noop} onToggleSave={noop} onDismiss={noop} />,
    );
    const savedBtn = Array.from(current.container.querySelectorAll('button.item-row__action')).find(
      (b) => b.textContent === 'Saved',
    )!;
    expect(savedBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('dismiss calls onDismiss with the item', () => {
    const onDismiss = vi.fn();
    const item = makeFeedItem();
    current = mount(
      <ItemRow item={item} dismissing={false} onOpen={noop} onToggleSave={noop} onDismiss={onDismiss} />,
    );
    const dismissBtn = Array.from(current.container.querySelectorAll('button.item-row__action')).find(
      (b) => b.textContent === 'Dismiss',
    )!;
    actClick(dismissBtn);
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith(item);
  });
});

describe('ItemRow -- dismissing transition state', () => {
  it('marks the row aria-hidden and with the dismissing class while the fade plays, without implying undo', () => {
    const item = makeFeedItem();
    current = mount(
      <ItemRow item={item} dismissing={true} onOpen={noop} onToggleSave={noop} onDismiss={noop} />,
    );
    const row = current.container.querySelector('li.item-row')!;
    expect(row.classList.contains('item-row--dismissing')).toBe(true);
    expect(row.getAttribute('aria-hidden')).toBe('true');
    // No "undo"/"undismiss" affordance anywhere -- dismissal is irreversible.
    expect(current.container.textContent!.toLowerCase()).not.toContain('undo');
  });
});
