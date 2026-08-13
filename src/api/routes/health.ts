import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/connection.ts';
import type { Env } from '../../config/env.ts';
import { gateStatus } from '../../cost/gate.ts';

export function registerHealth(server: FastifyInstance, deps: { db: Db; env: Env }): void {
  // Deliberately unauthenticated: this is a liveness probe for process
  // supervision (§12). It exposes no item data.
  server.get('/health', () => {
    const row = deps.db.prepare('select count(*) as c from schema_migrations').get() as {
      c: number;
    };
    return {
      status: 'ok',
      db: 'ok',
      migrations: row.c,
      tz: deps.env.WF_TZ,
      costGates: gateStatus(),
    };
  });
}
