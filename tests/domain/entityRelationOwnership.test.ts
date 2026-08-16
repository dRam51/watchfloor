import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **One implementation of the related-entity relation, pinned as a property of
 * the source tree** (M5 task 17).
 *
 * Task 7's report:
 *
 * > `planEntityNotes(...).related` is the first computation of that relation in
 * > the tree — recommend lifting it to `src/domain/` when the endpoint is
 * > built, rather than an API route importing a vault module.
 *
 * Both halves of that sentence are checked here, because both are the kind of
 * thing that is true on the day it is written and quietly stops being true.
 * The failure mode a behaviour test cannot see is a SECOND implementation:
 * `src/api/routes/entities.ts` growing its own co-occurrence loop would keep
 * every test in this repository green while the endpoint and the vault slowly
 * disagreed about what "related" means — and a disagreement between a note in
 * the owner's knowledge base and a graph on the dashboard is exactly the kind
 * of defect nobody reports, because both look plausible.
 *
 * The marker for "has its own implementation" is a call to `getItemEntities(`
 * with a counting loop around it, which is what the pre-lift vault planner
 * did. It is a proxy rather than a proof, but it is the shape the defect
 * actually takes here, and it is the shape a reviewer would recognise.
 */

const SRC = 'src';
const DOMAIN_MODULE = join(SRC, 'domain', 'entityGraph.ts');
const VAULT_ENTITIES = join(SRC, 'vault', 'entities.ts');
const API_ROUTE = join(SRC, 'api', 'routes', 'entities.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('the relation lives in src/domain, and is called from both consumers', () => {
  it('src/domain/entityGraph.ts is where it is defined', () => {
    expect(read(DOMAIN_MODULE)).toMatch(/export function countRelatedEntities\s*\(/);
  });

  it('the vault planner calls it rather than computing its own', () => {
    const vault = read(VAULT_ENTITIES);
    expect(vault, 'src/vault/entities.ts does not import the domain relation').toContain(
      "from '../domain/entityGraph.ts'",
    );
    expect(vault).toMatch(/\bcountRelatedEntities\s*\(/);
  });

  it('the vault planner no longer accumulates co-occurrence itself', () => {
    // The pre-lift implementation was a loop over `getItemEntities` keeping a
    // `Map<string, number>`. If that comes back, there are two answers again.
    expect(read(VAULT_ENTITIES)).not.toMatch(/\bgetItemEntities\s*\(/);
  });

  it('the API route calls it rather than computing its own', () => {
    const route = read(API_ROUTE);
    expect(route).toMatch(/from '\.\.\/\.\.\/domain\/entityGraph\.ts'/);
    expect(route).not.toMatch(/\bgetItemEntities\s*\(/);
  });
});

describe('the API route does not reach into the vault', () => {
  it('imports nothing from src/vault/', () => {
    // src/api/routes/items.ts legitimately does (M5 task 15 threads saved-item
    // promotion through the save transition), so this is scoped to the route
    // that has no business there: the vault is the highest-risk subsystem in
    // the milestone — its bugs destroy hand-written work — and a read-only
    // graph query is not a reason to put it on a web request path.
    expect(read(API_ROUTE)).not.toMatch(/from '[^']*vault\//);
  });
});
