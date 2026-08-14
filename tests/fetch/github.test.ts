import { describe, expect, it } from 'vitest';
import { GitHubClient, RATE_LIMITS } from '../../src/fetch/github.ts';

describe('auth mode', () => {
  it('reports unauthenticated when no token is supplied', () => {
    const client = new GitHubClient({ baseUrl: 'http://127.0.0.1:1' });
    expect(client.mode).toBe('unauthenticated');
  });

  it('reports authenticated when a token is supplied', () => {
    const client = new GitHubClient({ token: 'ghp_example', baseUrl: 'http://127.0.0.1:1' });
    expect(client.mode).toBe('authenticated');
  });

  it('treats an empty or whitespace-only token as unauthenticated, not as a broken credential', () => {
    // A .env line left as `WF_GITHUB_TOKEN=` reads as '' rather than undefined.
    // Sending `Authorization: Bearer ` would 401 every request; falling back to
    // the real unauthenticated mode is both correct and the honest report.
    expect(new GitHubClient({ token: '', baseUrl: 'http://127.0.0.1:1' }).mode).toBe('unauthenticated');
    expect(new GitHubClient({ token: '   ', baseUrl: 'http://127.0.0.1:1' }).mode).toBe('unauthenticated');
  });

  it('publishes the documented ceiling for each mode so a caller can budget before spending', () => {
    // The failure this prevents: a poll that discovers it is on 60/hour by
    // exhausting it. These are readable without making a request.
    expect(RATE_LIMITS.unauthenticated).toEqual({ searchPerMinute: 10, corePerHour: 60 });
    expect(RATE_LIMITS.authenticated).toEqual({ searchPerMinute: 30, corePerHour: 5_000 });
  });

  it('reports the ceiling matching its own mode', () => {
    expect(new GitHubClient({ baseUrl: 'http://127.0.0.1:1' }).limits.corePerHour).toBe(60);
    expect(new GitHubClient({ token: 'ghp_example', baseUrl: 'http://127.0.0.1:1' }).limits.corePerHour).toBe(5_000);
  });
});
