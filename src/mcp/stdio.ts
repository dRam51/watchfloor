/**
 * The stdio transport (M5 task 10). Newline-delimited JSON-RPC over a pair of
 * streams, and nothing else.
 *
 * Everything protocol-shaped lives in src/mcp/server.ts behind
 * `handle(line) -> line | null`, so this module is pure framing. That split is
 * why the whole dispatcher is testable without a process, and why the binding's
 * own observation holds here — *"The wire format ... works unchanged over Unix
 * domain sockets, TCP connections, or any similar channel"* — a socket
 * transport later is this file with a different pair of streams.
 *
 * ## Sequential, on purpose
 *
 * Lines are handled one at a time, each awaited before the next is read. MCP
 * correlates by `id` and would permit out-of-order responses, but every read
 * here is synchronous SQLite, so concurrency would buy nothing and cost the
 * guarantee that two responses can never interleave inside one `write`.
 *
 * ## stdout is protocol-only
 *
 * *"The server MUST NOT write anything to its `stdout` that is not a valid MCP
 * message."* Nothing in this package calls `console.log`; the query log goes
 * to stderr, which the binding explicitly permits. A stray `console.log`
 * anywhere under `src/mcp/` corrupts the protocol for a client that is
 * mid-request, which is why tests/mcp/sourceProperties.test.ts scans for one.
 */

import type { Readable, Writable } from 'node:stream';
import { encodeMessage, errorResponse, RPC_INVALID_REQUEST } from './jsonrpc.ts';
import type { McpServer } from './server.ts';

/**
 * A line longer than this is refused rather than accumulated.
 *
 * Without a cap, a peer that opens a brace and never sends a newline holds the
 * process's memory hostage with no error and no timeout — the failure looks
 * like a hang, which is the hardest kind to diagnose from the client side. 4
 * MiB is far past any legitimate request: arguments here are entity names,
 * timestamps and limits.
 */
export const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;

export interface StdioTransportOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly server: McpServer;
  readonly maxLineBytes?: number;
}

/**
 * Serves until `input` ends.
 *
 * Resolving on end is the graceful-shutdown contract: *"Servers SHOULD exit
 * promptly when their standard input is closed or reads return end-of-file.
 * This is the primary graceful-shutdown signal and the only portable one."*
 */
export function serveStdio(options: StdioTransportOptions): Promise<void> {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;

  return new Promise<void>((resolve, reject) => {
    let buffer = '';
    // Backpressure: `data` events keep arriving while an await is in flight,
    // so lines are queued and drained by one runner rather than handled
    // concurrently. Without this, two handlers could write interleaved.
    const queue: string[] = [];
    let draining = false;
    let ended = false;
    let failed: unknown = null;

    const write = (line: string): void => {
      options.output.write(`${line}\n`);
    };

    async function drain(): Promise<void> {
      if (draining) return;
      draining = true;
      try {
        while (queue.length > 0) {
          const line = queue.shift()!;
          const response = await options.server.handle(line);
          if (response !== null) write(response);
        }
      } catch (cause) {
        failed = cause;
      } finally {
        draining = false;
      }
      if (failed !== null) {
        reject(failed);
        return;
      }
      if (ended && queue.length === 0) resolve();
    }

    const tooLong = (bytes: number): void => {
      write(
        encodeMessage(
          errorResponse(null, RPC_INVALID_REQUEST, `message too long: ${bytes} bytes exceeds the ${maxLineBytes}-byte limit`),
        ),
      );
    };

    function enqueue(raw: string): void {
      // A CRLF peer is legal on this wire; the delimiter is the newline.
      const line = raw.replace(/\r$/, '').trim();
      if (line.length === 0) return; // blank lines are not messages

      // The cap applies to a COMPLETE line too, not only to an unterminated
      // buffer -- found by the test, which sent an oversized line WITH its
      // newline and got a parse error from the dispatcher instead of a
      // refusal from the transport. A 5 MiB well-terminated line is the same
      // hazard as a 5 MiB unterminated one; only the unterminated case is a
      // hang, and both are refusals.
      const bytes = Buffer.byteLength(line, 'utf8');
      if (bytes > maxLineBytes) {
        tooLong(bytes);
        return;
      }
      queue.push(line);
    }

    options.input.setEncoding('utf8');

    options.input.on('data', (chunk: string) => {
      buffer += chunk;

      let index = buffer.indexOf('\n');
      while (index !== -1) {
        enqueue(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }

      // Over the cap with no terminator in sight: refuse what has accumulated
      // and resynchronise at the next newline rather than dying. A client that
      // sent one bad line should still be able to send a good one. This is the
      // HANG case; `enqueue` handles the oversized-but-terminated one.
      const buffered = Buffer.byteLength(buffer, 'utf8');
      if (buffered > maxLineBytes) {
        tooLong(buffered);
        buffer = '';
      }

      void drain();
    });

    options.input.on('end', () => {
      // A final line with no trailing newline is still a message.
      if (buffer.length > 0) {
        enqueue(buffer);
        buffer = '';
      }
      ended = true;
      void drain();
      if (!draining && queue.length === 0) resolve();
    });

    options.input.on('error', reject);
  });
}
