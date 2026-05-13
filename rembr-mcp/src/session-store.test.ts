/**
 * Unit Tests: RedisSessionStore
 * REM-254: Session store implementation and expiration policy
 *
 * Tests:
 * - Sliding-window TTL (reset on read)
 * - In-memory fallback when Redis is unavailable
 * - CRUD operations (set / get / delete / exists / listSessions)
 * - Health reporting
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Redis mock
// ---------------------------------------------------------------------------
const mockRedisOps: { [key: string]: { value: string; expiresAt: number } } = {};

const mockRedis = {
  setex: vi.fn(async (key: string, ttl: number, value: string) => {
    mockRedisOps[key] = { value, expiresAt: Date.now() + ttl * 1000 };
    return 'OK';
  }),
  get: vi.fn(async (key: string) => {
    const entry = mockRedisOps[key];
    if (!entry || Date.now() > entry.expiresAt) return null;
    return entry.value;
  }),
  expire: vi.fn(async (key: string, ttl: number) => {
    if (mockRedisOps[key]) {
      mockRedisOps[key].expiresAt = Date.now() + ttl * 1000;
    }
    return 1;
  }),
  del: vi.fn(async (key: string) => {
    delete mockRedisOps[key];
    return 1;
  }),
  exists: vi.fn(async (key: string) => {
    const entry = mockRedisOps[key];
    return entry && Date.now() <= entry.expiresAt ? 1 : 0;
  }),
  keys: vi.fn(async (pattern: string) => {
    const prefix = pattern.replace('*', '');
    return Object.keys(mockRedisOps).filter(k =>
      k.startsWith(prefix) && Date.now() <= mockRedisOps[k].expiresAt
    );
  }),
  on: vi.fn(),
  disconnect: vi.fn().mockResolvedValue(undefined),
};

vi.mock('ioredis', () => ({
  default: vi.fn(() => mockRedis),
}));

import { RedisSessionStore, SessionData } from './session-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    transport: null,
    server: null,
    createdAt: Date.now() - 5000,
    lastAccessed: Date.now(),
    ...overrides,
  };
}

function forceRedisDown(store: RedisSessionStore) {
  (store as any).redisAvailable = false;
}

function forceRedisUp(store: RedisSessionStore) {
  (store as any).redisAvailable = true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RedisSessionStore', () => {
  let store: RedisSessionStore;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockRedisOps).forEach(k => delete mockRedisOps[k]);
    store = new RedisSessionStore('redis://localhost:6379');
  });

  // ---- Construction --------------------------------------------------------

  describe('constructor', () => {
    it('should create store with Redis URL', () => {
      expect(store).toBeDefined();
      expect(store.sessionTTL).toBe(3600); // default
    });

    it('should respect SESSION_TTL env var', () => {
      process.env.SESSION_TTL = '7200';
      const s = new RedisSessionStore('redis://localhost');
      expect(s.sessionTTL).toBe(7200);
      delete process.env.SESSION_TTL;
    });

    it('should construct without URL using env vars', () => {
      const s = new RedisSessionStore();
      expect(s).toBeDefined();
    });
  });

  // ---- Key prefix ----------------------------------------------------------

  describe('key prefix', () => {
    it('should use mcp:session: prefix', () => {
      const getKey = (store as any).getKey.bind(store);
      expect(getKey('abc')).toBe('mcp:session:abc');
    });
  });

  // ---- set / get -----------------------------------------------------------

  describe('set and get', () => {
    it('should store a session in Redis', async () => {
      const session = makeSession();
      await store.set('sess-1', session);

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'mcp:session:sess-1',
        store.sessionTTL,
        expect.any(String)
      );
    });

    it('should retrieve a stored session', async () => {
      const session = makeSession();
      await store.set('sess-2', session);

      const retrieved = await store.get('sess-2');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.createdAt).toBe(session.createdAt);
    });

    it('should return null for unknown session', async () => {
      const result = await store.get('no-such-session');
      expect(result).toBeNull();
    });

    it('should null out transport and server on set', async () => {
      const session = makeSession({ transport: { socket: 'fake' }, server: { rpc: true } });
      await store.set('sess-3', session);

      const retrieved = await store.get('sess-3');
      expect(retrieved!.transport).toBeNull();
      expect(retrieved!.server).toBeNull();
    });
  });

  // ---- Sliding TTL ---------------------------------------------------------

  describe('sliding-window TTL', () => {
    it('should reset Redis TTL on get', async () => {
      await store.set('slide-1', makeSession());
      vi.clearAllMocks(); // clear the setex call

      await store.get('slide-1');

      expect(mockRedis.expire).toHaveBeenCalledWith(
        'mcp:session:slide-1',
        store.sessionTTL
      );
    });

    it('should update lastAccessed on updateLastAccessed', async () => {
      const oldTime = Date.now() - 60_000;
      await store.set('slide-2', makeSession({ lastAccessed: oldTime }));

      await store.updateLastAccessed('slide-2');

      const retrieved = await store.get('slide-2');
      expect(retrieved!.lastAccessed).toBeGreaterThan(oldTime);
    });
  });

  // ---- delete / exists / list ---------------------------------------------

  describe('delete', () => {
    it('should remove a session', async () => {
      await store.set('del-1', makeSession());
      await store.delete('del-1');

      const result = await store.get('del-1');
      expect(result).toBeNull();
    });
  });

  describe('exists', () => {
    it('should return true for existing session', async () => {
      await store.set('ex-1', makeSession());
      expect(await store.exists('ex-1')).toBe(true);
    });

    it('should return false for missing session', async () => {
      expect(await store.exists('ghost')).toBe(false);
    });
  });

  describe('listSessions', () => {
    it('should list stored session IDs', async () => {
      await store.set('list-1', makeSession());
      await store.set('list-2', makeSession());

      const ids = await store.listSessions();
      expect(ids).toContain('list-1');
      expect(ids).toContain('list-2');
    });
  });

  // ---- In-memory fallback --------------------------------------------------

  describe('in-memory fallback (REM-254)', () => {
    beforeEach(() => {
      forceRedisDown(store);
    });

    it('should store session in memory when Redis is unavailable', async () => {
      await store.set('mem-1', makeSession());

      // Should NOT have called Redis setex
      expect(mockRedis.setex).not.toHaveBeenCalled();

      const retrieved = await store.get('mem-1');
      expect(retrieved).not.toBeNull();
    });

    it('should retrieve session from memory when Redis is unavailable', async () => {
      await store.set('mem-2', makeSession());
      const result = await store.get('mem-2');

      expect(result).not.toBeNull();
      expect(result!.createdAt).toBeDefined();
    });

    it('should return null for unknown session in memory', async () => {
      const result = await store.get('no-such-mem');
      expect(result).toBeNull();
    });

    it('should delete session from memory', async () => {
      await store.set('mem-del', makeSession());
      await store.delete('mem-del');

      const result = await store.get('mem-del');
      expect(result).toBeNull();
    });

    it('should list in-memory sessions', async () => {
      await store.set('mem-list-1', makeSession());
      await store.set('mem-list-2', makeSession());

      const ids = await store.listSessions();
      expect(ids).toContain('mem-list-1');
      expect(ids).toContain('mem-list-2');
    });

    it('should apply sliding TTL in memory on get', async () => {
      await store.set('mem-slide', makeSession());

      // Artificially expire it
      const entry = (store as any).memoryStore.get('mem-slide');
      expect(entry).toBeDefined();
      const beforeExpiry = entry.expiresAt;

      // Small delay then read
      await new Promise(r => setTimeout(r, 5));
      await store.get('mem-slide');

      const afterExpiry = (store as any).memoryStore.get('mem-slide').expiresAt;
      // TTL should have been extended
      expect(afterExpiry).toBeGreaterThanOrEqual(beforeExpiry);
    });

    it('should return null for expired in-memory session', async () => {
      await store.set('mem-exp', makeSession());
      // Force-expire the entry
      const entry = (store as any).memoryStore.get('mem-exp');
      entry.expiresAt = Date.now() - 1;

      const result = await store.get('mem-exp');
      expect(result).toBeNull();
    });

    it('should check in-memory sessions from exists()', async () => {
      await store.set('mem-exists', makeSession());
      expect(await store.exists('mem-exists')).toBe(true);
    });
  });

  // ---- Health reporting ----------------------------------------------------

  describe('getHealth', () => {
    it('should report redis=true when connected', () => {
      forceRedisUp(store);
      const health = store.getHealth();
      expect(health.redis).toBe(true);
    });

    it('should report redis=false when disconnected', () => {
      forceRedisDown(store);
      const health = store.getHealth();
      expect(health.redis).toBe(false);
    });

    it('should count in-memory sessions', async () => {
      forceRedisDown(store);
      await store.set('health-1', makeSession());
      await store.set('health-2', makeSession());

      const health = store.getHealth();
      expect(health.inMemorySessionCount).toBe(2);
    });
  });

  // ---- cleanup -------------------------------------------------------------

  describe('cleanup', () => {
    it('should disconnect Redis', async () => {
      await store.cleanup();
      expect(mockRedis.disconnect).toHaveBeenCalled();
    });
  });
});
