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
  },
});
