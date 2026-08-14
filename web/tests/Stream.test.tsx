// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Stream } from '../src/components/Stream.tsx';
import { actClick, fetchRouter, flush, makeFeedItem, makeFeedResponse, mount, type Mounted } from './testUtils.tsx';

let current: Mounted | null = null;
afterEach(() => {
  current?.unmount();
  current = null;
  vi.unstubAllGlobals();
});

const TOKEN = 'test-token';

function findByText(container: HTMLElement, selector: string, text: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).find((el) => el.textContent === text);
}

describe('Stream -- initial load', () => {
  it('fetches /api/feed with no beat filter and renders the real items it gets back', async () => {
    const alpha = makeFeedItem({ title: 'Alpha item' });
    const { fn, calls } = fetchRouter([
      {
        match: (url) => url.startsWith('/api/feed'),
        body: makeFeedResponse({ items: [alpha], nextCursor: null }),
      },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/feed?limit=25');
    expect(current.container.textContent).toContain('Alpha item');
  });

  it('shows an explicit empty state rather than nothing when the feed has zero items', async () => {
    const { fn } = fetchRouter([
      { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [] }) },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    expect(current.container.textContent).toContain('Nothing here right now.');
  });

  it('surfaces a fetch failure with a retry affordance rather than a blank screen', async () => {
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/feed'), status: 500, body: {} }]);
    vi.stubGlobal('fetch', fn);

    current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    expect(current.container.textContent).toContain('feed error');
    expect(current.container.querySelector('.stream__retry')).not.toBeNull();
  });

  it('treats a 401 as an auth failure and calls onUnauthorized, not the generic error path', async () => {
    const onUnauthorized = vi.fn();
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/feed'), status: 401, body: {} }]);
    vi.stubGlobal('fetch', fn);

    current = mount(<Stream token={TOKEN} onUnauthorized={onUnauthorized} />);
    await flush();

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(current.container.textContent).not.toContain('feed error');
  });
});

describe('Stream -- beat filtering happens server-side (would fail under client-side filtering)', () => {
  it('re-fetches through the API on a beat click, rendering an item that never existed in the first response', async () => {
    // Page-1 (merged) response: only "Alpha item" exists anywhere on the client yet.
    const alpha = makeFeedItem({ title: 'Alpha item', beats: ['ai'], representativeBeat: 'ai' });
    // The cyber-filtered response introduces "Bravo item" -- a title that
    // was NEVER part of the client's fetched data before this click. A
    // client-side filter over the already-fetched array could not possibly
    // produce this row; only a real second network round trip can.
    const bravo = makeFeedItem({ title: 'Bravo item', beats: ['cyber'], representativeBeat: 'cyber' });

    const { fn, calls } = fetchRouter([
      {
        match: (url) => url.startsWith('/api/feed') && !url.includes('beat='),
        body: makeFeedResponse({ items: [alpha], nextCursor: null }),
      },
      {
        match: (url) => url.startsWith('/api/feed') && url.includes('beat=cyber'),
        body: makeFeedResponse({ items: [bravo], beat: 'cyber', nextCursor: null }),
      },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
    await flush();
    expect(current.container.textContent).toContain('Alpha item');
    expect(calls).toHaveLength(1);

    const cyberChip = findByText(current.container, '.beat-filter__chip', 'Cyber')!;
    actClick(cyberChip);
    await flush();

    // A genuine second request was made, scoped to the selected beat...
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain('beat=cyber');
    // ...and the DOM now shows exactly what THAT response contained: the
    // previously-unseen item is present, and the old merged-view item --
    // which a naive client-side filter would have kept lying around -- is
    // gone.
    expect(current.container.textContent).toContain('Bravo item');
    expect(current.container.textContent).not.toContain('Alpha item');
  });

  it('omits the beat parameter entirely for "All" rather than sending a literal "all" value', async () => {
    const { fn, calls } = fetchRouter([
      { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [] }) },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    expect(calls[0]!.url).not.toContain('beat=');
  });
});

describe('Stream -- explicit pagination, never infinite scroll', () => {
  it('shows a "Load more" button when nextCursor is present, and passes the cursor back verbatim', async () => {
    const first = makeFeedItem({ title: 'Page one item' });
    const second = makeFeedItem({ title: 'Page two item' });

    const { fn, calls } = fetchRouter([
      {
        match: (url) => url.startsWith('/api/feed') && !url.includes('cursor='),
        body: makeFeedResponse({ items: [first], nextCursor: 'cursor-xyz' }),
      },
      {
        match: (url) => url.includes('cursor=cursor-xyz'),
        body: makeFeedResponse({ items: [second], nextCursor: null }),
      },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    const loadMore = current.container.querySelector<HTMLButtonElement>('.stream__load-more')!;
    expect(loadMore).not.toBeNull();
    expect(loadMore.classList.contains('touch-target')).toBe(true);

    actClick(loadMore);
    await flush();

    expect(calls).toHaveLength(2);
    // Verbatim cursor, nothing reconstructed from local beat/profile state:
    // no `beat=` or `profile=` on this request at all.
    expect(calls[1]!.url).toBe('/api/feed?cursor=cursor-xyz&limit=25');
    expect(calls[1]!.url).not.toContain('beat=');
    expect(calls[1]!.url).not.toContain('profile=');

    // Page 2 is APPENDED, not swapped in -- both rows are visible.
    expect(current.container.textContent).toContain('Page one item');
    expect(current.container.textContent).toContain('Page two item');
    // No more pages: the button is gone.
    expect(current.container.querySelector('.stream__load-more')).toBeNull();
  });

  it('never fetches a second page on its own -- scrolling triggers nothing', async () => {
    const item = makeFeedItem({ title: 'Only item' });
    const { fn, calls } = fetchRouter([
      { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [item], nextCursor: 'more' }) },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
    await flush();
    expect(calls).toHaveLength(1);

    // Simulate scrolling to the bottom of the page -- if this were an
    // infinite-scroll implementation, a scroll or intersection signal here
    // would trigger a second fetch.
    window.dispatchEvent(new Event('scroll'));
    document.body.dispatchEvent(new Event('scroll'));
    await flush();

    expect(calls).toHaveLength(1); // still just the one, explicit, initial request
    expect(current.container.querySelector('.stream__load-more')).not.toBeNull();
  });
});

describe('Stream -- item state actions', () => {
  it('open fires a background mark-read request without blocking navigation', async () => {
    const item = makeFeedItem({ title: 'Readable item' });
    const { fn, calls } = fetchRouter([
      { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [item] }) },
      {
        match: (url, init) => url.includes('/read') && init?.method === 'POST',
        body: { readAt: '2026-08-14T18:00:00.000Z', savedAt: null, dismissedAt: null },
      },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    const openLink = current.container.querySelector('a.item-row__action')!;
    actClick(openLink);
    await flush();

    const readCall = calls.find((c) => c.url.includes('/read'));
    expect(readCall).toBeDefined();
    expect(readCall!.url).toContain(`/api/items/${item.itemKey}/read`);
  });

  it('save then unsave round-trips through POST then DELETE and flips the button label', async () => {
    const item = makeFeedItem({ title: 'Saveable item' });
    const { fn, calls } = fetchRouter([
      { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [item] }) },
      {
        match: (url, init) => url.includes('/save') && init?.method === 'POST',
        body: { readAt: null, savedAt: '2026-08-14T18:00:00.000Z', dismissedAt: null },
      },
      {
        match: (url, init) => url.includes('/save') && init?.method === 'DELETE',
        body: { readAt: null, savedAt: null, dismissedAt: null },
      },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
    await flush();

    const saveBtn = () => findByText(current!.container, 'button.item-row__action', 'Save');
    const savedBtn = () => findByText(current!.container, 'button.item-row__action', 'Saved');

    expect(saveBtn()).toBeDefined();
    actClick(saveBtn()!);
    await flush();

    expect(savedBtn()).toBeDefined();
    expect(calls.some((c) => c.url.includes('/save') && c.init?.method === 'POST')).toBe(true);

    actClick(savedBtn()!);
    await flush();

    expect(saveBtn()).toBeDefined();
    expect(calls.some((c) => c.url.includes('/save') && c.init?.method === 'DELETE')).toBe(true);
  });

  it('dismiss removes the row after the server confirms, and offers no way back', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true, // force prefers-reduced-motion so the removal timer is 0ms
      media: '',
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const item = makeFeedItem({ title: 'Doomed item' });
    const { fn } = fetchRouter([
      { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [item] }) },
      {
        match: (url, init) => url.includes('/dismiss') && init?.method === 'POST',
        body: { readAt: null, savedAt: null, dismissedAt: '2026-08-14T18:00:00.000Z' },
      },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
    await flush();
    expect(current.container.textContent).toContain('Doomed item');

    const dismissBtn = findByText(current.container, 'button.item-row__action--danger', 'Dismiss')!;
    actClick(dismissBtn);

    // Let the dismiss POST resolve, then the (0ms, reduced-motion) removal timer fire.
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();

    expect(current.container.textContent).not.toContain('Doomed item');
    expect(current.container.textContent).toContain('Nothing here right now.');
  });
});
