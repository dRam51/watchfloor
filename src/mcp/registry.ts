/**
 * Tool registration — **the seam Task 11 builds against** (M5 task 10).
 *
 * A tool is four things and no more: a name, a description, a zod schema for
 * its arguments, and a `run` that takes the parsed arguments and a context.
 * Everything else — the credential check, the JSON-RPC framing, the §8.2
 * serializer, the query log, the read-only database handle — belongs to
 * src/mcp/server.ts and is inherited, not re-implemented per tool.
 *
 * That division is the point. §8.2's prohibitions are enforced at the
 * boundary, so a tool written in M6 by someone who never read §8.2 is still
 * bound by it. This is the same shape as src/api/auth.ts's root-instance hook:
 * *"a task author who adds a new route and does nothing auth-related gets a
 * protected route by default"*.
 *
 * ---------------------------------------------------------------------------
 * What the registry itself enforces, at REGISTRATION
 * ---------------------------------------------------------------------------
 * Two §8.2 checks run before a tool can exist, and both are startup failures:
 *
 * 1. **The tool's NAME.** `get_price_target` is refused. A bot-facing tool
 *    whose signature implies a recommendation must never reach a `tools/list`,
 *    because by then a model has already read it and formed an expectation.
 * 2. **Every ARGUMENT name, at any depth.** A tool accepting `positionSize`
 *    means the bot is telling Watchfloor its position size, which is the same
 *    boundary crossed in the other direction.
 *
 * Plus the ordinary hygiene the wire needs: a legal, unique name, a non-empty
 * description, and a schema that can actually be expressed as JSON Schema —
 * checked here rather than at `tools/list` time, so an unconvertible schema
 * fails while someone is watching.
 */

import type { z } from 'zod';
import { forbiddenPhraseFor } from './fields.ts';
import type { JsonValue } from './serialize.ts';
import type { ReadOnlyCorpus } from './readonly.ts';
import { propertyNamesOf, toJsonSchema, UnsupportedSchemaError, type JsonSchemaNode } from './schema.ts';

/**
 * Everything a tool is given. Deliberately small.
 *
 * `corpus` is the read-only handle (src/mcp/readonly.ts) and is the ONLY route
 * to data — a tool cannot open its own connection, because it is handed one
 * and imports nothing that could open another (pinned by
 * tests/mcp/sourceProperties.test.ts).
 *
 * `now` is a canonical timestamp fixed once per request, following this
 * codebase's standing convention that *now is always a parameter, never read
 * from the system clock internally* (src/score/decay.ts, src/score/rank.ts,
 * and the M5 controller ruling on `generatedAt`). Two tools called in one
 * request see the same instant; a point-in-time read is reproducible.
 */
export interface McpToolContext {
  readonly corpus: ReadOnlyCorpus;
  readonly now: string;
}

export interface McpToolResult {
  /**
   * The machine-readable answer. Goes out as `structuredContent`, and as JSON
   * text alongside it for backwards compatibility, exactly as the spec
   * suggests. **Passed through the §8.2 serializer by the dispatcher**, so a
   * tool cannot emit a forbidden field whatever it puts here.
   */
  readonly structured: JsonValue;
  /** Prose for the model. Defaults to the JSON of `structured`. */
  readonly text?: string;
  /**
   * A tool EXECUTION error (`isError: true`) — *"actionable feedback that
   * language models can use to self-correct"*. Not for server bugs; those
   * throw and become protocol errors.
   */
  readonly isError?: boolean;
  /** Row count for the query log, when the answer is countable. */
  readonly rows?: number;
}

export interface McpTool<Args> {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  run(args: Args, ctx: McpToolContext): McpToolResult | Promise<McpToolResult>;
}

export interface ToolSpec<S extends z.ZodObject<z.ZodRawShape>> {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: S;
  run(args: z.infer<S>, ctx: McpToolContext): McpToolResult | Promise<McpToolResult>;
}

/**
 * Ties `run`'s argument type to `inputSchema` so a tool cannot declare one
 * shape and destructure another. Task 11 should use this rather than writing
 * the interface out by hand.
 */
export function defineTool<S extends z.ZodObject<z.ZodRawShape>>(spec: ToolSpec<S>): McpTool<z.infer<S>> {
  return spec;
}

/** A tool as `tools/list` publishes it. */
export interface ToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaNode;
}

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRegistryError';
  }
}

// "The following SHOULD be the only allowed characters: uppercase and
// lowercase ASCII letters, digits, underscore, hyphen, and dot", 1-128 long.
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

interface Registered<Args> {
  readonly tool: McpTool<Args>;
  readonly descriptor: ToolDescriptor;
}

export class ToolRegistry {
  readonly #tools = new Map<string, Registered<never>>();

  get size(): number {
    return this.#tools.size;
  }

  register<Args>(tool: McpTool<Args>): void {
    if (!TOOL_NAME.test(tool.name)) {
      throw new ToolRegistryError(
        `tool name ${JSON.stringify(tool.name)} is not legal: 1-128 characters from ` +
          `[A-Za-z0-9_.-], no spaces or commas`,
      );
    }
    if (this.#tools.has(tool.name)) {
      throw new ToolRegistryError(`tool ${tool.name} is already registered`);
    }
    if (tool.description.trim().length === 0) {
      throw new ToolRegistryError(`tool ${tool.name} needs a non-empty description — the model reads it`);
    }

    const namePhrase = forbiddenPhraseFor(tool.name);
    if (namePhrase !== null) {
      throw new ToolRegistryError(
        `tool name ${tool.name} matches the forbidden rule "${namePhrase}" (§8.2: Watchfloor must ` +
          `never expose sentiment, directional labels, price targets, conviction ratings, trade ` +
          `signals, position sizing, or any field whose name implies a recommendation)`,
      );
    }

    let inputSchema: JsonSchemaNode;
    try {
      inputSchema = toJsonSchema(tool.inputSchema);
    } catch (cause) {
      if (cause instanceof UnsupportedSchemaError) {
        throw new ToolRegistryError(`tool ${tool.name} has an input schema that cannot be published as JSON Schema: ${cause.message}`);
      }
      throw cause;
    }

    for (const property of propertyNamesOf(inputSchema)) {
      const phrase = forbiddenPhraseFor(property);
      if (phrase !== null) {
        throw new ToolRegistryError(
          `tool ${tool.name} declares the argument \`${property}\`, which matches the forbidden ` +
            `rule "${phrase}" (§8.2). The boundary holds in both directions: the bot does not tell ` +
            `Watchfloor its positions either.`,
        );
      }
    }

    const descriptor: ToolDescriptor = {
      name: tool.name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      description: tool.description,
      inputSchema,
    };
    this.#tools.set(tool.name, { tool, descriptor } as unknown as Registered<never>);
  }

  get(name: string): McpTool<never> | undefined {
    return this.#tools.get(name)?.tool;
  }

  /**
   * Sorted by name. *"Servers SHOULD return tools in a deterministic order
   * ... Deterministic ordering enables clients to reliably cache the tool list
   * and improves LLM prompt cache hit rates."* Registration order would be
   * deterministic too, but it is deterministic by accident — it changes when
   * a composition root is reordered.
   */
  list(): ToolDescriptor[] {
    return [...this.#tools.values()]
      .map((entry) => entry.descriptor)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
}
