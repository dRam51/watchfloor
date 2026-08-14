import { z } from 'zod';

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// An absolute path in config is the single most common reason a service fails
// to come up on a new host (§12). Reject it here rather than at 3am on the
// target machine.
const relativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p), {
    message: 'must be a relative path — absolute paths do not survive migration',
  });

// WF_VAULT_ROOT is deliberately NOT `relativePath`. Every other WF_* path
// lives under the repo, so forcing it relative keeps it portable across
// hosts. An Obsidian vault is the opposite: it lives outside the repo by
// definition (often in a cloud-synced directory the OS manages), so a
// relative path would mean either an absolute path in disguise (a `../../..`
// climb that breaks the moment the repo moves) or nothing at all on the
// eventual Linux host. CLAUDE.md's "zero absolute paths" rule (§12) governs
// the committed *source tree* — it says nothing about the values a gitignored
// `.env` may hold, which is exactly where a machine-specific path belongs.
// See CLAUDE.md "Portability debt" for the history. Do not "fix" this back to
// relativePath — that reintroduces the defect this comment is describing.
// Windows-drive paths (a drive letter, colon, and separator) are still
// rejected: this project targets macOS/Linux hosts only, so that form is
// never meaningful here regardless of which side of "absolute" it falls on.
const vaultRootPath = z
  .string()
  .min(1)
  .refine((p) => !/^[A-Za-z]:[\\/]/.test(p), {
    message: 'must not be a Windows-style path — this project targets macOS/Linux hosts only',
  });

const EnvSchema = z.object({
  WF_DB_PATH: relativePath,
  // Optional until something reads them. Nothing in src/ consumes either one
  // yet, so requiring them made a fresh deploy hard-fail on variables that
  // change no behavior. They keep their relative-path validation for when a
  // real consumer arrives.
  WF_DATA_DIR: relativePath.optional(),
  WF_LOG_DIR: relativePath.optional(),
  WF_VAULT_ROOT: vaultRootPath.optional(),
  WF_TZ: z.string().min(1).refine(isValidTimeZone, {
    message: 'must be a valid IANA timezone, e.g. America/New_York',
  }),
  // NO ROUTE ENFORCES THIS TOKEN YET. It is validated here and then never
  // read: the only route is /health, which is deliberately public (a liveness
  // probe for process supervision). Required so the credential exists and is
  // long enough before the first authenticated route needs it — but do not
  // assume any request is being checked against it today. Authentication
  // belongs to the milestone that adds the real API surface; until then,
  // treat every route as unauthenticated. Also stated in docs/layout.md.
  WF_API_TOKEN: z.string().min(8),
  WF_API_PORT: z.coerce.number().int().positive().default(8787),
  // How often src/bin/scheduler.ts's tick loop checks which sources are due
  // (self-rescheduling setTimeout, not setInterval -- see that file). M1
  // task 10 fix round 1, minor: this used to be a hardcoded literal in
  // scheduler.ts itself, moved here once src/config/env.ts was no longer a
  // concurrently-edited sibling's file. `.positive()` (matching WF_API_PORT)
  // rejects 0 and negative values at config-load time, closing off the same
  // class of hazard as the poll_interval hardening elsewhere in this task --
  // a 0 tick would busy-loop `setTimeout(tick, 0)` indefinitely.
  WF_SCHEDULER_TICK_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new EnvError(`invalid environment:\n${lines.join('\n')}`);
  }
  return result.data;
}
