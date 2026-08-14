import { useId, useState } from 'react';
import { activeOverride, type FeedItemRepo } from '../api/types.ts';
import { relativeTime } from '../lib/relativeTime.ts';
import { prefersReducedMotion } from '../lib/motion.ts';
import { velocityDisplay } from '../lib/repoVelocity.ts';
import { BEAT_LABELS, ScoreIndicator, type ItemRowProps } from './ItemRow.tsx';

/**
 * The repos lane row (M4a task 8). §7, verbatim: *"Repos lane rows differ:
 * repo name, one-line description, language, stars + velocity arrow,
 * last-commit age."*
 *
 * A DIFFERENT component from `ItemRow`, inside the SAME lane container. What
 * differs is the content: a repo has no source id, no cluster count and no
 * publication date worth showing, and it has five facts a news item does not.
 * What does NOT differ is the row chrome -- the `.item-row*` classes, the
 * roving-tabindex contract, the three always-visible affordances, the
 * expand-in-place detail panel and the pinned-at-zero score substitution are
 * all imported or reused verbatim, so `Lane.tsx` drives this row through the
 * identical `toggleRef`/`onFocusRow` wiring and `j`/`k`/`o`/`s`/`x` work here
 * with no lane-side special case. `FeedRow.tsx` is the one place that chooses
 * between the two.
 *
 * ---------------------------------------------------------------------------
 * THIS ROW EXISTS UNDER FOUR EXPLICIT PROHIBITIONS
 * ---------------------------------------------------------------------------
 * Each is a way the UI would state something the system does not know, and
 * each was found in an earlier wave rather than here. Every one has a named
 * test in web/tests/RepoRow.test.tsx (and web/tests/repoVelocity.test.ts for
 * the two that are pure formatting).
 *
 * 1. `spanDays` IS NEVER A WHOLE NUMBER OF DAYS. It is elapsed time between
 *    two observation instants; a 23:00/01:00 pair is 0.083 days, not 2.
 *    Rendering the day-label count would restore the 12x error src/score/
 *    velocity.ts was built to prevent -- at the last layer, where a human
 *    reads it. `lib/repoVelocity.ts`'s `formatSpan` owns this.
 *
 * 2. `openIssuesAndPullRequests` IS NEVER LABELLED "issues". GitHub's field
 *    counts open pull requests too: 3 issues plus 90 PRs reports 93.
 *    src/domain/repo.ts named it honestly and said so; the label here says
 *    "issues+PRs" and the title says why.
 *
 * 3. A NULL README EXCERPT IS NEVER "no README". An unread README (the
 *    enrichment budget ran out) and a missing one both produce `null`; only
 *    `readmeKnown` separates them, and §4 suppresses only the second. The two
 *    render through different elements so neither can drift into the other.
 *
 * 4. AN UNMEASURED VELOCITY IS NEVER AN ARROW. `starsPerDay` exists only on
 *    the `ok` branch of the union, and ON A FRESH DATABASE EVERY REPO IS
 *    INSUFFICIENT FOR SEVEN DAYS -- which is exactly when this lane is most
 *    likely to be judged. The three arrows are reserved for measured
 *    directions; the four insufficient reasons get a neutral glyph plus the
 *    history that does exist, in the always-visible label rather than only a
 *    tooltip (a phone browser never shows one).
 */

export interface RepoRowProps extends ItemRowProps {
  /**
   * Passed separately rather than read off `item.repo` so the non-null
   * narrowing happens ONCE, in `FeedRow.tsx`, instead of being re-asserted
   * with a `!` everywhere in this file.
   */
  repo: FeedItemRepo;
}

/**
 * Exact, and locale-independent.
 *
 * No `toLocaleString()`: it reads the host locale, which is the same class of
 * ambient-environment read the standing portability rule bans for the system
 * timezone ("TZ set explicitly in config ... never read the system
 * timezone"). A grouped literal is also stable enough to assert on.
 *
 * Not abbreviated either. "12.3k" silently discards up to 99 stars, and §4's
 * whole comparison is between a repo at 400 and one at 30k -- a lane about
 * star counts should not round them.
 */
function formatStars(stars: number): string {
  const digits = Math.trunc(Math.abs(stars)).toString();
  let grouped = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += ',';
    grouped += digits[i];
  }
  return stars < 0 ? `-${grouped}` : grouped;
}

/**
 * §7's "last-commit age".
 *
 * `null` means GitHub reports the repo has never been pushed to -- a real,
 * different fact from "we do not know when", so it does not fall through to
 * `relativeTime`'s generic "undated".
 */
function LastCommit({ lastCommitAt }: { lastCommitAt: string | null }) {
  if (lastCommitAt === null) {
    return (
      <span className="repo-row__pushed repo-row__pushed--never" title="GitHub reports no push to this repository, ever.">
        never pushed
      </span>
    );
  }
  return (
    <span className="repo-row__pushed" title={`Last commit pushed ${lastCommitAt}`}>
      {relativeTime(lastCommitAt)}
    </span>
  );
}

/** PROHIBITION 4. See this file's doc comment. */
function VelocityCell({ repo }: { repo: FeedItemRepo }) {
  const display = velocityDisplay(repo.velocity);
  const className = [
    'repo-row__velocity',
    `repo-row__velocity--${display.direction}`,
    display.stale ? 'repo-row__velocity--stale' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={className} title={display.title}>
      <span className="repo-row__velocity-glyph" aria-hidden="true">
        {display.glyph}
      </span>
      <span className="repo-row__velocity-label">{display.label}</span>
      {display.stale && (
        <span className="repo-row__velocity-stale-mark" aria-hidden="true">
          *
        </span>
      )}
    </span>
  );
}

/** PROHIBITION 3. See this file's doc comment. */
function ReadmeBlock({ repo }: { repo: FeedItemRepo }) {
  if (repo.readmeExcerpt !== null) {
    return <p className="repo-row__readme">{repo.readmeExcerpt}</p>;
  }
  if (repo.readmeKnown) {
    // The ONLY branch permitted to make this claim: src/enrich/repo.ts's
    // `isReadmeKnown` returned true, so the question was actually answered.
    return (
      <p className="repo-row__readme repo-row__readme--absent">
        This repository has no README.
      </p>
    );
  }
  return (
    <p className="repo-row__readme repo-row__readme--unknown">
      README not yet read &mdash; the enrichment budget did not reach this repository. Not the same as having none.
    </p>
  );
}

export function RepoRow({
  item,
  repo,
  dismissing,
  focused,
  tabIndex,
  onFocusRow,
  toggleRef,
  onOpen,
  onToggleSave,
  onDismiss,
}: RepoRowProps) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const override = activeOverride(item);
  const saved = item.state.savedAt !== null;
  const read = item.state.readAt !== null;

  // Identical to ItemRow's -- see that file for the full reasoning on why one
  // declarative boolean is already "one pulse, not a blinking siren".
  const alertActive = override.pinned && !read;
  const pulseEnabled = alertActive && !prefersReducedMotion();

  return (
    <li
      className={[
        'item-row',
        'repo-row',
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
          className="item-row__toggle repo-row__toggle"
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
          <span className="repo-row__name">{repo.fullName}</span>
          {repo.description === null ? (
            <span className="repo-row__description repo-row__description--missing">no description</span>
          ) : (
            <span className="repo-row__description">{repo.description}</span>
          )}
          <span className="repo-row__meta">
            {repo.language === null ? (
              <span className="repo-row__language repo-row__language--missing" title="GitHub detected no primary language.">
                no language
              </span>
            ) : (
              <span className="repo-row__language">{repo.language}</span>
            )}
            <span className="repo-row__stars" title={`${formatStars(repo.stars)} stars`}>
              <span aria-hidden="true">&#9733;</span>
              {formatStars(repo.stars)}
            </span>
            <VelocityCell repo={repo} />
            <LastCommit lastCommitAt={repo.lastCommitAt} />
          </span>
        </button>

        <div className="item-row__actions">
          <a
            className="item-row__action touch-target"
            href={item.canonicalUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => onOpen(item)}
            aria-label={`Open ${repo.fullName} in a new tab`}
          >
            Open
          </a>
          <button
            type="button"
            className="item-row__action touch-target"
            aria-pressed={saved}
            onClick={() => onToggleSave(item)}
            aria-label={saved ? `Remove ${repo.fullName} from saved` : `Save ${repo.fullName}`}
          >
            {saved ? 'Saved' : 'Save'}
          </button>
          <button
            type="button"
            className="item-row__action item-row__action--danger touch-target"
            onClick={() => onDismiss(item)}
            aria-label={`Dismiss ${repo.fullName} -- this cannot be undone`}
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
          <ReadmeBlock repo={repo} />
          <dl className="item-row__facts repo-row__facts">
            <dt>Link</dt>
            <dd className="item-row__url">{item.canonicalUrl}</dd>
            <dt>Stars</dt>
            <dd>{formatStars(repo.stars)}</dd>
            <dt>Velocity</dt>
            <dd className="repo-row__velocity-detail">{velocityDisplay(repo.velocity).title}</dd>
            {/* PROHIBITION 2: the label carries the PR half, always. */}
            <dt>Open</dt>
            <dd
              className="repo-row__issues"
              title="GitHub's open_issues_count counts open pull requests as well as open issues, so this is their sum, not an issue count."
            >
              {repo.openIssuesAndPullRequests} issues+PRs
            </dd>
            <dt>License</dt>
            <dd>{repo.licenseSpdxId ?? 'none identified'}</dd>
            <dt>Last commit</dt>
            <dd>{repo.lastCommitAt ?? 'never pushed'}</dd>
            <dt>Beats</dt>
            <dd>{item.beats.map((b) => BEAT_LABELS[b]).join(', ')}</dd>
            {item.entities.length > 0 && (
              <>
                <dt>Entities</dt>
                <dd>{item.entities.join(', ')}</dd>
              </>
            )}
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
