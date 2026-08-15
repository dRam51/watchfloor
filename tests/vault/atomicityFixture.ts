/**
 * The two note bodies the atomicity test alternates between, built the same
 * way in the parent and in the spawned child so the parent can classify what
 * it reads as "exactly A", "exactly B", or "torn" with no ambiguity.
 */

import { renderManagedNote, type ManagedContent } from '../../src/vault/frontmatter.ts';

const GENERATED_AT = '2026-08-15T07:00:00.000Z';

export function buildAlternatingNotes(bodyBytes: number): [ManagedContent, ManagedContent] {
  const size = Math.max(bodyBytes, 1);
  return [
    renderManagedNote({
      tier: 'fully-managed',
      generatedAt: GENERATED_AT,
      body: `# A\n\n${'a'.repeat(size)}`,
    }),
    renderManagedNote({
      tier: 'fully-managed',
      generatedAt: GENERATED_AT,
      body: `# B\n\n${'b'.repeat(size)}`,
    }),
  ];
}
