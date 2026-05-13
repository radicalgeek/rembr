import Redis from 'ioredis';

export interface SessionData {
  transport: any;
  server: any;
  createdAt: number;
  lastAccessed: number;
}

/**
 * RedisSessionStore — MCP session persistence with resilient fallback (REM-254)
 *
 * ## Expiration Policy
 *
 * Sessions use a **sliding-window TTL** (default: 1 hour).  Every time a session
 * is read (`get`) or explicitly refreshed (`updateLastAccessed`), the TTL is reset
 * to the full window from that point.  Idle sessions expire naturally without
 * manual cleanup.
 *
 * | Event                  | Action                                  |
 * |------------------------|-----------------------------------------|
 * | `set()`                | Store with full TTL (SETEX)             |
 * | `get()`                | Return data + reset TTL (sliding)       |
 * | `updateLastAccessed()` | Update lastAccessed field + reset TTL   |
 * | `delete()`             | Immediate removal                       |
 * | Inactivity > TTL       | Redis expires key automatically         |
 *
 * ## Resilience / In-Memory Fallback (REM-254)
 *
 * When Redis is unavailable (connection error, pod restart, network partition):
 * - Writes and reads fall through to an in-process `Map`.
 * - The in-memory store applies the same TTL logic so sessions still expire.
 * - A warning is logged on every fallback operation so the condition is visible.
 * - When Redis recovers, new sessions are written to Redis; old in-memory sessions
 *   remain in memory until they expire or the process restarts.
 *
 * ## Environment Variables
 * - `REDIS_URL`      — full Redis URL (takes priority)
 * - `REDIS_HOST`     — Redis host (default: localhost)
 * - `REDIS_PORT`     — Redis port (default: 6379)
 * - `REDIS_PASSWORD` — Redis password (optional)
 * - `SESSION_TTL`    — TTL in seconds (default: 3600)
 */
export class RedisSessionStore {
  private redis: Redis;
  private readonly keyPrefix = 'mcp:session:';
  readonly sessionTTL: number;

  // In-memory fallback
  private readonly memoryStore = new Map<string, { data: string; expiresAt: number }>();
  private redisAvailable = true;

  constructor(redisUrl?: string) {
    this.sessionTTL = parseInt(process.env.SESSION_TTL || '3600', 10);

    if (redisUrl || process.env.REDIS_URL) {
      this.redis = new Redis(redisUrl || process.env.REDIS_URL!, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      });
    } else {
      this.redis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD || undefined,
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      });
    }

    this.redis.on('connect', () => {
      console.log('✅ Redis session store connected');
      this.redisAvailable = true;
    });

    this.redis.on('error', (error) => {
      console.error('❌ Redis session store error — falling back to in-memory store:', error.message);
      this.redisAvailable = false;
    });

    this.redis.on('close', () => {
      console.warn('⚠️ Redis session store connection closed — using in-memory fallback');
      this.redisAvailable = false;
    });
  }

  private getKey(sessionId: string): string {
    return `${this.keyPrefix}${sessionId}`;
  }

  // ---------------------------------------------------------------------------
  // Memory fallback helpers
  // ---------------------------------------------------------------------------

  private memGet(sessionId: string): string | null {
    const entry = this.memoryStore.get(sessionId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.memoryStore.delete(sessionId);
      return null;
    }
    // Sliding window: reset TTL on read
    entry.expiresAt = Date.now() + this.sessionTTL * 1000;
    return entry.data;
  }

  private memSet(sessionId: string, value: string): void {
    this.memoryStore.set(sessionId, {
      data: value,
      expiresAt: Date.now() + this.sessionTTL * 1000,
    });
  }

  private memDel(sessionId: string): void {
    this.memoryStore.delete(sessionId);
  }

  private memKeys(): string[] {
    const now = Date.now();
    const keys: string[] = [];
    for (const [id, entry] of this.memoryStore.entries()) {
      if (entry.expiresAt > now) {
        keys.push(id);
      } else {
        this.memoryStore.delete(id); // opportunistic cleanup
      }
    }
    return keys;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async set(sessionId: string, data: SessionData): Promise<void> {
    const key = this.getKey(sessionId);
    const sessionData = {
      ...data,
      // transport and server objects are not serializable — store metadata only
      transport: null,
      server: null,
      lastAccessed: Date.now(),
    };
    const serialized = JSON.stringify(sessionData);

    if (!this.redisAvailable) {
      console.warn('⚠️ Redis unavailable — storing session in memory:', sessionId);
      this.memSet(sessionId, serialized);
      return;
    }

    try {
      await this.redis.setex(key, this.sessionTTL, serialized);
      this.redisAvailable = true;
      console.log('💾 Session stored in Redis:', { sessionId, ttl: this.sessionTTL });
    } catch (error) {
      console.warn('⚠️ Redis unavailable — storing session in memory:', sessionId);
      this.redisAvailable = false;
      this.memSet(sessionId, serialized);
    }
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const key = this.getKey(sessionId);

    // Try Redis first
    if (this.redisAvailable) {
      try {
        const data = await this.redis.get(key);
        if (data) {
          // Sliding window: reset TTL on read
          await this.redis.expire(key, this.sessionTTL);
          const sessionData = JSON.parse(data) as SessionData;
          console.log('📖 Session retrieved from Redis:', { sessionId });
          return sessionData;
        }
        // Not found in Redis — check memory (could have been written during outage)
      } catch (error) {
        console.warn('⚠️ Redis get failed — checking in-memory fallback:', sessionId);
        this.redisAvailable = false;
      }
    }

    // Fallback to in-memory
    const memData = this.memGet(sessionId);
    if (memData) {
      console.warn('📖 Session retrieved from in-memory fallback:', sessionId);
      return JSON.parse(memData) as SessionData;
    }

    console.log('🔍 Session not found:', sessionId);
    return null;
  }

  async delete(sessionId: string): Promise<void> {
    const key = this.getKey(sessionId);
    this.memDel(sessionId);

    try {
      await this.redis.del(key);
      console.log('🗑️ Session deleted:', sessionId);
    } catch (error) {
      console.warn('⚠️ Redis delete failed (session removed from memory):', sessionId);
    }
  }

  async exists(sessionId: string): Promise<boolean> {
    if (this.redisAvailable) {
      try {
        const key = this.getKey(sessionId);
        const exists = await this.redis.exists(key);
        if (exists === 1) return true;
      } catch {
        this.redisAvailable = false;
      }
    }
    // Check in-memory fallback
    return this.memGet(sessionId) !== null;
  }

  async listSessions(): Promise<string[]> {
    const ids = new Set<string>();

    // Add in-memory sessions (expired ones are filtered by memKeys)
    for (const id of this.memKeys()) ids.add(id);

    if (this.redisAvailable) {
      try {
        const pattern = `${this.keyPrefix}*`;
        const keys = await this.redis.keys(pattern);
        for (const key of keys) ids.add(key.replace(this.keyPrefix, ''));
      } catch (error) {
        console.warn('⚠️ Redis keys failed — listing in-memory sessions only');
      }
    }

    return Array.from(ids);
  }

  async updateLastAccessed(sessionId: string): Promise<void> {
    try {
      const sessionData = await this.get(sessionId);
      if (sessionData) {
        sessionData.lastAccessed = Date.now();
        await this.set(sessionId, sessionData);
      }
    } catch (error) {
      console.error('❌ Failed to update session access time:', error);
    }
  }

  /**
   * Returns current backend health for observability.
   */
  getHealth(): { redis: boolean; inMemorySessionCount: number } {
    return {
      redis: this.redisAvailable,
      inMemorySessionCount: this.memKeys().length,
    };
  }

  async cleanup(): Promise<void> {
    try {
      await this.redis.disconnect();
      console.log('✅ Redis session store disconnected');
    } catch (error) {
      console.error('❌ Failed to disconnect Redis:', error);
    }
  }
}
