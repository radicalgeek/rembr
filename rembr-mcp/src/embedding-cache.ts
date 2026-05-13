import Redis from 'ioredis';
import * as crypto from 'crypto';
import { trackCacheHit } from './metrics.js';

/**
 * EmbeddingCache - Redis-backed LRU cache for embeddings
 * 
 * Uses Redis for distributed caching with in-memory fallback.
 * Embeddings are expensive to generate (~100-500ms each), so caching
 * dramatically improves performance for repeated searches.
 * 
 * Cache key format: embedding:{model}:{hash}
 * TTL: 24 hours (embeddings don't change for same text)
 */
export class EmbeddingCache {
  private static instance: EmbeddingCache;
  private redis: Redis | null = null;
  private memoryCache: Map<string, number[]> = new Map();
  private maxMemoryCacheSize = 1000;
  private defaultTtl = 86400; // 24 hours in seconds
  private model: string;
  private isConnected = false;

  private constructor() {
    this.model = process.env.OLLAMA_EMBEDDING_MODEL || 'nomic-embed-text';
    this.setupRedis();
  }

  static getInstance(): EmbeddingCache {
    if (!EmbeddingCache.instance) {
      EmbeddingCache.instance = new EmbeddingCache();
    }
    return EmbeddingCache.instance;
  }

  private setupRedis(): void {
    const redisHost = process.env.REDIS_HOST;
    const redisPort = process.env.REDIS_PORT;
    const redisPassword = process.env.REDIS_PASSWORD;
    
    if (!redisHost) {
      console.log('📦 EmbeddingCache: Redis not configured, using in-memory cache');
      return;
    }

    try {
      this.redis = new Redis({
        host: redisHost,
        port: parseInt(redisPort || '6379'),
        password: redisPassword,
        retryStrategy: (times) => {
          if (times > 3) {
            console.warn('📦 EmbeddingCache: Redis connection failed, falling back to memory cache');
            return null; // Stop retrying
          }
          return Math.min(times * 100, 3000);
        },
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });

      this.redis.on('connect', () => {
        this.isConnected = true;
        console.log('✅ EmbeddingCache: Redis connected');
      });

      this.redis.on('error', (error) => {
        console.error('❌ EmbeddingCache: Redis error:', error.message);
        this.isConnected = false;
      });

      this.redis.on('close', () => {
        this.isConnected = false;
      });

      // Connect immediately
      this.redis.connect().catch((err) => {
        console.warn('📦 EmbeddingCache: Redis connect failed, using memory cache:', err.message);
      });

    } catch (error) {
      console.error('❌ EmbeddingCache: Failed to setup Redis:', error);
    }
  }

  /**
   * Generate cache key from text
   */
  private getCacheKey(text: string): string {
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    return `embedding:${this.model}:${hash}`;
  }

  /**
   * Get embedding from cache
   * Returns undefined if not cached
   */
  async get(text: string): Promise<number[] | undefined> {
    const key = this.getCacheKey(text);

    // Try Redis first
    if (this.redis && this.isConnected) {
      try {
        const cached = await this.redis.get(key);
        if (cached) {
          trackCacheHit('embedding');
          // Also store in memory for faster subsequent hits
          const embedding = JSON.parse(cached) as number[];
          this.setMemoryCache(key, embedding);
          return embedding;
        }
      } catch (error) {
        console.warn('EmbeddingCache: Redis get error:', error);
      }
    }

    // Fall back to memory cache
    const memCached = this.memoryCache.get(key);
    if (memCached) {
      trackCacheHit('embedding');
      // Move to end (most recently used)
      this.memoryCache.delete(key);
      this.memoryCache.set(key, memCached);
      return memCached;
    }

    return undefined;
  }

  /**
   * Store embedding in cache
   */
  async set(text: string, embedding: number[]): Promise<void> {
    const key = this.getCacheKey(text);

    // Store in Redis
    if (this.redis && this.isConnected) {
      try {
        await this.redis.setex(key, this.defaultTtl, JSON.stringify(embedding));
      } catch (error) {
        console.warn('EmbeddingCache: Redis set error:', error);
      }
    }

    // Also store in memory cache
    this.setMemoryCache(key, embedding);
  }

  /**
   * Store in memory cache with LRU eviction
   */
  private setMemoryCache(key: string, embedding: number[]): void {
    // Evict oldest if at capacity
    if (this.memoryCache.size >= this.maxMemoryCacheSize) {
      const firstKey = this.memoryCache.keys().next().value;
      if (firstKey) this.memoryCache.delete(firstKey);
    }
    this.memoryCache.set(key, embedding);
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    redisConnected: boolean;
    memoryCacheSize: number;
    redisCacheSize?: number;
  }> {
    const stats = {
      redisConnected: this.isConnected,
      memoryCacheSize: this.memoryCache.size,
      redisCacheSize: undefined as number | undefined,
    };

    if (this.redis && this.isConnected) {
      try {
        const keys = await this.redis.keys(`embedding:${this.model}:*`);
        stats.redisCacheSize = keys.length;
      } catch (error) {
        console.warn('EmbeddingCache: Failed to get Redis stats:', error);
      }
    }

    return stats;
  }

  /**
   * Clear all cached embeddings
   */
  async clear(): Promise<void> {
    this.memoryCache.clear();
    
    if (this.redis && this.isConnected) {
      try {
        const keys = await this.redis.keys(`embedding:${this.model}:*`);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      } catch (error) {
        console.warn('EmbeddingCache: Failed to clear Redis cache:', error);
      }
    }
  }
}
