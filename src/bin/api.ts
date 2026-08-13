import { join } from 'node:path';
import { loadEnv } from '../config/env.ts';
import { openDatabase } from './openDatabase.ts';
import { runMigrations } from '../db/migrate.ts';
import { buildServer } from '../api/server.ts';

const env = loadEnv();
const db = openDatabase(env.WF_DB_PATH);

// Resolved relative to this module, not the process cwd: a process
// supervisor (§12) may launch us from any working directory. This file lives
// at src/bin/api.ts, so two levels up is the repo root.
const migrationsDir = join(import.meta.dirname, '..', '..', 'db', 'migrations');
const applied = runMigrations(db, migrationsDir);
if (applied.length > 0) console.log(`applied migrations: ${applied.join(', ')}`);

const server = buildServer({ db, env });
// Bind to loopback only; external reach is via Tailscale (§2).
await server.listen({ port: env.WF_API_PORT, host: '127.0.0.1' });
console.log(`watchfloor api listening on 127.0.0.1:${env.WF_API_PORT} (TZ=${env.WF_TZ})`);
