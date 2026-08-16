/**
 * zod in, JSON Schema out (M5 task 10).
 *
 * `tools/list` has to advertise a JSON Schema; the dispatcher has to validate
 * arguments. If those are two separately-authored artefacts they drift, and
 * the drift is invisible — the advertised contract stays plausible while the
 * enforced one moves. So a tool declares ONE zod schema and the wire form is
 * derived from it.
 *
 * The converter throws on anything it does not understand rather than emitting
 * an approximation. A wrong schema on the wire is worse than no tool: the bot
 * would send arguments the server then rejects, with the schema insisting they
 * were fine.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toJsonSchema, UnsupportedSchemaError } from '../../src/mcp/schema.ts';

describe('toJsonSchema', () => {
  it('converts an object with required and optional properties', () => {
    const schema = z.object({
      entity: z.string().describe('The entity name, exactly as stored'),
      limit: z.number().int().optional(),
    });
    expect(toJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'The entity name, exactly as stored' },
        limit: { type: 'integer' },
      },
      required: ['entity'],
      additionalProperties: false,
    });
  });

  it('emits the no-parameter form the spec recommends', () => {
    expect(toJsonSchema(z.object({}))).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('converts enums, arrays, booleans and literals', () => {
    const schema = z.object({
      beat: z.enum(['ai', 'cyber']),
      kinds: z.array(z.string()),
      pinned: z.boolean(),
      version: z.literal(1),
    });
    expect(toJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        beat: { type: 'string', enum: ['ai', 'cyber'] },
        kinds: { type: 'array', items: { type: 'string' } },
        pinned: { type: 'boolean' },
        version: { const: 1 },
      },
      required: ['beat', 'kinds', 'pinned', 'version'],
      additionalProperties: false,
    });
  });

  it('treats a defaulted property as optional and advertises the default', () => {
    const schema = z.object({ limit: z.number().int().default(25) });
    expect(toJsonSchema(schema)).toEqual({
      type: 'object',
      properties: { limit: { type: 'integer', default: 25 } },
      additionalProperties: false,
    });
  });

  it('converts a nullable property to a type union', () => {
    const schema = z.object({ asOf: z.string().nullable() });
    expect(toJsonSchema(schema).properties?.asOf).toEqual({ type: ['string', 'null'] });
  });

  it('carries min/max on a number, which is how a limit is documented', () => {
    const schema = z.object({ limit: z.number().int().min(1).max(200) });
    expect(toJsonSchema(schema).properties?.limit).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 200,
    });
  });

  it('carries minLength on a string', () => {
    expect(toJsonSchema(z.object({ q: z.string().min(1) })).properties?.q).toEqual({
      type: 'string',
      minLength: 1,
    });
  });

  it('keeps a description written on the object itself', () => {
    const schema = z.object({ a: z.string() }).describe('the arguments');
    expect(toJsonSchema(schema).description).toBe('the arguments');
  });

  it('throws on a zod type it does not understand, rather than guessing', () => {
    expect(() => toJsonSchema(z.object({ when: z.date() }))).toThrow(UnsupportedSchemaError);
  });

  it('names the offending property path when it throws', () => {
    expect(() => toJsonSchema(z.object({ outer: z.object({ when: z.date() }) }))).toThrow(
      /outer\.when/,
    );
  });

  it('requires the top level to be an object, as the Tool schema does', () => {
    expect(() => toJsonSchema(z.string() as unknown as z.ZodObject<z.ZodRawShape>)).toThrow(
      UnsupportedSchemaError,
    );
  });
});
