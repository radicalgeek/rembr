import { describe, expect, it, vi } from 'vitest';
import { fetchWithDeadline, readBoundedJson } from './security/bounded-fetch.js';

describe('bounded upstream fetch helpers', () => {
  it('rejects declared and streamed bodies over the hard byte limit', async () => {
    const declared = new Response('{}', {
      headers: { 'content-type': 'application/json', 'content-length': '9999' },
    });
    await expect(readBoundedJson(declared, 100)).rejects.toThrow('safe byte limit');

    const chunked = new Response(JSON.stringify({ value: 'x'.repeat(1000) }), {
      headers: { 'content-type': 'application/json' },
    });
    await expect(readBoundedJson(chunked, 100)).rejects.toThrow('safe byte limit');
  });

  it('aborts a stalled fetch and clears its timer', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = fetchWithDeadline('http://models.test', {}, 500);
    const rejection = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
    expect((fetchMock.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    vi.useRealTimers();
  });
});
