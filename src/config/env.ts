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

const EnvSchema = z.object({
  WF_DB_PATH: relativePath,
  WF_DATA_DIR: relativePath,
  WF_LOG_DIR: relativePath,
  WF_VAULT_ROOT: relativePath.optional(),
  WF_TZ: z.string().min(1).refine(isValidTimeZone, {
    message: 'must be a valid IANA timezone, e.g. America/New_York',
  }),
  WF_API_TOKEN: z.string().min(8),
  WF_API_PORT: z.coerce.number().int().positive().default(8787),
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
