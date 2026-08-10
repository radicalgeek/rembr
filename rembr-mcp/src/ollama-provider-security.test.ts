import { beforeEach, describe, expect, it, vi } from 'vitest';

const cacheGet = vi.fn();
const cacheSet = vi.fn();

vi.mock('./embedding-cache.js', () => ({
  EmbeddingCache: {
    getInstance: () => ({ get: cacheGet, set: cacheSet }),
  },
}));
vi.mock('./ollama-client.js', () => ({
  OllamaClient: { getInstance: () => ({}) },
}));
vi.mock('./metrics.js', () => ({ trackEmbeddingGeneration: vi.fn() }));

import { OpenAICompatibleEmbeddingProvider } from './ollama-provider.js';

describe('OpenAI-compatible embedding boundary', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    cacheGet.mockReset().mockResolvedValue(null);
    cacheSet.mockReset().mockResolvedValue(undefined);
  });

  it('accepts exactly one finite vector with the configured dimensions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ embedding: [0.1, -0.2, 0.3] }],
    }), { headers: { 'content-type': 'application/json' } })));

    const provider = new OpenAICompatibleEmbeddingProvider('http://models.test/v1', 'embed', 3);
    await expect(provider.generateEmbedding('bounded input')).resolves.toEqual([0.1, -0.2, 0.3]);
  });

  it.each([
    { data: [] },
    { data: [{ embedding: [1, 2, 3] }, { embedding: [1, 2, 3] }] },
    { data: [{ embedding: [1, 2] }] },
    { data: [{ embedding: [1, null, 3] }] },
  ])('rejects malformed choices, dimensions, and numeric values', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    })));
    const provider = new OpenAICompatibleEmbeddingProvider('http://models.test/v1', 'embed', 3);
    await expect(provider.generateEmbedding('input')).rejects.toThrow(/invalid/i);
  });

  it('rejects an oversized chunked response before JSON parsing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x'.repeat(513 * 1024), {
      headers: { 'content-type': 'application/json' },
    })));
    const provider = new OpenAICompatibleEmbeddingProvider('http://models.test/v1', 'embed', 3);
    await expect(provider.generateEmbedding('input')).rejects.toThrow('safe byte limit');
  });

  it('does not reflect an upstream error body in caller-visible errors', async () => {
    const secret = ['upstream', 'private', 'detail'].join('-');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(secret, { status: 502 })));
    const provider = new OpenAICompatibleEmbeddingProvider('http://models.test/v1', 'embed', 3);
    const failure = await provider.generateEmbedding('input').catch(error => error as Error);
    expect(failure.message).toBe('Embedding request failed with status 502');
    expect(failure.message).not.toContain(secret);
  });

  it('bounds configured dimensions and cancels availability response bodies', async () => {
    expect(() => new OpenAICompatibleEmbeddingProvider('http://models.test/v1', 'embed', 0)).toThrow('bounded integer');
    expect(() => new OpenAICompatibleEmbeddingProvider('http://models.test/v1', 'embed', 20_000)).toThrow('bounded integer');

    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: { cancel } }));
    const provider = new OpenAICompatibleEmbeddingProvider('http://models.test/v1', 'embed', 3);
    await expect(provider.isAvailable()).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
