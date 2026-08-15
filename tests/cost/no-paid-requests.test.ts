/**
 * The zero-dollar proof (M5 task 2, half 2).
 *
 * `docs/costs.md` has carried this requirement since M0, and the Anthropic
 * backend is what makes it come due:
 *
 * > the zero-flag test proves only that `isPaidAllowed()` returns **false when
 * > it is called**. It does **not** prove that no code path can reach a paid
 * > service — a client that simply never consults the gate would sail past it.
 *
 * This file is option **(b)**: an integration test that stubs the network
 * layer and asserts **zero requests fire** with the flag unset. Three things
 * make it more than a restatement of the gate test:
 *
 *  1. **It blocks at the socket layer, not at `fetch`.** A client that reaches
 *     the wire through `node:http`, `node:https`, or its own transport never
 *     touches `globalThis.fetch`. See `tests/cost/networkTrap.ts`.
 *  2. **It is symmetric.** The same client, the same input, one environment
 *     variable apart: flag unset must produce **exactly zero** outbound
 *     attempts, and flag set must produce **exactly one**. A test that only
 *     asserted "zero" would pass just as happily against a client that did
 *     nothing at all, which is the way this kind of guard usually rots.
 *  3. **It is registry-driven.** Every `paid` entry in `src/cost/registry.ts`
 *     must have an exerciser below, so the day a second paid client lands
 *     (markets data, at M4b) this file fails until it is covered rather than
 *     silently proving nothing about it.
 *
 * A static complement sits at the bottom: no module under `src/` may contain a
 * paid vendor's hostname. That is what makes the coverage map above
 * trustworthy — it bounds the set of files that could reach a paid host to the
 * ones this test drives.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type RequestListener, type Server } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICES } from '../../src/cost/registry.ts';
import { createLlmBackend } from '../../src/enrich/llm/backend.ts';
import { ANTHROPIC_API_KEY_ENV_VAR } from '../../src/enrich/llm/anthropic.ts';
import { installNetworkTrap } from './networkTrap.ts';
import type { LlmConfig } from '../../src/enrich/llm/config.ts';
import type { LlmResult } from '../../src/enrich/llm/types.ts';

// ---------------------------------------------------------------------------
// A recorder that must never be reached
// ---------------------------------------------------------------------------

const openServers: Server[] = [];

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected an AddressInfo');
  return `http://127.0.0.1:${address.port}`;
}

/** A real listener that counts what reaches it. Zero is the expected count. */
async function recorder(): Promise<{ baseUrl: string; hits: () => number }> {
  let count = 0;
  const baseUrl = await serve((_req, res) => {
    count += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"unexpected":"this listener should not have been reached"}');
  });
  return { baseUrl, hits: () => count };
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
const FAKE_KEY = 'sk-ant-not-a-real-key-fixture-only';

// ---------------------------------------------------------------------------
// One exerciser per paid service in the registry
// ---------------------------------------------------------------------------

interface Exerciser {
  /** Drives the real client end-to-end, against `baseUrl`, with `env`. */
  run(baseUrl: string, env: NodeJS.ProcessEnv): Promise<LlmResult>;
  /** The env that would let this service spend, minus the flag itself. */
  credentials: NodeJS.ProcessEnv;
}

function anthropicConfig(baseUrl: string): LlmConfig {
  return {
    backend: 'anthropic',
    limits: {
      timeoutMs: 5_000,
      maxPromptChars: 24_000,
      maxResponseBytes: 1_048_576,
      maxOutputTokens: 512,
    },
    ollama: { baseUrl: 'http://127.0.0.1:1', model: 'unused-here' },
    anthropic: {
      base_url: baseUrl,
      model: 'a-paid-model',
      pricing: { usd_per_million_input_tokens: 5, usd_per_million_output_tokens: 25 },
    },
  };
}

/**
 * Keyed by `src/cost/registry.ts` service id. Adding a `paid` service without
 * adding an entry here fails the coverage test below.
 */
const PAID_CLIENT_EXERCISERS: Record<string, Exerciser> = {
  'anthropic-api': {
    credentials: { [ANTHROPIC_API_KEY_ENV_VAR]: FAKE_KEY },
    run: (baseUrl, env) =>
      createLlmBackend(anthropicConfig(baseUrl), env).complete(
        { system: 'You are a terse technical summarizer.', prompt: 'What is a CVE?' },
        { now: NOW },
      ),
  },
};

const PAID_SERVICES = SERVICES.filter((service) => service.costClass === 'paid');

// ---------------------------------------------------------------------------
// The harness bites (negative controls)
//
// A guard that has never failed is not a guard. These three run the trap
// against traffic that IS supposed to be caught, so the assertions below can
// only pass because nothing fired -- never because the trap is inert.
// ---------------------------------------------------------------------------

describe('the network trap itself', () => {
  it('blocks and records a fetch, and the listener never sees it', async () => {
    const { baseUrl, hits } = await recorder();
    const trap = installNetworkTrap();
    try {
      await expect(fetch(baseUrl)).rejects.toThrow();
    } finally {
      trap.uninstall();
    }

    expect(trap.attempts()).toHaveLength(1);
    expect(trap.attempts()[0]!.target).toContain('127.0.0.1');
    expect(hits()).toBe(0);
  });

  it('blocks a client that never touches globalThis.fetch', async () => {
    // The bypass a fetch-only trap cannot see: node:http reaches the wire
    // through net.Socket, and so does node:https, and so does undici when a
    // dependency brings its own transport.
    const { baseUrl, hits } = await recorder();
    const port = Number(new URL(baseUrl).port);
    const trap = installNetworkTrap();
    let failed = false;
    try {
      await new Promise<void>((resolve) => {
        try {
          const req = httpRequest({ host: '127.0.0.1', port, path: '/' }, () => resolve());
          req.on('error', () => {
            failed = true;
            resolve();
          });
          req.end();
        } catch {
          failed = true;
          resolve();
        }
      });
    } finally {
      trap.uninstall();
    }

    expect(failed).toBe(true);
    expect(trap.attempts().some((attempt) => attempt.via === 'socket')).toBe(true);
    expect(hits()).toBe(0);
  });

  it('restores the real network on uninstall, so "zero hits" means something', async () => {
    // Without this, every assertion in this file could be satisfied by a
    // permanently broken network rather than by a client that chose not to
    // call. This proves the recorder WOULD have seen a request.
    const { baseUrl, hits } = await recorder();
    const trap = installNetworkTrap();
    trap.uninstall();

    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    expect(hits()).toBe(1);
    expect(trap.attempts()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

describe('every paid client in the registry', () => {
  it('has an exerciser in this file', () => {
    // The line that keeps this test honest as the system grows: a paid service
    // with no exerciser is a paid service this proof says nothing about.
    expect(PAID_SERVICES.length).toBeGreaterThan(0);
    const uncovered = PAID_SERVICES.filter(
      (service) => PAID_CLIENT_EXERCISERS[service.id] === undefined,
    ).map((service) => service.id);
    expect(uncovered, 'add an exerciser to PAID_CLIENT_EXERCISERS for each').toEqual([]);
  });

  it('exercises no service that is not registered as paid', () => {
    const stray = Object.keys(PAID_CLIENT_EXERCISERS).filter(
      (id) => !PAID_SERVICES.some((service) => service.id === id),
    );
    expect(stray, 'these ids are not paid entries in src/cost/registry.ts').toEqual([]);
  });
});

for (const service of PAID_SERVICES) {
  describe(`${service.id} with WF_ALLOW_PAID_${service.category!.toUpperCase()} unset`, () => {
    it('fires zero requests -- not one blocked at the socket, none attempted', async () => {
      const exerciser = PAID_CLIENT_EXERCISERS[service.id];
      if (exerciser === undefined) throw new Error(`no exerciser for ${service.id}`);

      const { baseUrl, hits } = await recorder();
      const trap = installNetworkTrap();
      let result: LlmResult;
      try {
        // A completely empty env: no flags of any kind, and the credential
        // present, so "it had no key" cannot be what stopped it.
        result = await exerciser.run(baseUrl, { ...exerciser.credentials });
      } finally {
        trap.uninstall();
      }

      const detail = trap
        .attempts()
        .map((attempt) => `${attempt.via} -> ${attempt.target}\n${attempt.stack}`)
        .join('\n\n');
      expect(trap.attempts(), `an outbound attempt escaped the cost gate:\n${detail}`).toEqual([]);
      expect(hits()).toBe(0);
      expect(result.status).toBe('unavailable');
      if (result.status !== 'unavailable') throw new Error('unreachable');
      expect(result.reason).toBe('disabled_by_cost_policy');
    });

    it('fires exactly one request with the flag set, which is what makes the zero meaningful', async () => {
      // The other half of the symmetry. Same client, same prompt, one env
      // variable different. If this ever reports zero too, the test above is
      // measuring a no-op rather than a gate.
      const exerciser = PAID_CLIENT_EXERCISERS[service.id];
      if (exerciser === undefined) throw new Error(`no exerciser for ${service.id}`);

      const { baseUrl, hits } = await recorder();
      const trap = installNetworkTrap();
      try {
        await exerciser.run(baseUrl, {
          ...exerciser.credentials,
          [`WF_ALLOW_PAID_${service.category!.toUpperCase()}`]: '1',
        });
      } finally {
        trap.uninstall();
      }

      expect(trap.attempts()).toHaveLength(1);
      // Blocked, so even the enabled half of this test cannot spend or leave
      // this machine -- the trap refuses the connection rather than observing
      // it.
      expect(hits()).toBe(0);
    });
  });
}

// ---------------------------------------------------------------------------
// The static complement: only one module may know a paid host
// ---------------------------------------------------------------------------

/**
 * Hostnames that can bill. Deliberately a literal list rather than something
 * derived: `src/cost/registry.ts` records classifications, not endpoints, and
 * a derived list would go quiet exactly when someone adds a vendor without
 * thinking about this file.
 */
const PAID_VENDOR_HOSTS = ['api.anthropic.com'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Comments are prose; only what the code could actually reach counts. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('no paid vendor hostname is reachable from src/', () => {
  it('appears in no module, so base_url can only come from config', () => {
    // This is what bounds the exerciser map above to something meaningful: if
    // no module can name a paid host, no module can reach one except through
    // the configured base_url the tests drive. A hardcoded endpoint -- an SDK
    // default, a retry fallback, a "quick check" -- trips this immediately.
    const offenders: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      const text = code(file);
      for (const host of PAID_VENDOR_HOSTS) {
        if (text.includes(host)) offenders.push(`${file}: ${host}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
