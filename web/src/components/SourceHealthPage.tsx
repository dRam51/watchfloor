import { useEffect, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { fetchSourceHealth, type SourceHealth } from '../api/sourceHealth.ts';
import { relativeTime } from '../lib/relativeTime.ts';
import { sortForHealthDisplay } from '../lib/sourceHealthOrder.ts';
import './SourceHealthPage.css';

/**
 * The source-health page (M3 task 11, Wave 4). §7, verbatim:
 *
 *   "Source health page — per source: last success, last failure, error
 *   string, items yielded over the last 7 days, current backoff state.
 *   Silent-failing feeds are the main failure mode of a system like this;
 *   make them loud."
 *
 * Renders `GET /api/sources` (src/api/routes/sources.ts, M3 task 5). The
 * one rule every piece of this component answers to: `failing` already
 * INCLUDES the zero-error stale case (a source that stopped being polled,
 * or whose feed silently stopped publishing, with nothing in `lastError` to
 * show for it) -- so nothing here may gate its loud treatment on
 * `lastError` or `consecutiveFailures` alone. See `sortForHealthDisplay`
 * and the `FAILING` badge below, both keyed on `.failing` (and, for the
 * REASON shown, `.stale` specifically), never on the raw error fields.
 *
 * STANDALONE ON PURPOSE, same as SearchView.tsx: does not import or edit
 * `App.tsx` (Wave 4 concurrency note). Ready to mount behind whatever
 * view-switch / nav affordance the coordinator adds centrally -- see this
 * task's report for the exact recipe.
 */

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; sources: SourceHealth[] };

export interface SourceHealthPageProps {
  token: string;
  onUnauthorized: () => void;
  /** Optional: a caller with a view-switch (see report) passes this so the
   * page has a way back. Omit for a standalone mount (e.g. a test). */
  onClose?: () => void;
}

export function SourceHealthPage({ token, onUnauthorized, onClose }: SourceHealthPageProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  // Bumped by the Refresh button to re-run the load effect -- mirrors
  // Stream.tsx's own `retryToken` pattern (M3 task 8/9) rather than
  // inventing a second convention for "the user asked to reload".
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    fetchSourceHealth(token)
      .then((response) => {
        if (cancelled) return;
        setState({ status: 'ready', sources: sortForHealthDisplay(response.sources) });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          onUnauthorized();
          return;
        }
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'unknown error',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [token, retryToken]);

  const failingCount = state.status === 'ready' ? state.sources.filter((s) => s.failing).length : null;
  const enabledCount = state.status === 'ready' ? state.sources.filter((s) => s.enabled).length : null;

  return (
    <section className="source-health" aria-label="Source health">
      <div className="source-health__toolbar">
        <h2 className="source-health__title">Source health</h2>
        <div className="source-health__toolbar-actions">
          <button
            type="button"
            className="source-health__refresh touch-target"
            onClick={() => setRetryToken((n) => n + 1)}
          >
            Refresh
          </button>
          {onClose && (
            <button type="button" className="source-health__close touch-target" onClick={onClose}>
              Close <span className="key-hint">Esc</span>
            </button>
          )}
        </div>
      </div>

      {state.status === 'loading' && <p className="source-health__status">loading source health&hellip;</p>}

      {state.status === 'error' && (
        <p className="source-health__status source-health__status--error">
          health error: {state.message}{' '}
          <button
            type="button"
            className="source-health__retry touch-target"
            onClick={() => setRetryToken((n) => n + 1)}
          >
            Retry
          </button>
        </p>
      )}

      {state.status === 'ready' && (
        <>
          {/*
            The summary banner -- impossible to miss even without reading
            the list below. Positive framing ("all healthy") deliberately
            does NOT use --color-accent's glow treatment or invent a green:
            a healthy state should read as quiet, not celebratory, so all
            the visual weight in this component is reserved for the one
            state that needs it.
          */}
          {failingCount !== null && failingCount > 0 ? (
            <p
              className="source-health__summary source-health__summary--failing"
              role="alert"
            >
              {failingCount} of {enabledCount} enabled source{enabledCount === 1 ? '' : 's'} failing right
              now.
            </p>
          ) : (
            <p className="source-health__summary">
              All {enabledCount} enabled source{enabledCount === 1 ? '' : 's'} healthy.
            </p>
          )}

          <ul className="source-health__list">
            {state.sources.map((source) => (
              <SourceHealthRow key={source.id} source={source} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Label for the "last success" fact -- three genuinely different states,
 * never collapsed to one blank dash (task brief: "Nulls are meaningful"). */
function lastSuccessLabel(source: SourceHealth): string {
  if (!source.everPolled) return 'Never polled';
  if (source.lastSuccessAt === null) return 'Polled, but never succeeded';
  return `${relativeTime(source.lastSuccessAt)}`;
}

/** The REASON a failing source is failing -- deliberately branches on
 * `.stale` FIRST for the zero-error case, so a source with nothing in
 * `lastError` still gets an honest, specific sentence instead of a blank
 * "FAILING" badge with no explanation (task brief: "A page that only
 * highlights lastError would miss it entirely"). */
function failureReason(source: SourceHealth): string {
  const reasons: string[] = [];
  if (source.consecutiveFailures > 0) {
    reasons.push(
      `${source.consecutiveFailures} consecutive failure${source.consecutiveFailures === 1 ? '' : 's'}`,
    );
  }
  if (source.stale) {
    const since = source.everPolled && source.lastSuccessAt !== null
      ? `last success ${relativeTime(source.lastSuccessAt)}`
      : 'no successful poll on record';
    reasons.push(`stale — overdue against its own ${source.pollInterval} interval (${since})`);
  }
  return reasons.join('; ');
}

function SourceHealthRow({ source }: { source: SourceHealth }) {
  const rowClass = [
    'source-health__row',
    source.failing ? 'source-health__row--failing' : '',
    !source.enabled ? 'source-health__row--disabled' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <li className={rowClass}>
      <div className="source-health__row-head">
        <StatusBadge source={source} />
        <span className="source-health__name">{source.name}</span>
        <span className="source-health__id">{source.id}</span>
        <span className="source-health__interval">every {source.pollInterval}</span>
        <span className="source-health__beats">{source.beats.join(', ')}</span>
      </div>

      {/* The loud part: rendered directly in the flow, always visible --
          never behind a hover/title-only affordance (§7.1). Shown for
          EVERY failing source, including the zero-error stale one. */}
      {source.failing && <p className="source-health__reason">{failureReason(source)}</p>}

      <dl className="source-health__facts">
        <dt>Last success</dt>
        <dd>{lastSuccessLabel(source)}</dd>

        <dt>Last failure</dt>
        <dd>{source.lastFailureAt === null ? 'No failures on record' : relativeTime(source.lastFailureAt)}</dd>

        <dt>Last error</dt>
        <dd className={source.lastError ? 'source-health__error-text' : undefined}>
          {source.lastError ?? 'None on record'}
        </dd>

        <dt>Backoff</dt>
        <dd>
          {source.inBackoff && source.nextEligibleAt
            ? `In backoff, retries ${relativeTime(source.nextEligibleAt)}`
            : 'Not in backoff'}
        </dd>

        <dt>Items yielded</dt>
        <dd>
          {source.itemsYieldedSinceWindowStart} since window start
          {source.windowStartedAt !== null ? ` (${relativeTime(source.windowStartedAt)})` : ' (no window yet)'}
          {/* Honest, not "last 7 days" (task brief: "a tumbling window, not
              a sliding one... labelling it 'last 7 days' would be quietly
              wrong"). */}
          <span className="source-health__hint"> — resets on a ~7-day tumble, not a rolling count</span>
        </dd>
      </dl>
    </li>
  );
}

/** The one badge every source gets, in priority order: DISABLED overrides
 * everything else (task brief: "Disabled sources must not read as
 * broken" -- even a disabled source with failure history in
 * `lastError`/`consecutiveFailures` shows this, never FAILING), then
 * FAILING (which already covers the stale case), then a quiet OK. */
function StatusBadge({ source }: { source: SourceHealth }) {
  if (!source.enabled) {
    return <span className="source-health__badge source-health__badge--disabled">DISABLED</span>;
  }
  if (source.failing) {
    return <span className="source-health__badge source-health__badge--failing">FAILING</span>;
  }
  return <span className="source-health__badge source-health__badge--ok">OK</span>;
}
