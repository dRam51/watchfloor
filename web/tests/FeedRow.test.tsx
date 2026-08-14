// @vitest-environment jsdom
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedRow } from '../src/components/FeedRow.tsx';
import { Lane, type LaneHandle } from '../src/components/Lane.tsx';
import { Stream } from '../src/components/Stream.tsx';
import type { Beat } from '../src/api/types.ts';
import {
  actKeyDown,
  fetchRouter,
  flush,
  makeFeedItem,
  makeFeedResponse,
  makeRepo,
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
const noop = () => {};

// ---------------------------------------------------------------------------
// The dispatcher itself
// ---------------------------------------------------------------------------

describe('FeedRow -- selects on the PAYLOAD, not on the lane', () => {
  function render(item: Parameters<typeof makeFeedItem>[0] = {}) {
    current = mount(
      <FeedRow
        item={makeFeedItem(item)}
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

  it('an item with a repo payload gets the repo row', () => {
    const container = render({ repo: makeRepo({ fullName: 'openai/whisper' }) });
    expect(container.querySelector('li.repo-row')).not.toBeNull();
    expect(container.textContent).toContain('openai/whisper');
  });

  it('an item with NO repo payload gets the news row, even in the repos beat', () => {
    // This is the state the whole lane is in today: task 7 owns the feed
    // response and has not landed the field yet. Degrading to a row that says
    // less is honest; drawing repo furniture around absent data is not.
    const container = render({ representativeBeat: 'repos', beats: ['repos'], title: 'Some repos-beat item' });
    expect(container.querySelector('li.repo-row')).toBeNull();
    expect(container.querySelector('li.item-row')).not.toBeNull();
    expect(container.textContent).toContain('Some repos-beat item');
  });

  it('an explicit null repo is treated as absent, not as an empty repo', () => {
    const container = render({ representativeBeat: 'repos', beats: ['repos'], repo: null });
    expect(container.querySelector('li.repo-row')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inside the lane container
// ---------------------------------------------------------------------------

function laneWith(items: ReturnType<typeof makeFeedItem>[], beat: Beat = 'repos', ref = createRef<LaneHandle>()) {
  const { fn, calls } = fetchRouter([
    { match: (url) => url.startsWith('/api/feed'), body: makeFeedResponse({ items, beat }) },
    { match: (url) => url.startsWith('/api/items/'), body: {} },
  ]);
  vi.stubGlobal('fetch', fn);
  current = mount(
    <Lane
      ref={ref}
      beat={beat}
      collapsed={false}
      onToggleCollapse={noop}
      token={TOKEN}
      onUnauthorized={noop}
      focusedItemKey={null}
      onItemFocus={noop}
      onItemCountChange={noop}
      isDefaultEntry={false}
    />,
  );
  return { ref, calls };
}

describe('Lane -- repo rows live in the SAME lane container as news rows', () => {
  it('renders repo rows inside the ordinary lane list, with no second list', async () => {
    laneWith([
      makeFeedItem({ repo: makeRepo({ fullName: 'langchain-ai/langgraph' }) }),
      makeFeedItem({ repo: makeRepo({ fullName: 'ggerganov/llama.cpp' }) }),
    ]);
    await flush();

    const lists = current!.container.querySelectorAll('.lane__list');
    expect(lists).toHaveLength(1);
    expect(lists[0]!.querySelectorAll('li.repo-row')).toHaveLength(2);
    expect(current!.container.textContent).toContain('langchain-ai/langgraph');
  });

  it('a MIXED lane renders each row in its own shape, in one list, in server order', async () => {
    laneWith([
      makeFeedItem({ repo: makeRepo({ fullName: 'openai/whisper' }) }),
      makeFeedItem({ title: 'A plain news item' }),
    ]);
    await flush();

    const rows = Array.from(current!.container.querySelectorAll('.lane__list > li'));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.classList.contains('repo-row')).toBe(true);
    expect(rows[1]!.classList.contains('repo-row')).toBe(false);
    expect(rows[1]!.textContent).toContain('A plain news item');
  });

  it('the lane still reports an empty repos lane as empty, not as a broken repo row', async () => {
    laneWith([]);
    await flush();
    expect(current!.container.textContent).toContain('Nothing here yet.');
  });
});

describe('Lane -- keyboard, save and dismiss work on repo rows exactly as on news rows', () => {
  it('focusRowAt moves REAL DOM focus onto a repo row\'s toggle', async () => {
    const { ref } = laneWith([
      makeFeedItem({ repo: makeRepo({ fullName: 'a/one' }) }),
      makeFeedItem({ repo: makeRepo({ fullName: 'b/two' }) }),
    ]);
    await flush();

    ref.current!.focusRowAt(1);
    const toggles = current!.container.querySelectorAll('.item-row__toggle');
    expect(document.activeElement).toBe(toggles[1]);
    // The lane's rowRefs are wired through RepoRow's toggleRef -- if they were
    // not, focusRowAt would silently no-op and this would be document.body.
    expect(document.activeElement).not.toBe(document.body);
  });

  it('indexOfItemKey finds a repo row, so j/k and o/s/x can act on it', async () => {
    const first = makeFeedItem({ repo: makeRepo({ fullName: 'a/one' }) });
    const { ref } = laneWith([first, makeFeedItem({ repo: makeRepo({ fullName: 'b/two' }) })]);
    await flush();
    expect(ref.current!.indexOfItemKey(first.itemKey)).toBe(0);
    expect(ref.current!.itemCount).toBe(2);
  });

  it('dismissAt removes a repo row, with no un-dismiss offered anywhere', async () => {
    const first = makeFeedItem({ repo: makeRepo({ fullName: 'a/one' }) });
    const { ref } = laneWith([first, makeFeedItem({ repo: makeRepo({ fullName: 'b/two' }) })]);
    await flush();

    expect(current!.container.querySelectorAll('li.repo-row')).toHaveLength(2);
    ref.current!.dismissAt(0);
    await flush();
    expect(current!.container.querySelector('li.repo-row')!.classList.contains('item-row--dismissing')).toBe(true);
    expect(current!.container.textContent!.toLowerCase()).not.toContain('undo');
  });

  it('toggleSaveAt flips a repo row\'s save state through the same route a news row uses', async () => {
    const first = makeFeedItem({ repo: makeRepo({ fullName: 'a/one' }) });
    const { ref, calls } = laneWith([first]);
    await flush();

    ref.current!.toggleSaveAt(0);
    await flush();
    const saveCall = calls.find((c) => c.url.includes('/save'));
    expect(saveCall).toBeDefined();
    expect(saveCall!.url).toContain(first.itemKey);
  });
});

// ---------------------------------------------------------------------------
// Cross-listing -- the invariant M3 built the {beat, itemKey} focus record for
// ---------------------------------------------------------------------------

describe('FeedRow -- a cross-listed repo renders as a repo in EVERY lane it appears in', () => {
  it('the same item, same itemKey, renders identically in the ai lane and the repos lane', async () => {
    // CLAUDE.md: "Beats belong to the item -- unioned across every version
    // sharing an item_key." Selecting the row shape on `beat === 'repos'`
    // would render this one item as a repo in one lane and as a news story in
    // the other -- two different claims about one thing.
    const crossListed = makeFeedItem({
      beats: ['ai', 'repos'],
      representativeBeat: 'repos',
      repo: makeRepo({ fullName: 'cross/listed' }),
    });

    laneWith([crossListed], 'repos');
    await flush();
    const inRepos = current!.container.querySelector('li.repo-row');
    expect(inRepos).not.toBeNull();
    const reposName = current!.container.querySelector('.repo-row__name')!.textContent;
    current!.unmount();
    current = null;

    laneWith([crossListed], 'ai');
    await flush();
    expect(current!.container.querySelector('li.repo-row')).not.toBeNull();
    expect(current!.container.querySelector('.repo-row__name')!.textContent).toBe(reposName);
  });
});

// ---------------------------------------------------------------------------
// The phone view -- §7's "legible on a phone browser" half
// ---------------------------------------------------------------------------

describe('Stream -- the narrow-viewport merged view renders repo rows too', () => {
  it('a repo item in the merged stream is a repo row, not a news row', async () => {
    const { fn } = fetchRouter([
      {
        match: (url) => url.startsWith('/api/feed'),
        body: makeFeedResponse({ items: [makeFeedItem({ repo: makeRepo({ fullName: 'phone/visible' }) })] }),
      },
    ]);
    vi.stubGlobal('fetch', fn);
    current = mount(<Stream token={TOKEN} onUnauthorized={noop} />);
    await flush();

    expect(current.container.querySelector('li.repo-row')).not.toBeNull();
    expect(current.container.textContent).toContain('phone/visible');
  });

  it('j moves focus onto a repo row in the merged stream', async () => {
    const { fn } = fetchRouter([
      {
        match: (url) => url.startsWith('/api/feed'),
        body: makeFeedResponse({
          items: [
            makeFeedItem({ repo: makeRepo({ fullName: 'a/one' }) }),
            makeFeedItem({ repo: makeRepo({ fullName: 'b/two' }) }),
          ],
        }),
      },
    ]);
    vi.stubGlobal('fetch', fn);
    current = mount(<Stream token={TOKEN} onUnauthorized={noop} />);
    await flush();

    actKeyDown('j');
    const toggles = current.container.querySelectorAll('.item-row__toggle');
    expect(document.activeElement).toBe(toggles[0]);
  });
});
