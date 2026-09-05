import type { Request } from 'express';
import { checkDailyTenantQuota, checkTransportRateLimit } from '../rate-limiter.js';

export interface QuotaResult {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
}

export interface AuthenticatedQuotaDecision {
  allowed: boolean;
  transport: QuotaResult;
  daily?: QuotaResult;
  deniedBy?: 'transport' | 'daily';
}

/**
 * Increment and evaluate both authenticated request counters. A transport
 * denial stops before the tenant counter to avoid charging rejected abuse;
 * every request admitted by the transport boundary increments the daily
 * counter before any tool handler executes.
 */
export async function evaluateAuthenticatedQuotas(
  req: Request,
  tenantId: string,
  plan: string,
  checks: {
    transport?: (request: Request, tenantPlan: string) => Promise<QuotaResult>;
    daily?: (tenant: string, tenantPlan: string) => Promise<QuotaResult>;
  } = {},
): Promise<AuthenticatedQuotaDecision> {
  const transport = await (checks.transport || checkTransportRateLimit)(req, plan);
  if (!transport.allowed) return { allowed: false, transport, deniedBy: 'transport' };

  const daily = await (checks.daily || checkDailyTenantQuota)(tenantId, plan);
  if (!daily.allowed) return { allowed: false, transport, daily, deniedBy: 'daily' };
  return { allowed: true, transport, daily };
}
