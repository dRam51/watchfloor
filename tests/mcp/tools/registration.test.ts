/**
 * The composition root, and the pin that stops a tool shipping unreachable
 * (M5 task 11).
 *
 * This project has now hit the unowned-seam pattern **seven** times — M3's
 * `registerItems`, M4a's `github_search` adapter, star snapshots and README
 * enricher, M5's `writeDailyNote`, `promoteSavedItem` and the whole Wave 1 LLM
 * stack. Every one was correctly built, fully tested, and called by nothing.
 *
 * So the reachability of these five tools is not left to a live run to
 * discover. `src/mcp/tools.ts` is asserted to reference every tool factory this
 * package exports, `registerBotTools` is asserted to be called by
 * `src/bin/mcp.ts`, and the published `tools/list` is asserted to contain
 * §8.2's five by name. Deleting a `registry.register(...)` line goes red here.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openReadOnlyCorpus, type ReadOnlyCorpus } from '../../../src/mcp/readonly.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import { createMcpServer } from '../../../src/mcp/server.ts';
import { registerBotTools } from '../../../src/mcp/tools.ts';
import { authedRequest, decode, TEST_MCP_TOKEN } from '../fixture.ts';
import { seedRealCorpus } from './fixture.ts';

const repoRoot = join(import.meta.dirname, '..', '..', '..');

const open: ReadOnlyCorpus[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});

/** §8.2's five, verbatim, plus Task 10's own diagnostic. */
const SECTION_8_2_TOOLS = [
  'get_catalysts',
  'get_filings',
  'get_items_for_entity',
  'get_market_snapshot',
  'get_source_health',
];

function registry(): ToolRegistry {
  const reg = new ToolRegistry();
  // No deps argument: this exercises the PRODUCTION path, which reads the real
  // config/sources.yaml and config/decay.yaml. A malformed config is then a
  // startup failure with someone watching, not a first-tools/call surprise.
  registerBotTools(reg);
  return reg;
}

describe('registerBotTools', () => {
  it('registers §8.2\'s five tools against the real config files', () => {
    const names = registry().list().map((tool) => tool.name);
    for (const name of SECTION_8_2_TOOLS) expect(names).toContain(name);
  });

  it('registers exactly six tools — the five plus describe_boundary, and nothing stray', () => {
    expect(registry().list().map((t) => t.name)).toEqual([...SECTION_8_2_TOOLS, 'describe_boundary'].sort());
  });

  it('publishes a non-empty description and an object schema for every one', () => {
    for (const tool of registry().list()) {
      expect(tool.description.trim().length).toBeGreaterThan(30);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('every §8.2 query tool advertises asOf — the point-in-time clause, visible to the model', () => {
    for (const tool of registry().list()) {
      if (tool.name === 'describe_boundary') continue;
      expect(Object.keys(tool.inputSchema.properties ?? {})).toContain('asOf');
    }
  });
});

describe('reachability', () => {
  const composition = readFileSync(join(repoRoot, 'src', 'mcp', 'tools.ts'), 'utf8');

  it('is checking a real file — the non-vacuity check', () => {
    expect(composition).toContain('registerBotTools');
  });

  it('references every tool factory this package exports', () => {
    const dir = join(repoRoot, 'src', 'mcp', 'tools');
    const factories: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      const text = readFileSync(join(dir, name), 'utf8');
      for (const match of text.matchAll(/export function (create[A-Za-z0-9_]*Tools?)\(/g)) {
        factories.push(match[1]!);
      }
    }
    // If this list is empty the assertion below is vacuous, which is exactly
    // how an unreachable component ships.
    expect(factories.length).toBeGreaterThanOrEqual(3);
    expect(factories.filter((factory) => !composition.includes(`${factory}(`))).toEqual([]);
  });

  it('is called by the real entrypoint, not only by tests', () => {
    const bin = readFileSync(join(repoRoot, 'src', 'bin', 'mcp.ts'), 'utf8');
    expect(bin).toContain('registerBotTools(registry)');
  });
});

describe('tools/list, over the wire', () => {
  it('publishes all six to an authenticated client', async () => {
    const corpus = openReadOnlyCorpus(seedRealCorpus());
    open.push(corpus);
    const server = createMcpServer({
      corpus,
      token: TEST_MCP_TOKEN,
      registry: registry(),
      log: { record: () => {} },
      now: () => '2026-08-16T00:00:00.000Z',
    });
    const response = decode(await server.handle(authedRequest('tools/list')));
    const tools = (response.result?.tools ?? []) as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual([...SECTION_8_2_TOOLS, 'describe_boundary'].sort());
  });
});
