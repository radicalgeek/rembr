import { afterEach, describe, expect, it, vi } from 'vitest';
import { AzureOpenAIEmbeddingProvider } from './ollama-provider.js';

describe('AzureOpenAIEmbeddingProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the Azure deployment URL, API key, and requested dimensions', async () => {
    const embedding = [0.1, 0.2, 0.3];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding }] })
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AzureOpenAIEmbeddingProvider(
      'https://example.openai.azure.com/',
      'text embedding 3',
      'test-key',
      '2024-10-21',
      embedding.length
    );

    await expect(provider.generateEmbedding('provider-request-shape')).resolves.toEqual(embedding);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.openai.azure.com/openai/deployments/text%20embedding%203/embeddings?api-version=2024-10-21',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': 'test-key'
        },
        body: JSON.stringify({
          input: 'provider-request-shape',
          dimensions: embedding.length
        })
      })
    );
    expect(provider.getModelFingerprint()).toBe('azure:text embedding 3:dims-3');
  });

  it('includes bounded Azure error details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'invalid API key'
    }));
    const provider = new AzureOpenAIEmbeddingProvider(
      'https://example.openai.azure.com',
      'embedding',
      'test-key',
      '2024-10-21',
      3
    );

    await expect(provider.generateEmbedding('provider-http-error'))
      .rejects.toThrow('Azure embedding request failed (401): invalid API key');
  });

  it('rejects embeddings with unexpected dimensions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2] }] })
    }));
    const provider = new AzureOpenAIEmbeddingProvider(
      'https://example.openai.azure.com',
      'embedding',
      'test-key',
      '2024-10-21',
      3
    );

    await expect(provider.generateEmbedding('provider-dimension-error'))
      .rejects.toThrow('Invalid embedding dimensions: expected 3, got 2');
  });
});
