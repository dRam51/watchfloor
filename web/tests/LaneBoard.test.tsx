// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LaneBoard } from '../src/components/LaneBoard.tsx';
import {
  actClick,
  actKeyDown,
  fetchRouter,
  flush,
  makeFeedItem,
  makeFeedResponse,
  mount,
  type FetchCall,
  type Mounted,
  type RouteHandler,
} from './testUtils.tsx';

let current: Mounted | null = null;
afterEach(() => {
  current?.unmount();
  current = null;
  vi.unstubAllGlobals();
});

const TOKEN = 'test-token';
const ALL_BEATS = ['ai', 'cyber', 'aisec', 'repos', 'markets', 'usnews'] as const;
const BEAT_LABELS: Record<string, string> = {
  ai: 'AI',
  cyber: 'Cyber',
  aisec: 'AI Security',
  repos: 'Repos',
  markets: 'Markets',
  usnews: 'US News',
};

function layoutBody(order: readonly string[] = ALL_BEATS, collapsed: readonly string[] = []) {
  return { lanes: order.map((beat) => ({ beat, collapsed: collapsed.includes(beat) })) };
}

/** A feed handler for every beat not otherwise overridden -- keeps each
 * test's handler list short by only spelling out the beats it actually
 * cares about. */
function emptyFeedForEveryBeat(): RouteHandler {
  return { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items: [] }) };
}

/**
 * Matches the `beat` QUERY PARAMETER exactly (via URLSearchParams, not
 * `url.includes('beat=' + beat)`) -- a plain substring check would have
 * `beat=ai` also match `beat=aisec`, since "aisec" starts with "ai". That
 * collision is real and was caught by this suite once already: it silently
 * fed the AI Security lane the AI lane's fixture, which then made a
 * text-content-based lane lookup ambiguous too (see `findLaneByLabel` below
 * for the fix on that side).
 */
function feedForBeat(beat: string, items: ReturnType<typeof makeFeedItem>[]): RouteHandler {
  return {
    match: (url) => {
      if (!url.startsWith('/api/feed')) return false;
      const query = new URLSearchParams(url.split('?')[1] ?? '');
      return query.get('beat') === beat;
    },
    body: makeFeedResponse({ items, beat: beat as never }),
  };
}

function laneLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.lane__label')).map((el) => el.textContent ?? '');
}

/**
 * Finds a lane by its EXACT `.lane__label` text, not a substring match
 * against the whole lane's `textContent` -- a row's own expanded detail
 * panel can legitimately contain another beat's name (e.g. a cross-listed
 * item's "Beats: AI, Cyber" fact), and "AI Security"/"AI" both contain
 * "AI", so anything looser than an exact label match is fragile by
 * construction, not just in the one case that surfaced it.
 */
function findLaneByLabel(container: HTMLElement, beat: (typeof ALL_BEATS)[number]): HTMLElement {
  const label = BEAT_LABELS[beat];
  const lane = Array.from(container.querySelectorAll<HTMLElement>('.lane')).find(
    (l) => l.querySelector('.lane__label')?.textContent === label,
  );
  if (!lane) throw new Error(`no lane found with label "${label}"`);
  return lane;
}

async function mountBoard(handlers: RouteHandler[]): Promise<{ calls: FetchCall[] }> {
  const { fn, calls } = fetchRouter(handlers);
  vi.stubGlobal('fetch', fn);
  current = mount(<LaneBoard token={TOKEN} onUnauthorized={() => {}} />);
  await flush();
  await flush(); // one extra cycle: layout GET -> six lanes mount -> six feed GETs
  return { calls };
}

describe('LaneBoard -- loads server-side order and collapse (§7.1: no browser storage)', () => {
  it('renders exactly six lanes, in the order the server returned', async () => {
    const shuffled = ['usnews', 'ai', 'markets', 'cyber', 'repos', 'aisec'];
    await mountBoard([
      { match: (url) => url.startsWith('/api/dashboard/layout'), body: layoutBody(shuffled) },
      emptyFeedForEveryBeat(),
    ]);

    const labels = laneLabels(current!.container);
    expect(labels).toEqual(['US News', 'AI', 'Markets', 'Cyber', 'Repos', 'AI Security']);
  });

  it('a lane marked collapsed by the server renders collapsed, with no local override', async () => {
    await mountBoard([
      { match: (url) => url.startsWith('/api/dashboard/layout'), body: layoutBody(ALL_BEATS, ['usnews']) },
      emptyFeedForEveryBeat(),
    ]);

    const usnewsLane = findLaneByLabel(current!.container, 'usnews');
    expect(usnewsLane.classList.contains('lane--collapsed')).toBe(true);
    expect(usnewsLane.querySelector('.lane__body')).toBeNull();
  });

  it('repos and markets render legitimately empty -- no crash, no error styling, before M4a/M4b add sources', async () => {
    await mountBoard([
      { match: (url) => url.startsWith('/api/dashboard/layout'), body: layoutBody() },
      emptyFeedForEveryBeat(),
    ]);

    const repos = findLaneByLabel(current!.container, 'repos');
    const markets = findLaneByLabel(current!.container, 'markets');
    expect(repos.textContent).toContain('Nothing here yet.');
    expect(markets.textContent).toContain('Nothing here yet.');
    expect(repos.querySelector('.lane__status--error')).toBeNull();
    expect(markets.querySelector('.lane__status--error')).toBeNull();
  });
});

describe('LaneBoard -- collapse toggle persists as a FULL replace, server order preserved', () => {
  it('sends all six lanes with only the clicked one flipped, in the same order', async () => {
    let putBody: unknown = null;
    const { calls } = await mountBoard([
      {
        match: (url, init) => url.startsWith('/api/dashboard/layout') && (init?.method ?? 'GET') === 'GET',
        body: layoutBody(),
      },
      emptyFeedForEveryBeat(),
    ]);

    // Add the PUT handler now that the initial GET-only router above has done its job.
    const putFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.startsWith('/api/dashboard/layout') && init?.method === 'PUT') {
        putBody = JSON.parse(String(init.body));
        return { ok: true, status: 200, json: async () => putBody };
      }
      if (url.startsWith('/api/dashboard/layout')) {
        return { ok: true, status: 200, json: async () => layoutBody() };
      }
      return { ok: true, status: 200, json: async () => makeFeedResponse({ items: [] }) };
    });
    vi.stubGlobal('fetch', putFn);

    const usnewsToggle = findLaneByLabel(current!.container, 'usnews').querySelector<HTMLButtonElement>(
      '.lane__collapse-toggle',
    )!;

    actClick(usnewsToggle);
    await flush();

    expect(putBody).toEqual({
      lanes: ALL_BEATS.map((beat) => ({ beat, collapsed: beat === 'usnews' })),
    });
  });

  it('reconciles by re-fetching the server layout when the PUT fails, rather than trusting the optimistic flip', async () => {
    const { calls } = await mountBoard([
      { match: (url, init) => url.startsWith('/api/dashboard/layout') && (init?.method ?? 'GET') === 'GET', body: layoutBody() },
      emptyFeedForEveryBeat(),
    ]);

    let getCount = 0;
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.startsWith('/api/dashboard/layout') && init?.method === 'PUT') {
        return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      }
      if (url.startsWith('/api/dashboard/layout')) {
        getCount += 1;
        return { ok: true, status: 200, json: async () => layoutBody() }; // server's real (unflipped) truth
      }
      return { ok: true, status: 200, json: async () => makeFeedResponse({ items: [] }) };
    });
    vi.stubGlobal('fetch', fn);

    const cyberToggle = findLaneByLabel(current!.container, 'cyber').querySelector<HTMLButtonElement>(
      '.lane__collapse-toggle',
    )!;

    actClick(cyberToggle);
    await flush();
    await flush();

    expect(getCount).toBeGreaterThan(0); // reconciled with a fresh GET after the failed PUT
    const cyberLaneAfter = findLaneByLabel(current!.container, 'cyber');
    expect(cyberLaneAfter.classList.contains('lane--collapsed')).toBe(false); // back to server truth
  });
});

describe('LaneBoard -- ONE keyboard coordinator, not six (the hard problem, task brief)', () => {
  it('"j" moves focus WITHIN the focused lane only -- a sibling lane\'s rows are untouched', async () => {
    const aiA = makeFeedItem({ title: 'AI Row A', beats: ['ai'], representativeBeat: 'ai' });
    const aiB = makeFeedItem({ title: 'AI Row B', beats: ['ai'], representativeBeat: 'ai' });
    const cyberA = makeFeedItem({ title: 'Cyber Row A', beats: ['cyber'], representativeBeat: 'cyber' });

    await mountBoard([
      { match: (url) => url.startsWith('/api/dashboard/layout'), body: layoutBody() },
      feedForBeat('ai', [aiA, aiB]),
      feedForBeat('cyber', [cyberA]),
      emptyFeedForEveryBeat(),
    ]);

    const aiRows = findLaneByLabel(current!.container, 'ai').querySelectorAll<HTMLButtonElement>('.item-row__toggle');
    const cyberRows = findLaneByLabel(current!.container, 'cyber').querySelectorAll<HTMLButtonElement>('.item-row__toggle');

    act(() => aiRows[0]!.focus());
    expect(document.activeElement).toBe(aiRows[0]);

    actKeyDown('j');

    expect(document.activeElement).toBe(aiRows[1]); // moved within the AI lane
    expect(document.activeElement).not.toBe(cyberRows[0]); // cyber lane untouched
    expect(cyberRows[0]!.getAttribute('tabindex')).not.toBe('0'); // no phantom focus painted there
  });

  it('a single "j" press with nothing focused calls .focus() EXACTLY ONCE across the whole board -- the test that would fail if six lanes each ran their own entry logic', async () => {
    const aiA = makeFeedItem({ title: 'AI Row A', beats: ['ai'], representativeBeat: 'ai' });
    const cyberA = makeFeedItem({ title: 'Cyber Row A', beats: ['cyber'], representativeBeat: 'cyber' });

    await mountBoard([
      { match: (url) => url.startsWith('/api/dashboard/layout'), body: layoutBody() },
      feedForBeat('ai', [aiA]),
      feedForBeat('cyber', [cyberA]),
      emptyFeedForEveryBeat(),
    ]);

    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    focusSpy.mockClear();

    actKeyDown('j');

    // A naive "each Lane owns its own entry-on-first-j logic" bug would have
    // EVERY lane with items call .focus() on its own row 0 in response to
    // one keydown -- jsdom's document.activeElement would still only show
    // the LAST one, hiding the bug from an activeElement-only assertion.
    // Counting the actual .focus() calls is what catches it.
    expect(focusSpy).toHaveBeenCalledTimes(1);
    focusSpy.mockRestore();
  });

  it('exactly one row across the entire board has tabIndex 0 while nothing is focused', async () => {
    const aiA = makeFeedItem({ title: 'AI Row A', beats: ['ai'], representativeBeat: 'ai' });
    const cyberA = makeFeedItem({ title: 'Cyber Row A', beats: ['cyber'], representativeBeat: 'cyber' });

    await mountBoard([
      { match: (url) => url.startsWith('/api/dashboard/layout'), body: layoutBody() },
      feedForBeat('ai', [aiA]),
      feedForBeat('cyber', [cyberA]),
      emptyFeedForEveryBeat(),
    ]);

    const allToggles = current!.container.querySelectorAll<HTMLButtonElement>('.item-row__toggle');
    const zeroTabIndexCount = Array.from(allToggles).filter((el) => el.getAttribute('tabindex') === '0').length;
    expect(zeroTabIndexCount).toBe(1);
  });

  it('a cross-listed item present in TWO lanes only lights up the lane that actually received DOM focus', async () => {
    // Same itemKey deliberately reused across both beats' responses -- an
    // item cross-listed into two beats is unioned by the same item_key
    // (CLAUDE.md), so it can legitimately appear in two lanes' lists at once.
    const shared = makeFeedItem({ title: 'Cross-listed item', beats: ['ai', 'cyber'], representativeBeat: 'ai' });
    const sameKeyInCyber = { ...shared, representativeBeat: 'cyber' as const };

    await mountBoard([
      { match: (url) => url.startsWith('/api/dashboard/layout'), body: layoutBody() },
      feedForBeat('ai', [shared]),
      feedForBeat('cyber', [sameKeyInCyber]),
      emptyFeedForEveryBeat(),
    ]);

    const aiLane = findLaneByLabel(current!.container, 'ai');
    const cyberLane = findLaneByLabel(current!.container, 'cyber');
    const aiRow = aiLane.querySelector<HTMLButtonElement>('.item-row__toggle')!;

    act(() => aiRow.focus());

    const aiRowLi = aiLane.querySelector('li.item-row')!;
    const cyberRowLi = cyberLane.querySelector('li.item-row')!;
    expect(aiRowLi.classList.contains('item-row--focused')).toBe(true);
    // The bug this proves absent: BOTH lanes painting `focused` for the
    // same itemKey, because the coordinator's record was keyed on itemKey
    // alone rather than (beat, itemKey).
    expect(cyberRowLi.classList.contains('item-row--focused')).toBe(false);
  });

  it('"1"-"6" jumps focus into the corresponding lane\'s first row', async () => {
    const cyberA = makeFeedItem({ title: 'Cyber Row A', beats: ['cyber'], representativeBeat: 'cyber' });
    await mountBoard([
      { match: (url) => url.startsWith('/api/dashboard/layout'), body: layoutBody() },
      feedForBeat('cyber', [cyberA]),
      emptyFeedForEveryBeat(),
    ]);

    actKeyDown('2'); // BEATS[1] === 'cyber'

    const cyberRow = findLaneByLabel(current!.container, 'cyber').querySelector<HTMLButtonElement>('.item-row__toggle')!;
    expect(document.activeElement).toBe(cyberRow);
  });

  it('"1"-"6" on a COLLAPSED lane focuses its collapse toggle instead of doing nothing', async () => {
    await mountBoard([
      { match: (url) => url.startsWith('/api/dashboard/layout'), body: layoutBody(ALL_BEATS, ['cyber']) },
      emptyFeedForEveryBeat(),
    ]);

    actKeyDown('2'); // cyber, collapsed

    const toggle = findLaneByLabel(current!.container, 'cyber').querySelector<HTMLButtonElement>('.lane__collapse-toggle')!;
    expect(document.activeElement).toBe(toggle);
  });

  it('"o"/"s"/"x" act on the focused item in its own lane only', async () => {
    const aiItem = makeFeedItem({ title: 'AI Item', beats: ['ai'], representativeBeat: 'ai' });
    const { calls } = await mountBoard([
      { match: (url) => url.startsWith('/api/dashboard/layout'), body: layoutBody() },
      feedForBeat('ai', [aiItem]),
      { match: (url, init) => url.includes('/save') && init?.method === 'POST', body: { readAt: null, savedAt: '2026-08-14T18:00:00.000Z', dismissedAt: null } },
      emptyFeedForEveryBeat(),
    ]);

    const aiRow = findLaneByLabel(current!.container, 'ai').querySelector<HTMLButtonElement>('.item-row__toggle')!;
    act(() => aiRow.focus());

    actKeyDown('s');
    await flush();

    const saveCall = calls.find((c) => c.url.includes('/save') && c.init?.method === 'POST');
    expect(saveCall).toBeDefined();
    expect(saveCall!.url).toContain(aiItem.itemKey);
  });

  it('"r" refreshes every lane -- six fresh page-1 requests, not a page 2', async () => {
    const { calls } = await mountBoard([
      { match: (url) => url.startsWith('/api/dashboard/layout'), body: layoutBody() },
      emptyFeedForEveryBeat(),
    ]);

    const feedCallsBefore = calls.filter((c) => c.url.startsWith('/api/feed')).length;
    expect(feedCallsBefore).toBe(6);

    actKeyDown('r');
    await flush();

    const feedCallsAfter = calls.filter((c) => c.url.startsWith('/api/feed'));
    expect(feedCallsAfter.length).toBe(12);
    expect(feedCallsAfter.every((c) => !c.url.includes('cursor='))).toBe(true);
  });

  it('"/" focuses the search box and prevents the key\'s default action', async () => {
    await mountBoard([
      { match: (url) => url.startsWith('/api/dashboard/layout'), body: layoutBody() },
      emptyFeedForEveryBeat(),
    ]);

    const searchInput = current!.container.querySelector<HTMLInputElement>('.search-box__input')!;
    expect(document.activeElement).not.toBe(searchInput);

    const event = actKeyDown('/', {}, document.body);

    expect(document.activeElement).toBe(searchInput);
    expect(event.defaultPrevented).toBe(true);
  });
});
