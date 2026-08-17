/**
 * The desktop shell's frontend half (M8, brief §7.3).
 *
 * ## One build serves both, and the browser must not pay for this
 *
 * `@tauri-apps/api` is imported **dynamically, and only after** the runtime
 * check below says we are inside the shell. In a browser the import never
 * happens, so Vite emits it as a separate chunk the daily driver never
 * fetches — the same discipline `MapPanel.tsx` applies to MapLibre, and for
 * the same reason. Pinned by `web/tests/shellLazy.test.ts`.
 *
 * ## Why the polling lives here and not in Rust
 *
 * Notifications need to know which items are newly pinned, which needs an
 * authenticated request, which needs the bearer token. The token is held in
 * memory for one tab and never stored (`web/src/auth/AuthContext.tsx`), and
 * moving it into a Rust process would mean persisting it to disk. So the
 * webview polls — exactly as the dashboard already does, through the same
 * `apiFetch` — and asks Rust only to draw the notification.
 *
 * §7.3: *"Neither shell ships credentials beyond the static bearer token."*
 * This ships none.
 *
 * ## Zero new endpoints
 *
 * `GET /api/feed?beat=…` already returns `override.signal.pinned` per item
 * (M3). That is the whole data dependency. §7.3 is explicit that a shell
 * needing an endpoint the web UI does not have is a signal the API is wrong.
 */

import { apiFetch } from '../api/client.ts';
import type { FeedItem } from '../api/types.ts';

/**
 * True when running inside the Tauri shell.
 *
 * Checked against the injected `__TAURI_INTERNALS__` rather than the user
 * agent: Tauri's webview reports a perfectly ordinary Safari/WebKit UA on
 * macOS, so a UA sniff would be wrong in both directions.
 */
export function isTauriShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Beats whose overrides can actually fire today. See the plan for why only these. */
const OVERRIDE_BEATS = ['cyber'] as const;

/**
 * How often the webview asks the server what is pinned.
 *
 * Five minutes, matching `AmbientView`'s refresh and for the same reason: the
 * ingest cycle runs three times a day, so polling faster cannot surface
 * anything sooner and only costs battery on a laptop.
 */
export const POLL_MS = 5 * 60_000;

interface FeedResponse {
  items: FeedItem[];
}

/** A pinned item reduced to what a notification needs. */
export interface OverrideItem {
  itemKey: string;
  title: string;
  sourceId: string;
}

/**
 * Every currently-pinned item across the beats that have live override rules.
 *
 * Exported and pure-ish so the selection logic is testable without a shell,
 * a network, or a Tauri runtime.
 */
export function pinnedFrom(items: readonly FeedItem[]): OverrideItem[] {
  return items
    .filter((i) => i.override?.signal?.pinned === true)
    .map((i) => ({ itemKey: i.itemKey, title: i.title, sourceId: i.sourceId }));
}

/**
 * Which of `current` were not in `seen`.
 *
 * Separated from the effect so the "do not shout on first load" rule is a
 * property of a pure function rather than of a timing accident. §7.4's
 * pulse rule is the same instinct: *"One pulse, not a blinking siren."*
 */
export function newSince(
  current: readonly OverrideItem[],
  seen: ReadonlySet<string>,
): OverrideItem[] {
  return current.filter((i) => !seen.has(i.itemKey));
}

/**
 * Start the shell's background behaviour. Returns a stop function.
 *
 * A no-op outside the shell, so the caller does not have to guard — the
 * browser build calls this too and nothing happens.
 */
export function startShellIntegration(token: string): () => void {
  if (!isTauriShell()) return () => {};

  let stopped = false;
  let timer: number | undefined;
  /**
   * Item keys already known to be pinned.
   *
   * Seeded on the FIRST poll without notifying. On a cold start every pinned
   * KEV entry in the corpus is "new", and a shell that announced 1,665 of
   * them at login would be uninstalled within the hour. Only what appears
   * after the shell is running is news.
   */
  const seen = new Set<string>();
  let seeded = false;

  const poll = async () => {
    if (stopped) return;
    try {
      const responses = await Promise.all(
        OVERRIDE_BEATS.map((beat) =>
          apiFetch<FeedResponse>(`/api/feed?beat=${beat}&limit=50`, token),
        ),
      );
      const pinned = responses.flatMap((r) => pinnedFrom(r.items));

      // The tray count is every pinned item, not just the new ones: it is a
      // state indicator ("this much is flagged"), where the notification is
      // an event ("this just landed").
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_tray_count', { count: pinned.length });

      if (!seeded) {
        for (const item of pinned) seen.add(item.itemKey);
        seeded = true;
        return;
      }

      const fresh = newSince(pinned, seen);
      for (const item of fresh) seen.add(item.itemKey);
      if (fresh.length === 0) return;

      const { isPermissionGranted, requestPermission, sendNotification } = await import(
        '@tauri-apps/plugin-notification'
      );
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === 'granted';
      if (!granted) return;

      // One notification for a batch, not one per item. A cycle can land
      // several KEV entries at once, and N notifications for one ingest is
      // the blinking siren §7.4 rules out.
      if (fresh.length === 1) {
        const only = fresh[0]!;
        sendNotification({ title: `Watchfloor · ${only.sourceId}`, body: only.title });
      } else {
        sendNotification({
          title: `Watchfloor · ${fresh.length} flagged items`,
          body: fresh
            .slice(0, 3)
            .map((i) => i.title)
            .join(' · '),
        });
      }
    } catch {
      // A failed poll is not an error worth showing. The dashboard in the same
      // window is already telling the reader if the API is unreachable, and a
      // second complaint from the tray adds noise, not information.
    }
  };

  void poll();
  timer = window.setInterval(() => void poll(), POLL_MS);

  return () => {
    stopped = true;
    if (timer !== undefined) window.clearInterval(timer);
  };
}
