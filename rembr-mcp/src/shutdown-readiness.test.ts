import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { afterEach, vi } from 'vitest';
import { resolveShutdownDrainMs, waitForDrain } from './security/shutdown.js';

describe('readiness and graceful shutdown ordering', () => {
  const source = readFileSync(fileURLToPath(new URL('./index-http.ts', import.meta.url)), 'utf8');

  it('keeps liveness shallow and gates readiness on a bounded database probe', () => {
    const health = source.indexOf("this.app.get('/health'");
    const ready = source.indexOf("this.app.get('/ready'");
    const details = source.indexOf("this.app.get('/health/details'");
    expect(health).toBeGreaterThan(0);
    expect(ready).toBeGreaterThan(health);
    expect(ready).toBeLessThan(details);
    const readyBlock = source.slice(ready, details);
    expect(readyBlock).toContain("res.status(200).json({ ready: true })");
    expect(readyBlock).toContain("res.status(503).json({ ready: false })");
    expect(readyBlock).toContain("query_timeout: 1_500");
    expect(readyBlock).toContain('this.closing || this.closed');
  });

  it('stops admission, drains HTTP/background work, then closes the database', () => {
    const performClose = source.indexOf('private async performClose()');
    const closing = source.indexOf('this.closing = true', performClose);
    const stopListener = source.indexOf("this.httpServer!.close", performClose);
    const drain = source.indexOf('const drained = await waitForDrain', performClose);
    const forceClose = source.indexOf('closeAllConnections', performClose);
    const closeDb = source.indexOf('this.db.close().then', performClose);
    expect(closing).toBeLessThan(stopListener);
    expect(stopListener).toBeLessThan(drain);
    expect(drain).toBeLessThan(forceClose);
    expect(forceClose).toBeLessThan(closeDb);
    expect(source).toContain('if (this.closePromise) return this.closePromise');
    const sigterm = source.indexOf("process.on('SIGTERM'");
    expect(source.indexOf('await server.close()', sigterm)).toBeGreaterThan(sigterm);
    expect(source.indexOf('process.exit(0)', sigterm)).toBeGreaterThan(source.indexOf('await server.close()', sigterm));
  });

  it('allows a normal request lasting longer than 15 seconds to finish before cutoff', async () => {
    vi.useFakeTimers();
    let busy = true;
    setTimeout(() => { busy = false; }, 20_000);
    const pending = waitForDrain(() => busy, resolveShutdownDrainMs(), 100);

    await vi.advanceTimersByTimeAsync(20_100);
    await expect(pending).resolves.toBe(true);
  });

  it('bounds configured drain time so cleanup fits within the pod grace period', () => {
    expect(resolveShutdownDrainMs()).toBe(45_000);
    expect(() => resolveShutdownDrainMs('4999')).toThrow();
    expect(() => resolveShutdownDrainMs('50001')).toThrow();
    expect(resolveShutdownDrainMs('50000')).toBe(50_000);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
