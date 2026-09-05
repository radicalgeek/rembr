import { describe, expect, it, vi } from 'vitest';
import { ModelConcurrencyLimiter } from './security/model-concurrency.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

describe('model concurrency admission', () => {
  it('enforces both global and per-tenant concurrency while preserving another tenant lane', async () => {
    const limiter = new ModelConcurrencyLimiter(3, 2, 8, 1_000);
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const hold = (tenantId: string) => limiter.withPermit({ tenantId }, () => new Promise<void>(resolve => {
      active++;
      maximum = Math.max(maximum, active);
      releases.push(() => { active--; resolve(); });
    }));

    const a1 = hold(TENANT_A);
    const a2 = hold(TENANT_A);
    const a3 = hold(TENANT_A);
    const b1 = hold(TENANT_B);
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    expect(maximum).toBe(3);
    expect(active).toBe(3);

    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    while (releases.length) releases.shift()?.();
    await Promise.all([a1, a2, a3, b1]);
  });

  it('bounds the queue and removes cancelled waiters', async () => {
    const limiter = new ModelConcurrencyLimiter(1, 1, 1, 1_000);
    let release!: () => void;
    const active = limiter.withPermit({ tenantId: TENANT_A }, () => new Promise<void>(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));

    const controller = new AbortController();
    const queued = limiter.withPermit({ tenantId: TENANT_B, signal: controller.signal }, async () => undefined);
    await expect(limiter.withPermit({ tenantId: TENANT_B }, async () => undefined)).rejects.toThrow('queue is full');
    controller.abort();
    await expect(queued).rejects.toThrow('cancelled');
    release();
    await active;
  });
});
