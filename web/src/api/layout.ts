import { apiFetch } from './client.ts';
import type { Beat } from './types.ts';

/**
 * GET/PUT /api/dashboard/layout (src/api/routes/dashboard.ts, M3 task 6) --
 * lane order and per-lane collapse state, server-side. §7.1: "Don't put any
 * of it in browser storage" -- this module is the ONLY place either value is
 * read or written; `LaneBoard.tsx` holds the result in React state for the
 * lifetime of the tab, never in localStorage/sessionStorage/a cookie.
 *
 * `PUT` is a full replace (docs/api.md): array order IS lane order, and
 * there is no partial per-lane PATCH. `saveLaneLayout` therefore always
 * takes the complete six-entry array -- a caller changing one lane's
 * `collapsed` flag must send back all six, unchanged ones included.
 */

export interface LaneLayoutEntry {
  beat: Beat;
  collapsed: boolean;
}

export interface LaneLayoutResponse {
  lanes: LaneLayoutEntry[];
}

const LAYOUT_PATH = '/api/dashboard/layout';

export function fetchLaneLayout(token: string): Promise<LaneLayoutResponse> {
  return apiFetch<LaneLayoutResponse>(LAYOUT_PATH, token);
}

export function saveLaneLayout(token: string, lanes: LaneLayoutEntry[]): Promise<LaneLayoutResponse> {
  return apiFetch<LaneLayoutResponse>(LAYOUT_PATH, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lanes }),
  });
}
