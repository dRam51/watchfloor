/**
 * §8.2: *"Isolation that still holds: **separate process, separate
 * credential**, separate DB user (read-only role)."* (M5 task 10.)
 *
 * "Separate" is the whole requirement, and it is the part that is easy to
 * satisfy on paper and lose in `.env`. A `WF_MCP_TOKEN` set to the same string
 * as `WF_API_TOKEN` is not a separate credential — revoking one revokes both,
 * and the isolation claim becomes a naming convention. So the process refuses
 * to start in that state, rather than reporting it.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveMcpToken,
  isAuthorized,
  McpCredentialError,
  MCP_TOKEN_ENV,
  MCP_TOKEN_META_KEY,
} from '../../src/mcp/auth.ts';

const API_TOKEN = 'dashboard-token-value-0001';
const MCP_TOKEN = 'bot-token-value-000000002';

describe('resolveMcpToken', () => {
  it('returns the configured token', () => {
    expect(resolveMcpToken({ WF_MCP_TOKEN: MCP_TOKEN, WF_API_TOKEN: API_TOKEN })).toBe(MCP_TOKEN);
  });

  it('trims surrounding whitespace, which a .env line picks up silently', () => {
    expect(resolveMcpToken({ WF_MCP_TOKEN: `  ${MCP_TOKEN}  `, WF_API_TOKEN: API_TOKEN })).toBe(MCP_TOKEN);
  });

  it('refuses to start with no credential at all', () => {
    expect(() => resolveMcpToken({ WF_API_TOKEN: API_TOKEN })).toThrow(McpCredentialError);
    expect(() => resolveMcpToken({ WF_API_TOKEN: API_TOKEN })).toThrow(MCP_TOKEN_ENV);
  });

  it('refuses a blank credential rather than treating it as unset', () => {
    expect(() => resolveMcpToken({ WF_MCP_TOKEN: '   ', WF_API_TOKEN: API_TOKEN })).toThrow(
      McpCredentialError,
    );
  });

  it('refuses a credential short enough to guess', () => {
    expect(() => resolveMcpToken({ WF_MCP_TOKEN: 'short', WF_API_TOKEN: API_TOKEN })).toThrow(
      /at least/,
    );
  });

  // The requirement itself, mechanised.
  it('refuses a credential equal to WF_API_TOKEN — that is not a separate credential', () => {
    expect(() => resolveMcpToken({ WF_MCP_TOKEN: API_TOKEN, WF_API_TOKEN: API_TOKEN })).toThrow(
      /separate credential/,
    );
  });

  it('still refuses when the two differ only by whitespace', () => {
    expect(() =>
      resolveMcpToken({ WF_MCP_TOKEN: ` ${API_TOKEN} `, WF_API_TOKEN: API_TOKEN }),
    ).toThrow(/separate credential/);
  });

  it('accepts the credential when WF_API_TOKEN is not set at all', () => {
    expect(resolveMcpToken({ WF_MCP_TOKEN: MCP_TOKEN })).toBe(MCP_TOKEN);
  });

  it('never echoes the credential in any refusal', () => {
    const cases: NodeJS.ProcessEnv[] = [
      { WF_MCP_TOKEN: 'short', WF_API_TOKEN: API_TOKEN },
      { WF_MCP_TOKEN: API_TOKEN, WF_API_TOKEN: API_TOKEN },
    ];
    for (const env of cases) {
      try {
        resolveMcpToken(env);
        throw new Error('expected a refusal');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain(env.WF_MCP_TOKEN);
        expect(message).not.toContain(API_TOKEN);
      }
    }
  });
});

describe('isAuthorized', () => {
  it('accepts the exact credential', () => {
    expect(isAuthorized(MCP_TOKEN, MCP_TOKEN)).toBe(true);
  });

  it('rejects a wrong credential', () => {
    expect(isAuthorized('bot-token-value-000000003', MCP_TOKEN)).toBe(false);
  });

  it('rejects a right prefix', () => {
    expect(isAuthorized(MCP_TOKEN.slice(0, -1), MCP_TOKEN)).toBe(false);
  });

  it.each([undefined, null, 42, ['x'], { token: MCP_TOKEN }, ''])(
    'rejects the non-string %s the same way it rejects a wrong value',
    (presented) => {
      expect(isAuthorized(presented, MCP_TOKEN)).toBe(false);
    },
  );
});

describe('MCP_TOKEN_META_KEY', () => {
  // The 2026-07-28 `_meta` key rules: an optional reverse-DNS prefix ending in
  // `/`, where "any prefix where the second label is `modelcontextprotocol` or
  // `mcp` is reserved for MCP use", and a name that begins and ends with an
  // alphanumeric character.
  it('is a legal, non-reserved _meta key', () => {
    const [prefix, name] = MCP_TOKEN_META_KEY.split('/');
    expect(name).toMatch(/^[a-z0-9A-Z](?:[-_.a-zA-Z0-9]*[a-z0-9A-Z])?$/);
    const labels = (prefix ?? '').split('.');
    for (const label of labels) expect(label).toMatch(/^[A-Za-z](?:[-A-Za-z0-9]*[A-Za-z0-9])?$/);
    expect(labels[1]).not.toBe('modelcontextprotocol');
    expect(labels[1]).not.toBe('mcp');
  });
});
