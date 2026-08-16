import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/connection.ts';
import {
  getItemState,
  markItemRead,
  saveItem,
  unsaveItem,
  dismissItem,
  type ItemState,
} from '../../domain/itemState.ts';
import { promoteSavedItemToVault } from '../../vault/sync.ts';

/**
 * Item state writes — the HTTP surface over `src/domain/itemState.ts`.
 *
 * M3 task 3 built the complete domain layer (`markItemRead`, `saveItem`,
 * `unsaveItem`, `dismissItem`) and task 4's feed *reads* the resulting state
 * onto each row, but no task owned exposing the **writes**. The gap fell
 * between task boundaries and was found while checking what §7's keyboard
 * actions actually need: `s` (save) and `x` (dismiss) had nothing to call,
 * so the dashboard could display state it could never change.
 *
 * ## Why discrete endpoints rather than one PATCH
 *
 * The three actions do not have uniform semantics, and a single
 * `PATCH /state {read, saved, dismissed}` body would flatten that:
 *
 * - **read** is idempotent and one-way. Re-reading does not re-stamp.
 * - **save** is reversible — hence a matching DELETE.
 * - **dismiss is IRREVERSIBLE.** §7: "Dismissed items never come back." The
 *   domain layer has no `undismiss` at all, deliberately, and it also writes
 *   a row to `interest_dismissal_signals` as a negative interest signal.
 *
 * Separate routes make that asymmetry visible in the URL space: there is a
 * `DELETE .../save` and conspicuously no `DELETE .../dismiss`. A uniform
 * PATCH would invite a client to try setting `dismissed: false` and get a
 * silent no-op, or worse, tempt someone into adding an undismiss to make the
 * shape regular.
 *
 * ## Idempotency
 *
 * Every action is safe to repeat, which matters because §7's keyboard nav
 * means a held key or a double-tap is ordinary. `dismissItem` returns the
 * existing state unchanged when already dismissed (and writes no second
 * signal row); `markItemRead` does not re-stamp. So these are POSTs that
 * behave idempotently rather than PUTs that pretend to be replacements.
 */
/**
 * Where §8.1's `saved/` promotion writes, and in which zone it dates the file.
 *
 * `root` is `WF_VAULT_ROOT` as `src/api/server.ts` read it, or `null` when it
 * is unset — **the shipped configuration**, and a clean no-op rather than an
 * error. Passed down rather than read from `process.env` here: a request
 * handler reading a global is one the composition root cannot see or override,
 * and it would leave a test's vault one stray environment variable away from
 * the owner's real one.
 */
export interface ItemsVaultDeps {
  readonly root: string | null;
  /** `WF_TZ`. Decides the day label in `saved/YYYY-MM-DD-…`, never the host zone. */
  readonly tz: string;
}

export interface ItemsRouteDeps {
  db: Db;
  /** Injectable clock, matching this codebase's "now is always a parameter" convention. */
  now?: () => string;
  /**
   * Omitted = no promotion at all, which is what the M3 route tests do. The
   * real server always passes it; `tests/api/itemsVault.test.ts` goes through
   * `buildServer` precisely so a composition root that stopped passing it
   * would fail rather than quietly stop writing notes.
   */
  vault?: ItemsVaultDeps;
}

const ParamsSchema = z.object({
  // sha256 hex of the canonical url — see deriveItemKey in src/domain/item.ts.
  itemKey: z.string().regex(/^[0-9a-f]{64}$/, 'itemKey must be a 64-character hex digest'),
});

function stateJson(state: ItemState | null) {
  // Null state (never touched, or un-saved back to nothing) is reported as
  // explicit nulls rather than an absent object, so a client never has to
  // distinguish "no state row" from "state with nothing set" — the same
  // absence-vs-emptiness rule the feed and source-health routes follow.
  return {
    readAt: state?.readAt ?? null,
    savedAt: state?.savedAt ?? null,
    dismissedAt: state?.dismissedAt ?? null,
  };
}

export function registerItems(server: FastifyInstance, deps: ItemsRouteDeps): void {
  const nowFn = deps.now ?? (() => new Date().toISOString());

  /**
   * §8.1's `saved/` promotion, at save time (M5 task 15).
   *
   * **Why here rather than in a reconciliation pass.** Task 8 established it
   * and M5's acceptance criterion forces it: a pass over
   * `item_state where saved_at is not null` cannot distinguish a note that was
   * never written from one the owner deleted on purpose. Delete the tree,
   * re-sync, and such a pass faithfully rebuilds exactly what §8.1's "written
   * once at creation, then never touched again by any job" forbids. So
   * promotion is an event on the save transition, and there is deliberately no
   * backfill: an item saved while the vault is unmounted is never promoted,
   * which is a bounded, visible cost — the item is still saved in the
   * dashboard — rather than a silent rebuild of something deleted on purpose.
   *
   * **Why it cannot fail the request.** By the time this runs the save has
   * already succeeded and been returned. The vault being unmounted is not the
   * caller's problem, and a 500 here would make an action that worked look
   * like one that failed — which, in §7's keyboard flow, invites a retry that
   * cannot help. `promoteSavedItemToVault` never throws; every refusal is a
   * return value, logged and dropped.
   */
  function promoteToVault(itemKey: string): void {
    if (deps.vault === undefined) return;
    const outcome = promoteSavedItemToVault(deps.db, itemKey, {
      tz: deps.vault.tz,
      root: deps.vault.root,
    });
    // Silent on the paths where nothing is wrong: no vault configured (the
    // shipped configuration), the note already there, the item un-saved
    // between the write and the read. Loud on the two that mean the owner
    // expects a note and has not got one.
    if (outcome.status === 'unmounted') {
      console.warn(
        `saved-item promotion skipped: the vault is not mounted (${outcome.reason}). ` +
          `${outcome.detail}`,
      );
    } else if (outcome.status === 'refused') {
      console.warn(`saved-item promotion refused for ${itemKey} (${outcome.reason}): ${outcome.detail}`);
    }
  }

  function withKey(
    handler: (itemKey: string, now: string) => ItemState | null,
  ): (request: { params: unknown }, reply: { code: (n: number) => { send: (b: unknown) => unknown }; send: (b: unknown) => unknown }) => unknown {
    return (request, reply) => {
      const parsed = ParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid itemKey' });
      }
      return reply.send(stateJson(handler(parsed.data.itemKey, nowFn())));
    };
  }

  // Deliberately no existence check against `items`: state is keyed on
  // item_key, which survives re-versioning and retention, and a client that
  // has an item_key got it from the feed. Rejecting unknown keys would add a
  // lookup on every keystroke to prevent nothing.
  server.post('/items/:itemKey/read', withKey((k, now) => markItemRead(deps.db, k, now)));
  server.post(
    '/items/:itemKey/save',
    withKey((k, now) => {
      const state = saveItem(deps.db, k, now);
      promoteToVault(k);
      return state;
    }),
  );
  server.delete('/items/:itemKey/save', withKey((k, now) => unsaveItem(deps.db, k, now)));
  server.post('/items/:itemKey/dismiss', withKey((k, now) => dismissItem(deps.db, k, now)));

  // Read-back, mostly for tests and for a client reconciling after an
  // offline period (§7.1's PWA note, M6).
  server.get('/items/:itemKey/state', withKey((k) => getItemState(deps.db, k)));
}
