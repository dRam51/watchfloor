/**
 * Tool registration — the seam Task 11 builds against (M5 task 10).
 *
 * The registry is where §8.2's prohibition is enforced on a tool's *shape*,
 * before it ever runs: a tool named `get_price_target`, or one accepting a
 * `positionSize` argument, is refused at registration. That is deliberately a
 * startup failure rather than a runtime one — a bot-facing tool whose very
 * signature implies a recommendation should never reach a `tools/list`.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineTool, ToolRegistry, ToolRegistryError } from '../../src/mcp/registry.ts';

const ok = { structured: { rows: [] } };

function simpleTool(name: string, inputSchema = z.object({})) {
  return defineTool({ name, description: `the ${name} tool`, inputSchema, run: () => ok });
}

describe('ToolRegistry', () => {
  it('registers and retrieves a tool', () => {
    const registry = new ToolRegistry();
    registry.register(simpleTool('get_source_health'));
    expect(registry.get('get_source_health')?.name).toBe('get_source_health');
    expect(registry.size).toBe(1);
  });

  it('returns undefined for an unknown tool rather than throwing', () => {
    expect(new ToolRegistry().get('nope')).toBeUndefined();
  });

  it('lists tools in a deterministic order, as the spec asks', () => {
    const registry = new ToolRegistry();
    registry.register(simpleTool('get_source_health'));
    registry.register(simpleTool('get_catalysts'));
    registry.register(simpleTool('get_items_for_entity'));
    expect(registry.list().map((t) => t.name)).toEqual([
      'get_catalysts',
      'get_items_for_entity',
      'get_source_health',
    ]);
  });

  it('publishes the JSON Schema derived from the tool own zod schema', () => {
    const registry = new ToolRegistry();
    registry.register(
      simpleTool('get_items_for_entity', z.object({ entity: z.string().min(1), limit: z.number().int().max(200).optional() })),
    );
    expect(registry.list()[0]!.inputSchema).toEqual({
      type: 'object',
      properties: { entity: { type: 'string', minLength: 1 }, limit: { type: 'integer', maximum: 200 } },
      required: ['entity'],
      additionalProperties: false,
    });
  });

  it('refuses a duplicate name', () => {
    const registry = new ToolRegistry();
    registry.register(simpleTool('get_source_health'));
    expect(() => registry.register(simpleTool('get_source_health'))).toThrow(ToolRegistryError);
  });

  it('refuses an empty description — a tool the model cannot understand is not a tool', () => {
    const registry = new ToolRegistry();
    const tool = defineTool({ name: 'x', description: '  ', inputSchema: z.object({}), run: () => ok });
    expect(() => registry.register(tool)).toThrow(/description/);
  });

  it.each(['has space', 'has/slash', 'has,comma', ''])('refuses the malformed name %o', (name) => {
    expect(() => new ToolRegistry().register(simpleTool(name))).toThrow(ToolRegistryError);
  });

  it('refuses a schema it cannot express on the wire, at registration', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(simpleTool('t', z.object({ when: z.date() })))).toThrow(
      /JSON Schema/,
    );
  });
});

// ---------------------------------------------------------------------------
// §8.2, enforced on the tool's SHAPE
// ---------------------------------------------------------------------------
describe('ToolRegistry and §8.2', () => {
  it.each(['get_price_target', 'sentiment_for_entity', 'position_sizing', 'recommendation'])(
    'refuses the tool name %s',
    (name) => {
      expect(() => new ToolRegistry().register(simpleTool(name))).toThrow(/§8.2/);
    },
  );

  it('refuses an ARGUMENT whose name implies a recommendation', () => {
    const registry = new ToolRegistry();
    const tool = simpleTool('get_items', z.object({ positionSize: z.number() }));
    expect(() => registry.register(tool)).toThrow(/positionSize/);
  });

  it('refuses a forbidden argument nested inside an object argument', () => {
    const registry = new ToolRegistry();
    const tool = simpleTool('get_items', z.object({ filter: z.object({ readScore: z.number() }) }));
    expect(() => registry.register(tool)).toThrow(/readScore/);
  });

  it('still allows the tool names §8.2 actually asks for', () => {
    const registry = new ToolRegistry();
    for (const name of ['get_items_for_entity', 'get_source_health', 'get_market_snapshot', 'get_catalysts', 'get_filings']) {
      expect(() => registry.register(simpleTool(name)), name).not.toThrow();
    }
    expect(registry.size).toBe(5);
  });

  it('still allows signal_score as an argument name', () => {
    expect(() =>
      new ToolRegistry().register(simpleTool('t', z.object({ minSignalScore: z.number() }))),
    ).not.toThrow();
  });
});

describe('defineTool', () => {
  it('carries the optional title through to the listing', () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({ name: 't', title: 'Human Readable', description: 'd', inputSchema: z.object({}), run: () => ok }),
    );
    expect(registry.list()[0]).toMatchObject({ name: 't', title: 'Human Readable', description: 'd' });
  });

  it('omits title entirely when there is none, rather than emitting null', () => {
    const registry = new ToolRegistry();
    registry.register(simpleTool('t'));
    expect('title' in registry.list()[0]!).toBe(false);
  });
});
