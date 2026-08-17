import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  isTauriShell,
  newSince,
  pinnedFrom,
  startShellIntegration,
  POLL_MS,
  type OverrideItem,
} from '../src/shell/tauri.ts';
import type { FeedItem } from '../src/api/types.ts';

/**
 * **The occurrence-eleven guard** (M8).
 *
 * CLAUDE.md's table records ten components that were correctly built, fully
 * tested, and reachable from nothing. A desktop shell integration is a
 * textbook candidate: if `App.tsx` never calls it, the shell still opens, the
 * dashboard still renders, and it simply never notifies — with `tsc` clean and
 * every unit test green.
 *
 * So this file asserts three separate things, because they fail independently:
 *
 * 1. The integration is **called** from the composition root.
 * 2. It is **inert in a browser** — the daily driver must not pay for it.
 * 3. Its selection logic is **correct**, in particular that a cold start does
 *    not announce the entire back catalogue.
 */

const APP = readFileSync(join(process.cwd(), 'web', 'src', 'App.tsx'), 'utf8');
const CODE = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** A FeedItem is large; these tests only touch four fields. */
function item(itemKey: string, pinned: boolean, title = itemKey): FeedItem {
  return {
    itemKey,
    title,
    sourceId: 'cisa-kev',
    override: { signal: { pinned }, read: { pinned: false } },
  } as unknown as FeedItem;
}

describe('the shell integration is reachable from App.tsx', () => {
  it('is imported and called', () => {
    expect(CODE).toContain("from './shell/tauri.ts'");
    expect(CODE).toMatch(/\bstartShellIntegration\s*\(/);
  });

  it('is called unconditionally, not behind an isTauriShell() guard at the call site', () => {
    // Two places deciding "are we in the shell?" is one place too many, and
    // the call-site copy is the one that rots. The module owns that test and
    // returns a no-op; App.tsx must not second-guess it.
    expect(
      /isTauriShell\s*\(\s*\)/.test(CODE),
      'App.tsx re-tests for the shell at the call site; startShellIntegration already does',
    ).toBe(false);
  });

  it('cleans up on unmount, so a token change does not leave a second poller running', () => {
    expect(CODE).toMatch(/return startShellIntegration\(token\);/);
  });
});

describe('it is inert in a browser', () => {
  it('reports not-a-shell when __TAURI_INTERNALS__ is absent', () => {
    expect(isTauriShell()).toBe(false);
  });

  it('startShellIntegration is a no-op that still returns a callable stop function', () => {
    // The contract App.tsx relies on: safe to call, safe to call the result.
    const stop = startShellIntegration('a-token');
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });

  it('never imports @tauri-apps at module scope', () => {
    // A static import would pull the Tauri API into the browser's entry chunk.
    // Every `@tauri-apps` reference in this module must be a dynamic import
    // inside the shell-only branch.
    const src = readFileSync(join(process.cwd(), 'web', 'src', 'shell', 'tauri.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(
      /^\s*import\s[^\n]*from\s+['"]@tauri-apps/m.test(code),
      'a static @tauri-apps import would ship the Tauri API to every browser visitor',
    ).toBe(false);
    expect(code).toMatch(/await import\(\s*['"]@tauri-apps/);
  });
});

describe('what it would notify about', () => {
  it('selects only pinned items', () => {
    const picked = pinnedFrom([item('a', true), item('b', false), item('c', true)]);
    expect(picked.map((p) => p.itemKey)).toEqual(['a', 'c']);
  });

  it('treats nothing as new when everything was already seen', () => {
    const current: OverrideItem[] = [{ itemKey: 'a', title: 'A', sourceId: 's' }];
    expect(newSince(current, new Set(['a']))).toEqual([]);
  });

  it('reports only what appeared since the last look', () => {
    const current: OverrideItem[] = [
      { itemKey: 'a', title: 'A', sourceId: 's' },
      { itemKey: 'b', title: 'B', sourceId: 's' },
    ];
    expect(newSince(current, new Set(['a'])).map((i) => i.itemKey)).toEqual(['b']);
  });

  it('would announce the entire back catalogue if the first poll were not seeded', () => {
    // THE reason the poller seeds silently on its first pass. `cisa-kev` dumps
    // its whole 1,665-entry catalogue on a cold start (CLAUDE.md), so an
    // unseeded shell would fire a notification for every one of them at login.
    // This test states the size of that mistake rather than describing it.
    const catalogue = Array.from({ length: 1665 }, (_, i) => item(`kev-${i}`, true));
    expect(newSince(pinnedFrom(catalogue), new Set()).length).toBe(1665);
  });

  it('polls on a cycle measured in minutes, not seconds', () => {
    // The ingest cycle runs three times a day; polling faster cannot surface
    // anything sooner and only costs battery.
    expect(POLL_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe('the shell ships no credentials and adds no endpoints', () => {
  const RUST = readFileSync(join(process.cwd(), 'src-tauri', 'src', 'lib.rs'), 'utf8');

  it('the Rust side never mentions a token', () => {
    // §7.3: "Neither shell ships credentials beyond the static bearer token."
    // The design goal is stronger -- Rust never sees one at all, so there is
    // nothing to persist. A `token` appearing here means the polling moved,
    // and the credential moved with it.
    expect(/token/i.test(RUST.replace(/\/\/.*$/gm, ''))).toBe(false);
  });

  it('calls only endpoints the web UI already uses', () => {
    // M8's stated deliverable: "both shells run against the unmodified API
    // with zero shell-specific endpoints."
    const src = readFileSync(join(process.cwd(), 'web', 'src', 'shell', 'tauri.ts'), 'utf8');
    const paths = src.match(/apiFetch<[^>]*>\(\s*`([^`]+)`/g) ?? [];
    for (const p of paths) {
      expect(p, `shell calls an endpoint outside /api/feed: ${p}`).toContain('/api/feed');
    }
  });
});

describe('the shell does not leak into the browser bundle', () => {
  const ASSETS = join(process.cwd(), 'web', 'dist', 'assets');
  const built = existsSync(ASSETS);
  const maybe = built ? it : it.skip;

  maybe('the entry chunk contains no Tauri API code', () => {
    // The ENTRY is whatever index.html actually loads, read from the HTML
    // rather than guessed from the filename. Vite named the Tauri chunk
    // `index-*.js` too, so a filename-prefix match would have compared the
    // wrong file against itself and passed for the wrong reason.
    const html = readFileSync(join(process.cwd(), 'web', 'dist', 'index.html'), 'utf8');
    const entry = html.match(/<script[^>]*src="\/assets\/([^"]+\.js)"/)?.[1];
    expect(entry, 'could not find the entry script in index.html').toBeDefined();

    const text = readFileSync(join(ASSETS, entry!), 'utf8');
    // `__TAURI_INTERNALS__` IS expected here -- it is the feature-detect
    // string in `isTauriShell()`, a few bytes. What must not be here is the
    // plugin implementation the dynamic import fetches.
    expect(
      text.includes('plugin:notification'),
      `${entry} carries the Tauri notification plugin -- the dynamic import was hoisted`,
    ).toBe(false);
  });

  maybe('the Tauri chunk exists, so the split is real rather than empty', () => {
    // Without this, a build that dropped the integration entirely would pass
    // the assertion above. The absence of a thing only means something
    // alongside evidence the thing exists.
    const chunks = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
    const withPlugin = chunks.filter((f) =>
      readFileSync(join(ASSETS, f), 'utf8').includes('plugin:notification'),
    );
    expect(withPlugin.length, 'no chunk contains the notification plugin at all').toBeGreaterThan(0);
  });

  maybe('index.html does not preload the Tauri chunk', () => {
    const html = readFileSync(join(process.cwd(), 'web', 'dist', 'index.html'), 'utf8');
    const chunks = readdirSync(ASSETS).filter((f) =>
      readFileSync(join(ASSETS, f), 'utf8').includes('plugin:notification'),
    );
    for (const chunk of chunks) {
      expect(html.includes(`modulepreload`) && html.includes(chunk), chunk).toBe(false);
    }
  });
});
