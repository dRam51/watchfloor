// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Stream } from '../src/components/Stream.tsx';
import {
  actClick,
  actKeyDown,
  fetchRouter,
  flush,
  makeFeedItem,
  makeFeedResponse,
  mount,
  type Mounted,
} from './testUtils.tsx';

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

describe('Stream -- global keyboard navigation (M3 task 9)', () => {
  function toggles(container: HTMLElement): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('.item-row__toggle'));
  }

  describe('j/k -- real focus, not a painted highlight', () => {
    it('"j" enters the list at the first row when nothing has focus yet, then moves forward', async () => {
      const a = makeFeedItem({ title: 'Row A' });
      const b = makeFeedItem({ title: 'Row B' });
      const c = makeFeedItem({ title: 'Row C' });
      const { fn } = fetchRouter([
        { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [a, b, c] }) },
      ]);
      vi.stubGlobal('fetch', fn);

      current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
      await flush();
      const rows = toggles(current.container);
      expect(rows).toHaveLength(3);
      expect(document.activeElement).not.toBe(rows[0]);

      actKeyDown('j');
      // This is the assertion a "selectedIndex that only paints a border"
      // implementation cannot pass: it checks real DOM focus, not a class.
      expect(document.activeElement).toBe(rows[0]);

      actKeyDown('j');
      expect(document.activeElement).toBe(rows[1]);
    });

    it('"k" enters the list at the LAST row when nothing has focus yet, then moves backward', async () => {
      const a = makeFeedItem({ title: 'Row A' });
      const b = makeFeedItem({ title: 'Row B' });
      const c = makeFeedItem({ title: 'Row C' });
      const { fn } = fetchRouter([
        { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [a, b, c] }) },
      ]);
      vi.stubGlobal('fetch', fn);

      current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
      await flush();
      const rows = toggles(current.container);

      actKeyDown('k');
      expect(document.activeElement).toBe(rows[2]);

      actKeyDown('k');
      expect(document.activeElement).toBe(rows[1]);
    });

    it('clamps at the last row rather than wrapping back to the first', async () => {
      const a = makeFeedItem({ title: 'Row A' });
      const b = makeFeedItem({ title: 'Row B' });
      const { fn } = fetchRouter([
        { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [a, b] }) },
      ]);
      vi.stubGlobal('fetch', fn);

      current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
      await flush();
      const rows = toggles(current.container);

      actKeyDown('j');
      actKeyDown('j');
      actKeyDown('j'); // past the end
      expect(document.activeElement).toBe(rows[1]);
    });
  });

  describe('roving tabindex -- exactly one row is ever a Tab stop, and it tracks real focus', () => {
    it('defaults the entry point to row 0, then hands it to whichever row is actually focused', async () => {
      const a = makeFeedItem({ title: 'Row A' });
      const b = makeFeedItem({ title: 'Row B' });
      const { fn } = fetchRouter([
        { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [a, b] }) },
      ]);
      vi.stubGlobal('fetch', fn);

      current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
      await flush();
      const rows = toggles(current.container);
      expect(rows[0]!.getAttribute('tabindex')).toBe('0');
      expect(rows[1]!.getAttribute('tabindex')).toBe('-1');

      actKeyDown('j'); // moves real focus to row 0 (already the entry point)
      actKeyDown('j'); // moves real focus to row 1

      expect(rows[0]!.getAttribute('tabindex')).toBe('-1');
      expect(rows[1]!.getAttribute('tabindex')).toBe('0');
    });
  });

  describe('typing in a text field suppresses navigation keys (task brief, decision 4/DoD 3)', () => {
    it('"j" typed into the search box does not move row focus -- it is just a letter there', async () => {
      const a = makeFeedItem({ title: 'Row A' });
      const b = makeFeedItem({ title: 'Row B' });
      const { fn } = fetchRouter([
        { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [a, b] }) },
      ]);
      vi.stubGlobal('fetch', fn);

      current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
      await flush();

      const searchInput = current.container.querySelector<HTMLInputElement>('.search-box__input')!;
      act(() => searchInput.focus());
      expect(document.activeElement).toBe(searchInput);

      const event = actKeyDown('j', {}, searchInput);

      expect(document.activeElement).toBe(searchInput); // still here, not on a row
      // Nothing in this app claimed the key -- the browser is free to insert
      // the letter normally.
      expect(event.defaultPrevented).toBe(false);
    });

    it('"/" pressed while ALREADY inside the search box does not get intercepted -- a real query can contain a slash', async () => {
      const { fn } = fetchRouter([
        { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [] }) },
      ]);
      vi.stubGlobal('fetch', fn);

      current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
      await flush();

      const searchInput = current.container.querySelector<HTMLInputElement>('.search-box__input')!;
      act(() => searchInput.focus());

      const event = actKeyDown('/', {}, searchInput);
      expect(event.defaultPrevented).toBe(false);
    });
  });

  describe('"/" -- focuses search without leaking a literal slash (task brief, decision 4)', () => {
    it('moves real focus to the search input and prevents the key\'s default action', async () => {
      const { fn } = fetchRouter([
        { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [] }) },
      ]);
      vi.stubGlobal('fetch', fn);

      current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
      await flush();

      const searchInput = current.container.querySelector<HTMLInputElement>('.search-box__input')!;
      expect(document.activeElement).not.toBe(searchInput);

      // Dispatched on document.body (nothing row-specific has focus yet) --
      // mirrors a real user pressing "/" with focus resting on the page.
      const event = actKeyDown('/', {}, document.body);

      expect(document.activeElement).toBe(searchInput);
      // preventDefault is the jsdom-verifiable proxy for "no character would
      // have been inserted" -- jsdom does not itself implement the browser's
      // keydown -> character-insertion default action the way a real
      // browser does, so it cannot reproduce the leak on its own; asserting
      // the fix (preventDefault called before focus moved) is what a jsdom
      // test CAN prove.
      expect(event.defaultPrevented).toBe(true);
      expect(searchInput.value).toBe('');
    });
  });

  describe('o/s/x act on the focused row, sharing the exact functions their pointer affordances call', () => {
    it('"o" opens the focused item in a new tab and fires the same mark-read request as the Open link', async () => {
      const item = makeFeedItem({ title: 'Openable item' });
      const { fn, calls } = fetchRouter([
        { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [item] }) },
        {
          match: (url, init) => url.includes('/read') && init?.method === 'POST',
          body: { readAt: '2026-08-14T18:00:00.000Z', savedAt: null, dismissedAt: null },
        },
      ]);
      vi.stubGlobal('fetch', fn);
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
      await flush();

      actKeyDown('j'); // focus the only row
      actKeyDown('o');
      await flush();

      expect(openSpy).toHaveBeenCalledExactlyOnceWith(item.canonicalUrl, '_blank', 'noopener,noreferrer');
      const readCall = calls.find((c) => c.url.includes('/read'));
      expect(readCall).toBeDefined();

      openSpy.mockRestore();
    });

    it('"s" toggles save for the focused row through the same POST/DELETE the Save button uses', async () => {
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

      actKeyDown('j');
      actKeyDown('s');
      await flush();

      expect(calls.some((c) => c.url.includes('/save') && c.init?.method === 'POST')).toBe(true);
      expect(current.container.textContent).toContain('Saved');

      actKeyDown('s');
      await flush();

      expect(calls.some((c) => c.url.includes('/save') && c.init?.method === 'DELETE')).toBe(true);
    });

    it('"x" dismisses the focused row AND moves real focus to a neighbor row synchronously, before the fade removes it', async () => {
      vi.stubGlobal('matchMedia', () => ({
        matches: true, // reduced motion -- 0ms removal timer, deterministic
        media: '',
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
      const a = makeFeedItem({ title: 'Row A' });
      const b = makeFeedItem({ title: 'Row B' });
      const c = makeFeedItem({ title: 'Row C' });
      const { fn } = fetchRouter([
        { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [a, b, c] }) },
        {
          match: (url, init) => url.includes('/dismiss') && init?.method === 'POST',
          body: { readAt: null, savedAt: null, dismissedAt: '2026-08-14T18:00:00.000Z' },
        },
      ]);
      vi.stubGlobal('fetch', fn);

      current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
      await flush();

      actKeyDown('j');
      actKeyDown('j'); // focus row 1 (Row B)
      const rowsBefore = toggles(current.container);
      expect(document.activeElement).toBe(rowsBefore[1]);

      actKeyDown('x');

      // Synchronous check, deliberately BEFORE any flush/await: the row is
      // still in the DOM (the fade/removal is on a timer), but real focus
      // has ALREADY moved to its neighbor. A "visual only" implementation
      // has nothing that could make this assertion pass, since there is no
      // CSS class involved anywhere in it.
      const rowsAfterKeydown = toggles(current.container);
      expect(document.activeElement).toBe(rowsAfterKeydown[2]); // Row C, the neighbor

      await flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flush();

      expect(current.container.textContent).not.toContain('Row B');
      expect(current.container.textContent).toContain('Row A');
      expect(current.container.textContent).toContain('Row C');
    });

    it('o/s/x are no-ops when no row has been focused yet -- nothing fires on an unfocused list', async () => {
      const item = makeFeedItem();
      const { fn, calls } = fetchRouter([
        { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [item] }) },
      ]);
      vi.stubGlobal('fetch', fn);

      current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
      await flush();
      expect(calls).toHaveLength(1);

      actKeyDown('o');
      actKeyDown('s');
      actKeyDown('x');
      await flush();

      expect(calls).toHaveLength(1); // no /read, /save, or /dismiss request
    });
  });

  describe('"r" -- a fresh page 1, never a page-2 request against the frozen cursor (task brief, decision 2)', () => {
    it('fetches a fresh, cursor-less page rather than paginating', async () => {
      const item = makeFeedItem({ title: 'Refreshable item' });
      const { fn, calls } = fetchRouter([
        { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [item], nextCursor: 'cursor-abc' }) },
      ]);
      vi.stubGlobal('fetch', fn);

      current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
      await flush();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).not.toContain('cursor=');

      actKeyDown('r');
      await flush();

      expect(calls).toHaveLength(2);
      // Exactly a page-1-shaped request -- NOT the frozen cursor from the
      // first response, and not a `loadMore`-shaped request at all.
      expect(calls[1]!.url).toBe('/api/feed?limit=25');
      expect(calls[1]!.url).not.toContain('cursor=');
    });

    it('the same function backs the always-visible Refresh button', async () => {
      const item = makeFeedItem({ title: 'Refreshable item' });
      const { fn, calls } = fetchRouter([
        { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [item] }) },
      ]);
      vi.stubGlobal('fetch', fn);

      current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
      await flush();
      expect(calls).toHaveLength(1);

      const refreshBtn = current.container.querySelector<HTMLButtonElement>('.stream__refresh')!;
      expect(refreshBtn.classList.contains('touch-target')).toBe(true);
      actClick(refreshBtn);
      await flush();

      expect(calls).toHaveLength(2);
    });
  });

  describe('"1"-"6" -- select the corresponding beat, sharing BeatFilter\'s own onChange (task brief, decision 1)', () => {
    it('pressing "2" selects cyber (BEATS[1]), issuing the same request clicking the Cyber chip would', async () => {
      const alpha = makeFeedItem({ title: 'Alpha item', beats: ['ai'], representativeBeat: 'ai' });
      const bravo = makeFeedItem({ title: 'Bravo item', beats: ['cyber'], representativeBeat: 'cyber' });
      const { fn, calls } = fetchRouter([
        {
          match: (url) => url.startsWith('/api/feed') && !url.includes('beat='),
          body: makeFeedResponse({ items: [alpha] }),
        },
        {
          match: (url) => url.includes('beat=cyber'),
          body: makeFeedResponse({ items: [bravo], beat: 'cyber' }),
        },
      ]);
      vi.stubGlobal('fetch', fn);

      current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
      await flush();
      expect(current.container.textContent).toContain('Alpha item');

      actKeyDown('2');
      await flush();

      expect(calls).toHaveLength(2);
      expect(calls[1]!.url).toContain('beat=cyber');
      expect(current.container.textContent).toContain('Bravo item');
      expect(current.container.textContent).not.toContain('Alpha item');
    });
  });

  describe('modifier-held keys pass through untouched', () => {
    it('Cmd+R does not also trigger this app\'s refresh', async () => {
      const item = makeFeedItem();
      const { fn, calls } = fetchRouter([
        { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [item] }) },
      ]);
      vi.stubGlobal('fetch', fn);

      current = mount(<Stream token={TOKEN} onUnauthorized={() => {}} />);
      await flush();
      expect(calls).toHaveLength(1);

      actKeyDown('r', { metaKey: true });
      await flush();

      expect(calls).toHaveLength(1); // unchanged
    });
  });
});
