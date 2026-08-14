import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Routes that do NOT require a bearer token. This is an EXEMPTION list, not
// a protection list, and the direction matters: every route registered on
// this server instance is protected by the onRequest hook below unless its
// path is named here. A task author who adds a new route and does nothing
// auth-related gets a protected route by default (fails closed). The
// opposite shape — a list of routes that ARE protected — fails open the
// moment someone forgets to add an entry, which is exactly the mistake M3
// task 1 exists to close off. See tests/api/auth.test.ts's "default
// protection" suite, which registers a brand-new route the hook has never
// heard of and proves it is 401 without a token.
//
// /health stays open: it is a liveness probe for process supervision (§12),
// hit by a supervisor (systemd/launchd) that has no natural way to carry a
// secret, and its body is operational status (migration count, configured
// TZ, source count, cost-gate state) — not item data, not anything from the
// brief's §11 appendix. Nothing in it is useful to an attacker beyond "the
// process is up," which an unauthenticated TCP connect already reveals.
const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/health']);

// RFC 7235 defines auth-scheme as a case-insensitive token and allows one or
// more spaces between the scheme and the credential (`1*SP`), so both are
// accepted here: `Bearer`, `bearer`, and `BEARER` are equivalent, and extra
// internal whitespace is tolerated. What is NOT accepted: a missing scheme,
// a non-Bearer scheme, or a scheme with nothing after it — those all read as
// "no credential supplied" and fall through to the same 401 as a missing
// header entirely.
const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

function parseBearerToken(header: string | string[] | undefined): string {
  if (typeof header !== 'string') return '';
  const match = BEARER_PATTERN.exec(header.trim());
  return match?.[1] ?? '';
}

// A plain `===` on secrets is a timing side channel: it returns as soon as
// it finds a differing byte, so comparison time leaks how many leading bytes
// matched. node:crypto's timingSafeEqual fixes that for buffers of equal
// length, but it *throws* a RangeError when lengths differ — a naive caller
// that catches that and treats it as "not equal" reintroduces a smaller
// version of the same problem: instant rejection on length mismatch and a
// full-length comparison otherwise, so response timing alone can reveal
// whether a guess had the right length.
//
// Hashing both sides to a fixed-size SHA-256 digest before comparing removes
// the length-mismatch case entirely — timingSafeEqual always receives two
// 32-byte buffers, so it never throws and every call (right length, wrong
// length, empty string) takes the same code path.
function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

// A 401 for "no token" and a 401 for "wrong token" must be indistinguishable
// (same status, same body) — otherwise the response itself is an oracle an
// attacker can use to tell "I need to try a token" from "I have the right
// shape, wrong value." parseBearerToken already collapses every malformed
// or missing case to '', so a missing header and a present-but-wrong token
// both flow through the exact same comparison below; there is only one
// unauthorized response in this module.
function isAuthorized(header: string | string[] | undefined, token: string): boolean {
  const provided = parseBearerToken(header);
  return constantTimeEqual(provided, token);
}

/**
 * Registers a global `onRequest` hook that rejects any request lacking a
 * valid `Authorization: Bearer <token>` header, except for PUBLIC_PATHS.
 *
 * Registered at the root Fastify instance (never inside `.register()`), so
 * it is not subject to Fastify's plugin encapsulation — it applies to every
 * route on `server`, including ones registered after this call returns.
 * That ordering independence is load-bearing: task authors adding routes
 * later must not need to know this hook exists.
 */
export function registerAuth(server: FastifyInstance, token: string): void {
  server.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (PUBLIC_PATHS.has(path)) return;

    if (!isAuthorized(request.headers.authorization, token)) {
      // Deliberately minimal: no message distinguishing "missing" from
      // "wrong", no echo of what was sent. The token itself never appears
      // in a log line or a response anywhere in this module.
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });
}
