import { apiFetch } from './client.ts';
import type { FeedItemState } from './types.ts';

/**
 * The item-state write routes (src/api/routes/items.ts). All four are
 * idempotent -- safe to fire again on a double-tap or a held key (Task 9's
 * concern, but the affordances these back are this task's). Every call
 * returns the resulting `{readAt, savedAt, dismissedAt}`, which the caller
 * writes back onto its local copy of the row rather than re-fetching the
 * whole feed.
 *
 * Deliberately NO `undismissItem` -- §7: "Dismissed items never come back."
 * The domain layer has no such route to call; a client-side undo would have
 * to fake it, which is exactly the kind of business logic the frontend must
 * not invent (§7.1).
 */

function itemPath(itemKey: string, action: string): string {
  return `/api/items/${encodeURIComponent(itemKey)}/${action}`;
}

export function markItemRead(token: string, itemKey: string): Promise<FeedItemState> {
  return apiFetch<FeedItemState>(itemPath(itemKey, 'read'), token, { method: 'POST' });
}

export function saveItem(token: string, itemKey: string): Promise<FeedItemState> {
  return apiFetch<FeedItemState>(itemPath(itemKey, 'save'), token, { method: 'POST' });
}

export function unsaveItem(token: string, itemKey: string): Promise<FeedItemState> {
  return apiFetch<FeedItemState>(itemPath(itemKey, 'save'), token, { method: 'DELETE' });
}

export function dismissItem(token: string, itemKey: string): Promise<FeedItemState> {
  return apiFetch<FeedItemState>(itemPath(itemKey, 'dismiss'), token, { method: 'POST' });
}
