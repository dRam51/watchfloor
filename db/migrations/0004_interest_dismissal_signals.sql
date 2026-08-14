-- Dismissal-as-negative-interest-signal log (M3 task 3, src/domain/itemState.ts).
--
-- §7: "Dismissal feeds the interest profile as a negative signal (log it;
-- don't auto-tune the weights)." item_state (0001_init.sql) cannot serve as
-- that log on its own: it is deliberately mutable, single-current-value UI
-- state ("Mutable UI state ... Deliberately NOT append-only", per its own
-- schema comment) -- a save/un-save or, hypothetically, a second dismiss
-- overwrites whatever was there before, so it can only ever answer "is this
-- item dismissed right now", never "what has been dismissed, and when".
-- This table is the append-only record of the dismissal EVENT itself, kept
-- deliberately separate from item_state for exactly that reason.
--
-- "Log it; don't auto-tune the weights" is enforced by omission, not by
-- code: nothing in this codebase reads this table back to adjust
-- config/interests.yaml or any score component. It exists to be read by a
-- human (or a future, explicitly-reviewed tuning pass someone deliberately
-- builds and justifies) -- never by an automated feedback loop. A row here
-- records only the fact and moment of dismissal; the "what did the user not
-- like about it" question is answered by joining item_key back to items
-- (title, beats, entities), not by duplicating that content into this log.
--
-- append-only, like items / item_scores / item_clusters (0001_init.sql):
-- a signal log is a historical record of what happened, and "correcting"
-- it by mutation would defeat the purpose of logging in the first place.
-- One row per genuine not-dismissed -> dismissed transition -- a repeat
-- dismiss call on an already-dismissed item_key (a no-op at the item_state
-- layer, since dismissal never reverses) writes no additional row here.
create table interest_dismissal_signals (
  signal_id    text primary key,
  item_key     text not null,
  dismissed_at text not null,
  created_at   text not null
);

-- Every negative signal for a given item, in order -- the read pattern a
-- future review pass needs.
create index interest_dismissal_signals_item_key on interest_dismissal_signals (item_key, dismissed_at);

create trigger interest_dismissal_signals_no_update before update on interest_dismissal_signals
begin
  select raise(ABORT, 'interest_dismissal_signals is append-only; write a new row rather than editing this one');
end;

create trigger interest_dismissal_signals_no_delete before delete on interest_dismissal_signals
begin
  select raise(ABORT, 'interest_dismissal_signals is append-only; write a new row rather than editing this one');
end;
