import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    // Only web/tests/*.test.tsx needs a JSX transform. vitest.config.ts
    // (unlike vite.config.ts) does not load @vitejs/plugin-react, so this
    // is set explicitly rather than left to tsconfig auto-discovery, which
    // vitest's esbuild pipeline is not guaranteed to walk up to
    // web/tsconfig.json for.
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  test: {
    // Backend tests default to `node` (most touch node:sqlite, fs, real
    // temp-file databases). Frontend component tests need a DOM and opt
    // into `jsdom` per-file via the `// @vitest-environment jsdom` magic
    // comment at the top of each web/tests/*.test.tsx file (see
    // web/tests/App.test.tsx and web/tests/motion.test.ts) rather than
    // flipping this default globally, which would be wrong for every
    // existing backend test.
    include: ['tests/**/*.test.ts', 'web/tests/**/*.test.tsx', 'web/tests/**/*.test.ts'],
    environment: 'node',

    // =====================================================================
    // 30s, not vitest's default 5s, and the default was never a choice this
    // repo made -- it was simply never set.
    //
    // Six test files spawn REAL child processes (`execFile` against
    // src/bin/*.ts): the CLI's delegation tests, the vault and MCP
    // entrypoints, the portability script, and the atomicity tests. That is
    // deliberate and is what gives those tests their value -- a composition
    // root is exactly the code no in-process test exercises. Each spawn pays
    // Node startup plus TypeScript type-stripping plus the module graph, and
    // several tests spawn TWICE (run migrate, then run it again to prove
    // idempotence).
    //
    // Idle, the slowest is ~2s. But vitest runs test FILES in parallel across
    // 10 cores, so a spawn-heavy test competes with ~3,600 other tests for
    // the same CPU, and 5s stopped being enough:
    //
    //     tests/cli/bin.test.ts  > runs the real migration entrypoint
    //     tests/vault/bin.test.ts > is idempotent
    //         Error: Test timed out in 5000ms      (passed in isolation)
    //
    // Set globally rather than per-test on purpose. A per-test override fixes
    // the two that happened to cross the line today and is forgotten by
    // whoever writes the next spawn test, which is how this flake returns.
    // The class needs the budget, not the instances.
    //
    // The signal is not lost: a genuinely hung test still fails, at 30s
    // instead of 5s, against a suite that already runs 60-120s.
    // =====================================================================
    testTimeout: 30_000,
    // Hooks spawn too -- tests/vault/bin.test.ts builds a real corpus in
    // beforeAll. A hook that outlives its own budget fails the whole file
    // with a message about the hook rather than the test, which is a worse
    // thing to debug than a slow one.
    hookTimeout: 30_000,
  },
});
