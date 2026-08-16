import { useEffect, useState } from 'react';
import { ApiError } from '../api/client.ts';
import {
  fetchEntityGraph,
  fetchEntityList,
  type EntityGraphResponse,
  type EntityListResponse,
} from '../api/entities.ts';
import { layoutEntityRadial } from '../lib/entityRadial.ts';
import { useIsWideViewport } from '../lib/viewport.ts';
import './EntityGraphView.css';

/**
 * §7.4's entity graph view (M5 task 17).
 *
 * M5's acceptance asks that this "renders the `related_entities`". It renders
 * them twice, in two shapes, and which one you get depends on how much room
 * there is:
 *
 * - **A ranked adjacency list, always.** Focus, neighbour, shared-item count,
 *   in the order the server ranked them. Every row is a button that re-focuses
 *   the graph, so the list is how you *walk* the relation rather than a
 *   consolation prize.
 * - **A radial SVG, above the lane breakpoint only.** Focus at the centre,
 *   neighbours on a ring, edge weight by shared items — including the chords
 *   between neighbours, which is the part a list cannot show.
 *
 * ## The phone answer, stated plainly
 *
 * §7's deliverable is "usable daily on a laptop, legible on a phone browser",
 * and **the ring is not legible on a phone.** Fifteen labels around a circle
 * at 375px is not a tuning problem: `Retrieval-augmented generation` alone is
 * wider than half the viewport, and two labels on opposite sides of the ring
 * overlap before the ring is big enough to be worth drawing. A graph whose
 * labels are removed or truncated to three characters tells you nothing, so
 * shrinking it is not an answer either.
 *
 * The honest answer is that below the breakpoint the ranked list **is** the
 * view — and it is not a degradation. It carries every number the SVG encodes
 * (which entities, in which order, with how many shared items) exactly, rather
 * than approximately, and it is tappable where a 6-pixel circle is not. What
 * it loses is the neighbour-to-neighbour structure, which is real and is
 * stated in this comment rather than hidden.
 *
 * `useIsWideViewport` is the same hook `App.tsx` uses to choose between
 * `Stream` and `LaneBoard`, at the same ~700px, with the same guarded default:
 * a host that cannot measure itself gets the view that always works.
 */

export interface EntityGraphViewProps {
  token: string;
  onUnauthorized: () => void;
  /** Optional, exactly as `SearchView`'s is: a standalone mount has nowhere to return to. */
  onClose?: () => void;
}

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: EntityListResponse };

type GraphState =
  | { status: 'idle' }
  | { status: 'loading'; entity: string }
  | { status: 'error'; entity: string; message: string }
  | { status: 'ready'; data: EntityGraphResponse };

/**
 * The floor, in distinct items, below which an entity is not drawn.
 *
 * Mirrors the server's default (`DEFAULT_MIN_ITEMS_FOR_NODE`) rather than
 * overriding it — sent explicitly so the number the view *states* and the
 * number the server *applied* are provably the same one, instead of the view
 * printing a constant it hopes matches. If they ever diverge the response's
 * own `minItems` is what the user sees, because that is the applied value.
 */
const MIN_ITEMS = 2;

/**
 * Locale-independent thousands grouping.
 *
 * `toLocaleString` would read the host's locale, which is the same class of
 * host-dependence `CLAUDE.md` calls out for `localeCompare` in the scorer and
 * which this project refuses everywhere else. `RepoRow` formats star counts
 * the same way and for the same reason.
 */
function groupThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function EntityGraphView({ token, onUnauthorized, onClose }: EntityGraphViewProps) {
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [focus, setFocus] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphState>({ status: 'idle' });
  const isWide = useIsWideViewport();

  useEffect(() => {
    let cancelled = false;
    setList({ status: 'loading' });
    fetchEntityList(token, MIN_ITEMS)
      .then((data) => {
        if (cancelled) return;
        setList({ status: 'ready', data });
        // Open on the biggest entity rather than on nothing: an empty view
        // that waits for a selection is a view whose first impression is that
        // the feature has no data.
        setFocus((current) => current ?? data.entities[0]?.entity ?? null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          onUnauthorized();
          return;
        }
        setList({
          status: 'error',
          message: error instanceof Error ? error.message : 'unknown error',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [token, onUnauthorized]);

  useEffect(() => {
    if (focus === null) return;
    let cancelled = false;
    setGraph({ status: 'loading', entity: focus });
    fetchEntityGraph(token, focus, MIN_ITEMS)
      .then((data) => {
        if (!cancelled) setGraph({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          onUnauthorized();
          return;
        }
        setGraph({
          status: 'error',
          entity: focus,
          message: error instanceof Error ? error.message : 'unknown error',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [token, focus, onUnauthorized]);

  const data = graph.status === 'ready' ? graph.data : null;
  const neighbours = data ? data.nodes.filter((node) => !node.focus) : [];

  return (
    <section className="entity-graph" aria-label="Entity graph">
      <div className="entity-graph__bar">
        <label className="entity-graph__picker-label" htmlFor="entity-graph-picker">
          entity
        </label>
        <select
          id="entity-graph-picker"
          className="entity-graph__picker touch-target"
          value={focus ?? ''}
          disabled={list.status !== 'ready' || list.data.entities.length === 0}
          onChange={(event) => setFocus(event.target.value)}
        >
          {/* A native select, not a bespoke listbox: it is keyboard-navigable
              and type-ahead searchable for free, and on a phone it becomes the
              OS picker, which is the best control on that device by a distance. */}
          {list.status === 'ready' &&
            list.data.entities.map((entry) => (
              <option key={entry.entity} value={entry.entity}>
                {entry.entity} ({groupThousands(entry.itemCount)})
              </option>
            ))}
        </select>
        {onClose && (
          <button type="button" className="entity-graph__close touch-target" onClick={onClose}>
            Close
          </button>
        )}
      </div>

      {/* Stated up front and always, not discovered by wondering where the
          CVEs went. The threshold is a real editorial choice -- 3,298 of 3,474
          entities on the live corpus are named by exactly one item -- and a
          view that silently drew 5% of the corpus while looking complete is
          the failure this line exists to prevent. */}
      {list.status === 'ready' && (
        <p className="entity-graph__threshold">
          Drawing entities named by <strong>2 or more items</strong> &mdash;{' '}
          {groupThousands(list.data.entitiesAtOrAboveThreshold)} of{' '}
          {groupThousands(list.data.entitiesTotal)}.{' '}
          {groupThousands(list.data.entitiesBelowThreshold)} single-mention{' '}
          {plural(list.data.entitiesBelowThreshold, 'entity', 'entities')} (mostly CVE
          identifiers) {plural(list.data.entitiesBelowThreshold, 'is', 'are')} not drawn: one
          item is one edge, which draws a spoke and says nothing.
        </p>
      )}

      {list.status === 'loading' && <p className="entity-graph__status">Loading entities&hellip;</p>}

      {list.status === 'error' && (
        <p className="entity-graph__status entity-graph__status--error">
          entity list error: {list.message}
        </p>
      )}

      {list.status === 'ready' && list.data.entitiesTotal === 0 && (
        <p className="entity-graph__status">
          No entities have been extracted from this corpus yet.
        </p>
      )}

      {graph.status === 'loading' && <p className="entity-graph__status">Loading graph&hellip;</p>}

      {graph.status === 'error' && (
        <p className="entity-graph__status entity-graph__status--error">
          graph error: {graph.message}
        </p>
      )}

      {/* Three different empty states, deliberately not one. "We have never
          seen this name", "we have seen it but nothing is named beside it",
          and "things are named beside it but all of them fall below the floor"
          are different facts, and collapsing them would be exactly the
          absence-versus-emptiness mistake the API refuses to make. */}
      {data && !data.known && (
        <p className="entity-graph__status">
          No item in this corpus names &ldquo;{data.entity}&rdquo;.
        </p>
      )}

      {data && data.known && neighbours.length === 0 && (
        <p className="entity-graph__status">
          No other entity is named alongside &ldquo;{data.entity}&rdquo;
          {data.neighbours.hiddenBelowThreshold > 0
            ? ` at this threshold — ${groupThousands(data.neighbours.hiddenBelowThreshold)} ${plural(
                data.neighbours.hiddenBelowThreshold,
                'entity is',
                'entities are',
              )} named beside it by a single item each.`
            : ' anywhere in the corpus.'}
        </p>
      )}

      {data && data.known && neighbours.length > 0 && (
        <>
          {isWide && <EntityRing graph={data} onFocus={setFocus} />}

          <p className="entity-graph__neighbour-note">
            Showing {groupThousands(data.neighbours.shown)} of{' '}
            {groupThousands(data.neighbours.aboveThreshold)}{' '}
            {plural(data.neighbours.aboveThreshold, 'entity', 'entities')} named alongside{' '}
            &ldquo;{data.entity}&rdquo;
            {data.neighbours.hiddenBelowThreshold > 0 &&
              `, with ${groupThousands(data.neighbours.hiddenBelowThreshold)} more below the ${data.minItems}-item floor`}
            .
          </p>

          <ul className="entity-graph__related-list">
            {neighbours.map((node) => (
              <li className="entity-graph__related" key={node.entity}>
                <button
                  type="button"
                  className="entity-graph__related-button touch-target"
                  onClick={() => setFocus(node.entity)}
                >
                  <span className="entity-graph__related-entity">{node.entity}</span>
                  <span className="entity-graph__related-shared">
                    {groupThousands(node.sharedItemsWithFocus ?? 0)} shared{' '}
                    {plural(node.sharedItemsWithFocus ?? 0, 'item', 'items')}
                  </span>
                  <span className="entity-graph__related-total">
                    {groupThousands(node.itemCount)} total
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * The ring.
 *
 * `role="img"` with a summary rather than a tree of interactive SVG elements:
 * the ranked list below carries the same navigation as real `<button>`s, so
 * the accessible route already exists and duplicating it inside the SVG would
 * mean two tab stops per entity for one action. The circles stay clickable as
 * a pointer convenience, which is additive rather than load-bearing.
 *
 * All geometry comes from `lib/entityRadial.ts`; nothing is computed here.
 * Every colour and font size comes from `EntityGraphView.css` via a token.
 */
function EntityRing({
  graph,
  onFocus,
}: {
  graph: EntityGraphResponse;
  onFocus: (entity: string) => void;
}) {
  const layout = layoutEntityRadial(graph);
  const neighbourCount = layout.nodes.length - 1;

  return (
    <svg
      className="entity-graph__svg"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={
        `Entity graph centred on ${graph.entity}, with ${neighbourCount} related ` +
        `${plural(neighbourCount, 'entity', 'entities')}. The same relation is listed below.`
      }
    >
      {/* Edges first so nodes sit on top of them. */}
      {layout.edges.map((edge) => (
        <line
          key={`${edge.source}|${edge.target}`}
          className={`entity-graph__edge${edge.toFocus ? ' entity-graph__edge--to-focus' : ''}`}
          x1={edge.x1}
          y1={edge.y1}
          x2={edge.x2}
          y2={edge.y2}
          strokeWidth={edge.width}
        />
      ))}

      {layout.nodes.map((node) => (
        <g
          key={node.entity}
          className={`entity-graph__node${node.focus ? ' entity-graph__node--focus' : ''}`}
          onClick={node.focus ? undefined : () => onFocus(node.entity)}
        >
          <title>
            {`${node.entity} — ${groupThousands(node.itemCount)} ${plural(node.itemCount, 'item', 'items')}` +
              (node.sharedItemsWithFocus === null
                ? ''
                : `, ${groupThousands(node.sharedItemsWithFocus)} shared with ${graph.entity}`)}
          </title>
          <circle className="entity-graph__node-dot" cx={node.x} cy={node.y} r={node.radius} />
          <text
            className="entity-graph__node-label"
            x={node.labelX}
            y={node.labelY}
            textAnchor={node.labelAnchor}
            dominantBaseline="middle"
          >
            {node.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
