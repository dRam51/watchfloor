// @vitest-environment jsdom
import { act, createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Lane, type LaneHandle } from '../src/components/Lane.tsx';
import { actClick, fetchRouter, flush, makeFeedItem, makeFeedResponse, mount, type Mounted } from './testUtils.tsx';

let current: Mounted | null = null;
afterEach(() => {
  current?.unmount();
  current = null;
  vi.unstubAllGlobals();
});

const TOKEN = 'test-token';
const noop = () => {};
const noopCount = () => {};

function renderLane(overrides: Partial<Parameters<typeof Lane>[0]> = {}, ref = createRef<LaneHandle>()) {
  const props = {
    beat: 'cyber' as const,
    collapsed: false,
    onToggleCollapse: noop,
    token: TOKEN,
    onUnauthorized: noop,
    focusedItemKey: null,
    onItemFocus: noop,
    onItemCountChange: noopCount,
    isDefaultEntry: false,
    ...overrides,
  };
  current = mount(<Lane ref={ref} {...props} />);
  return { ref, props };
}

describe('Lane -- fetches its own FIXED beat, never the merged feed', () => {
  it('requests exactly its own beat and the lane page size, with no way to filter it', async () => {
    const { fn, calls } = fetchRouter([
      { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [] }) },
    ]);
    vi.stubGlobal('fetch', fn);

    renderLane({ beat: 'aisec' });
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/feed?beat=aisec&limit=20');
  });
});

describe('Lane -- repos/markets legitimately empty (task brief, DoD 4)', () => {
  it('renders a clear "nothing here" status, distinct from loading or an error', async () => {
    const { fn } = fetchRouter([
      { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [] }) },
    ]);
    vi.stubGlobal('fetch', fn);

    renderLane({ beat: 'repos' });
    await flush();

    expect(current!.container.textContent).toContain('Nothing here yet.');
    expect(current!.container.querySelector('.lane__status--error')).toBeNull();
  });

  it('renders a distinct error status (with retry) on a fetch failure, not the empty message', async () => {
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/feed'), status: 500, body: {} }]);
    vi.stubGlobal('fetch', fn);

    renderLane({ beat: 'markets' });
    await flush();

    expect(current!.container.textContent).not.toContain('Nothing here yet.');
    expect(current!.container.querySelector('.lane__status--error')).not.toBeNull();
    expect(current!.container.querySelector('.lane__retry')).not.toBeNull();
  });
});

describe('Lane -- collapse hides the body but keeps the header, and never relies on hover', () => {
  it('shows only the header (label + toggle) while collapsed -- no list, no status, no load-more', async () => {
    const { fn } = fetchRouter([
      { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [makeFeedItem({ title: 'Hidden item' })] }) },
    ]);
    vi.stubGlobal('fetch', fn);

    renderLane({ collapsed: true });
    await flush();

    expect(current!.container.textContent).toContain('Cyber');
    expect(current!.container.textContent).not.toContain('Hidden item');
    expect(current!.container.querySelector('.lane__body')).toBeNull();
    const toggle = current!.container.querySelector<HTMLButtonElement>('.lane__collapse-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.classList.contains('touch-target')).toBe(true);
  });

  it('the collapse toggle is always rendered and calls onToggleCollapse with this lane\'s own beat -- a real click, never hover-only', async () => {
    const onToggleCollapse = vi.fn();
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [] }) }]);
    vi.stubGlobal('fetch', fn);

    renderLane({ beat: 'usnews', collapsed: false, onToggleCollapse });
    await flush();

    const toggle = current!.container.querySelector<HTMLButtonElement>('.lane__collapse-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    actClick(toggle);
    expect(onToggleCollapse).toHaveBeenCalledExactlyOnceWith('usnews');
  });
});

describe('Lane -- reports its own item count upward (coordinator needs this for the default entry lane)', () => {
  it('calls onItemCountChange with its beat and the real item count once the fetch settles', async () => {
    const item = makeFeedItem();
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [item] }) }]);
    vi.stubGlobal('fetch', fn);
    const onItemCountChange = vi.fn();

    renderLane({ beat: 'ai', onItemCountChange });
    await flush();

    expect(onItemCountChange).toHaveBeenCalledWith('ai', 1);
  });
});

describe('Lane -- imperative handle (LaneBoard drives this lane through it, never a local listener)', () => {
  it('focusRowAt moves real DOM focus to that row and fires onItemFocus tagged with this beat', async () => {
    const a = makeFeedItem({ title: 'Row A' });
    const b = makeFeedItem({ title: 'Row B' });
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [a, b] }) }]);
    vi.stubGlobal('fetch', fn);
    const onItemFocus = vi.fn();
    const ref = createRef<LaneHandle>();

    renderLane({ beat: 'cyber', onItemFocus }, ref);
    await flush();

    act(() => ref.current!.focusRowAt(1));

    const toggles = current!.container.querySelectorAll<HTMLButtonElement>('.item-row__toggle');
    expect(document.activeElement).toBe(toggles[1]);
    expect(onItemFocus).toHaveBeenCalledExactlyOnceWith('cyber', b.itemKey);
  });

  it('indexOfItemKey finds a real key and returns null for one this lane does not have', async () => {
    const a = makeFeedItem({ title: 'Row A' });
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [a] }) }]);
    vi.stubGlobal('fetch', fn);
    const ref = createRef<LaneHandle>();

    renderLane({}, ref);
    await flush();

    expect(ref.current!.indexOfItemKey(a.itemKey)).toBe(0);
    expect(ref.current!.indexOfItemKey('does-not-exist')).toBeNull();
    expect(ref.current!.itemCount).toBe(1);
  });

  it('focusEntry focuses row 0 when expanded and non-empty', async () => {
    const a = makeFeedItem({ title: 'Row A' });
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [a] }) }]);
    vi.stubGlobal('fetch', fn);
    const ref = createRef<LaneHandle>();

    renderLane({ collapsed: false }, ref);
    await flush();

    act(() => ref.current!.focusEntry());

    const toggle = current!.container.querySelector<HTMLButtonElement>('.item-row__toggle')!;
    expect(document.activeElement).toBe(toggle);
  });

  it('focusEntry focuses the collapse toggle instead when the lane is collapsed -- there is no row to land on', async () => {
    const a = makeFeedItem({ title: 'Row A' });
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [a] }) }]);
    vi.stubGlobal('fetch', fn);
    const ref = createRef<LaneHandle>();

    renderLane({ collapsed: true }, ref);
    await flush();

    act(() => ref.current!.focusEntry());

    const toggle = current!.container.querySelector<HTMLButtonElement>('.lane__collapse-toggle')!;
    expect(document.activeElement).toBe(toggle);
  });

  it('focusEntry focuses the collapse toggle when expanded but genuinely empty (repos/markets pre-M4)', async () => {
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [] }) }]);
    vi.stubGlobal('fetch', fn);
    const ref = createRef<LaneHandle>();

    renderLane({ beat: 'repos', collapsed: false }, ref);
    await flush();

    act(() => ref.current!.focusEntry());

    const toggle = current!.container.querySelector<HTMLButtonElement>('.lane__collapse-toggle')!;
    expect(document.activeElement).toBe(toggle);
  });

  it('openAt opens the item in a new tab AND fires the same mark-read request the Open link uses', async () => {
    const item = makeFeedItem({ title: 'Openable' });
    const { fn, calls } = fetchRouter([
      { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [item] }) },
      { match: (url, init) => url.includes('/read') && init?.method === 'POST', body: { readAt: '2026-08-14T18:00:00.000Z', savedAt: null, dismissedAt: null } },
    ]);
    vi.stubGlobal('fetch', fn);
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const ref = createRef<LaneHandle>();

    renderLane({}, ref);
    await flush();

    act(() => ref.current!.openAt(0));
    await flush();

    expect(openSpy).toHaveBeenCalledExactlyOnceWith(item.canonicalUrl, '_blank', 'noopener,noreferrer');
    expect(calls.some((c) => c.url.includes('/read'))).toBe(true);
    openSpy.mockRestore();
  });

  it('toggleSaveAt round-trips through the same POST/DELETE the Save button uses', async () => {
    const item = makeFeedItem({ title: 'Saveable' });
    const { fn, calls } = fetchRouter([
      { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [item] }) },
      { match: (url, init) => url.includes('/save') && init?.method === 'POST', body: { readAt: null, savedAt: '2026-08-14T18:00:00.000Z', dismissedAt: null } },
    ]);
    vi.stubGlobal('fetch', fn);
    const ref = createRef<LaneHandle>();

    renderLane({}, ref);
    await flush();

    act(() => ref.current!.toggleSaveAt(0));
    await flush();

    expect(calls.some((c) => c.url.includes('/save') && c.init?.method === 'POST')).toBe(true);
    expect(current!.container.textContent).toContain('Saved');
  });

  it('dismissAt removes the row after the server confirms', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, media: '', addEventListener: () => {}, removeEventListener: () => {} }));
    const item = makeFeedItem({ title: 'Doomed' });
    const { fn } = fetchRouter([
      { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [item] }) },
      { match: (url, init) => url.includes('/dismiss') && init?.method === 'POST', body: { readAt: null, savedAt: null, dismissedAt: '2026-08-14T18:00:00.000Z' } },
    ]);
    vi.stubGlobal('fetch', fn);
    const ref = createRef<LaneHandle>();

    renderLane({}, ref);
    await flush();
    expect(current!.container.textContent).toContain('Doomed');

    act(() => ref.current!.dismissAt(0));
    await flush(6);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();

    expect(current!.container.textContent).not.toContain('Doomed');
    expect(current!.container.textContent).toContain('Nothing here yet.');
  });

  it('refresh fetches a fresh page 1, not the next page', async () => {
    const item = makeFeedItem();
    const { fn, calls } = fetchRouter([
      { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [item], nextCursor: 'abc' }) },
    ]);
    vi.stubGlobal('fetch', fn);
    const ref = createRef<LaneHandle>();

    renderLane({}, ref);
    await flush();
    expect(calls).toHaveLength(1);

    act(() => ref.current!.refresh());
    await flush();

    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe('/api/feed?beat=cyber&limit=20');
  });
});

describe('Lane -- dismiss focus handoff stays WITHIN this lane, scoped by the coordinator-supplied focusedItemKey', () => {
  it('moves focus to a neighbor row in THIS lane synchronously, before the fade removes it', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, media: '', addEventListener: () => {}, removeEventListener: () => {} }));
    const a = makeFeedItem({ title: 'Row A' });
    const b = makeFeedItem({ title: 'Row B' });
    const c = makeFeedItem({ title: 'Row C' });
    const { fn } = fetchRouter([
      { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [a, b, c] }) },
      { match: (url, init) => url.includes('/dismiss') && init?.method === 'POST', body: { readAt: null, savedAt: null, dismissedAt: '2026-08-14T18:00:00.000Z' } },
    ]);
    vi.stubGlobal('fetch', fn);
    const ref = createRef<LaneHandle>();

    // focusedItemKey already scoped to THIS lane, mirroring what LaneBoard
    // computes (`focusedItem.beat === lane.beat ? focusedItem.itemKey : null`).
    renderLane({ focusedItemKey: b.itemKey }, ref);
    await flush();

    act(() => ref.current!.dismissAt(1));

    const rows = current!.container.querySelectorAll<HTMLButtonElement>('.item-row__toggle');
    expect(document.activeElement).toBe(rows[2]); // Row C, the neighbor -- synchronous, before any await

    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();
    expect(current!.container.textContent).not.toContain('Row B');
  });
});

describe('Lane -- heat strip (M3 task 12, §7.4: "at the top of each lane")', () => {
  it('renders the 24-bar heat strip above the item list when expanded', async () => {
    const item = makeFeedItem({ publishedAt: '2026-08-14T17:30:00.000Z' });
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [item] }) }]);
    vi.stubGlobal('fetch', fn);

    renderLane({ beat: 'cyber' });
    await flush();

    const body = current!.container.querySelector('.lane__body')!;
    const strip = body.querySelector('.heat-strip');
    expect(strip).not.toBeNull();
    // "At the top" -- the strip is the body's first child, ahead of the list.
    expect(body.firstElementChild).toBe(strip);
    expect(strip!.querySelectorAll('.heat-strip__bar')).toHaveLength(24);
  });

  it('a genuinely empty lane (repos/markets pre-M4) still shows a full, "quiet" heat strip, not a missing one', async () => {
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [] }) }]);
    vi.stubGlobal('fetch', fn);

    renderLane({ beat: 'repos' });
    await flush();

    const strip = current!.container.querySelector('.heat-strip')!;
    expect(strip.getAttribute('aria-label')).toBe('No activity in the last 24 hours');
    expect(strip.querySelectorAll('.heat-strip__bar')).toHaveLength(24);
  });

  it('the heat strip disappears along with the rest of the body while collapsed', async () => {
    const item = makeFeedItem();
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [item] }) }]);
    vi.stubGlobal('fetch', fn);

    renderLane({ collapsed: true });
    await flush();

    expect(current!.container.querySelector('.heat-strip')).toBeNull();
  });
});

describe('Lane -- roving tabindex: only the default-entry lane claims row 0 while nothing has real focus', () => {
  it('gives row 0 tabIndex 0 when isDefaultEntry is true and nothing is focused', async () => {
    const a = makeFeedItem({ title: 'Row A' });
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [a] }) }]);
    vi.stubGlobal('fetch', fn);

    renderLane({ isDefaultEntry: true, focusedItemKey: null });
    await flush();

    const toggle = current!.container.querySelector<HTMLButtonElement>('.item-row__toggle')!;
    expect(toggle.getAttribute('tabindex')).toBe('0');
  });

  it('gives row 0 tabIndex -1 when this lane is NOT the default entry, even though nothing is focused anywhere', async () => {
    const a = makeFeedItem({ title: 'Row A' });
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [a] }) }]);
    vi.stubGlobal('fetch', fn);

    renderLane({ isDefaultEntry: false, focusedItemKey: null });
    await flush();

    const toggle = current!.container.querySelector<HTMLButtonElement>('.item-row__toggle')!;
    expect(toggle.getAttribute('tabindex')).toBe('-1');
  });

  it('the actually-focused row is always tabIndex 0, overriding isDefaultEntry', async () => {
    const a = makeFeedItem({ title: 'Row A' });
    const b = makeFeedItem({ title: 'Row B' });
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [a, b] }) }]);
    vi.stubGlobal('fetch', fn);

    renderLane({ isDefaultEntry: false, focusedItemKey: b.itemKey });
    await flush();

    const toggles = current!.container.querySelectorAll<HTMLButtonElement>('.item-row__toggle');
    expect(toggles[0]!.getAttribute('tabindex')).toBe('-1');
    expect(toggles[1]!.getAttribute('tabindex')).toBe('0');
  });
});
