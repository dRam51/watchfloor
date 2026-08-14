import { ItemRow, type ItemRowProps } from './ItemRow.tsx';
import { RepoRow } from './RepoRow.tsx';

/**
 * The ONE place the two row shapes are chosen between (M4a task 8).
 *
 * §7 asks for a repos row that "differs" from the news row while living in the
 * same lane container, so something has to pick. Putting that choice here --
 * rather than in `Lane.tsx` and again in `Stream.tsx` -- means the two views
 * cannot disagree about what a repo looks like, and a third view added later
 * inherits the choice by using this component.
 *
 * THE PREDICATE IS THE PAYLOAD, NOT THE LANE. `item.repo != null` selects the
 * repo row; `beat === 'repos'` deliberately does not. Two reasons, both about
 * not lying:
 *
 * 1. A cross-listed item is ONE item in TWO lanes (CLAUDE.md: "Beats belong to
 *    the item -- unioned across every version sharing an item_key"). Keying on
 *    the lane would render the same repo as a repo in one lane and as a news
 *    story in another. Keying on the payload renders it identically in both,
 *    which is what it is. (The `{beat, itemKey}` focus record in
 *    `LaneBoard.tsx` is what keeps those two renderings from both claiming
 *    focus; nothing here touches that.)
 * 2. An item WITHOUT a repo payload that ranks into the repos lane -- and, right
 *    now, EVERY item in it, because this milestone's Task 7 is still adding the
 *    field to `GET /api/feed` -- falls back to the news row rather than
 *    rendering a repo row full of blanks. Degrading to a row that says less is
 *    honest; rendering repo furniture around data we do not have is not.
 *
 * Props are `ItemRowProps` verbatim and are forwarded untouched, so the roving
 * tabindex, `toggleRef` and `onFocusRow` wiring a caller already has for
 * `ItemRow` works unchanged.
 */
export function FeedRow(props: ItemRowProps) {
  const repo = props.item.repo;
  if (repo != null) return <RepoRow {...props} repo={repo} />;
  return <ItemRow {...props} />;
}
