import { useId, useState } from 'react';
import { activeOverride, activeScore, type Beat, type FeedItem } from '../api/types.ts';
import { relativeTime } from '../lib/relativeTime.ts';

/**
 * One item row -- §7's spec, verbatim: "score indicator, title, source,
 * relative time, cluster count, beat tag. One line at rest, expands in
 * place for the excerpt/summary and metadata."
 *
 * This is the ONLY row component in the tree. Task 10 (six-lane layout) is
 * expected to reuse this exact component inside a lane container -- if a
 * future change here only makes sense "inside a column", that violates the
 * ordering rule this task exists under (M3 plan §7.1: "no task may build a
 * lane-shaped component before the merged stream works").
 */

const BEAT_LABELS: Record<Beat, string> = {
  ai: 'AI',
  cyber: 'Cyber',
  aisec: 'AI Security',
  repos: 'Repos',
  markets: 'Markets',
  usnews: 'US News',
};

export interface ItemRowProps {
  item: FeedItem;
  dismissing: boolean;
  /**
   * Real-focus wiring for M3 task 9's keyboard layer (`j`/`k` roving
   * navigation). `focused` and `tabIndex` are both DERIVED from actual DOM
   * focus in Stream.tsx (never an independent "selectedIndex" that merely
   * paints a highlight) -- see that file's `focusedItemKey` state and its
   * own comment on why. `toggleRef` and `onFocusRow` are what keep it that
   * way: `toggleRef` lets Stream call `.focus()` on this exact button, and
   * `onFocusRow` reports back whenever this button receives focus by ANY
   * means (keyboard nav, Tab, or a plain mouse click), so the two paths
   * can never disagree about which row is "current."
   */
  focused: boolean;
  tabIndex: number;
  onFocusRow: () => void;
  toggleRef?: (el: HTMLButtonElement | null) => void;
  onOpen: (item: FeedItem) => void;
  onToggleSave: (item: FeedItem) => void;
  onDismiss: (item: FeedItem) => void;
}

/**
 * Hard overrides pin regardless of score, and on real cyber data 21 of 50
 * pinned rows round to exactly 0.000 (task brief, point 1). A bare "0.000"
 * next to a sorted list reads as "this system is broken" -- pinning is a
 * SEPARATE axis from score, so it gets its own label rather than
 * masquerading as a (very low) score. The numeric value is still shown,
 * dimmed, so a pinned item's actual score is never hidden -- only
 * de-emphasized relative to the "why is this here" answer, which is the pin.
 */
function ScoreIndicator({ item }: { item: FeedItem }) {
  const override = activeOverride(item);
  const score = activeScore(item);
  const formatted = score.toFixed(3);

  if (override.pinned) {
    const title = override.label ? `Pinned: ${override.label}` : 'Pinned';
    return (
      <span className="item-row__score item-row__score--pinned" title={title}>
        <span className="item-row__pin-badge">PINNED</span>
        <span className="item-row__score-value item-row__score-value--dim">{formatted}</span>
      </span>
    );
  }

  return (
    <span className="item-row__score">
      <span className="item-row__score-value">{formatted}</span>
    </span>
  );
}

function SummaryBlock({ summary }: { summary: string | null }) {
  // A null summary and an empty one are different facts (task brief, point
  // 4): null means the source carried no excerpt at all; '' means one was
  // attempted and came back empty. Collapsing both to the same rendering
  // would hide a real ingest signal.
  if (summary === null) {
    return <p className="item-row__summary item-row__summary--missing">No excerpt available from this source.</p>;
  }
  if (summary === '') {
    return <p className="item-row__summary item-row__summary--empty">Excerpt was empty when fetched.</p>;
  }
  return <p className="item-row__summary">{summary}</p>;
}

export function ItemRow({
  item,
  dismissing,
  focused,
  tabIndex,
  onFocusRow,
  toggleRef,
  onOpen,
  onToggleSave,
  onDismiss,
}: ItemRowProps) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const override = activeOverride(item);
  const saved = item.state.savedAt !== null;
  const read = item.state.readAt !== null;
  const extraBeats = item.beats.length > 1 ? item.beats.length - 1 : 0;

  return (
    <li
      className={[
        'item-row',
        override.pinned ? 'item-row--pinned' : '',
        read ? 'item-row--read' : '',
        dismissing ? 'item-row--dismissing' : '',
        focused ? 'item-row--focused' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-hidden={dismissing}
    >
      <div className="item-row__row">
        <button
          type="button"
          ref={toggleRef}
          className="item-row__toggle"
          aria-expanded={expanded}
          aria-controls={detailId}
          tabIndex={tabIndex}
          onFocus={onFocusRow}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="item-row__chevron" aria-hidden="true">
            {expanded ? '▾' : '▸'}
          </span>
          <ScoreIndicator item={item} />
          <span className="item-row__title">{item.title}</span>
          <span className="item-row__meta">
            <span className="item-row__source">{item.sourceId}</span>
            <span className="item-row__time">{relativeTime(item.publishedAt)}</span>
            {item.clusterSize > 1 && (
              <span className="item-row__cluster" title={`${item.clusterSize} items in this cluster`}>
                &times;{item.clusterSize}
              </span>
            )}
            <span className="item-row__beat">
              {BEAT_LABELS[item.representativeBeat]}
              {extraBeats > 0 && ` +${extraBeats}`}
            </span>
          </span>
        </button>

        <div className="item-row__actions">
          <a
            className="item-row__action touch-target"
            href={item.canonicalUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => onOpen(item)}
            aria-label={`Open "${item.title}" in a new tab`}
          >
            Open
          </a>
          <button
            type="button"
            className="item-row__action touch-target"
            aria-pressed={saved}
            onClick={() => onToggleSave(item)}
            aria-label={saved ? `Remove "${item.title}" from saved` : `Save "${item.title}"`}
          >
            {saved ? 'Saved' : 'Save'}
          </button>
          <button
            type="button"
            className="item-row__action item-row__action--danger touch-target"
            onClick={() => onDismiss(item)}
            aria-label={`Dismiss "${item.title}" -- this cannot be undone`}
          >
            Dismiss
          </button>
        </div>
      </div>

      <div
        id={detailId}
        className={`item-row__detail-wrapper${expanded ? ' item-row__detail-wrapper--expanded' : ''}`}
        aria-hidden={!expanded}
      >
        <div className="item-row__detail">
          <SummaryBlock summary={item.summary} />
          <dl className="item-row__facts">
            <dt>Link</dt>
            <dd className="item-row__url">{item.canonicalUrl}</dd>
            <dt>Beats</dt>
            <dd>{item.beats.map((b) => BEAT_LABELS[b]).join(', ')}</dd>
            <dt>Type</dt>
            <dd>{item.itemType}</dd>
            {item.entities.length > 0 && (
              <>
                <dt>Entities</dt>
                <dd>{item.entities.join(', ')}</dd>
              </>
            )}
            <dt>Published</dt>
            <dd>{item.publishedAt ?? 'undated'}</dd>
            {override.pinned && (
              <>
                <dt>Override</dt>
                <dd>{override.label ?? 'pinned'}</dd>
              </>
            )}
            {saved && (
              <>
                <dt>Saved</dt>
                <dd>{item.state.savedAt}</dd>
              </>
            )}
            {read && (
              <>
                <dt>Read</dt>
                <dd>{item.state.readAt}</dd>
              </>
            )}
          </dl>
        </div>
      </div>
    </li>
  );
}
