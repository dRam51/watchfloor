/**
 * A process-wide outbound-network trap, for the zero-dollar proof.
 *
 * `docs/costs.md` asks for *"an integration test that stubs the network layer
 * and asserts zero requests fire with the flag unset."* This is that network
 * layer. It is a test utility, never imported by `src/`.
 *
 * ## Why it patches `net.Socket.prototype.connect` and not just `fetch`
 *
 * The obvious version of this trap replaces `globalThis.fetch` and counts
 * calls. It is fooled by the exact defect the proof exists to catch: a client
 * that reaches the wire some other way — `node:http`, `node:https`, a vendor
 * SDK bundling undici or axios — never touches `globalThis.fetch`, so a
 * fetch-only trap reports a serene zero while the request leaves the machine.
 *
 * Every one of those paths eventually calls `net.Socket.prototype.connect`
 * (TLS included: `tls.TLSSocket` extends `net.Socket` and inherits it), so
 * that is where the floor goes. `fetch` is patched **as well**, purely because
 * it can report the full URL a socket cannot — `attempts()` is far more useful
 * when it names `https://api.anthropic.com/v1/messages` rather than
 * `160.79.104.10:443`.
 *
 * ## It blocks; it does not merely observe
 *
 * Both patches throw instead of delegating. An observing trap would let the
 * request complete — which, for a paid vendor, means the test suite itself
 * could spend money while proving that it cannot. Nothing here can put a
 * packet on the wire.
 *
 * ## Scope
 *
 * The patch is global to the worker process for as long as it is installed, so
 * install it around the narrowest possible window and **always uninstall in a
 * `finally`**. `uninstall()` is idempotent and restores the original functions
 * by reference rather than by re-`require`ing them, so nesting or double calls
 * cannot leave a patched function behind.
 */

import { Socket } from 'node:net';

export interface OutboundAttempt {
  /** Which layer caught it. `socket` is the floor; `fetch` carries a URL. */
  via: 'fetch' | 'socket';
  /** The URL, or `host:port`, as far as that layer could see it. */
  target: string;
  /** Where the call came from, so a failure names the offending module. */
  stack: string;
}

/**
 * Thrown in place of any outbound connection. Deliberately not an
 * `Error` subclass with a transport `code`: a client that classifies this as a
 * retryable network blip is behaving exactly as it would against a genuinely
 * unreachable host, which keeps the trap from changing the code path it is
 * measuring.
 */
export class NetworkTrapError extends Error {
  constructor(target: string) {
    super(
      `network trap: refused an outbound connection to ${target}. ` +
        `A test installed tests/cost/networkTrap.ts, which blocks every outbound socket in this process.`,
    );
    this.name = 'NetworkTrapError';
  }
}

export interface NetworkTrap {
  /** Every outbound attempt since installation, in order. */
  attempts(): OutboundAttempt[];
  /** Restores the real network. Idempotent; safe to call from a `finally`. */
  uninstall(): void;
}

function describeFetchInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input !== null && typeof input === 'object' && 'url' in input) {
    return String((input as { url: unknown }).url);
  }
  return '(unrecognised fetch input)';
}

/** node:net's connect() is overloaded: (options[, cb]) or (port[, host][, cb]). */
function describeSocketArgs(args: unknown[]): string {
  const [first, second] = args;
  if (typeof first === 'object' && first !== null) {
    const options = first as { host?: unknown; port?: unknown; path?: unknown };
    if (options.path !== undefined) return `unix:${String(options.path)}`;
    return `${String(options.host ?? 'localhost')}:${String(options.port ?? '?')}`;
  }
  if (typeof first === 'number' || typeof first === 'string') {
    const host = typeof second === 'string' ? second : 'localhost';
    return `${host}:${String(first)}`;
  }
  return '(unrecognised socket target)';
}

function callSite(): string {
  // Drop this frame and the patch's own frame; keep enough to name the caller.
  return (new Error().stack ?? '').split('\n').slice(3, 8).join('\n');
}

export function installNetworkTrap(): NetworkTrap {
  const attempts: OutboundAttempt[] = [];
  const realFetch = globalThis.fetch;
  const realConnect = Socket.prototype.connect;
  let installed = true;

  const record = (via: OutboundAttempt['via'], target: string): void => {
    attempts.push({ via, target, stack: callSite() });
  };

  // Rejects a promise rather than throwing synchronously, because that is how
  // the real fetch reports an unreachable host. A synchronous throw would take
  // a different path through `try { await fetch() }` than the failure it is
  // standing in for, and the enabled half of the symmetry test depends on the
  // client classifying this exactly as it would a genuine network error.
  globalThis.fetch = ((input: unknown, _init?: unknown): Promise<Response> => {
    const target = describeFetchInput(input);
    record('fetch', target);
    return Promise.reject(new NetworkTrapError(target));
  }) as unknown as typeof globalThis.fetch;

  // The socket floor throws synchronously instead, and that asymmetry is
  // deliberate: nothing in this project reaches the wire except through
  // `fetch`, so anything landing here is already a defect, and a hard throw
  // makes it impossible to swallow via an 'error' listener and carry on.
  Socket.prototype.connect = function trappedConnect(this: Socket, ...args: unknown[]): never {
    const target = describeSocketArgs(args);
    record('socket', target);
    throw new NetworkTrapError(target);
  } as unknown as typeof Socket.prototype.connect;

  return {
    attempts: () => [...attempts],
    uninstall: () => {
      if (!installed) return;
      installed = false;
      globalThis.fetch = realFetch;
      Socket.prototype.connect = realConnect;
    },
  };
}
