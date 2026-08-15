import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOllamaBackend, OLLAMA_CHAT_PATH } from '../../../src/enrich/llm/ollama.ts';
import { LlmPromptTooLargeError, isLlmOk } from '../../../src/enrich/llm/types.ts';
import type { LlmConfig } from '../../../src/enrich/llm/config.ts';

// ---------------------------------------------------------------------------
// Real local http servers, no mocks -- the pattern tests/fetch/http.test.ts and
// tests/fetch/github.test.ts established. The BODIES these servers serve are
// real, captured live from the Ollama daemon running on this machine on
// 2026-08-15 (see tests/fixtures/ollama/). Nothing here reaches the network.
// ---------------------------------------------------------------------------

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'tests', 'fixtures', 'ollama', name), 'utf8');
}

const CHAT_200 = fixture('chat-200.json');
const CHAT_200_LENGTH = fixture('chat-200-length.json');
const CHAT_404 = fixture('chat-404-model-missing.json');

const openServers: Server[] = [];

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected an AddressInfo from an ephemeral TCP listener');
  }
  return `http://127.0.0.1:${address.port}`;
}

/** An address nothing is listening on: bound, then closed before use. */
async function deadAddress(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected an AddressInfo');
  const url = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return url;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

const NOW = '2026-08-15T06:39:56.760Z';
const MODEL = 'llama3.2:latest';

function configFor(baseUrl: string, overrides: Partial<LlmConfig['limits']> = {}): LlmConfig {
  return {
    backend: 'ollama',
    limits: {
      timeoutMs: 5_000,
      maxPromptChars: 24_000,
      maxResponseBytes: 1_048_576,
      maxOutputTokens: 512,
      ...overrides,
    },
    ollama: { baseUrl, model: MODEL, temperature: 0, keepAlive: '5m' },
  };
}

/** Serves one captured body at the chat path, and records what was received. */
async function serveChat(status: number, body: string): Promise<{ baseUrl: string; seen: () => Received }> {
  const received: Received = { count: 0, path: null, method: null, body: null };
  const baseUrl = await serve((req, res) => {
    void (async () => {
      received.count += 1;
      received.path = req.url ?? null;
      received.method = req.method ?? null;
      received.body = await readBody(req);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    })();
  });
  return { baseUrl, seen: () => received };
}

interface Received {
  count: number;
  path: string | null;
  method: string | null;
  body: string | null;
}

// ---------------------------------------------------------------------------
// The completion that worked
// ---------------------------------------------------------------------------

describe('a real captured completion', () => {
  it('returns the text the model produced', async () => {
    const { baseUrl } = await serveChat(200, CHAT_200);
    const result = await createOllamaBackend(configFor(baseUrl)).complete(
      { prompt: 'In one sentence, what is a CVE?' },
      { now: NOW },
    );

    expect(isLlmOk(result)).toBe(true);
    if (!isLlmOk(result)) throw new Error('unreachable');
    expect(result.text).toContain('CVE');
    expect(result.finish).toBe('stop');
  });

  it('reports the model the daemon named, not the one config asked for', async () => {
    // A config saying `llama3.2` and a daemon resolving `llama3.2:latest` are
    // the same model with two names; the answer's provenance is the daemon's.
    const { baseUrl } = await serveChat(200, CHAT_200);
    const config = configFor(baseUrl);
    config.ollama.model = 'llama3.2';
    const result = await createOllamaBackend(config).complete({ prompt: 'hi' }, { now: NOW });

    if (!isLlmOk(result)) throw new Error('expected ok');
    expect(result.model).toBe('llama3.2:latest');
  });

  it('reports the token counts the daemon returned', async () => {
    // 42 / 27 are the real numbers in the captured response.
    const { baseUrl } = await serveChat(200, CHAT_200);
    const result = await createOllamaBackend(configFor(baseUrl)).complete({ prompt: 'hi' }, { now: NOW });

    expect(result.usage).toEqual({
      inputTokens: 42,
      outputTokens: 27,
      totalTokens: 69,
      counted: true,
    });
  });

  it('reports a measured zero cost against the ollama-local registry entry', async () => {
    const { baseUrl } = await serveChat(200, CHAT_200);
    const result = await createOllamaBackend(configFor(baseUrl)).complete({ prompt: 'hi' }, { now: NOW });

    expect(result.cost.amountUsd).toBe(0);
    expect(result.cost.measured).toBe(true);
    expect(result.cost.serviceId).toBe('ollama-local');
  });

  it('carries the injected now, and never reads a clock for it', async () => {
    const { baseUrl } = await serveChat(200, CHAT_200);
    const result = await createOllamaBackend(configFor(baseUrl)).complete({ prompt: 'hi' }, { now: NOW });

    expect(result.asOf).toBe(NOW);
    expect(Number.isFinite(result.latencyMs)).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('refuses a non-canonical now rather than recording a guess', async () => {
    const { baseUrl } = await serveChat(200, CHAT_200);
    await expect(
      createOllamaBackend(configFor(baseUrl)).complete({ prompt: 'hi' }, { now: '2026-08-15' }),
    ).rejects.toThrow();
  });
});

describe('the request it sends', () => {
  it('POSTs the chat endpoint with the configured model and a non-streaming body', async () => {
    const { baseUrl, seen } = await serveChat(200, CHAT_200);
    await createOllamaBackend(configFor(baseUrl)).complete({ prompt: 'hi' }, { now: NOW });

    const sent = JSON.parse(seen().body!) as Record<string, unknown>;
    expect(seen().method).toBe('POST');
    expect(seen().path).toBe(OLLAMA_CHAT_PATH);
    expect(sent.model).toBe(MODEL);
    expect(sent.stream).toBe(false);
  });

  it('sends the system instruction as its own message', async () => {
    const { baseUrl, seen } = await serveChat(200, CHAT_200);
    await createOllamaBackend(configFor(baseUrl)).complete(
      { system: 'You are a terse technical summarizer.', prompt: 'What is a CVE?' },
      { now: NOW },
    );

    const sent = JSON.parse(seen().body!) as { messages: Array<{ role: string; content: string }> };
    expect(sent.messages).toEqual([
      { role: 'system', content: 'You are a terse technical summarizer.' },
      { role: 'user', content: 'What is a CVE?' },
    ]);
  });

  it('omits the system message entirely when there is none', async () => {
    const { baseUrl, seen } = await serveChat(200, CHAT_200);
    await createOllamaBackend(configFor(baseUrl)).complete({ prompt: 'hi' }, { now: NOW });

    const sent = JSON.parse(seen().body!) as { messages: Array<{ role: string }> };
    expect(sent.messages.map((m) => m.role)).toEqual(['user']);
  });

  it('caps generation server-side from config, and carries temperature and keep_alive', async () => {
    const { baseUrl, seen } = await serveChat(200, CHAT_200);
    await createOllamaBackend(configFor(baseUrl)).complete({ prompt: 'hi' }, { now: NOW });

    const sent = JSON.parse(seen().body!) as {
      options: { num_predict: number; temperature: number };
      keep_alive: string;
    };
    expect(sent.options.num_predict).toBe(512);
    expect(sent.options.temperature).toBe(0);
    expect(sent.keep_alive).toBe('5m');
  });

  it('lets one call override the output cap without editing config', async () => {
    const { baseUrl, seen } = await serveChat(200, CHAT_200);
    await createOllamaBackend(configFor(baseUrl)).complete(
      { prompt: 'hi', maxOutputTokens: 32 },
      { now: NOW },
    );

    const sent = JSON.parse(seen().body!) as { options: { num_predict: number } };
    expect(sent.options.num_predict).toBe(32);
  });
});

describe('hitting the output cap is a completion, not a failure', () => {
  it('reports finish: length and still returns the text', async () => {
    // Captured live with num_predict: 8 -- the daemon answered 200 with
    // done_reason "length" and eight real tokens. Folding that into
    // `unavailable` would throw away a legitimate, if short, answer.
    const { baseUrl } = await serveChat(200, CHAT_200_LENGTH);
    const result = await createOllamaBackend(configFor(baseUrl)).complete({ prompt: 'hi' }, { now: NOW });

    if (!isLlmOk(result)) throw new Error('expected ok');
    expect(result.finish).toBe('length');
    expect(result.text).toBe('The OWASP (Open Web Application Security');
    expect(result.usage.outputTokens).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Every way it can be unavailable
// ---------------------------------------------------------------------------

describe('the daemon is not running', () => {
  it('reports not_running rather than throwing, because that is an ordinary state', async () => {
    const backend = createOllamaBackend(configFor(await deadAddress()));
    const result = await backend.complete({ prompt: 'hi' }, { now: NOW });

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('unreachable');
    expect(result.reason).toBe('not_running');
    expect(result.retryable).toBe(true);
  });

  it('still reports usage and a measured zero cost for the call that never happened', async () => {
    const backend = createOllamaBackend(configFor(await deadAddress()));
    const result = await backend.complete({ prompt: 'hi' }, { now: NOW });

    expect(result.usage.counted).toBe(false);
    expect(result.usage.totalTokens).toBeNull();
    expect(result.cost.amountUsd).toBe(0);
    expect(result.cost.measured).toBe(true);
  });

  it('names the model that was asked for, so the operator can check the config', async () => {
    const backend = createOllamaBackend(configFor(await deadAddress()));
    const result = await backend.complete({ prompt: 'hi' }, { now: NOW });
    expect(result.model).toBe(MODEL);
  });
});

describe('the daemon is running but the model is not installed', () => {
  it('reports model_missing, distinctly from not_running', async () => {
    // Captured live: Ollama answers 404 with {"error":"model '…' not found"}.
    // Collapsing this into a generic error would send the operator to restart
    // a daemon that is already healthy.
    const { baseUrl } = await serveChat(404, CHAT_404);
    const result = await createOllamaBackend(configFor(baseUrl)).complete({ prompt: 'hi' }, { now: NOW });

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toBe('model_missing');
    expect(result.detail).toContain('not found');
  });

  it('is not retryable, because retrying cannot pull a model', async () => {
    const { baseUrl } = await serveChat(404, CHAT_404);
    const result = await createOllamaBackend(configFor(baseUrl)).complete({ prompt: 'hi' }, { now: NOW });

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.retryable).toBe(false);
  });
});

describe('other http outcomes', () => {
  it('classifies a 5xx as retryable', async () => {
    const { baseUrl } = await serveChat(503, '{"error":"server busy"}');
    const result = await createOllamaBackend(configFor(baseUrl)).complete({ prompt: 'hi' }, { now: NOW });

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toBe('http_error');
    expect(result.retryable).toBe(true);
    expect(result.detail).toContain('server busy');
  });

  it('classifies a 4xx that is not a 404 as permanent', async () => {
    const { baseUrl } = await serveChat(400, '{"error":"invalid options"}');
    const result = await createOllamaBackend(configFor(baseUrl)).complete({ prompt: 'hi' }, { now: NOW });

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toBe('http_error');
    expect(result.retryable).toBe(false);
  });
});

describe('a 200 whose body is not what the daemon documents', () => {
  it('reports malformed_response rather than an empty completion', async () => {
    // The single most dangerous outcome for this module: `''` stored as an
    // enrichment result is indistinguishable from a real one forever.
    const { baseUrl } = await serveChat(200, '{"model":"x","done":true}');
    const result = await createOllamaBackend(configFor(baseUrl)).complete({ prompt: 'hi' }, { now: NOW });

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toBe('malformed_response');
  });

  it('reports malformed_response for a body that is not JSON at all', async () => {
    const { baseUrl } = await serveChat(200, 'not json');
    const result = await createOllamaBackend(configFor(baseUrl)).complete({ prompt: 'hi' }, { now: NOW });

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toBe('malformed_response');
  });

  it('is not retryable -- the same daemon returns the same shape a moment later', async () => {
    const { baseUrl } = await serveChat(200, 'not json');
    const result = await createOllamaBackend(configFor(baseUrl)).complete({ prompt: 'hi' }, { now: NOW });

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The bounds
// ---------------------------------------------------------------------------

describe('timeout', () => {
  it('reports timeout when the daemon never answers', async () => {
    const baseUrl = await serve(() => {
      // Deliberately never responds. A local model really can hang.
    });
    const result = await createOllamaBackend(configFor(baseUrl, { timeoutMs: 150 })).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toBe('timeout');
    expect(result.retryable).toBe(true);
  });

  it('lets one call set its own deadline', async () => {
    const baseUrl = await serve(() => {});
    const result = await createOllamaBackend(configFor(baseUrl, { timeoutMs: 60_000 })).complete(
      { prompt: 'hi' },
      { now: NOW, timeoutMs: 150 },
    );

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toBe('timeout');
  });
});

describe('response byte ceiling', () => {
  it('aborts a response that exceeds the ceiling instead of buffering it whole', async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Streams far past the ceiling. If the ceiling were not enforced while
      // streaming, this would be buffered in full before anything noticed.
      const chunk = 'x'.repeat(64 * 1024);
      for (let i = 0; i < 64; i += 1) res.write(chunk);
      res.end();
    });

    const result = await createOllamaBackend(configFor(baseUrl, { maxResponseBytes: 4096 })).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toBe('response_too_large');
    expect(result.retryable).toBe(false);
  });

  it('lets one call raise its own ceiling', async () => {
    const { baseUrl } = await serveChat(200, CHAT_200);
    const result = await createOllamaBackend(configFor(baseUrl, { maxResponseBytes: 8 })).complete(
      { prompt: 'hi' },
      { now: NOW, maxResponseBytes: 1_048_576 },
    );

    expect(result.status).toBe('ok');
  });
});

describe('prompt ceiling', () => {
  it('throws rather than truncating, and sends no request at all', async () => {
    // A caller-side error a retry cannot fix. Truncating instead would
    // summarise half an article with total confidence.
    const { baseUrl, seen } = await serveChat(200, CHAT_200);
    const backend = createOllamaBackend(configFor(baseUrl, { maxPromptChars: 100 }));

    await expect(backend.complete({ prompt: 'x'.repeat(101) }, { now: NOW })).rejects.toThrow(
      LlmPromptTooLargeError,
    );
    expect(seen().count).toBe(0);
  });

  it('counts the system instruction against the same ceiling', async () => {
    const { baseUrl } = await serveChat(200, CHAT_200);
    const backend = createOllamaBackend(configFor(baseUrl, { maxPromptChars: 100 }));

    await expect(
      backend.complete({ system: 'x'.repeat(60), prompt: 'y'.repeat(60) }, { now: NOW }),
    ).rejects.toThrow(LlmPromptTooLargeError);
  });

  it('reports both the size and the ceiling so a caller can trim to fit', async () => {
    const { baseUrl } = await serveChat(200, CHAT_200);
    const backend = createOllamaBackend(configFor(baseUrl, { maxPromptChars: 100 }));

    await expect(backend.complete({ prompt: 'x'.repeat(150) }, { now: NOW })).rejects.toMatchObject({
      chars: 150,
      maxChars: 100,
    });
  });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe('the backend describes itself without making a request', () => {
  it('publishes its name, its configured model, and its cost-registry id', async () => {
    const backend = createOllamaBackend(configFor(await deadAddress()));
    expect(backend.name).toBe('ollama');
    expect(backend.model).toBe(MODEL);
    expect(backend.serviceId).toBe('ollama-local');
  });
});

// ---------------------------------------------------------------------------
// Why /api/chat and not /api/generate
// ---------------------------------------------------------------------------

describe('the endpoint choice, against both real captured responses', () => {
  it('avoids /api/generate, whose response carries a context token array chat does not', async () => {
    // Both captured live from the same daemon, same model, same prompt.
    // /api/generate returns a `context` array -- the full tokenised
    // conversation -- which more than doubles the response for a value this
    // module never reads. /api/chat also takes the system role natively
    // instead of requiring it to be concatenated into one prompt string.
    const generate = JSON.parse(fixture('generate-200.json')) as Record<string, unknown>;
    const chat = JSON.parse(CHAT_200) as Record<string, unknown>;

    expect(Array.isArray(generate.context)).toBe(true);
    expect(chat.context).toBeUndefined();
    expect(fixture('generate-200.json').length).toBeGreaterThan(CHAT_200.length * 1.5);
    expect(OLLAMA_CHAT_PATH).toBe('/api/chat');
  });
});
