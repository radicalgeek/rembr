import { OllamaClient } from './ollama-client.js';

export interface EmbeddingProvider {
  name: string;
  model: string;
  dimensions: number;
  generateEmbedding(text: string): Promise<number[]>;
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

  async generateEmbedding(text: string): Promise<number[]> {
    // Delegate to OllamaClient singleton
    return this.client.generateEmbedding(text);
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

