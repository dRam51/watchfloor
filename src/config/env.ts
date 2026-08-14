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

// Node's setTimeout/setInterval `delay` argument is internally a 32-bit
// signed integer; anything larger silently clamps to 1ms rather than being
// rejected. See WF_SCHEDULER_TICK_INTERVAL_MS's own comment for why that
// matters here specifically (M1 task 10 fix round 2).
const MAX_SETTIMEOUT_DELAY_MS = 2_147_483_647; // 2^31 - 1

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
  // Enforced by src/api/auth.ts's onRequest hook (M3 task 1) against every
  // route except /health, which stays public as a liveness probe. Compared
  // via a constant-time, fixed-length digest comparison — see that file for
  // why a plain `===` or a bare crypto.timingSafeEqual would leak timing.
  WF_API_TOKEN: z.string().min(8),
  WF_API_PORT: z.coerce.number().int().positive().default(8787),
  // M4a task 1. A read-only GitHub PAT, consumed by src/fetch/github.ts.
  //
  // OPTIONAL, and that is a design decision rather than leniency: the client
  // has a real unauthenticated mode (60 core requests/hour, 10 search
  // requests/minute, both confirmed live) and reports which mode it is in, so
  // an absent token is a supported configuration. The PAT raises those
  // ceilings to 5,000/hour and 30/minute. The owner creates it; no code here
  // may attempt to.
  //
  // Deliberately NOT `.min(1)`, unlike WF_API_TOKEN above. A `.env` line left
  // as `WF_GITHUB_TOKEN=` reads as '' rather than undefined, and rejecting
  // that would let an optional variable stop the process from booting — the
  // opposite of optional. GitHubClient trims and treats '' as absent, so the
  // reported mode stays honest.
  //
  // Also deliberately unvalidated in shape. GitHub has used `ghp_`,
  // `github_pat_`, and a bare 40-hex form; a prefix check here would reject a
  // legitimate future format and require editing this file to fix it. The API
  // is the authority on whether a credential works.
  //
  // This value is a live credential against the owner's GitHub account and
  // this repository is PUBLIC. It must never be logged, echoed into an error,
  // or committed — see src/fetch/github.ts for how that is enforced and
  // tests/fetch/github.test.ts for the guards that pin it.
  WF_GITHUB_TOKEN: z.string().optional(),
  // How often src/bin/scheduler.ts's tick loop checks which sources are due
  // (self-rescheduling setTimeout, not setInterval -- see that file). M1
  // task 10 fix round 1, minor: this used to be a hardcoded literal in
  // scheduler.ts itself, moved here once src/config/env.ts was no longer a
  // concurrently-edited sibling's file. `.positive()` (matching WF_API_PORT)
  // rejects 0 and negative values at config-load time, closing off the same
  // class of hazard as the poll_interval hardening elsewhere in this task --
  // a 0 tick would busy-loop `setTimeout(tick, 0)` indefinitely.
  //
  // `.max(MAX_SETTIMEOUT_DELAY_MS)` (M1 task 10 fix round 2, small item):
  // Node's setTimeout/setInterval delay is a 32-bit signed integer
  // internally -- a value above 2^31-1 is not rejected, it is silently
  // clamped to 1ms (confirmed empirically: `setTimeout(fn, 2147483648)`
  // emits a TimeoutOverflowWarning and fires after ~1ms, not ~24.8 days as
  // the literal value would suggest). An operator-supplied value THAT large
  // would therefore reproduce the exact busy-loop hazard `.positive()` above
  // exists to prevent, just from the opposite end of the range.
  WF_SCHEDULER_TICK_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_SETTIMEOUT_DELAY_MS)
    .default(60_000),
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
