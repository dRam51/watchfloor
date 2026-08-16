/**
 * zod → JSON Schema, for the `inputSchema` every MCP Tool must advertise
 * (M5 task 10).
 *
 * ## Why not a library
 *
 * `zod-to-json-schema` exists, and it is what `@modelcontextprotocol/sdk`
 * pulls in. This module covers the zod subset a bot-facing tool's arguments
 * can plausibly need — object, string, number/integer, boolean, enum, literal,
 * array, optional, nullable, default — in a form whose whole failure mode is a
 * loud throw. That is a smaller thing to own than a dependency, and this
 * project's standing rule is "no new runtime dependency without
 * justification".
 *
 * ## Why it throws instead of approximating
 *
 * A converter that emits `{}` for a type it does not understand produces a
 * schema that is *plausible and wrong*: the tool advertises "any object", the
 * bot sends what it likes, and the dispatcher's zod validation then rejects
 * arguments the published schema said were fine. The failure surfaces at the
 * bot, at runtime, as a contradiction. Throwing at registration surfaces it at
 * the developer, at startup, naming the property.
 *
 * ONE schema is the source of both the advertised contract and the enforced
 * one, so they cannot drift.
 */

import { z } from 'zod';

// Declared fields, not parameter properties -- see src/mcp/readonly.ts's
// SqlRefusedError for the Node-26 strip-only reason.
export class UnsupportedSchemaError extends Error {
  readonly path: string;
  readonly typeName: string;
  constructor(path: string, typeName: string) {
    super(
      `cannot express \`${path}\` (zod ${typeName}) as JSON Schema. Use one of: ` +
        `object, string, number, boolean, enum, literal, array, optional, nullable, default.`,
    );
    this.name = 'UnsupportedSchemaError';
    this.path = path;
    this.typeName = typeName;
  }
}

/**
 * The JSON Schema subset this module emits. Deliberately narrow and
 * hand-declared: the MCP `inputSchema` field is documented as "JSON Schema
 * 2020-12 when no `$schema` is present", and every key below is core to that
 * dialect.
 */
export interface JsonSchemaNode {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

type AnyZod = z.ZodTypeAny;

function defOf(schema: AnyZod): { typeName: string } & Record<string, unknown> {
  return schema._def as unknown as { typeName: string } & Record<string, unknown>;
}

interface NumberCheck {
  kind: string;
  value?: number;
}

function convertNumber(schema: AnyZod): JsonSchemaNode {
  const checks = (defOf(schema).checks ?? []) as NumberCheck[];
  const node: JsonSchemaNode = { type: checks.some((c) => c.kind === 'int') ? 'integer' : 'number' };
  for (const check of checks) {
    if (check.kind === 'min' && typeof check.value === 'number') node.minimum = check.value;
    if (check.kind === 'max' && typeof check.value === 'number') node.maximum = check.value;
  }
  return node;
}

function convertString(schema: AnyZod): JsonSchemaNode {
  const checks = (defOf(schema).checks ?? []) as NumberCheck[];
  const node: JsonSchemaNode = { type: 'string' };
  for (const check of checks) {
    if (check.kind === 'min' && typeof check.value === 'number') node.minLength = check.value;
    if (check.kind === 'max' && typeof check.value === 'number') node.maxLength = check.value;
  }
  return node;
}

/** `{ node, optional }` — optionality belongs to the PARENT's `required` list, not to the child node. */
interface Converted {
  node: JsonSchemaNode;
  optional: boolean;
}

function convert(schema: AnyZod, path: string): Converted {
  const def = defOf(schema);
  const description = schema.description;

  const withDescription = (node: JsonSchemaNode, optional = false): Converted => {
    if (description !== undefined) node.description = description;
    return { node, optional };
  };

  switch (def.typeName) {
    case 'ZodString':
      return withDescription(convertString(schema));
    case 'ZodNumber':
      return withDescription(convertNumber(schema));
    case 'ZodBoolean':
      return withDescription({ type: 'boolean' });
    case 'ZodEnum':
      return withDescription({ type: 'string', enum: [...(def.values as string[])] });
    case 'ZodLiteral':
      return withDescription({ const: def.value });
    case 'ZodArray': {
      const inner = convert(def.type as AnyZod, `${path}[]`);
      return withDescription({ type: 'array', items: inner.node });
    }
    case 'ZodOptional': {
      const inner = convert(def.innerType as AnyZod, path);
      if (description !== undefined) inner.node.description = description;
      return { node: inner.node, optional: true };
    }
    case 'ZodNullable': {
      const inner = convert(def.innerType as AnyZod, path);
      const type = inner.node.type;
      // `type: ['string', 'null']` rather than `anyOf`: the union form is
      // valid 2020-12, reads better in a tool listing, and keeps the node flat
      // for the forbidden-name walk the registry runs over it.
      inner.node.type = Array.isArray(type) ? [...type, 'null'] : type === undefined ? 'null' : [type, 'null'];
      if (description !== undefined) inner.node.description = description;
      return { node: inner.node, optional: inner.optional };
    }
    case 'ZodDefault': {
      const inner = convert(def.innerType as AnyZod, path);
      inner.node.default = (def.defaultValue as () => unknown)();
      if (description !== undefined) inner.node.description = description;
      // A defaulted property is not required -- the caller may omit it and
      // zod fills it in. Advertising it as required would make the schema
      // stricter than the validator, which is the drift this module exists to
      // prevent.
      return { node: inner.node, optional: true };
    }
    case 'ZodObject':
      return withDescription(convertObject(schema as z.ZodObject<z.ZodRawShape>, path));
    default:
      throw new UnsupportedSchemaError(path, String(def.typeName));
  }
}

function convertObject(schema: z.ZodObject<z.ZodRawShape>, path: string): JsonSchemaNode {
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];

  for (const [key, child] of Object.entries(schema.shape)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    const converted = convert(child as AnyZod, childPath);
    properties[key] = converted.node;
    if (!converted.optional) required.push(key);
  }

  const node: JsonSchemaNode = { type: 'object', properties };
  if (required.length > 0) node.required = required;
  // `additionalProperties: false` unconditionally. The spec's recommended
  // no-parameter form is `{ type: 'object', additionalProperties: false }`,
  // and a bot-facing tool that silently ignores an argument it does not
  // understand is a bot that thinks it filtered when it did not.
  node.additionalProperties = false;
  return node;
}

/**
 * The wire schema for a tool's arguments.
 *
 * The top level must be an object because `Tool.inputSchema` is an object
 * schema by definition — arguments arrive as `params.arguments`, a JSON
 * object.
 */
export function toJsonSchema(schema: z.ZodObject<z.ZodRawShape>): JsonSchemaNode {
  if (defOf(schema as AnyZod).typeName !== 'ZodObject') {
    throw new UnsupportedSchemaError('<root>', String(defOf(schema as AnyZod).typeName));
  }
  const node = convertObject(schema, '');
  const description = (schema as AnyZod).description;
  if (description !== undefined) node.description = description;
  return node;
}

/** Every property name the schema declares, at any depth. Used by the registry's §8.2 check. */
export function propertyNamesOf(node: JsonSchemaNode): string[] {
  const names: string[] = [];
  const visit = (current: JsonSchemaNode): void => {
    for (const [key, child] of Object.entries(current.properties ?? {})) {
      names.push(key);
      visit(child);
    }
    if (current.items) visit(current.items);
  };
  visit(node);
  return names;
}
