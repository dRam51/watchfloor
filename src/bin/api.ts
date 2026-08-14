import { join } from 'node:path';
import { loadEnv } from '../config/env.ts';
import { openDatabase } from '../db/openDatabase.ts';
import { assertMigrationsUpToDate } from '../db/migrate.ts';
import { loadSourcesFile } from '../sources/load.ts';
import { loadDecayConfig } from '../score/decay.ts';
import { loadOverridesConfig } from '../score/overrides.ts';
import { buildServer } from '../api/server.ts';
import { closeDb } from '../db/connection.ts';

// Resolved relative to this module, not the process cwd: a process
// supervisor (§12) may launch us from any working directory. This file lives
// at src/bin/api.ts, so two levels up is the repo root.
const repoRoot = join(import.meta.dirname, '..', '..');

try {
  const env = loadEnv();
  const db = openDatabase(env.WF_DB_PATH);

  // Entrypoints no longer auto-apply migrations (see src/db/migrate.ts's
  // doc comment on assertMigrationsUpToDate) — a routine boot must not be
  // the thing that silently applies whatever *.sql happens to be sitting in
  // db/migrations/, including a colleague's uncommitted work in progress.
  // Run `npm run migrate` first; this throws a clear message naming what is
  // pending if that has not happened yet.
  const { backfilledChecksums } = assertMigrationsUpToDate(db, join(repoRoot, 'db', 'migrations'));
  if (backfilledChecksums.length > 0) {
    console.log(
      `backfilled checksum for previously-applied migration(s) with no recorded checksum: ` +
        `${backfilledChecksums.join(', ')}`,
    );
  }

  // Validate the feed config at boot. Nothing polls these yet, but a
  // malformed sources.yaml that is only read at first poll fails at the
  // worst possible moment — hours later, in a scheduler, far from the deploy
  // that broke it. Fail here instead, while someone is still watching.
  const sources = loadSourcesFile(join(repoRoot, 'config', 'sources.yaml'));

  // Scoring config is loaded at boot for the same reason as sources.yaml: the
  // feed route applies decay and hard overrides on every request, so a
  // malformed decay.yaml or overrides.yaml should stop the process here,
  // while someone is watching, rather than 500ing on the first page load.
  const decayConfig = loadDecayConfig(join(repoRoot, 'config', 'decay.yaml'));
  const overridesConfig = loadOverridesConfig(join(repoRoot, 'config', 'overrides.yaml'));

  const server = buildServer({ db, env, sources, decayConfig, overridesConfig });
  // Bind to loopback only; external reach is via Tailscale (§2).
  await server.listen({ port: env.WF_API_PORT, host: '127.0.0.1' });
  console.log(
    `watchfloor api listening on 127.0.0.1:${env.WF_API_PORT} ` +
      `(TZ=${env.WF_TZ}, sources=${sources.length})`,
  );

  // Close the server before the database: an in-flight request still holds a
  // statement against it.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      console.log(`${signal} received, shutting down`);
      server
        .close()
        .catch((err: unknown) => console.error(`server close failed: ${(err as Error).message}`))
        .finally(() => {
          closeDb(db);
          process.exit(0);
        });
    });
  }
} catch (err) {
  // EnvError, DatabaseOpenError and SourceConfigError all carry messages
  // written specifically to name the offending variable, path, or config
  // line. A raw stack trace buries exactly that.
  console.error((err as Error).message);
  process.exit(1);
}
