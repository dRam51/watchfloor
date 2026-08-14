import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from '../db/connection.ts';
import type { Env } from '../config/env.ts';
import { registerHealth } from './routes/health.ts';
import { registerAuth } from './auth.ts';

export interface ServerDeps {
  db: Db;
  env: Env;
  /** Sources validated at boot. Surfaced by /health so a good config is observable. */
  sourceCount: number;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const server = Fastify({ logger: false });
  // Registered first, at the root instance, before any route exists yet.
  // Because this hook is added at the root (not inside a `.register()`
  // plugin context), Fastify's encapsulation model makes it apply to every
  // route regardless of registration order — a route added by a later task,
  // or even by a test after buildServer() returns, is still covered. See
  // src/api/auth.ts for the exemption list and the reasoning behind it.
  registerAuth(server, deps.env.WF_API_TOKEN);
  registerHealth(server, deps);
  return server;
}
