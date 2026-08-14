import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { fetchSearch, type SearchHit } from '../api/search.ts';
import { parseSnippet } from '../lib/snippet.ts';
import { relativeTime } from '../lib/relativeTime.ts';
import { SearchBox } from './SearchBox.tsx';
import './SearchView.css';

/**
 * The real search UI (M3 task 11, Wave 4). Task 9 built `SearchBox` as an
 * inert focus target; this component is what actually queries `GET
 * /api/search` and renders results -- built on top of `SearchBox`'s
 * `value`/`onChange`/`onEscape` extension points (this task's own addition
 * to that file) rather than duplicating an input element.
 *
 * STANDALONE ON PURPOSE: this file does not import or edit `App.tsx` or
 * `Stream.tsx` (Wave 4 concurrency note -- both are owned by the sibling
 * building the six-lane layout). It is exported ready to mount; see this
 * task's report for the exact recipe (view-switch state, the `/`
 * keybinding, a nav affordance to reach it) the coordinator or sibling
 * applies centrally, the same way Wave 2's routes were wired centrally.
 *
 * SUBMIT IS EXPLICIT, NOT LIVE-AS-YOU-TYPE: a plain `<form onSubmit>` (Enter
 * key, or the visible Search button -- §7.1 requires the button anyway,
 * since Enter has no touch equivalent otherwise) rather than a debounced
 * fetch on every keystroke. That matches this codebase's existing
 * "explicit action, not implicit background work" pattern (Stream.tsx's
 * explicit Load More over infinite scroll) and keeps this component's
 * async logic to one request per submit -- no timers, no stale-response
 * races to guard against.
 */

type SearchState =
  | { status: 'idle' }
  | { status: 'loading'; query: string }
  | { status: 'unsearchable'; query: string }
  | { status: 'results'; query: string; hits: SearchHit[] }
  | { status: 'error'; query: string; message: string };

export interface SearchViewProps {
  token: string;
  onUnauthorized: () => void;
  /** Optional: called when the user asks to leave search (Escape, the
   * Close button). A caller with nowhere to "return to" yet (e.g. a
   * standalone mount, or a test) can omit it -- the Close button and the
   * Escape handler simply don't render/fire in that case. */
  onClose?: () => void;
}

const RESULT_LIMIT = 25;

export function SearchView({ token, onUnauthorized, onClose }: SearchViewProps) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>({ status: 'idle' });
  const inputElRef = useRef<HTMLInputElement | null>(null);

  // '/' opening this view (task brief: "`/` opens it") should land the
  // caret ready to type immediately -- no extra click to start searching.
  useEffect(() => {
    inputElRef.current?.focus();
  }, []);

  function runSearch(): void {
    // Whitespace-only input is a MEANINGFUL, distinct case (`unsearchable`)
    // the server must see verbatim -- trimming it away client-side before
    // the request would silently turn a real, testable distinction into an
    // empty string this component never sends. A literal empty string,
    // conversely, is not a valid request at all (the route's `q.min(1)`
    // 400s on it), so that -- and only that -- is guarded here.
    if (query.length === 0) {
      setState({ status: 'idle' });
      return;
    }

    const q = query;
    setState({ status: 'loading', query: q });

    fetchSearch(token, q, RESULT_LIMIT)
      .then((response) => {
        if (response.unsearchable) {
          setState({ status: 'unsearchable', query: q });
        } else {
          // Results arrive already sorted by bm25 -- re-sorting here would
          // be exactly the client-side ranking logic §7.1 forbids.
          setState({ status: 'results', query: q, hits: response.hits });
        }
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          onUnauthorized();
          return;
        }
        setState({
          status: 'error',
          query: q,
          message: error instanceof Error ? error.message : 'unknown error',
        });
      });
  }

  return (
    <section className="search-view" aria-label="Search">
      <form
        className="search-view__bar"
        onSubmit={(event) => {
          event.preventDefault();
          runSearch();
        }}
      >
        <SearchBox
          inputRef={(el) => {
            inputElRef.current = el;
          }}
          value={query}
          onChange={setQuery}
          onEscape={onClose}
        />
        <button type="submit" className="search-view__submit touch-target">
          Search
        </button>
        {onClose && (
          <button type="button" className="search-view__close touch-target" onClick={onClose}>
            Close <span className="key-hint">Esc</span>
          </button>
        )}
      </form>

      {/* Stated up front, not left to be discovered after a failed search
          (task brief: "Search's indexing limits stated in the UI, not left
          to be discovered"). Always rendered, regardless of query state. */}
      <p className="search-view__scope-hint">
        Searches item titles and each item&rsquo;s stored excerpt only (~300 characters) &mdash;
        never the full article. A phrase from later in a piece will not be found here.
      </p>

      {state.status === 'idle' && <p className="search-view__status">Type a query and press Search.</p>}

      {state.status === 'loading' && <p className="search-view__status">Searching&hellip;</p>}

      {state.status === 'error' && (
        <p className="search-view__status search-view__status--error">search error: {state.message}</p>
      )}

      {/* Distinct from zero hits (task brief: "Say something different for
          the two cases; collapsing them throws away a distinction the API
          deliberately preserves.") -- this is the "nothing to search for"
          branch, not "searched and found nothing." */}
      {state.status === 'unsearchable' && (
        <p className="search-view__status">
          &ldquo;{state.query}&rdquo; has nothing searchable in it &mdash; try a word or two rather than
          blank space.
        </p>
      )}

      {state.status === 'results' && state.hits.length === 0 && (
        <p className="search-view__status">
          No matches for &ldquo;{state.query}&rdquo; in any indexed title or excerpt.
        </p>
      )}

      {state.status === 'results' && state.hits.length > 0 && (
        <ul className="search-view__results">
          {state.hits.map((hit) => (
            <SearchResultRow key={hit.itemKey} hit={hit} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SearchResultRow({ hit }: { hit: SearchHit }) {
  const segments = parseSnippet(hit.snippet);

  return (
    <li className="search-view__result">
      <a
        className="search-view__result-title"
        href={hit.canonicalUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        {hit.title}
      </a>
      <div className="search-view__result-meta">
        <span className="search-view__result-source">{hit.sourceId}</span>
        <span className="search-view__result-time">{relativeTime(hit.publishedAt)}</span>
      </div>
      {/*
        Built from DOM nodes (React elements), never innerHTML -- `snippet`
        is server-supplied text ultimately sourced from third-party article
        excerpts (task brief: "it is server-supplied text, so build it with
        DOM nodes rather than innerHTML"). `[` … `]` becomes emphasis
        (`<mark>`), not literal brackets.
      */}
      <p className="search-view__snippet">
        {segments.map((segment, index) =>
          segment.matched ? (
            <mark key={index} className="search-view__match">
              {segment.text}
            </mark>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
      </p>
    </li>
  );
}
