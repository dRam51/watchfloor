/**
 * Parses a `GET /api/search` snippet into plain/matched segments so a
 * component can render the match as emphasis (e.g. `<mark>`) instead of
 * printing the server's `[` … `]` markers literally, and WITHOUT
 * `dangerouslySetInnerHTML` (task brief, "Search" section: "build it with
 * DOM nodes rather than innerHTML" -- snippet text comes straight from
 * stored article excerpts, i.e. third-party content, so it must never be
 * parsed as markup).
 *
 * Framework-free on purpose: the actual DOM-node construction (React
 * elements, in this app) belongs to the component that calls this, so the
 * bracket-scanning logic can be unit-tested without mounting anything.
 *
 * docs/api.md, `GET /api/search`: "`snippet` marks the matched span with
 * `[` … `]`." A real snippet can contain the match MULTIPLE times (verified
 * live: `?q=AI` returns `"Import [AI] 457: [AI] stuxnet…"`), so this scans
 * the whole string rather than splitting on the first pair only.
 */
export interface SnippetSegment {
  text: string;
  matched: boolean;
}

export function parseSnippet(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let i = 0;

  while (i < snippet.length) {
    const openIdx = snippet.indexOf('[', i);
    if (openIdx === -1) {
      segments.push({ text: snippet.slice(i), matched: false });
      break;
    }
    if (openIdx > i) {
      segments.push({ text: snippet.slice(i, openIdx), matched: false });
    }

    const closeIdx = snippet.indexOf(']', openIdx + 1);
    if (closeIdx === -1) {
      // An unterminated `[` is not documented to happen -- the server always
      // pairs its markers -- but a rendering helper must not silently drop
      // content or throw if that guarantee is ever violated. Treat the rest
      // of the string as plain text rather than losing it.
      segments.push({ text: snippet.slice(openIdx), matched: false });
      break;
    }

    segments.push({ text: snippet.slice(openIdx + 1, closeIdx), matched: true });
    i = closeIdx + 1;
  }

  return segments;
}
