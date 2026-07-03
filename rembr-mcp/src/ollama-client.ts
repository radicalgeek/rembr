import { Ollama } from 'ollama';
import { createHash } from 'node:crypto';
import { trackEmbeddingGeneration } from './metrics.js';
import { EmbeddingCache } from './embedding-cache.js';

/**
 * OllamaClient - Singleton client for Ollama embedding and text generation
 *
 * ## Resilience Strategy (REM-255)
 *
 * Ollama is a local/in-cluster service with no built-in HA. To avoid making it
 * a hard single point of failure, this client implements:
 *
 * 1. **Timeouts** — embedding calls abort after 30 s; text generation defaults
 *    to 60 s for Ollama and 180 s for OpenAI-compatible endpoints.
 *
 * 2. **Retry with exponential backoff** — transient network blips (connection
 *    refused, 503, timeout) are retried up to `MAX_RETRIES` times with jittered
 *    exponential back-off (base 500 ms, cap 10 s).
 *
 * 3. **Circuit breaker** — after `CIRCUIT_OPEN_THRESHOLD` consecutive failures
 *    the breaker opens and all calls fail-fast for `CIRCUIT_RESET_MS` ms, giving
 *    Ollama time to recover without being hammered.
 *
 * 4. **Graceful degradation (embeddings only)** — when `OLLAMA_FALLBACK_EMBEDDING`
 *    is set to `"zero"` in the environment, a zero vector is returned on permanent
 *    failure instead of throwing. This allows the rest of the pipeline to continue
 *    (memory is stored without a meaningful embedding, and similarity search will
 *    score it near-zero rather than crashing the request). The fallback is logged
 *    as a warning so it is visible in observability tooling.
 *
 * 5. **Health check** — `isAvailable()` can be polled by liveness probes or
 *    called before batch operations to gate work that requires embeddings.
 *
 * ## Environment Variables
 * - `OLLAMA_HOST`              — Ollama base URL for embeddings (default: cluster-local service)
 * - `OLLAMA_TEXT_HOST`         — Optional Ollama base URL for text generation
 * - `TEXT_GENERATION_PROVIDER` — "ollama" or "openai-compatible" (also accepts "lmstudio")
 * - `LM_STUDIO_BASE_URL`       — LM Studio/OpenAI-compatible base URL, e.g. http://host:1234/v1
 * - `LM_STUDIO_MODEL`          — LM Studio model id for text generation
 * - `LM_STUDIO_API_KEY`        — Optional LM Studio bearer token (defaults to a non-empty local token)
 * - `OLLAMA_EMBEDDING_MODEL`   — embedding model name (default: nomic-embed-text)
 * - `OLLAMA_TEXT_MODEL`        — text-gen model name (default: llama3.1:8b)
 * - `TEXT_GENERATION_TIMEOUT_MS` — text generation timeout override in milliseconds
 * - `OLLAMA_FALLBACK_EMBEDDING`— set to "zero" to enable zero-vector fallback
 * - `OLLAMA_MAX_RETRIES`       — override retry count (default: 3)
 *
 * Used by:
 * - OllamaEmbeddingProvider (embeddings)
 * - DeduplicationService (semantic similarity)
 * - RelationshipMaintainerService (relationship inference)
 */
export class OllamaClient {
  private static instance: OllamaClient;
  private client: Ollama;
  private textClient: Ollama;
  private host: string;
  private textHost: string;
  private textProvider: 'ollama' | 'openai-compatible';
  private openAICompatibleApiKey: string;
  private embeddingModel: string;
  private textModel: string;
  private embeddingCache: EmbeddingCache;

  // Resilience config
  private readonly MAX_RETRIES: number;
  private readonly FALLBACK_MODE: 'throw' | 'zero';
  private readonly TEXT_GENERATION_TIMEOUT_MS: number;
  private readonly CIRCUIT_OPEN_THRESHOLD = 5;
  private readonly CIRCUIT_RESET_MS = 30_000;

  // Circuit breaker state
  private consecutiveFailures = 0;
  private circuitOpenedAt: number | null = null;

  private constructor() {
    this.host = process.env.OLLAMA_HOST || 'http://ollama.ai.svc.cluster.local:11434';
    this.textHost = process.env.LM_STUDIO_BASE_URL
      || process.env.OPENAI_COMPATIBLE_TEXT_BASE_URL
      || process.env.OLLAMA_TEXT_HOST
      || this.host;
    this.textProvider = this.resolveTextProvider(this.textHost);
    this.openAICompatibleApiKey = process.env.LM_STUDIO_API_KEY
      || process.env.OPENAI_COMPATIBLE_API_KEY
      || 'lm-studio';
    this.embeddingModel = process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';
    this.textModel = process.env.LM_STUDIO_MODEL
      || process.env.OPENAI_COMPATIBLE_TEXT_MODEL
      || process.env.OLLAMA_TEXT_MODEL
      || 'llama3.1:8b';
    this.client = new Ollama({ host: this.host });
    this.textClient = new Ollama({ host: this.textHost });
    this.embeddingCache = EmbeddingCache.getInstance();
    this.MAX_RETRIES = parseInt(process.env.OLLAMA_MAX_RETRIES || '3', 10);
    this.FALLBACK_MODE = process.env.OLLAMA_FALLBACK_EMBEDDING === 'zero' ? 'zero' : 'throw';
    const defaultTextTimeout = this.textProvider === 'openai-compatible' ? 180_000 : 60_000;
    this.TEXT_GENERATION_TIMEOUT_MS = this.parsePositiveInt(
      process.env.TEXT_GENERATION_TIMEOUT_MS,
      defaultTextTimeout
    );

    console.log(`OllamaClient initialized: host=${this.host}, textHost=${this.textHost}, textProvider=${this.textProvider}, embedding=${this.embeddingModel}, text=${this.textModel}, textTimeoutMs=${this.TEXT_GENERATION_TIMEOUT_MS}, maxRetries=${this.MAX_RETRIES}, fallback=${this.FALLBACK_MODE}`);
  }

  /**
   * Get singleton instance
   */
  static getInstance(): OllamaClient {
    if (!OllamaClient.instance) {
      OllamaClient.instance = new OllamaClient();
    }
    return OllamaClient.instance;
  }

  /**
   * Generate embedding vector for text with Redis-backed caching.
   *
   * For content that exceeds MAX_CHARS, uses a chunk-and-average strategy
   * instead of silent truncation (REM-268):
   *   1. Split text into overlapping chunks of MAX_CHARS with CHUNK_OVERLAP.
   *   2. Embed each chunk independently.
   *   3. Element-wise average and L2-normalise to produce a single 768-dim vector.
   *
   * This preserves semantic signal from the full content rather than discarding
   * everything after the first 6,000 characters.
   *
   * @param text Text to embed
   * @returns 768-dimensional embedding vector
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const MAX_CHARS = 6000;  // Safe per-chunk limit for nomic-embed-text
    const CHUNK_OVERLAP = 500; // Overlap to preserve sentence boundary context

    if (text.length <= MAX_CHARS) {
      return this.generateSingleEmbedding(text);
    }

    // Long content: chunk-and-average instead of silent truncation
    const chunks = this.chunkText(text, MAX_CHARS, CHUNK_OVERLAP);
    console.warn(
      `[Embedding] Content length ${text.length} chars exceeds limit of ${MAX_CHARS}. ` +
      `Using chunk-average strategy across ${chunks.length} chunk(s). ` +
      `Full content is stored; embedding represents the full text.`
    );

    const chunkEmbeddings = await Promise.all(
      chunks.map(chunk => this.generateSingleEmbedding(chunk))
    );
    return this.averageEmbeddings(chunkEmbeddings);
  }

  /**
   * Embed a single text chunk (must be ≤ MAX_CHARS).
   * Handles cache lookup, Ollama call (with retry + circuit breaker), cache write, and metrics.
   * Falls back to a zero vector when OLLAMA_FALLBACK_EMBEDDING=zero and all retries fail.
   */
  private async generateSingleEmbedding(text: string): Promise<number[]> {
    // Check cache first (Redis with memory fallback)
    const cached = await this.embeddingCache.get(text);
    if (cached) {
      return cached;
    }

    // Circuit breaker: fail-fast when Ollama is known to be down
    if (this.isCircuitOpen()) {
      const msg = `Ollama circuit breaker is open (${this.consecutiveFailures} consecutive failures). Waiting for reset.`;
      if (this.FALLBACK_MODE === 'zero') {
        console.warn(`[OllamaClient] ${msg} Returning zero vector.`);
        return new Array(768).fill(0);
      }
      throw new Error(msg);
    }

    const startTime = Date.now();
    let lastError: Error = new Error('Unknown embedding error');

    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delayMs = this.backoffDelay(attempt);
        console.warn(`[OllamaClient] Embedding retry ${attempt}/${this.MAX_RETRIES} in ${delayMs}ms`);
        await this.sleep(delayMs);
      }

      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Embedding generation timeout after 30 seconds')), 30000);
        });

        const embeddingPromise = this.client.embeddings({
          model: this.embeddingModel,
          prompt: text
        });

        const response = await Promise.race([embeddingPromise, timeoutPromise]);

        if (!response.embedding || response.embedding.length !== 768) {
          throw new Error(`Invalid embedding dimensions: expected 768, got ${response.embedding?.length}`);
        }

        // Success: reset circuit breaker
        this.consecutiveFailures = 0;
        this.circuitOpenedAt = null;

        // Track embedding generation metrics
        const durationSeconds = (Date.now() - startTime) / 1000;
        trackEmbeddingGeneration('ollama', this.embeddingModel, durationSeconds);

        // Cache the embedding (async, don't wait)
        this.embeddingCache.set(text, response.embedding).catch(err =>
          console.warn('Failed to cache embedding:', err.message)
        );

        return response.embedding;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(`[OllamaClient] Embedding attempt ${attempt + 1} failed:`, lastError.message);
      }
    }

    // All retries exhausted: update circuit breaker state
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.CIRCUIT_OPEN_THRESHOLD && !this.circuitOpenedAt) {
      this.circuitOpenedAt = Date.now();
      console.error(`[OllamaClient] Circuit breaker opened after ${this.consecutiveFailures} failures.`);
    }

    // Graceful degradation
    if (this.FALLBACK_MODE === 'zero') {
      console.warn(`[OllamaClient] All retries failed. Returning zero vector (fallback mode). Last error: ${lastError.message}`);
      return new Array(768).fill(0);
    }

    throw lastError;
  }

  /** Returns true if the circuit is open (Ollama should not be called). */
  private isCircuitOpen(): boolean {
    if (this.circuitOpenedAt === null) return false;
    if (Date.now() - this.circuitOpenedAt > this.CIRCUIT_RESET_MS) {
      // Half-open: allow one probe attempt
      console.info('[OllamaClient] Circuit breaker reset — allowing probe request.');
      this.circuitOpenedAt = null;
      this.consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  /** Jittered exponential backoff: base * 2^attempt + ±20% jitter, capped at 10 s. */
  private backoffDelay(attempt: number): number {
    const base = 500;
    const cap = 10_000;
    const exp = Math.min(base * Math.pow(2, attempt - 1), cap);
    const jitter = exp * 0.2 * (Math.random() * 2 - 1);
    return Math.round(exp + jitter);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Split text into overlapping chunks for long-content embedding (REM-268).
   * Uses character-based splitting; chunks may split mid-word but this is
   * acceptable for embedding purposes (context overlap compensates).
   */
  private chunkText(text: string, chunkSize: number, overlap: number): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      chunks.push(text.slice(start, start + chunkSize));
      if (start + chunkSize >= text.length) break;
      start += chunkSize - overlap;
    }
    return chunks;
  }

  /**
   * Average multiple embedding vectors element-wise, then L2-normalise.
   * Normalisation preserves cosine-similarity semantics across the merged vector.
   */
  private averageEmbeddings(embeddings: number[][]): number[] {
    const dims = embeddings[0].length;
    const avg = new Array(dims).fill(0);

    for (const emb of embeddings) {
      for (let i = 0; i < dims; i++) {
        avg[i] += emb[i];
      }
    }
    for (let i = 0; i < dims; i++) {
      avg[i] /= embeddings.length;
    }

    // L2 normalise so the result sits on the unit sphere (matches single-chunk vectors)
    const norm = Math.sqrt(avg.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < dims; i++) avg[i] /= norm;
    }

    return avg;
  }

  /**
   * Generate text using Ollama LLM
   * @param prompt User prompt
   * @param systemPrompt Optional system prompt
   * @param options Additional generation options
   * @returns Generated text response
   */
  async generateText(
    prompt: string, 
    systemPrompt?: string,
    options?: {
      temperature?: number;
      maxTokens?: number;
      stopSequences?: string[];
    }
  ): Promise<string> {
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Text generation timeout after ${this.TEXT_GENERATION_TIMEOUT_MS}ms`)),
          this.TEXT_GENERATION_TIMEOUT_MS
        );
      });

      const generatePromise = this.textProvider === 'openai-compatible'
        ? this.generateOpenAICompatibleText(prompt, systemPrompt, options)
        : this.textClient.generate({
            model: this.textModel,
            prompt,
            system: systemPrompt,
            stream: false,
            options: {
              temperature: options?.temperature ?? 0.7,
              num_predict: options?.maxTokens ?? 500,
              stop: options?.stopSequences
            }
          }).then(response => response.response);

      return await Promise.race([generatePromise, timeoutPromise]);
    } catch (error) {
      console.error('Text generation failed:', error);
      throw error;
    }
  }

  private async generateOpenAICompatibleText(
    prompt: string,
    systemPrompt?: string,
    options?: {
      temperature?: number;
      maxTokens?: number;
      stopSequences?: string[];
    }
  ): Promise<string> {
    const baseUrl = this.normalizedOpenAICompatibleBaseUrl();
    const disableThinking = process.env.OPENAI_COMPATIBLE_DISABLE_THINKING !== 'false';
    const defaultMaxTokens = Number(process.env.OPENAI_COMPATIBLE_MAX_TOKENS ?? 4096);
    const messages = [
      ...(systemPrompt ? [{ role: 'system', content: disableThinking ? `/no_think\n${systemPrompt}` : systemPrompt }] : []),
      { role: 'user', content: prompt }
    ];

    if (disableThinking && !systemPrompt) {
      messages[0].content = `/no_think\n${messages[0].content}`;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.openAICompatibleApiKey}`
      },
      body: JSON.stringify({
        model: this.textModel,
        messages,
        stream: false,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? defaultMaxTokens,
        stop: options?.stopSequences,
        ...(disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {})
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenAI-compatible text generation failed (${response.status}): ${body.slice(0, 500)}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string }; text?: string; finish_reason?: string }>;
      error?: { message?: string };
      usage?: unknown;
    };

    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? choice?.text;
    if (!text) {
      const reasoningLength = choice?.message?.reasoning_content?.length ?? 0;
      const finishReason = choice?.finish_reason ?? 'unknown';
      throw new Error(
        data.error?.message ||
        `OpenAI-compatible text generation returned no content (finish_reason=${finishReason}, reasoning_content_chars=${reasoningLength})`
      );
    }

    return text;
  }

  private resolveTextProvider(textHost: string): 'ollama' | 'openai-compatible' {
    const configured = process.env.TEXT_GENERATION_PROVIDER?.toLowerCase();
    if (configured === 'openai-compatible' || configured === 'lmstudio' || configured === 'lm-studio') {
      return 'openai-compatible';
    }
    if (configured === 'ollama') {
      return 'ollama';
    }
    if (process.env.LM_STUDIO_BASE_URL || process.env.OPENAI_COMPATIBLE_TEXT_BASE_URL) {
      return 'openai-compatible';
    }
    return textHost.replace(/\/$/, '').endsWith('/v1') ? 'openai-compatible' : 'ollama';
  }

  private normalizedOpenAICompatibleBaseUrl(): string {
    const trimmed = this.textHost.replace(/\/+$/, '');
    return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
  }

  private parsePositiveInt(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  /**
   * Check if Ollama service is available.
   * Returns false immediately when the circuit is open.
   */
  async isAvailable(): Promise<boolean> {
    if (this.isCircuitOpen()) return false;
    try {
      await this.client.list();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns current circuit breaker state for health checks / metrics.
   */
  getCircuitState(): { open: boolean; consecutiveFailures: number; openedAt: number | null } {
    return {
      open: this.isCircuitOpen(),
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.circuitOpenedAt,
    };
  }

  /**
   * Get configured host URL
   */
  getHost(): string {
    return this.host;
  }

  getTextHost(): string {
    return this.textHost;
  }

  getTextProvider(): string {
    return this.textProvider;
  }

  /**
   * Get embedding model name
   */
  getEmbeddingModel(): string {
    return this.embeddingModel;
  }

  /**
   * Get text generation model name
   */
  getTextModel(): string {
    return this.textModel;
  }

  /**
   * REM-249: Get model fingerprint for embedding consistency tracking.
   * Fingerprint is SHA-256(provider || model || dimensions).
   * Used to detect incompatible embeddings when the model changes.
   */
  getModelFingerprint(): string {
    const canonical = `ollama|${this.embeddingModel}|768`;
    return createHash('sha256').update(canonical).digest('hex');
  }
}
