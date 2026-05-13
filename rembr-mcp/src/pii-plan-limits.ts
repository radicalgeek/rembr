/**
 * PII Plan-Tier Limits & Capabilities (RAD-35)
 *
 * Defines PII capabilities and monthly scan quotas per pricing tier:
 *
 * | Plan       | PII Scanning       | Auto-Redaction | Compliance Reports | Scans/month |
 * |------------|--------------------|----------------|--------------------|-------------|
 * | Free       | Basic (regex only) | Manual only    | No                 | 100         |
 * | Pro        | Full (regex + NLP) | Automatic      | Monthly            | 1,000       |
 * | Team       | Full + Custom      | Automatic      | Weekly             | 10,000      |
 * | Business   | Full + Custom      | Automatic      | Weekly             | 50,000      |
 * | Enterprise | Full + Custom + API| Auto+Real-time | Daily + API        | Unlimited   |
 *
 * Plan gating controls:
 *   - Max sensitivity level allowed
 *   - Whether compliance_report is accessible
 *   - Compliance report frequency limits
 *   - Whether auto-redaction runs on store/update
 *   - Whether batch_scan is available
 *   - Whether custom detection rules are supported (future)
 *   - Monthly PII scan quota (detect + redact count toward this)
 */

import Redis from 'ioredis';

export type PlanTier = 'free' | 'pro' | 'team' | 'business' | 'enterprise';
export type PIISensitivity = 'low' | 'medium' | 'high';
export type ComplianceFrequency = 'none' | 'monthly' | 'weekly' | 'daily';

/** Sentinel value meaning no monthly limit applies */
export const PII_SCANS_UNLIMITED = Infinity;

export interface PIIPlanCapabilities {
  /** Maximum sensitivity level allowed for this plan */
  maxSensitivity: PIISensitivity;
  /** Whether auto-scan/redaction runs on store_memory and update_memory */
  autoScan: boolean;
  /** Whether the compliance_report operation is accessible */
  complianceReportEnabled: boolean;
  /** How frequently compliance reports can be generated */
  complianceFrequency: ComplianceFrequency;
  /** Whether batch_scan operation is available */
  batchScanEnabled: boolean;
  /** Whether custom PII detection rules are supported (future NLP/custom) */
  customRulesEnabled: boolean;
  /** Monthly PII scan quota (detect + redact operations). Infinity = unlimited. */
  piiScansPerMonth: number;
  /** Human-readable plan label */
  planLabel: string;
}

/** PII capabilities per plan tier */
export const PII_PLAN_CAPABILITIES: Record<PlanTier, PIIPlanCapabilities> = {
  free: {
    maxSensitivity: 'medium',
    autoScan: false,
    complianceReportEnabled: false,
    complianceFrequency: 'none',
    batchScanEnabled: false,
    customRulesEnabled: false,
    piiScansPerMonth: parseInt(process.env.PII_SCAN_LIMIT_FREE ?? '100', 10),
    planLabel: 'Free',
  },
  pro: {
    maxSensitivity: 'high',
    autoScan: true,
    complianceReportEnabled: true,
    complianceFrequency: 'monthly',
    batchScanEnabled: true,
    customRulesEnabled: false,
    piiScansPerMonth: parseInt(process.env.PII_SCAN_LIMIT_PRO ?? '1000', 10),
    planLabel: 'Pro',
  },
  team: {
    maxSensitivity: 'high',
    autoScan: true,
    complianceReportEnabled: true,
    complianceFrequency: 'weekly',
    batchScanEnabled: true,
    customRulesEnabled: true,
    piiScansPerMonth: parseInt(process.env.PII_SCAN_LIMIT_TEAM ?? '10000', 10),
    planLabel: 'Team',
  },
  business: {
    maxSensitivity: 'high',
    autoScan: true,
    complianceReportEnabled: true,
    complianceFrequency: 'weekly',
    batchScanEnabled: true,
    customRulesEnabled: true,
    piiScansPerMonth: parseInt(process.env.PII_SCAN_LIMIT_BUSINESS ?? '50000', 10),
    planLabel: 'Business',
  },
  enterprise: {
    maxSensitivity: 'high',
    autoScan: true,
    complianceReportEnabled: true,
    complianceFrequency: 'daily',
    batchScanEnabled: true,
    customRulesEnabled: true,
    piiScansPerMonth: PII_SCANS_UNLIMITED,
    planLabel: 'Enterprise',
  },
};

/**
 * Get PII capabilities for a given plan tier.
 * Defaults to 'free' if the plan is unknown.
 */
export function getPIICapabilities(plan: string): PIIPlanCapabilities {
  const tier = (plan || 'free').toLowerCase() as PlanTier;
  return PII_PLAN_CAPABILITIES[tier] ?? PII_PLAN_CAPABILITIES.free;
}

/**
 * Clamp sensitivity to the maximum allowed for a plan.
 * Free plan is capped at 'medium'; Pro+ can use 'high'.
 */
export function clampSensitivity(
  requested: PIISensitivity,
  plan: string
): PIISensitivity {
  const caps = getPIICapabilities(plan);
  const levels: PIISensitivity[] = ['low', 'medium', 'high'];
  const maxIdx = levels.indexOf(caps.maxSensitivity);
  const reqIdx = levels.indexOf(requested);
  return reqIdx > maxIdx ? caps.maxSensitivity : requested;
}

/**
 * Assert that a PII operation is permitted for a given plan.
 * Throws a descriptive error if the operation is gated.
 */
export function assertPIIOperationAllowed(
  operation: 'compliance_report' | 'batch_scan' | 'custom_rules',
  plan: string
): void {
  const caps = getPIICapabilities(plan);
  const planLabel = caps.planLabel;

  switch (operation) {
    case 'compliance_report':
      if (!caps.complianceReportEnabled) {
        throw new Error(
          `Compliance reports are not available on the ${planLabel} plan. ` +
          `Upgrade to Pro or higher to generate GDPR compliance reports.`
        );
      }
      break;
    case 'batch_scan':
      if (!caps.batchScanEnabled) {
        throw new Error(
          `Batch scanning is not available on the ${planLabel} plan. ` +
          `Upgrade to Pro or higher to run batch PII scans.`
        );
      }
      break;
    case 'custom_rules':
      if (!caps.customRulesEnabled) {
        throw new Error(
          `Custom PII detection rules are not available on the ${planLabel} plan. ` +
          `Upgrade to Team or higher to use custom rules.`
        );
      }
      break;
  }
}

// ─── Monthly PII Scan Quota (RAD-35) ─────────────────────────────────────────

/** Shared Redis client for PII scan quota tracking. Lazily initialised. */
let _redisClient: Redis | null = null;

function getPIIRedis(): Redis | null {
  if (_redisClient) return _redisClient;
  try {
    const url = process.env.REDIS_URL;
    _redisClient = url
      ? new Redis(url)
      : new Redis({
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379', 10),
          password: process.env.REDIS_PASSWORD || undefined,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          lazyConnect: true,
        });
    _redisClient.on('error', () => { /* fail-open */ });
    return _redisClient;
  } catch {
    return null;
  }
}

/** Current UTC month bucket for monthly quota tracking (YYYY-MM). */
function currentUtcMonth(): string {
  return new Date().toISOString().slice(0, 7); // "2026-03"
}

/** First day of the next UTC month (for quota reset display). */
function nextMonthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

export interface PIIScanQuotaResult {
  /** Whether the scan is permitted */
  allowed: boolean;
  /** Current count this month (after increment if allowed) */
  count: number;
  /** Monthly limit for this plan */
  limit: number;
  /** Remaining scans this month */
  remaining: number;
  /** ISO timestamp when the quota resets */
  resetsAt: string;
  /** Plan tier that determined the limit */
  planTier: string;
}

/**
 * Check and increment the monthly PII scan quota for a tenant.
 *
 * Call this before executing detect, redact, or batch_scan operations.
 * - If the quota is exceeded, returns allowed=false (caller must reject with 429).
 * - Enterprise plans are always allowed (unlimited).
 * - On Redis failure the check fails-open (allowed=true) to prevent Redis
 *   downtime from blocking PII scanning entirely.
 *
 * Redis key: `pii:scan:monthly:{tenantId}:{YYYY-MM}`
 * TTL: 62 days (ensures key survives across month boundaries for debugging).
 *
 * RAD-35: Per-tier PII scan limits.
 */
export async function checkPIIScanQuota(
  tenantId: string,
  plan: string,
  increment: number = 1,
): Promise<PIIScanQuotaResult> {
  const caps = getPIICapabilities(plan);
  const limit = caps.piiScansPerMonth;
  const planTier = (plan || 'free').toLowerCase();
  const resetAt = nextMonthStart();

  // Enterprise: unlimited — skip Redis entirely
  if (limit === PII_SCANS_UNLIMITED) {
    return { allowed: true, count: 0, limit: -1, remaining: -1, resetsAt: resetAt, planTier };
  }

  const client = getPIIRedis();
  const month = currentUtcMonth();
  const key = `pii:scan:monthly:${tenantId}:${month}`;

  if (!client) {
    // Fail-open: Redis unavailable → allow but report 0 count
    return { allowed: true, count: 0, limit, remaining: limit, resetsAt: resetAt, planTier };
  }

  try {
    // Peek current count before deciding whether to increment
    const raw = await client.get(key);
    const current = raw ? parseInt(raw, 10) : 0;

    if (current + increment > limit) {
      // Over quota — do NOT increment
      return {
        allowed: false,
        count: current,
        limit,
        remaining: Math.max(0, limit - current),
        resetsAt: resetAt,
        planTier,
      };
    }

    // Increment and set TTL (62 days in seconds)
    const newCount = await client.incrby(key, increment);
    await client.expire(key, 62 * 86400);

    return {
      allowed: true,
      count: newCount,
      limit,
      remaining: Math.max(0, limit - newCount),
      resetsAt: resetAt,
      planTier,
    };
  } catch {
    // Fail-open on Redis error
    return { allowed: true, count: 0, limit, remaining: limit, resetsAt: resetAt, planTier };
  }
}

/**
 * Get current monthly PII scan usage without incrementing.
 * Used by get_stats to expose quota info.
 *
 * RAD-35
 */
export async function getPIIScanUsage(
  tenantId: string,
  plan: string,
): Promise<PIIScanQuotaResult> {
  const caps = getPIICapabilities(plan);
  const limit = caps.piiScansPerMonth;
  const planTier = (plan || 'free').toLowerCase();
  const resetAt = nextMonthStart();

  if (limit === PII_SCANS_UNLIMITED) {
    return { allowed: true, count: 0, limit: -1, remaining: -1, resetsAt: resetAt, planTier };
  }

  const client = getPIIRedis();
  const key = `pii:scan:monthly:${tenantId}:${currentUtcMonth()}`;

  if (!client) {
    return { allowed: true, count: 0, limit, remaining: limit, resetsAt: resetAt, planTier };
  }

  try {
    const raw = await client.get(key);
    const count = raw ? parseInt(raw, 10) : 0;
    return {
      allowed: count < limit,
      count,
      limit,
      remaining: Math.max(0, limit - count),
      resetsAt: resetAt,
      planTier,
    };
  } catch {
    return { allowed: true, count: 0, limit, remaining: limit, resetsAt: resetAt, planTier };
  }
}
