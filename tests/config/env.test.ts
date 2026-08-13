import { describe, it, expect } from 'vitest';
import { loadEnv, EnvError } from '../../src/config/env.ts';

const valid = {
  WF_DB_PATH: './data/wf.db',
  WF_DATA_DIR: './data',
  WF_LOG_DIR: './logs',
  WF_TZ: 'America/New_York',
  WF_API_TOKEN: 'test-token-value',
};

describe('loadEnv', () => {
  it('parses a complete environment', () => {
    const env = loadEnv(valid);
    expect(env.WF_DB_PATH).toBe('./data/wf.db');
    expect(env.WF_API_PORT).toBe(8787);
    expect(env.WF_VAULT_ROOT).toBeUndefined();
  });

  it('names every missing variable at once', () => {
    try {
      loadEnv({});
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const msg = (e as EnvError).message;
      for (const key of ['WF_DB_PATH', 'WF_TZ', 'WF_API_TOKEN']) {
        expect(msg).toContain(key);
      }
    }
  });

  it('does not require the vars nothing consumes yet', () => {
    // WF_DATA_DIR and WF_LOG_DIR have no reader anywhere in src/. Requiring
    // them made a fresh deploy hard-fail on variables that change no
    // behavior. They stay validated when present, just not mandatory.
    const { WF_DATA_DIR, WF_LOG_DIR, ...rest } = valid;
    expect(WF_DATA_DIR && WF_LOG_DIR).toBeTruthy();

    const env = loadEnv(rest);
    expect(env.WF_DATA_DIR).toBeUndefined();
    expect(env.WF_LOG_DIR).toBeUndefined();

    expect(() => loadEnv({ ...rest, WF_LOG_DIR: '/var/log/wf' })).toThrow(EnvError);
  });

  it('rejects a timezone that is not a real IANA zone', () => {
    expect(() => loadEnv({ ...valid, WF_TZ: 'Pacific/Nowhere' })).toThrow(EnvError);
  });

  it('rejects an absolute path, which would not survive migration', () => {
    expect(() => loadEnv({ ...valid, WF_DB_PATH: '/var/lib/wf.db' })).toThrow(EnvError);
  });

  it('coerces the port to a number', () => {
    expect(loadEnv({ ...valid, WF_API_PORT: '9000' }).WF_API_PORT).toBe(9000);
  });
});
