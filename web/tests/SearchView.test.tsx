// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchView } from '../src/components/SearchView.tsx';
import { actClick, actKeyDown, fetchRouter, flush, mount, typeInto, type Mounted } from './testUtils.tsx';

let current: Mounted | null = null;
afterEach(() => {
  current?.unmount();
  current = null;
});

const TOKEN = 'test-token';

function getInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('.search-box__input')!;
}

/** typeInto (testUtils.tsx) deliberately does not wrap in act() itself --
 * every OTHER caller in this suite type is expected to, same as
 * App.test.tsx's own token-entry test does. Wrapped here once so every
 * "type a query then submit" call site below doesn't repeat it. */
function typeQuery(container: HTMLElement, value: string): void {
  act(() => {
    typeInto(getInput(container), value);
  });
}

function submit(container: HTMLElement): void {
  const form = container.querySelector('form.search-view__bar')!;
  actClick(form.querySelector('.search-view__submit')!);
}

describe('SearchView -- indexing limits are stated, not left to be discovered', () => {
  it('shows the "titles and ~300-character excerpts" caveat before any query is typed', async () => {
    current = mount(<SearchView token={TOKEN} onUnauthorized={() => {}} />);
    expect(current.container.textContent).toContain('~300 characters');
    expect(current.container.textContent).toContain('never the full article');
  });
});

describe('SearchView -- unsearchable vs. zero hits are rendered differently', () => {
  it('a whitespace-only query renders the "nothing searchable" message, not a generic empty-results one', async () => {
    const { fn, calls } = fetchRouter([
      {
        match: (url) => url.startsWith('/api/search'),
        body: { query: '   ', unsearchable: true, hits: [] },
      },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SearchView token={TOKEN} onUnauthorized={() => {}} />);
    typeQuery(current.container, '   ');
    submit(current.container);
    await flush();

    expect(calls).toHaveLength(1);
    expect(current.container.textContent).toContain('nothing searchable');
    expect(current.container.textContent).not.toContain('No matches for');
  });

  it('a real query that matches nothing renders the "no matches" message, distinct from unsearchable', async () => {
    const { fn } = fetchRouter([
      {
        match: (url) => url.startsWith('/api/search'),
        body: { query: 'zzyzx', unsearchable: false, hits: [] },
      },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SearchView token={TOKEN} onUnauthorized={() => {}} />);
    typeQuery(current.container, 'zzyzx');
    submit(current.container);
    await flush();

    expect(current.container.textContent).toContain('No matches for');
    expect(current.container.textContent).not.toContain('nothing searchable');
  });

  it('an operator-shaped query like "AND" is sent and treated as a real search, not specially blocked client-side', async () => {
    const { fn, calls } = fetchRouter([
      {
        match: (url) => url.startsWith('/api/search'),
        body: {
          query: 'AND',
          unsearchable: false,
          hits: [
            {
              itemKey: 'a'.repeat(64),
              title: 'A title with AND in it',
              sourceId: 'fixture',
              canonicalUrl: 'https://example.test/a',
              publishedAt: '2026-08-14T00:00:00.000Z',
              itemType: 'analysis',
              snippet: 'A title with [AND] in it',
              rank: -1.2,
            },
          ],
        },
      },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SearchView token={TOKEN} onUnauthorized={() => {}} />);
    typeQuery(current.container, 'AND');
    submit(current.container);
    await flush();

    expect(calls[0]!.url).toContain('q=AND');
    expect(current.container.textContent).toContain('A title with AND in it');
  });
});

describe('SearchView -- snippet rendering', () => {
  it('renders the [bracketed] match as a <mark> element, never as literal brackets or via innerHTML', async () => {
    const { fn } = fetchRouter([
      {
        match: (url) => url.startsWith('/api/search'),
        body: {
          query: 'AI',
          unsearchable: false,
          hits: [
            {
              itemKey: 'b'.repeat(64),
              title: 'Import AI 457',
              sourceId: 'import-ai',
              canonicalUrl: 'https://example.test/b',
              publishedAt: '2026-08-14T00:00:00.000Z',
              itemType: 'analysis',
              snippet: 'Import [AI] 457: [AI] stuxnet',
              rank: -2.6,
            },
          ],
        },
      },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SearchView token={TOKEN} onUnauthorized={() => {}} />);
    typeQuery(current.container, 'AI');
    submit(current.container);
    await flush();

    const marks = current.container.querySelectorAll('mark.search-view__match');
    expect(marks).toHaveLength(2);
    marks.forEach((mark) => expect(mark.textContent).toBe('AI'));

    // The raw bracket characters must never appear in the rendered text --
    // proof the markers were parsed into emphasis, not printed verbatim.
    const snippetEl = current.container.querySelector('.search-view__snippet')!;
    expect(snippetEl.textContent).not.toContain('[');
    expect(snippetEl.textContent).not.toContain(']');
    expect(snippetEl.textContent).toBe('Import AI 457: AI stuxnet');
  });

  it('never uses innerHTML to render a snippet -- proof the DOM subtree has no injected markup', async () => {
    const { fn } = fetchRouter([
      {
        match: (url) => url.startsWith('/api/search'),
        body: {
          query: 'script',
          unsearchable: false,
          hits: [
            {
              itemKey: 'c'.repeat(64),
              title: 'Suspicious title',
              sourceId: 'fixture',
              canonicalUrl: 'https://example.test/c',
              publishedAt: null,
              itemType: 'analysis',
              // If this were ever piped through innerHTML, this would
              // become a real, executing <img> element with a broken src
              // (onerror fires). Rendered via DOM nodes, it is inert text.
              snippet: '<img src=x onerror=alert(1)> [script] tag attempt',
              rank: -1.0,
            },
          ],
        },
      },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SearchView token={TOKEN} onUnauthorized={() => {}} />);
    typeQuery(current.container, 'script');
    submit(current.container);
    await flush();

    expect(current.container.querySelector('img')).toBeNull();
    expect(current.container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('SearchView -- results are rendered in server order, never re-sorted', () => {
  it('preserves hit order exactly as the API returned it', async () => {
    const { fn } = fetchRouter([
      {
        match: (url) => url.startsWith('/api/search'),
        body: {
          query: 'x',
          unsearchable: false,
          hits: [
            {
              itemKey: 'd'.repeat(64),
              title: 'Best match',
              sourceId: 'fixture',
              canonicalUrl: 'https://example.test/d',
              publishedAt: null,
              itemType: 'analysis',
              snippet: '[x] best',
              rank: -5.0,
            },
            {
              itemKey: 'e'.repeat(64),
              title: 'Weaker match',
              sourceId: 'fixture',
              canonicalUrl: 'https://example.test/e',
              publishedAt: null,
              itemType: 'analysis',
              snippet: '[x] weaker',
              rank: -0.1,
            },
          ],
        },
      },
    ]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SearchView token={TOKEN} onUnauthorized={() => {}} />);
    typeQuery(current.container, 'x');
    submit(current.container);
    await flush();

    const titles = Array.from(current.container.querySelectorAll('.search-view__result-title')).map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(['Best match', 'Weaker match']);

    // The raw bm25 rank must never be printed as if a bigger number were
    // better -- this component does not surface it at all.
    expect(current.container.textContent).not.toContain('-5');
    expect(current.container.textContent).not.toContain('-0.1');
  });
});

describe('SearchView -- query lifecycle', () => {
  it('does not fire a request for an empty query -- Search with nothing typed is a no-op, not a 400', async () => {
    const { fn } = fetchRouter([{ match: () => true, body: {} }]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SearchView token={TOKEN} onUnauthorized={() => {}} />);
    submit(current.container);
    await flush();

    expect(fn).not.toHaveBeenCalled();
  });

  it('shows a loading state between submit and the response landing', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    const fn = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fn);

    current = mount(<SearchView token={TOKEN} onUnauthorized={() => {}} />);
    typeQuery(current.container, 'pending');
    submit(current.container);
    await flush();

    expect(current.container.textContent).toContain('Searching');

    resolveFetch({ ok: true, status: 200, json: async () => ({ query: 'pending', unsearchable: false, hits: [] }) });
    await flush();
    expect(current.container.textContent).toContain('No matches for');
  });

  it('treats a 401 as an auth failure and calls onUnauthorized', async () => {
    const onUnauthorized = vi.fn();
    const { fn } = fetchRouter([{ match: (url) => url.startsWith('/api/search'), status: 401, body: {} }]);
    vi.stubGlobal('fetch', fn);

    current = mount(<SearchView token={TOKEN} onUnauthorized={onUnauthorized} />);
    typeQuery(current.container, 'anything');
    submit(current.container);
    await flush();

    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});

describe('SearchView -- focus and close affordances', () => {
  it('autofocuses the search input on mount -- "/" opening this view should land ready to type', () => {
    current = mount(<SearchView token={TOKEN} onUnauthorized={() => {}} />);
    expect(document.activeElement).toBe(getInput(current.container));
  });

  it('renders a visible, tappable Close button when onClose is supplied, and calls it on click', () => {
    const onClose = vi.fn();
    current = mount(<SearchView token={TOKEN} onUnauthorized={() => {}} onClose={onClose} />);
    const closeBtn = current.container.querySelector<HTMLButtonElement>('.search-view__close')!;
    expect(closeBtn).not.toBeNull();
    expect(closeBtn.classList.contains('touch-target')).toBe(true);

    actClick(closeBtn);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('omits the Close button entirely when onClose is not supplied, rather than rendering a dead one', () => {
    current = mount(<SearchView token={TOKEN} onUnauthorized={() => {}} />);
    expect(current.container.querySelector('.search-view__close')).toBeNull();
  });

  it('calls onClose on Escape from the search input too', () => {
    const onClose = vi.fn();
    current = mount(<SearchView token={TOKEN} onUnauthorized={() => {}} onClose={onClose} />);
    const input = getInput(current.container);

    actKeyDown('Escape', {}, input);

    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('SearchView -- the visible Search button is a real touch equivalent for Enter', () => {
  it('is at least a 44px touch target', () => {
    current = mount(<SearchView token={TOKEN} onUnauthorized={() => {}} />);
    const submitBtn = current.container.querySelector<HTMLButtonElement>('.search-view__submit')!;
    expect(submitBtn.classList.contains('touch-target')).toBe(true);
  });
});
