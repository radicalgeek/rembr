/**
 * Transport-layer rate limiting middleware for the MCP server.
 *
 * Implements a fixed-window counter using Redis (ioredis).
 * Runs BEFORE tool dispatch and business logic to protect the Ollama embedding
 * pipeline and PostgreSQL from runaway or misconfigured agents.
 *
 * Two rate-limit tiers:
 *
 * 1. Transport-layer (per-credential, per-minute) — REM-272
 *    Identity: SHA-256 hash of API key / Bearer token or client IP.
 *    Window: 60 seconds (configurable via RATE_LIMIT_*_PER_MIN env vars).
 *
 * 2. Per-tenant daily quota (per-tenant-ID, per-day) — REM-48
 *    Identity: tenant UUID.
 *    Window: 24 hours (UTC day boundary).
 *    Limits by plan:
 *      Free:       1,000  requests/day
 *      Pro:      100,000  requests/day
 *      Team:   1,000,000  requests/day
 *      Enterprise: custom (default 10,000,000)
 *
 * Redis availability:
 *   - When Redis IS available: counts stored in Redis (distributed, accurate).
 *   - When Redis is NOT available: counts stored in an in-process Map fallback
 *     (fail-CLOSED — limits ARE enforced, but state is local to each pod).
 *     This prevents a missing/down Redis from disabling all rate limiting.
 *
 * REM-272 / REM-48
 */

import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';

// ---------------------------------------------------------------------------
// Config — per-minute transport limits (REM-272)
// ---------------------------------------------------------------------------

/** Window size in seconds for per-minute transport limiting. */
const WINDOW_SECONDS = 60;

/** Paths that bypass rate limiting entirely. */
const BYPASS_PATHS = new Set(['/health', '/metrics', '/ping']);

/** Per-plan limits (requests per window). Overridable via env. */
export const PLAN_LIMITS: Record<string, number> = {
  free: parseInt(process.env.RATE_LIMIT_FREE || '60', 10),
  pro: parseInt(process.env.RATE_LIMIT_PRO || '300', 10),
  team: parseInt(process.env.RATE_LIMIT_TEAM || '1000', 10),
  business: parseInt(process.env.RATE_LIMIT_TEAM || '1000', 10),
  enterprise: parseInt(process.env.RATE_LIMIT_ENTERPRISE || '1000000', 10),
  default: parseInt(process.env.RATE_LIMIT_DEFAULT || '60', 10),
};

// ---------------------------------------------------------------------------
// Config — per-tenant daily limits (REM-48)
// ---------------------------------------------------------------------------

/** Window size in seconds for daily quota (24 hours). */
const DAY_SECONDS = 86400;

/** Per-plan daily request quotas. Overridable via env vars. */
export const DAILY_PLAN_LIMITS: Record<string, number> = {
  free:       parseInt(process.env.DAILY_LIMIT_FREE       || '1000',     10),
  pro:        parseInt(process.env.DAILY_LIMIT_PRO        || '100000',   10),
  team:       parseInt(process.env.DAILY_LIMIT_TEAM       || '1000000',  10),
  business:   parseInt(process.env.DAILY_LIMIT_BUSINESS   || '1000000',  10),
  enterprise: parseInt(process.env.DAILY_LIMIT_ENTERPRISE || '10000000', 10),
  default:    parseInt(process.env.DAILY_LIMIT_DEFAULT    || '1000',     10),
};

// ---------------------------------------------------------------------------
// Redis client (shared instance)
// ---------------------------------------------------------------------------

let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (redis) return redis;
  try {
    if (process.env.REDIS_URL) {
      redis = new Redis(process.env.REDIS_URL);
    } else {
      redis = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
        // Don't retry forever — fail fast so middleware can fall back
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: true,
      });
    }
    redis.on('error', (err) => {
      // Log but don't crash — fall back to in-process store
      console.error('[RateLimit] Redis error:', err.message);
    });
    return redis;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-process fallback store (used when Redis is unavailable)
//
// Map key: Redis key string (e.g. "ratelimit:key:abc123:12345")
// Map value: { count, expiresAtMs }
//
// Entries are evicted lazily on access and proactively in a periodic sweep.
// This is per-pod state — not distributed. It enforces limits within a single
// pod but cannot coordinate across replicas. Acceptable for the no-Redis case.
// ---------------------------------------------------------------------------

interface FallbackEntry {
  count: number;
  expiresAtMs: number;
}

const fallbackStore = new Map<string, FallbackEntry>();

/** Clean up expired entries every 5 minutes to prevent unbounded memory growth. */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of fallbackStore) {
    if (entry.expiresAtMs <= now) {
      fallbackStore.delete(key);
    }
  }
}, 5 * 60 * 1000).unref(); // unref so this doesn't prevent process exit

/**
 * Increment and return count from in-process fallback store.
 * TTL is windowSeconds * 2 (same as Redis strategy).
 */
function fallbackIncr(key: string, windowSeconds: number): number {
  const now = Date.now();
  const entry = fallbackStore.get(key);

  if (!entry || entry.expiresAtMs <= now) {
    // New window
    fallbackStore.set(key, { count: 1, expiresAtMs: now + windowSeconds * 2 * 1000 });
    return 1;
  }

  entry.count += 1;
  return entry.count;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a stable, opaque rate-limit key from the credential in the request.
 * Uses SHA-256 so raw credentials are never stored in Redis keys.
 */
function extractIdentityKey(req: Request): string {
  const apiKey = req.headers['x-api-key'] as string | undefined;
  const authHeader = req.headers['authorization'] as string | undefined;
  const credential = apiKey || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);

  if (credential) {
    return 'key:' + createHash('sha256').update(credential).digest('hex');
  }

  // Fall back to IP (less precise but always available)
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
  return 'ip:' + ip;
}

/** Current fixed-window bucket (Unix seconds rounded to window). */
function currentWindow(): number {
  return Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
}

/**
 * Current UTC day bucket for daily quota tracking.
 * Uses YYYY-MM-DD so the window resets at midnight UTC.
 */
function currentUtcDay(): string {
  return new Date().toISOString().slice(0, 10); // "2026-02-27"
}

// ---------------------------------------------------------------------------
// Core rate-limit check (shared logic)
// ---------------------------------------------------------------------------

interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
}

/**
 * Check and increment the request counter.
 * Uses Redis when available; falls back to in-process Map store otherwise.
 * Both paths enforce limits — there is no fail-open behaviour.
 * Returns { allowed, count, limit, retryAfterSeconds }.
 */
async function checkRateLimit(
  identityKey: string,
  limit: number,
  windowSeconds: number,
  windowKey: string | number,
): Promise<RateLimitResult> {
  const redisKey = `ratelimit:${identityKey}:${windowKey}`;

  let retryAfterSeconds: number;
  if (typeof windowKey === 'number') {
    // Per-minute window
    const windowEndsAt = (windowKey + 1) * windowSeconds;
    retryAfterSeconds = Math.max(0, windowEndsAt - Math.floor(Date.now() / 1000));
  } else {
    // Daily window — retry at next midnight UTC
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    retryAfterSeconds = Math.max(0, Math.floor((midnight.getTime() - now.getTime()) / 1000));
  }

  const client = getRedis();

  if (client) {
    // --- Redis path ---
    try {
      const count = await client.incr(redisKey);
      if (count === 1) {
        await client.expire(redisKey, windowSeconds * 2);
      }
      return { allowed: count <= limit, count, limit, retryAfterSeconds };
    } catch (err) {
      // Redis error mid-request — fall through to in-process store rather
      // than silently allowing the request.
      console.error('[RateLimit] Redis check failed, using in-process fallback:', (err as Error).message);
    }
  } else {
    console.warn('[RateLimit] Redis unavailable — enforcing limits via in-process fallback store (per-pod).');
  }

  // --- In-process fallback path (enforces limits, not fail-open) ---
  const count = fallbackIncr(redisKey, windowSeconds);
  return { allowed: count <= limit, count, limit, retryAfterSeconds };
}

// ---------------------------------------------------------------------------
// Per-tenant daily quota check (REM-48)
// ---------------------------------------------------------------------------

/**
 * Check (and increment) the per-tenant daily request quota.
 *
 * Call this after authentication, once tenantId and plan are known.
 * Returns the rate-limit result; caller decides whether to reject with 429.
 *
 * Redis key format: `daily:tenant:{tenantId}:{YYYY-MM-DD}`
 * TTL: 48 hours (2x window, so data persists for debugging).
 */
export async function checkDailyTenantQuota(
  tenantId: string,
  plan: string,
): Promise<RateLimitResult> {
  const limit = DAILY_PLAN_LIMITS[plan?.toLowerCase()] ?? DAILY_PLAN_LIMITS.default;
  const identityKey = `tenant:${tenantId}`;
  return checkRateLimit(identityKey, limit, DAY_SECONDS, currentUtcDay());
}

export async function checkTransportRateLimit(
  req: Request,
  plan: string,
): Promise<RateLimitResult> {
  const limit = PLAN_LIMITS[plan?.toLowerCase()] ?? PLAN_LIMITS.default;
  const identityKey = extractIdentityKey(req);
  return checkRateLimit(identityKey, limit, WINDOW_SECONDS, currentWindow());
}

/**
 * Get the current daily usage for a tenant without incrementing.
 * Useful for exposing quota info in get_stats.
 */
export async function getDailyTenantUsage(
  tenantId: string,
  plan: string,
): Promise<{ count: number; limit: number; remaining: number; resetAt: string }> {
  const client = getRedis();
  const limit = DAILY_PLAN_LIMITS[plan?.toLowerCase()] ?? DAILY_PLAN_LIMITS.default;

  if (!client) {
    // Check in-process fallback store
    const redisKey = `ratelimit:tenant:${tenantId}:${currentUtcDay()}`;
    const entry = fallbackStore.get(redisKey);
    const count = (entry && entry.expiresAtMs > Date.now()) ? entry.count : 0;
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    return {
      count,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt: midnight.toISOString(),
    };
  }

  try {
    const redisKey = `ratelimit:tenant:${tenantId}:${currentUtcDay()}`;
    const raw = await client.get(redisKey);
    const count = raw ? parseInt(raw, 10) : 0;
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    return {
      count,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt: midnight.toISOString(),
    };
  } catch {
    return { count: 0, limit, remaining: limit, resetAt: currentUtcDay() };
  }
}

// ---------------------------------------------------------------------------
// Exported plan-aware middleware factory (per-minute, REM-272)
// ---------------------------------------------------------------------------

/**
 * Returns an Express middleware that enforces transport-layer rate limiting.
 *
 * @param plan - Optional plan tier. Pass 'free'|'pro'|'team' etc. once auth
 *               resolves it. Defaults to PLAN_LIMITS.default until then.
 */
export function createRateLimitMiddleware(plan?: string) {
  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    // Skip health/metrics endpoints
    if (BYPASS_PATHS.has(req.path)) {
      next();
      return;
    }

    const limit = PLAN_LIMITS[plan || 'default'] ?? PLAN_LIMITS.default;
    const identityKey = extractIdentityKey(req);

    const { allowed, count, retryAfterSeconds } = await checkRateLimit(
      identityKey, limit, WINDOW_SECONDS, currentWindow()
    );

    // Always set informational headers
    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - count));
    res.setHeader('X-RateLimit-Window', `${WINDOW_SECONDS}s`);

    if (!allowed) {
      res.setHeader('Retry-After', retryAfterSeconds);
      res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Maximum ${limit} requests per ${WINDOW_SECONDS} seconds.`,
        retry_after: retryAfterSeconds,
      });
      return;
    }

    next();
  };
}

/** Pre-built default middleware (free-tier limits, no plan context required). */
export const defaultRateLimitMiddleware = createRateLimitMiddleware();
