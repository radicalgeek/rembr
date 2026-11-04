import { OllamaClient } from './ollama-client.js';
import { EmbeddingCache } from './embedding-cache.js';
import { trackEmbeddingGeneration } from './metrics.js';
import { cancelResponseBody, fetchWithDeadline, readBoundedJson } from './security/bounded-fetch.js';
import { modelConcurrencyLimiter, type ModelConcurrencyOptions } from './security/model-concurrency.js';

const MAX_EMBEDDING_RESPONSE_BYTES = 512 * 1024;
const MAX_EMBEDDING_DIMENSIONS = 16_384;

export interface EmbeddingProvider {
  name: string;
  model: string;
  dimensions: number;
  generateEmbedding(text: string, context?: ModelConcurrencyOptions): Promise<number[]>;
  isAvailable(): Promise<boolean>;
  /**
   * REM-249: Get model fingerprint for embedding consistency tracking.
   */
  getModelFingerprint(): string;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  name: string = 'ollama';
  model: string;
  dimensions: number;
  private client: OllamaClient;

  constructor(model: string = 'nomic-embed-text', dimensions: number = 768, host?: string) {
    this.model = model;
    this.dimensions = dimensions;
    // Use singleton OllamaClient instead of creating new instance
    this.client = OllamaClient.getInstance();
  }

  async generateEmbedding(text: string, context?: ModelConcurrencyOptions): Promise<number[]> {
    // Delegate to OllamaClient singleton
    return this.client.generateEmbedding(text, context);
  }

  async isAvailable(): Promise<boolean> {
    // Delegate to OllamaClient singleton
    return this.client.isAvailable();
  }

  getHost(): string {
    return this.client.getHost();
  }

  /**
   * REM-249: Get model fingerprint for embedding consistency tracking.
   */
  getModelFingerprint(): string {
    return this.client.getModelFingerprint();
  }

  static createDefault(host?: string): OllamaEmbeddingProvider {
    return new OllamaEmbeddingProvider('nomic-embed-text', 768, host);
  }
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  name: string = 'openai-compatible';
  model: string;
  dimensions: number;
  private baseUrl: string;
  private embeddingCache: EmbeddingCache;

  constructor(baseUrl: string, model: string, dimensions: number = 768) {
    if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > MAX_EMBEDDING_DIMENSIONS) {
      throw new Error('Embedding dimensions must be a safe bounded integer');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.dimensions = dimensions;
    this.embeddingCache = EmbeddingCache.getInstance();
  }

  async generateEmbedding(text: string, context: ModelConcurrencyOptions = {}): Promise<number[]> {
    const cached = await this.embeddingCache.get(text);
    if (cached) {
      return cached;
    }

    return modelConcurrencyLimiter.withPermit(context, () => this.generateEmbeddingUncached(text));
  }

  private async generateEmbeddingUncached(text: string): Promise<number[]> {

    const startTime = Date.now();
    const response = await fetchWithDeadline(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          input: text
        })
      }, 30_000);

    try {
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new Error(`Embedding request failed with status ${response.status}`);
      }

      const json = await readBoundedJson<{
        data?: Array<{ embedding?: number[] }>;
      }>(response, MAX_EMBEDDING_RESPONSE_BYTES);
      if (!json || typeof json !== 'object' || !Array.isArray(json.data) || json.data.length !== 1) {
        throw new Error('Embedding response had an invalid shape');
      }
      const embedding = json.data?.[0]?.embedding;

      if (!Array.isArray(embedding) || embedding.length !== this.dimensions) {
        throw new Error('Embedding response had invalid dimensions');
      }
      if (!embedding.every(value => typeof value === 'number' && Number.isFinite(value))) {
        throw new Error('Embedding response contained invalid numeric values');
      }

      const durationSeconds = (Date.now() - startTime) / 1000;
      trackEmbeddingGeneration(this.name, this.model, durationSeconds);

      this.embeddingCache.set(text, embedding).catch(() =>
        console.warn('Failed to cache embedding')
      );

      return embedding;
    } catch (error) {
      await cancelResponseBody(response);
      throw error;
    }
  }

  async isAvailable(): Promise<boolean> {
    let response: Response | undefined;
    try {
      response = await fetchWithDeadline(`${this.baseUrl}/models`, { method: 'GET' }, 3_000);
      return response.ok;
    } catch {
      return false;
    } finally {
      if (response) await cancelResponseBody(response);
    }
  }

  getModelFingerprint(): string {
    return `${this.name}:${this.model}:dims-${this.dimensions}`;
  }
}

/**
 * Azure OpenAI embedding provider.
 *
 * Azure is not drop-in OpenAI-compatible for embeddings: it uses deployment-based
 * URLs (`/openai/deployments/<deployment>/embeddings?api-version=<ver>`), an
 * `api-key` header instead of `Authorization: Bearer`, and accepts a native
 * `dimensions` parameter so a text-embedding-3-* deployment can return 768-dim
 * vectors that match the pgvector schema. Selected with EMBEDDING_PROVIDER=azure.
 */
export class AzureOpenAIEmbeddingProvider implements EmbeddingProvider {
  name: string = 'azure';
  model: string;
  dimensions: number;
  private endpoint: string;
  private apiKey: string;
  private apiVersion: string;
  private deployment: string;
  private embeddingCache: EmbeddingCache;

  constructor(endpoint: string, deployment: string, apiKey: string, apiVersion: string, dimensions: number = 768) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.deployment = deployment;
    this.apiKey = apiKey;
    this.apiVersion = apiVersion;
    this.dimensions = dimensions;
    this.model = deployment;
    this.embeddingCache = EmbeddingCache.getInstance();
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const cached = await this.embeddingCache.get(text);
    if (cached) {
      return cached;
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const url = `${this.endpoint}/openai/deployments/${encodeURIComponent(this.deployment)}/embeddings?api-version=${encodeURIComponent(this.apiVersion)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.apiKey
        },
        body: JSON.stringify({
          input: text,
          dimensions: this.dimensions
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Azure embedding request failed (${response.status}): ${body.slice(0, 300)}`);
      }

      const json = await response.json() as {
        data?: Array<{ embedding?: number[] }>;
      };
      const embedding = json.data?.[0]?.embedding;

      if (!embedding || embedding.length !== this.dimensions) {
        throw new Error(`Invalid embedding dimensions: expected ${this.dimensions}, got ${embedding?.length}`);
      }

      const durationSeconds = (Date.now() - startTime) / 1000;
      trackEmbeddingGeneration(this.name, this.model, durationSeconds);

      this.embeddingCache.set(text, embedding).catch(err =>
        console.warn('Failed to cache embedding:', err.message)
      );

      return embedding;
    } finally {
      clearTimeout(timeout);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.generateEmbedding('health');
      return true;
    } catch (error) {
      console.warn('[AzureOpenAIEmbeddingProvider] Availability check failed:', error instanceof Error ? error.message : error);
      return false;
    }
  }

  getModelFingerprint(): string {
    return `${this.name}:${this.model}:dims-${this.dimensions}`;
  }
}
