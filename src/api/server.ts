import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '../db/connection.ts';
import type { Env } from '../config/env.ts';
import { registerHealth } from './routes/health.ts';

export interface ServerDeps {
  db: Db;
  env: Env;
  /** Sources validated at boot. Surfaced by /health so a good config is observable. */
  sourceCount: number;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const server = Fastify({ logger: false });
  registerHealth(server, deps);
  return server;
}
