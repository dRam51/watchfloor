import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ANTHROPIC_API_KEY_ENV_VAR,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_PATH,
  ANTHROPIC_SERVICE_ID,
  AnthropicCredentialError,
  AnthropicSamplingUnsupportedError,
  createAnthropicBackend,
  parseAnthropicConfig,
} from '../../../src/enrich/llm/anthropic.ts';
import {
  DEFAULT_LLM_CONFIG_PATH,
  LlmConfigError,
  loadLlmConfig,
} from '../../../src/enrich/llm/config.ts';
import { LlmPromptTooLargeError, isLlmOk } from '../../../src/enrich/llm/types.ts';
import type { LlmConfig } from '../../../src/enrich/llm/config.ts';

// ---------------------------------------------------------------------------
// Real local http servers, no mocks -- the pattern tests/fetch/http.test.ts,
// tests/fetch/github.test.ts and tests/enrich/llm/ollama.test.ts established.
//
// NOTHING HERE REACHES api.anthropic.com. Every `base_url` below points at an
// ephemeral loopback listener this file started, and the api key is a literal
// fake. There is no Anthropic credential on this machine and this suite must
// never require one.
// ---------------------------------------------------------------------------

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

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'tests', 'fixtures', 'anthropic', name), 'utf8');
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

interface Received {
  count: number;
  path: string | null;
  method: string | null;
  headers: Record<string, string | string[] | undefined>;
  body: string | null;
}

/** Serves one body at any path, and records everything it was sent. */
async function serveMessages(
  status: number,
  body: string,
): Promise<{ baseUrl: string; seen: () => Received }> {
  const received: Received = { count: 0, path: null, method: null, headers: {}, body: null };
  const baseUrl = await serve((req, res) => {
    void (async () => {
      received.count += 1;
      received.path = req.url ?? null;
      received.method = req.method ?? null;
      received.headers = req.headers;
      received.body = await readBody(req);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    })();
  });
  return { baseUrl, seen: () => received };
}

const NOW = '2026-08-15T06:39:56.760Z';
const MODEL = 'claude-opus-5';
const FAKE_KEY = 'sk-ant-not-a-real-key-fixture-only';

function configFor(baseUrl: string, overrides: Partial<LlmConfig['limits']> = {}): LlmConfig {
  return {
    backend: 'anthropic',
    limits: {
      timeoutMs: 5_000,
      maxPromptChars: 24_000,
      maxResponseBytes: 1_048_576,
      maxOutputTokens: 512,
      ...overrides,
    },
    ollama: { baseUrl: 'http://127.0.0.1:1', model: 'unused-here' },
    anthropic: {
      base_url: baseUrl,
      model: MODEL,
      pricing: {
        usd_per_million_input_tokens: 5,
        usd_per_million_output_tokens: 25,
      },
    },
  };
}

/** The env of a machine that has never opted in to paid inference. */
const NO_FLAGS: NodeJS.ProcessEnv = {};

/** The env of an owner who has deliberately turned spending on. */
function enabledEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { WF_ALLOW_PAID_ANTHROPIC: '1', [ANTHROPIC_API_KEY_ENV_VAR]: FAKE_KEY, ...extra };
}

// ---------------------------------------------------------------------------
// The flag is unset: the code path is hard-disabled (§15)
// ---------------------------------------------------------------------------

describe('with WF_ALLOW_PAID_ANTHROPIC unset', () => {
  it('still constructs, so the API and dashboard can report the feature as off', async () => {
    // §15 requires "the API returns a clear 'disabled by cost policy' status,
    // and the dashboard shows the feature as off" -- which is only possible if
    // a disabled backend is a real object with an identity, rather than a
    // construction-time throw.
    const { baseUrl } = await serveMessages(200, '{}');
    const backend = createAnthropicBackend(configFor(baseUrl), NO_FLAGS);

    expect(backend.name).toBe('anthropic');
    expect(backend.model).toBe(MODEL);
    expect(backend.serviceId).toBe(ANTHROPIC_SERVICE_ID);
    expect(backend.enabled).toBe(false);
  });

  it('needs no api key to construct, because it can never make a request', async () => {
    // This is the configuration on the machine this was written on: no
    // credential exists. A disabled backend that demanded one would make the
    // "shows as off" path impossible to reach.
    const { baseUrl } = await serveMessages(200, '{}');
    expect(() => createAnthropicBackend(configFor(baseUrl), NO_FLAGS)).not.toThrow();
  });

  it('reports disabled_by_cost_policy rather than throwing', async () => {
    const { baseUrl } = await serveMessages(200, '{}');
    const result = await createAnthropicBackend(configFor(baseUrl), NO_FLAGS).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('unreachable');
    expect(result.reason).toBe('disabled_by_cost_policy');
  });

  it('is not retryable -- a deferred retry is the exact shape §15 forbids', async () => {
    const { baseUrl } = await serveMessages(200, '{}');
    const result = await createAnthropicBackend(configFor(baseUrl), NO_FLAGS).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.retryable).toBe(false);
  });

  it('fires no request at all', async () => {
    // The whole point. A gate that is consulted but not obeyed reads the same
    // in a status field and costs money.
    const { baseUrl, seen } = await serveMessages(200, '{}');
    await createAnthropicBackend(configFor(baseUrl), NO_FLAGS).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    expect(seen().count).toBe(0);
  });

  it('reports an unmeasured cost, never a placeholder $0', async () => {
    // A billable backend with no token counts must report `null` -- the
    // measured-zero branch of computeCost belongs to free-forever backends
    // only (see src/enrich/llm/types.ts).
    const { baseUrl } = await serveMessages(200, '{}');
    const result = await createAnthropicBackend(configFor(baseUrl), NO_FLAGS).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    expect(result.cost.amountUsd).toBeNull();
    expect(result.cost.measured).toBe(false);
    expect(result.cost.serviceId).toBe(ANTHROPIC_SERVICE_ID);
    expect(result.usage.counted).toBe(false);
  });

  it('carries the injected now and reads no clock', async () => {
    const { baseUrl } = await serveMessages(200, '{}');
    const result = await createAnthropicBackend(configFor(baseUrl), NO_FLAGS).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    expect(result.asOf).toBe(NOW);
    expect(Number.isFinite(result.latencyMs)).toBe(true);
  });

  it('names the model that was asked for, so the header can say what is off', async () => {
    const { baseUrl } = await serveMessages(200, '{}');
    const result = await createAnthropicBackend(configFor(baseUrl), NO_FLAGS).complete(
      { prompt: 'hi' },
      { now: NOW },
    );
    expect(result.model).toBe(MODEL);
  });
});

describe('argument validation happens whether or not the gate is open', () => {
  it('refuses a non-canonical now even while disabled', async () => {
    // A dry run with the flag off has to be a real rehearsal: turning the flag
    // on must not change which inputs the backend rejects.
    const { baseUrl } = await serveMessages(200, '{}');
    await expect(
      createAnthropicBackend(configFor(baseUrl), NO_FLAGS).complete(
        { prompt: 'hi' },
        { now: '2026-08-15' },
      ),
    ).rejects.toThrow();
  });

  it('refuses an oversized prompt even while disabled, and sends nothing', async () => {
    const { baseUrl, seen } = await serveMessages(200, '{}');
    const backend = createAnthropicBackend(configFor(baseUrl, { maxPromptChars: 100 }), NO_FLAGS);

    await expect(backend.complete({ prompt: 'x'.repeat(101) }, { now: NOW })).rejects.toThrow(
      LlmPromptTooLargeError,
    );
    expect(seen().count).toBe(0);
  });
});

describe('the gate can only tighten within one backend lifetime', () => {
  it('stays disabled when the flag is set after construction', async () => {
    // A backend built while the gate was shut never read a credential, so it
    // has nothing to spend with. Re-reading the flag later and quietly
    // becoming live would be the silent enablement §15 forbids in reverse.
    const { baseUrl, seen } = await serveMessages(200, '{}');
    const env: NodeJS.ProcessEnv = {};
    const backend = createAnthropicBackend(configFor(baseUrl), env);

    env.WF_ALLOW_PAID_ANTHROPIC = '1';
    env[ANTHROPIC_API_KEY_ENV_VAR] = FAKE_KEY;
    const result = await backend.complete({ prompt: 'hi' }, { now: NOW });

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toBe('disabled_by_cost_policy');
    expect(seen().count).toBe(0);
  });

  it('goes disabled when the flag is cleared after construction', async () => {
    const { baseUrl, seen } = await serveMessages(200, '{}');
    const env = enabledEnv();
    const backend = createAnthropicBackend(configFor(baseUrl), env);
    expect(backend.enabled).toBe(true);

    delete env.WF_ALLOW_PAID_ANTHROPIC;
    const result = await backend.complete({ prompt: 'hi' }, { now: NOW });

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toBe('disabled_by_cost_policy');
    expect(seen().count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------

describe('the api key', () => {
  it('is required once the flag is set, and refuses to construct without one', async () => {
    const { baseUrl } = await serveMessages(200, '{}');
    expect(() =>
      createAnthropicBackend(configFor(baseUrl), { WF_ALLOW_PAID_ANTHROPIC: '1' }),
    ).toThrow(AnthropicCredentialError);
  });

  it('treats a blank value as absent, the way WF_GITHUB_TOKEN is treated', async () => {
    const { baseUrl } = await serveMessages(200, '{}');
    expect(() =>
      createAnthropicBackend(configFor(baseUrl), {
        WF_ALLOW_PAID_ANTHROPIC: '1',
        [ANTHROPIC_API_KEY_ENV_VAR]: '   ',
      }),
    ).toThrow(AnthropicCredentialError);
  });

  it('ignores a machine-wide ANTHROPIC_API_KEY', async () => {
    // A developer machine with Claude Code installed very plausibly exports
    // ANTHROPIC_API_KEY. Honouring it would let this project spend on a
    // credential nobody handed it -- the opposite of an explicit opt-in.
    const { baseUrl } = await serveMessages(200, '{}');
    expect(() =>
      createAnthropicBackend(configFor(baseUrl), {
        WF_ALLOW_PAID_ANTHROPIC: '1',
        ANTHROPIC_API_KEY: 'sk-ant-someone-elses-key',
      }),
    ).toThrow(AnthropicCredentialError);
  });

  it('never puts the key in the error it throws when one is missing', async () => {
    const { baseUrl } = await serveMessages(200, '{}');
    let message = '';
    try {
      createAnthropicBackend(configFor(baseUrl), {
        WF_ALLOW_PAID_ANTHROPIC: '1',
        ANTHROPIC_API_KEY: 'sk-ant-someone-elses-key',
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(ANTHROPIC_API_KEY_ENV_VAR);
    expect(message).not.toContain('sk-ant-someone-elses-key');
  });
});

// ---------------------------------------------------------------------------
// The config block
// ---------------------------------------------------------------------------

describe('the anthropic config block', () => {
  it('refuses to build a backend when config/llm.yaml has no anthropic block', () => {
    const config = configFor('http://127.0.0.1:1');
    delete config.anthropic;
    expect(() => createAnthropicBackend(config, NO_FLAGS)).toThrow(LlmConfigError);
  });

  it('rejects a zero rate, which would report a measured $0 for a billable call', () => {
    // computeCost prices a zero-rate backend as measured $0 unconditionally.
    // That is correct for ollama-local and a lie for a service that bills, so
    // the rate is refused at config load rather than believed at read time.
    const config = configFor('http://127.0.0.1:1');
    (config.anthropic!.pricing as Record<string, number>).usd_per_million_input_tokens = 0;
    expect(() => createAnthropicBackend(config, NO_FLAGS)).toThrow(LlmConfigError);
  });

  it('rejects a non-http base url', () => {
    const config = configFor('api.anthropic.com');
    expect(() => createAnthropicBackend(config, NO_FLAGS)).toThrow(LlmConfigError);
  });

  it('rejects a missing model rather than picking one', () => {
    const config = configFor('http://127.0.0.1:1');
    delete config.anthropic!.model;
    expect(() => createAnthropicBackend(config, NO_FLAGS)).toThrow(LlmConfigError);
  });

  it('rejects an unknown key rather than silently ignoring it', () => {
    const config = configFor('http://127.0.0.1:1');
    config.anthropic!.temperature = 0;
    expect(() => createAnthropicBackend(config, NO_FLAGS)).toThrow(LlmConfigError);
  });
});

// ---------------------------------------------------------------------------
// The flag is set: the request it would actually send.
//
// Every test below runs against a loopback listener with a fake key. The
// bodies come from tests/fixtures/anthropic/, which are SYNTHETIC -- see the
// README there for why, and for what these tests therefore do and do not
// prove.
// ---------------------------------------------------------------------------

describe('the request it sends once spending is allowed', () => {
  it('POSTs the messages endpoint with the configured model', async () => {
    const { baseUrl, seen } = await serveMessages(200, fixture('messages-200.json'));
    await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    expect(seen().method).toBe('POST');
    expect(seen().path).toBe(ANTHROPIC_MESSAGES_PATH);
    const sent = JSON.parse(seen().body!) as Record<string, unknown>;
    expect(sent.model).toBe(MODEL);
  });

  it('authenticates with x-api-key and pins the api version', async () => {
    const { baseUrl, seen } = await serveMessages(200, fixture('messages-200.json'));
    await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    expect(seen().headers['x-api-key']).toBe(FAKE_KEY);
    expect(seen().headers['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
  });

  it('never puts the key in the url, where it would reach logs and history', async () => {
    const { baseUrl, seen } = await serveMessages(200, fixture('messages-200.json'));
    await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    expect(seen().path).not.toContain(FAKE_KEY);
    expect(seen().body).not.toContain(FAKE_KEY);
  });

  it('sends the system instruction as a top-level field, not a message role', async () => {
    // Anthropic has no `system` message role -- a system turn in `messages`
    // is a 400 on this API. This is the one shape difference from ollama's
    // /api/chat that a copy-paste would get wrong.
    const { baseUrl, seen } = await serveMessages(200, fixture('messages-200.json'));
    await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { system: 'You are a terse technical summarizer.', prompt: 'What is a CVE?' },
      { now: NOW },
    );

    const sent = JSON.parse(seen().body!) as {
      system: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(sent.system).toBe('You are a terse technical summarizer.');
    expect(sent.messages).toEqual([{ role: 'user', content: 'What is a CVE?' }]);
  });

  it('omits system entirely when there is none', async () => {
    const { baseUrl, seen } = await serveMessages(200, fixture('messages-200.json'));
    await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    const sent = JSON.parse(seen().body!) as Record<string, unknown>;
    expect('system' in sent).toBe(false);
  });

  it('caps generation from the shared limits block', async () => {
    const { baseUrl, seen } = await serveMessages(200, fixture('messages-200.json'));
    await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    const sent = JSON.parse(seen().body!) as { max_tokens: number };
    expect(sent.max_tokens).toBe(512);
  });

  it('lets one call override the output cap without editing config', async () => {
    const { baseUrl, seen } = await serveMessages(200, fixture('messages-200.json'));
    await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi', maxOutputTokens: 32 },
      { now: NOW },
    );

    const sent = JSON.parse(seen().body!) as { max_tokens: number };
    expect(sent.max_tokens).toBe(32);
  });

  it('sends no sampling parameters, which current models reject outright', async () => {
    const { baseUrl, seen } = await serveMessages(200, fixture('messages-200.json'));
    await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    const sent = JSON.parse(seen().body!) as Record<string, unknown>;
    expect('temperature' in sent).toBe(false);
    expect('top_p' in sent).toBe(false);
    expect('top_k' in sent).toBe(false);
  });

  it('refuses a per-call temperature rather than dropping it silently', async () => {
    // LlmRequest.temperature exists for ollama, where it is honoured. On
    // current Anthropic models temperature is REMOVED and returns a 400, so
    // forwarding it breaks every call and dropping it gives the caller a
    // sampler setting it never got. Refusing is the only honest option.
    const { baseUrl, seen } = await serveMessages(200, fixture('messages-200.json'));
    const backend = createAnthropicBackend(configFor(baseUrl), enabledEnv());

    await expect(backend.complete({ prompt: 'hi', temperature: 0 }, { now: NOW })).rejects.toThrow(
      AnthropicSamplingUnsupportedError,
    );
    expect(seen().count).toBe(0);
  });
});

describe('a documented 200', () => {
  it('returns the text the model produced', async () => {
    const { baseUrl } = await serveMessages(200, fixture('messages-200.json'));
    const result = await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'In one sentence, what is a CVE?' },
      { now: NOW },
    );

    if (!isLlmOk(result)) throw new Error('expected ok');
    expect(result.text).toContain('CVE');
    expect(result.finish).toBe('stop');
    expect(result.backend).toBe('anthropic');
  });

  it('reports the model the api named, not the one config asked for', async () => {
    const { baseUrl } = await serveMessages(200, fixture('messages-200.json'));
    const config = configFor(baseUrl);
    config.anthropic!.model = 'claude-opus-5-something-else';
    const result = await createAnthropicBackend(config, enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    if (!isLlmOk(result)) throw new Error('expected ok');
    expect(result.model).toBe(MODEL);
  });

  it('reports the token counts the api returned', async () => {
    const { baseUrl } = await serveMessages(200, fixture('messages-200.json'));
    const result = await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    expect(result.usage).toEqual({
      inputTokens: 42,
      outputTokens: 27,
      totalTokens: 69,
      counted: true,
    });
  });

  it('prices the call at the configured published rates', async () => {
    // 42 input at $5/MTok + 27 output at $25/MTok.
    const { baseUrl } = await serveMessages(200, fixture('messages-200.json'));
    const result = await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    expect(result.cost.measured).toBe(true);
    expect(result.cost.amountUsd).toBeCloseTo(0.000885, 9);
    expect(result.cost.serviceId).toBe(ANTHROPIC_SERVICE_ID);
  });

  it('reports an unmeasured cost when the api returned no usage block', async () => {
    // The distinction src/enrich/llm/types.ts exists to preserve: a billable
    // call with uncounted tokens is UNKNOWN, never $0.
    const { baseUrl } = await serveMessages(200, fixture('messages-200-no-usage.json'));
    const result = await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    expect(isLlmOk(result)).toBe(true);
    expect(result.usage.counted).toBe(false);
    expect(result.cost.amountUsd).toBeNull();
    expect(result.cost.measured).toBe(false);
  });

  it('treats hitting the output cap as a completion, not a failure', async () => {
    const { baseUrl } = await serveMessages(200, fixture('messages-200-max-tokens.json'));
    const result = await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    if (!isLlmOk(result)) throw new Error('expected ok');
    expect(result.finish).toBe('length');
    expect(result.text).toBe('A CVE is a public identifier');
  });

  it('carries a refusal as an empty completion with an unmodelled finish reason', async () => {
    // A refusal is a 200 with an empty `content` array and stop_reason
    // "refusal". We DID reach a model, so this belongs on the ok branch --
    // `text: ''` means "it said nothing", which is exactly true. The seam's
    // finish vocabulary has no member for it, and 'other' is defined as
    // "carried, not guessed at", so a refusal must not read as a clean stop.
    const { baseUrl } = await serveMessages(200, fixture('messages-200-refusal.json'));
    const result = await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    if (!isLlmOk(result)) throw new Error('expected ok');
    expect(result.text).toBe('');
    expect(result.finish).toBe('other');
    expect(result.usage.inputTokens).toBe(42);
  });
});

describe('a 200 whose body is not what the api documents', () => {
  it('reports malformed_response when there is no content array at all', async () => {
    const { baseUrl } = await serveMessages(200, '{"id":"msg_x","type":"message"}');
    const result = await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toBe('malformed_response');
    expect(result.retryable).toBe(false);
  });

  it('reports malformed_response for a body that is not JSON at all', async () => {
    const { baseUrl } = await serveMessages(200, 'not json');
    const result = await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toBe('malformed_response');
  });
});

describe('http outcomes', () => {
  it('reads a 404 as the configured model being wrong, not the endpoint', async () => {
    // The path is a constant this module owns, so it cannot be the 404's
    // cause. A model id typo is what is left -- and it needs a config edit,
    // not a retry.
    const { baseUrl } = await serveMessages(404, fixture('messages-404-model.json'));
    const result = await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toBe('model_missing');
    expect(result.retryable).toBe(false);
  });

  it('classifies a 401 as permanent -- a bad key is not a transient failure', async () => {
    const { baseUrl } = await serveMessages(401, fixture('messages-401.json'));
    const result = await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toBe('http_error');
    expect(result.retryable).toBe(false);
  });

  it('classifies a 429 as retryable', async () => {
    const { baseUrl } = await serveMessages(429, fixture('messages-429.json'));
    const result = await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toBe('http_error');
    expect(result.retryable).toBe(true);
  });

  it('classifies a 529 overloaded as retryable', async () => {
    const { baseUrl } = await serveMessages(529, '{"type":"error","error":{"type":"overloaded_error"}}');
    const result = await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.retryable).toBe(true);
  });

  it('never echoes the api key into an operator-facing detail', async () => {
    // A hostile or confused upstream can put anything in an error body; this
    // asserts the key never travels back out through OUR side of the message.
    const { baseUrl } = await serveMessages(401, fixture('messages-401.json'));
    const result = await createAnthropicBackend(configFor(baseUrl), enabledEnv()).complete(
      { prompt: 'hi' },
      { now: NOW },
    );

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.detail).not.toContain(FAKE_KEY);
  });
});

describe('transport outcomes', () => {
  it('reports not_running when nothing accepts the connection', async () => {
    const backend = createAnthropicBackend(configFor(await deadAddress()), enabledEnv());
    const result = await backend.complete({ prompt: 'hi' }, { now: NOW });

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toBe('not_running');
    expect(result.retryable).toBe(true);
  });

  it('reports timeout when the api never answers', async () => {
    const baseUrl = await serve(() => {});
    const result = await createAnthropicBackend(
      configFor(baseUrl, { timeoutMs: 150 }),
      enabledEnv(),
    ).complete({ prompt: 'hi' }, { now: NOW });

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toBe('timeout');
    expect(result.retryable).toBe(true);
  });

  it('aborts a response past the byte ceiling instead of buffering it whole', async () => {
    const baseUrl = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = 'x'.repeat(64 * 1024);
      for (let i = 0; i < 64; i += 1) res.write(chunk);
      res.end();
    });

    const result = await createAnthropicBackend(
      configFor(baseUrl, { maxResponseBytes: 4096 }),
      enabledEnv(),
    ).complete({ prompt: 'hi' }, { now: NOW });

    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toBe('response_too_large');
    expect(result.retryable).toBe(false);
  });

  it('reports an unmeasured cost for a call that never produced tokens', async () => {
    const backend = createAnthropicBackend(configFor(await deadAddress()), enabledEnv());
    const result = await backend.complete({ prompt: 'hi' }, { now: NOW });

    expect(result.cost.amountUsd).toBeNull();
    expect(result.cost.measured).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The shipped config
// ---------------------------------------------------------------------------

describe('the shipped config/llm.yaml', () => {
  it('carries an anthropic block that parses, so flipping the backend is one line', () => {
    // Without this the block could rot unnoticed and only fail on the day the
    // owner actually flips `backend: anthropic` -- turning a one-line change
    // into "now go invent the block's shape".
    const config = loadLlmConfig(join(process.cwd(), DEFAULT_LLM_CONFIG_PATH));
    const parsed = parseAnthropicConfig(config.anthropic);

    expect(parsed.model.length).toBeGreaterThan(0);
    expect(parsed.baseUrl.startsWith('https://')).toBe(true);
    expect(parsed.pricing.usdPerMillionInputTokens).toBeGreaterThan(0);
    expect(parsed.pricing.usdPerMillionOutputTokens).toBeGreaterThan(0);
  });

  it('still selects ollama -- RULING 2 ships the paid backend built and OFF', () => {
    expect(loadLlmConfig(join(process.cwd(), DEFAULT_LLM_CONFIG_PATH)).backend).toBe('ollama');
  });

  it('builds a disabled backend from the real file and a real empty environment', () => {
    // The end-to-end statement, with nothing invented: shipped config, no
    // flags, no credential -- off.
    const config = loadLlmConfig(join(process.cwd(), DEFAULT_LLM_CONFIG_PATH));
    const backend = createAnthropicBackend(config, {});
    expect(backend.enabled).toBe(false);
  });
});
