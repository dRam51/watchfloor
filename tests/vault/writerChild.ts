/**
 * A separate process that hammers one vault note through the REAL production
 * write path, so `tests/vault/atomicity.test.ts` can read the file
 * concurrently and kill this process mid-write.
 *
 * Not a `.test.ts` file, so vitest does not collect it (see
 * `vitest.config.ts`'s `include`). It is spawned with `node`, which runs
 * TypeScript directly on Node 26 — the same way `package.json`'s scripts run
 * `src/bin/*.ts`.
 *
 * It deliberately contains no writing logic of its own: every byte goes
 * through `openVaultSession(...).writeManagedNote(...)`. A child with its own
 * writer would prove something about the child.
 */

import { openVaultSession } from '../../src/vault/session.ts';
import { buildAlternatingNotes } from './atomicityFixture.ts';

const [root, relPath, bodyBytesArg, durationMsArg] = process.argv.slice(2);
if (root === undefined || relPath === undefined) {
  throw new Error('usage: writerChild.ts <root> <relPath> <bodyBytes> <durationMs>');
}

const [a, b] = buildAlternatingNotes(Number(bodyBytesArg ?? '0'));
const durationMs = Number(durationMsArg ?? '3000');

const session = openVaultSession(root, {
  // The caps are not what this test is about; raise them out of the way.
  maxBytesPerFile: 64 * 1024 * 1024,
  maxFilesPerRun: Number.MAX_SAFE_INTEGER,
});

const startedAt = Date.now();
let i = 0;
while (Date.now() - startedAt < durationMs) {
  session.writeManagedNote(relPath, i % 2 === 0 ? a : b);
  i += 1;
}
