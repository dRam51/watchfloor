import { useId, useState, type CSSProperties } from 'react';
import { activeOverride, activeScore, type Beat, type FeedItem } from '../api/types.ts';
import { relativeTime } from '../lib/relativeTime.ts';
import { prefersReducedMotion } from '../lib/motion.ts';
import { scoreIntensity } from '../lib/scoreIntensity.ts';

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

export const BEAT_LABELS: Record<Beat, string> = {
  ai: 'AI',
  cyber: 'Cyber',
  aisec: 'AI Security',
  repos: 'Repos',
  markets: 'Markets',
  usnews: 'US News',
};

/**
 * M4a task 8 exported this (and `ScoreIndicator` / `BEAT_LABELS` below) rather
 * than letting `RepoRow.tsx` restate it. The repos row differs in its CONTENT
 * (§7: "repo name, one-line description, language, stars + velocity arrow,
 * last-commit age"), not in its row CHROME: the same pinned-at-zero problem,
 * the same roving-tabindex contract, the same three affordances, the same
 * expand-in-place. A second copy of the pinned-at-zero substitution would be a
 * second place to forget it.
 */
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
 *
 * M3 task 12 extends this with a compact intensity bar (§7.4: "score shown
 * as a compact intensity bar", `lib/scoreIntensity.ts`). The SAME 0.000-pin
 * problem applies to a score-scaled bar even more starkly than to the bare
 * number: a bar driven by `score` would render completely EMPTY for the
 * most important rows on the page. Pinned rows therefore get a fixed,
 * always-full indicator instead of one driven by `score` -- the pin is the
 * signal there, never the number, and that stays true whether the number is
 * spelled out as text or as a bar's fill level.
 */
export function ScoreIndicator({ item }: { item: FeedItem }) {
  const override = activeOverride(item);
  const score = activeScore(item);
  const formatted = score.toFixed(3);

  if (override.pinned) {
    const title = override.label ? `Pinned: ${override.label}` : 'Pinned';
    return (
      <span className="item-row__score item-row__score--pinned" title={title}>
        <span className="item-row__pin-badge">PINNED</span>
        <span className="item-row__intensity item-row__intensity--pinned" aria-hidden="true" />
        <span className="item-row__score-value item-row__score-value--dim">{formatted}</span>
      </span>
    );
  }

  const intensity = scoreIntensity(score);
  return (
    <span className="item-row__score">
      <span className="item-row__intensity" aria-hidden="true" style={{ '--fill': intensity } as CSSProperties} />
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

  // M3 task 12, alert pulse (§7.4: "hard-override items ... arrive with a
  // brief glow-pulse ... and a persistent left-edge accent until read").
  // ONE condition drives both: `item-row--pinned` (the persistent left-edge
  // accent, tokens.css) and `item-row--pulse` (the one-shot arrival glow)
  // are both governed by "pinned AND not yet read", and BOTH clear the
  // instant `state.readAt` is set -- the accent's disappearance IS "until
  // read" made visible; the pulse, being a single `animation-iteration-
  // count: 1` keyframe (global.css), has virtually always already finished
  // playing by the time a read happens regardless.
  //
  // WHY THIS NEEDS NO "has it pulsed yet" state of its own: `item-row--pulse`
  // is applied declaratively, from the SAME `alertActive` boolean every
  // render, not toggled on/off by an effect. A CSS animation restarts only
  // when an element is freshly mounted with the class already present, or
  // when the class value actually flips between renders -- not merely by
  // being present, unchanged, across many re-renders (React never touches a
  // DOM attribute whose string value didn't change). Since `key={item.itemKey}`
  // (Stream.tsx/Lane.tsx) means each row is a fresh component instance
  // exactly when it is new to the list -- a genuinely new fetch page, a
  // freshly loaded lane, an explicit refresh -- "the class is present at
  // mount" and "this item just arrived in view" coincide, which is what
  // makes a bare boolean condition (no ref, no timer, no useEffect) already
  // "one pulse, not a blinking siren": an unrelated re-render of an
  // ALREADY-MOUNTED row (a save toggle, a focus change elsewhere) leaves the
  // class string identical to the previous render, so nothing replays.
  //
  // Reduced motion is honoured explicitly here (`prefersReducedMotion()`,
  // `lib/motion.ts`) by omitting the pulse class outright -- not merely
  // shortening it -- because even a fast flash is exactly the kind of
  // motion that preference exists to suppress; the persistent (non-
  // animated) accent still renders normally. This is on top of, not instead
  // of, tokens.css's own `--motion-pulse` zeroing under the same media
  // query (belt-and-suspenders: the same "default rather than an opt-in"
  // mechanism motion.ts's module doc comment describes, used the same way
  // `useItemFeed.ts`'s dismiss-timer already does with the identical call).
  const alertActive = override.pinned && !read;
  const pulseEnabled = alertActive && !prefersReducedMotion();

  return (
    <li
      className={[
        'item-row',
        alertActive ? 'item-row--pinned' : '',
        pulseEnabled ? 'item-row--pulse' : '',
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
