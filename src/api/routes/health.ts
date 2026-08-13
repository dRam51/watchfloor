import type { FastifyInstance } from 'fastify';
import type { ServerDeps } from '../server.ts';
import { gateStatus } from '../../cost/gate.ts';

export function registerHealth(server: FastifyInstance, deps: ServerDeps): void {
  // Deliberately unauthenticated: this is a liveness probe for process
  // supervision (§12). It exposes no item data. WF_API_TOKEN is not checked
  // here or anywhere else yet — see src/config/env.ts.
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
      sources: deps.sourceCount,
      costGates: gateStatus(),
    };
  });
}
