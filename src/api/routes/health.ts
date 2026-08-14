import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.ts';
import { gateStatus } from '../../cost/gate.ts';

export function registerHealth(server: FastifyInstance, deps: ServerDeps): void {
  // Deliberately unauthenticated (M3 task 1 decision — see PUBLIC_PATHS in
  // src/api/auth.ts): this is a liveness probe for process supervision
  // (§12), and its body is operational status, not item data. Every other
  // route on this server requires WF_API_TOKEN by default; this one is a
  // named exemption, not an oversight.
  server.get('/health', () => {
    const row = deps.db.prepare('select count(*) as c from schema_migrations').get() as {
      c: number;
    };
    return {
      status: 'ok',
      db: 'ok',
      migrations: row.c,
      tz: deps.env.WF_TZ,
      // Non-zero proves config/sources.yaml parsed and validated at boot.
      // Derived from the validated list rather than a separately-passed
      // count: M3 gave ServerDeps the full `sources` array (the health and
      // dashboard routes need each entry's beats and poll_interval), so a
      // second `sourceCount` field would be a copy of a fact that can drift.
      sources: deps.sources.length,
      costGates: gateStatus(),
    };
  });
}
