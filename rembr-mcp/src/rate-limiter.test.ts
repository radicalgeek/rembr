/**
 * Unit tests for rate-limiter middleware.
 * REM-272 / REM-48
 */

import { describe, it, expect } from 'vitest';
import { PLAN_LIMITS, DAILY_PLAN_LIMITS, createRateLimitMiddleware } from './rate-limiter.js';

describe('PLAN_LIMITS', () => {
  it('free limit is lower than pro', () => {
    expect(PLAN_LIMITS.free).toBeLessThan(PLAN_LIMITS.pro);
  });

  it('pro limit is lower than team', () => {
    expect(PLAN_LIMITS.pro).toBeLessThan(PLAN_LIMITS.team);
  });

  it('default limit equals free limit', () => {
    expect(PLAN_LIMITS.default).toBe(PLAN_LIMITS.free);
  });

  it('business matches team and enterprise exceeds team', () => {
    expect(PLAN_LIMITS.business).toBe(PLAN_LIMITS.team);
    expect(PLAN_LIMITS.enterprise).toBeGreaterThan(PLAN_LIMITS.team);
  });
});

describe('DAILY_PLAN_LIMITS (REM-48)', () => {
  it('free plan: 1,000 requests/day', () => {
    expect(DAILY_PLAN_LIMITS.free).toBe(1000);
  });

  it('pro plan: 100,000 requests/day', () => {
    expect(DAILY_PLAN_LIMITS.pro).toBe(100000);
  });

  it('team plan: 1,000,000 requests/day', () => {
    expect(DAILY_PLAN_LIMITS.team).toBe(1000000);
  });

  it('business matches team', () => {
    expect(DAILY_PLAN_LIMITS.business).toBe(DAILY_PLAN_LIMITS.team);
  });

  it('enterprise exceeds team', () => {
    expect(DAILY_PLAN_LIMITS.enterprise).toBeGreaterThan(DAILY_PLAN_LIMITS.team);
  });

  it('default equals free', () => {
    expect(DAILY_PLAN_LIMITS.default).toBe(DAILY_PLAN_LIMITS.free);
  });

  it('limits escalate: free < pro < team < enterprise', () => {
    expect(DAILY_PLAN_LIMITS.free).toBeLessThan(DAILY_PLAN_LIMITS.pro);
    expect(DAILY_PLAN_LIMITS.pro).toBeLessThan(DAILY_PLAN_LIMITS.team);
    expect(DAILY_PLAN_LIMITS.team).toBeLessThan(DAILY_PLAN_LIMITS.enterprise);
  });
});

describe('createRateLimitMiddleware', () => {
  it('returns a function (middleware)', () => {
    const mw = createRateLimitMiddleware('free');
    expect(typeof mw).toBe('function');
  });

  it('bypasses /health without calling Redis', async () => {
    const mw = createRateLimitMiddleware('free');
    let nextCalled = false;

    const req = { path: '/health', headers: {}, socket: {} } as any;
    const res = { setHeader: () => {}, status: () => ({ json: () => {} }) } as any;
    const next = () => { nextCalled = true; };

    await mw(req, res, next);
    expect(nextCalled).toBe(true);
  });

  it('bypasses /metrics without calling Redis', async () => {
    const mw = createRateLimitMiddleware('free');
    let nextCalled = false;

    const req = { path: '/metrics', headers: {}, socket: {} } as any;
    const res = { setHeader: () => {}, status: () => ({ json: () => {} }) } as any;
    const next = () => { nextCalled = true; };

    await mw(req, res, next);
    expect(nextCalled).toBe(true);
  });

  it('sets X-RateLimit-* headers and passes through when Redis unavailable (fail-open)', async () => {
    const mw = createRateLimitMiddleware('pro');
    const headers: Record<string, string | number> = {};
    let nextCalled = false;

    const req = { path: '/mcp', headers: { 'x-api-key': 'test-key' }, socket: {} } as any;
    const res = {
      setHeader: (k: string, v: string | number) => { headers[k] = v; },
      status: () => ({ json: () => {} })
    } as any;
    const next = () => { nextCalled = true; };

    await mw(req, res, next);

    // Fail-open: should pass through when Redis is unavailable in test env
    expect(nextCalled).toBe(true);
    expect(headers['X-RateLimit-Limit']).toBeDefined();
    expect(headers['X-RateLimit-Remaining']).toBeDefined();
    expect(headers['X-RateLimit-Window']).toBe('60s');
  });
});
