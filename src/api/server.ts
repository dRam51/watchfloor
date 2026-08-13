import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '../db/connection.ts';
import type { Env } from '../config/env.ts';
import { registerHealth } from './routes/health.ts';

export function buildServer(deps: { db: Db; env: Env }): FastifyInstance {
  const server = Fastify({ logger: false });
  registerHealth(server, deps);
  return server;
}
