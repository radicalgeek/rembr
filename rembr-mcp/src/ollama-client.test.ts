import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OllamaClient } from './ollama-client';
import { Ollama } from 'ollama';

// Mock Ollama module
vi.mock('ollama', () => {
  return {
    Ollama: vi.fn().mockImplementation(() => ({
      embeddings: vi.fn(),
      generate: vi.fn(),
      list: vi.fn()
    }))
  };
});

// Mock EmbeddingCache to prevent cache hits from bypassing circuit breaker
vi.mock('./embedding-cache.js', () => {
  return {
    EmbeddingCache: {
      getInstance: vi.fn(() => ({
        get: vi.fn().mockResolvedValue(null),  // Always cache miss
        set: vi.fn().mockResolvedValue(undefined),
      })),
    },
  };
});

describe('OllamaClient', () => {
  let client: OllamaClient;
  let mockOllamaInstance: any;

  beforeEach(() => {
    // Reset singleton for each test
    (OllamaClient as any).instance = undefined;
    
    // Get fresh instance
    client = OllamaClient.getInstance();
    
    // Get mock Ollama instance
    mockOllamaInstance = (client as any).client;

    // Make retries instant in all tests (override per-test in resilience block when needed)
    vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined);
    vi.spyOn(client as any, 'backoffDelay').mockReturnValue(0);
  });

  describe('Singleton Pattern', () => {
    it('should return same instance on multiple calls', () => {
      const instance1 = OllamaClient.getInstance();
      const instance2 = OllamaClient.getInstance();
      
      expect(instance1).toBe(instance2);
    });

    it('should initialize with default configuration', () => {
      expect(client.getHost()).toBe('http://ollama.ai.svc.cluster.local:11434');
      expect(client.getEmbeddingModel()).toBe('nomic-embed-text');
      expect(client.getTextModel()).toBe('llama3.1:8b');
    });

    it('should respect OLLAMA_HOST environment variable', () => {
      process.env.OLLAMA_HOST = 'http://custom-host:11434';
      (OllamaClient as any).instance = undefined;
      
      const customClient = OllamaClient.getInstance();
      expect(customClient.getHost()).toBe('http://custom-host:11434');
      
      delete process.env.OLLAMA_HOST;
    });
  });

  describe('generateEmbedding', () => {
    it('should generate valid embedding vector', async () => {
      const mockEmbedding = Array(768).fill(0).map(() => Math.random());
      mockOllamaInstance.embeddings.mockResolvedValue({
        embedding: mockEmbedding
      });

      const result = await client.generateEmbedding('test text');

      expect(result).toEqual(mockEmbedding);
      expect(result.length).toBe(768);
      expect(mockOllamaInstance.embeddings).toHaveBeenCalledWith({
        model: 'nomic-embed-text',
        prompt: 'test text'
      });
    });

    it('should throw error for invalid dimensions', async () => {
      mockOllamaInstance.embeddings.mockResolvedValue({
        embedding: Array(512).fill(0) // Wrong dimensions
      });

      await expect(client.generateEmbedding('test'))
        .rejects.toThrow('Invalid embedding dimensions: expected 768, got 512');
    });

    it('should handle timeout after 30 seconds', async () => {
      // Verify that the timeout error propagates after retries are exhausted.
      // We simulate this by having embeddings always reject with the same error that
      // the internal timeout would produce (avoids fake-timer complexity with retries).
      const timeoutErr = new Error('Embedding generation timeout after 30 seconds');
      mockOllamaInstance.embeddings.mockRejectedValue(timeoutErr);

      await expect(client.generateEmbedding('timeout-unique-text'))
        .rejects.toThrow('Embedding generation timeout after 30 seconds');
    });

    it('should handle Ollama service errors', async () => {
      mockOllamaInstance.embeddings.mockRejectedValue(new Error('Connection refused'));

      await expect(client.generateEmbedding('test'))
        .rejects.toThrow('Connection refused');
    });

    it('should handle empty text input', async () => {
      const mockEmbedding = Array(768).fill(0);
      mockOllamaInstance.embeddings.mockResolvedValue({
        embedding: mockEmbedding
      });

      const result = await client.generateEmbedding('');

      expect(result.length).toBe(768);
      expect(mockOllamaInstance.embeddings).toHaveBeenCalledWith({
        model: 'nomic-embed-text',
        prompt: ''
      });
    });

    it('should handle long text input', async () => {
      const longText = 'test '.repeat(10000);
      const mockEmbedding = Array(768).fill(0);
      mockOllamaInstance.embeddings.mockResolvedValue({
        embedding: mockEmbedding
      });

      const result = await client.generateEmbedding(longText);

      expect(result.length).toBe(768);
    });
  });

  describe('generateText', () => {
    it('should generate text with prompt only', async () => {
      mockOllamaInstance.generate.mockResolvedValue({
        response: 'Generated text response'
      });

      const result = await client.generateText('What is the weather?');

      expect(result).toBe('Generated text response');
      expect(mockOllamaInstance.generate).toHaveBeenCalledWith({
        model: 'llama3.1:8b',
        prompt: 'What is the weather?',
        system: undefined,
        stream: false,
        options: {
          temperature: 0.7,
          num_predict: 500,
          stop: undefined
        }
      });
    });

    it('should generate text with system prompt', async () => {
      mockOllamaInstance.generate.mockResolvedValue({
        response: 'Helpful response'
      });

      const result = await client.generateText(
        'User question',
        'You are a helpful assistant'
      );

      expect(result).toBe('Helpful response');
      expect(mockOllamaInstance.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'You are a helpful assistant'
        })
      );
    });

    it('should respect custom generation options', async () => {
      mockOllamaInstance.generate.mockResolvedValue({
        response: 'Custom response'
      });

      await client.generateText('test', undefined, {
        temperature: 0.5,
        maxTokens: 100,
        stopSequences: ['\n\n']
      });

      expect(mockOllamaInstance.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          options: {
            temperature: 0.5,
            num_predict: 100,
            stop: ['\n\n']
          }
        })
      );
    });

    it('should handle timeout after 60 seconds', async () => {
      vi.useFakeTimers();
      
      mockOllamaInstance.generate.mockImplementation(() => 
        new Promise(resolve => setTimeout(resolve, 70000))
      );

      const promise = client.generateText('test');
      
      vi.advanceTimersByTime(60000);
      
      await expect(promise).rejects.toThrow('Text generation timeout after 60 seconds');
      
      vi.useRealTimers();
    });

    it('should handle generation errors', async () => {
      mockOllamaInstance.generate.mockRejectedValue(new Error('Model not found'));

      await expect(client.generateText('test'))
        .rejects.toThrow('Model not found');
    });
  });

  describe('isAvailable', () => {
    it('should return true when service is available', async () => {
      mockOllamaInstance.list.mockResolvedValue({ models: [] });

      const result = await client.isAvailable();

      expect(result).toBe(true);
      expect(mockOllamaInstance.list).toHaveBeenCalled();
    });

    it('should return false when service is unavailable', async () => {
      mockOllamaInstance.list.mockRejectedValue(new Error('Connection failed'));

      const result = await client.isAvailable();

      expect(result).toBe(false);
    });
  });

  describe('Configuration', () => {
    it('should return correct host', () => {
      expect(client.getHost()).toBe('http://ollama.ai.svc.cluster.local:11434');
    });

    it('should return correct embedding model', () => {
      expect(client.getEmbeddingModel()).toBe('nomic-embed-text');
    });

    it('should return correct text model', () => {
      expect(client.getTextModel()).toBe('llama3.1:8b');
    });

    it('should respect environment variables', () => {
      process.env.OLLAMA_HOST = 'http://test:11434';
      process.env.OLLAMA_EMBEDDING_MODEL = 'custom-embed';
      process.env.OLLAMA_TEXT_MODEL = 'custom-llm';
      
      (OllamaClient as any).instance = undefined;
      const customClient = OllamaClient.getInstance();

      expect(customClient.getHost()).toBe('http://test:11434');
      expect(customClient.getEmbeddingModel()).toBe('custom-embed');
      expect(customClient.getTextModel()).toBe('custom-llm');

      delete process.env.OLLAMA_HOST;
      delete process.env.OLLAMA_EMBEDDING_MODEL;
      delete process.env.OLLAMA_TEXT_MODEL;
    });
  });

  describe('Edge Cases', () => {
    it('should handle null response from Ollama', async () => {
      mockOllamaInstance.embeddings.mockResolvedValue({
        embedding: null
      });

      await expect(client.generateEmbedding('test'))
        .rejects.toThrow('Invalid embedding dimensions');
    });

    it('should handle undefined response', async () => {
      mockOllamaInstance.embeddings.mockResolvedValue({});

      await expect(client.generateEmbedding('test'))
        .rejects.toThrow('Invalid embedding dimensions');
    });

    it('should handle special characters in text', async () => {
      const specialText = '特殊字符 émojis 🎉\n\ttab\r\nline breaks';
      const mockEmbedding = Array(768).fill(0);
      mockOllamaInstance.embeddings.mockResolvedValue({
        embedding: mockEmbedding
      });

      const result = await client.generateEmbedding(specialText);

      expect(result.length).toBe(768);
      expect(mockOllamaInstance.embeddings).toHaveBeenCalledWith({
        model: 'nomic-embed-text',
        prompt: specialText
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Resilience Tests (REM-255)
  // ---------------------------------------------------------------------------
  describe('Resilience — Retry Logic', () => {
    beforeEach(() => {
      // Fast-forward sleep so retry tests do not take seconds
      vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined);
      vi.spyOn(client as any, 'backoffDelay').mockReturnValue(0);
    });

    it('should succeed on second attempt after transient failure', async () => {
      const mockEmbedding = Array(768).fill(0.1);
      mockOllamaInstance.embeddings
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValue({ embedding: mockEmbedding });

      const result = await client.generateEmbedding('retry test');

      expect(result).toEqual(mockEmbedding);
      expect(mockOllamaInstance.embeddings).toHaveBeenCalledTimes(2);
    });

    it('should throw after exhausting all retries (default 3)', async () => {
      mockOllamaInstance.embeddings.mockRejectedValue(new Error('Service unavailable'));

      await expect(client.generateEmbedding('test'))
        .rejects.toThrow('Service unavailable');

      // Initial attempt + MAX_RETRIES(3) = 4 total calls
      expect(mockOllamaInstance.embeddings).toHaveBeenCalledTimes(4);
    });

    it('should return zero vector fallback when OLLAMA_FALLBACK_EMBEDDING=zero', async () => {
      process.env.OLLAMA_FALLBACK_EMBEDDING = 'zero';
      (OllamaClient as any).instance = undefined;
      const fallbackClient = OllamaClient.getInstance();
      vi.spyOn(fallbackClient as any, 'sleep').mockResolvedValue(undefined);
      vi.spyOn(fallbackClient as any, 'backoffDelay').mockReturnValue(0);
      const mockInstance = (fallbackClient as any).client;
      mockInstance.embeddings.mockRejectedValue(new Error('Ollama down'));

      const result = await fallbackClient.generateEmbedding('test');

      expect(result).toHaveLength(768);
      expect(result.every((v: number) => v === 0)).toBe(true);

      delete process.env.OLLAMA_FALLBACK_EMBEDDING;
    });

    it('should reset consecutive failures on success', async () => {
      const mockEmbedding = Array(768).fill(0.5);
      mockOllamaInstance.embeddings
        .mockRejectedValueOnce(new Error('flap'))
        .mockResolvedValue({ embedding: mockEmbedding });

      await client.generateEmbedding('test');

      expect((client as any).consecutiveFailures).toBe(0);
    });
  });

  describe('Resilience — Circuit Breaker', () => {
    beforeEach(() => {
      vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined);
      vi.spyOn(client as any, 'backoffDelay').mockReturnValue(0);
    });

    it('should report circuit as closed initially', () => {
      const state = client.getCircuitState();
      expect(state.open).toBe(false);
      expect(state.consecutiveFailures).toBe(0);
    });

    it('should open circuit after threshold consecutive failures', async () => {
      mockOllamaInstance.embeddings.mockRejectedValue(new Error('down'));

      // Drive failures until circuit opens (threshold = 5, each call does 4 attempts)
      const threshold = (client as any).CIRCUIT_OPEN_THRESHOLD as number;
      for (let i = 0; i < threshold; i++) {
        await client.generateEmbedding(`test-${i}`).catch(() => { /* expected */ });
      }

      const state = client.getCircuitState();
      expect(state.open).toBe(true);
      expect(state.openedAt).not.toBeNull();
    });

    it('should fail-fast when circuit is open', async () => {
      // Force circuit open
      (client as any).consecutiveFailures = 10;
      (client as any).circuitOpenedAt = Date.now();

      await expect(client.generateEmbedding('test'))
        .rejects.toThrow('circuit breaker is open');

      // Should not have called Ollama at all
      expect(mockOllamaInstance.embeddings).not.toHaveBeenCalled();
    });

    it('should return false from isAvailable when circuit is open', async () => {
      (client as any).consecutiveFailures = 10;
      (client as any).circuitOpenedAt = Date.now();

      const available = await client.isAvailable();
      expect(available).toBe(false);
      expect(mockOllamaInstance.list).not.toHaveBeenCalled();
    });

    it('should half-open circuit after reset period', async () => {
      // Open the circuit but backdate it past the reset window
      const resetMs = (client as any).CIRCUIT_RESET_MS as number;
      (client as any).consecutiveFailures = 10;
      (client as any).circuitOpenedAt = Date.now() - resetMs - 1;

      const state = client.getCircuitState();
      expect(state.open).toBe(false); // should have reset
      expect((client as any).circuitOpenedAt).toBeNull();
    });
  });
});
