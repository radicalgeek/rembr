/**
 * PII Plan-Tier Limits Tests (RAD-35 / REM-51)
 */

import { describe, it, expect } from 'vitest';
import {
  getPIICapabilities,
  clampSensitivity,
  assertPIIOperationAllowed,
  checkPIIScanQuota,
  getPIIScanUsage,
  PII_PLAN_CAPABILITIES,
  PII_SCANS_UNLIMITED,
  type PlanTier,
} from './pii-plan-limits.js';

describe('getPIICapabilities', () => {
  it('free plan: basic capabilities only', () => {
    const caps = getPIICapabilities('free');
    expect(caps.maxSensitivity).toBe('medium');
    expect(caps.autoScan).toBe(false);
    expect(caps.complianceReportEnabled).toBe(false);
    expect(caps.complianceFrequency).toBe('none');
    expect(caps.batchScanEnabled).toBe(false);
    expect(caps.customRulesEnabled).toBe(false);
  });

  it('pro plan: full capabilities with monthly reports', () => {
    const caps = getPIICapabilities('pro');
    expect(caps.maxSensitivity).toBe('high');
    expect(caps.autoScan).toBe(true);
    expect(caps.complianceReportEnabled).toBe(true);
    expect(caps.complianceFrequency).toBe('monthly');
    expect(caps.batchScanEnabled).toBe(true);
    expect(caps.customRulesEnabled).toBe(false);
  });

  it('team plan: full capabilities with weekly reports + custom rules', () => {
    const caps = getPIICapabilities('team');
    expect(caps.maxSensitivity).toBe('high');
    expect(caps.autoScan).toBe(true);
    expect(caps.complianceReportEnabled).toBe(true);
    expect(caps.complianceFrequency).toBe('weekly');
    expect(caps.batchScanEnabled).toBe(true);
    expect(caps.customRulesEnabled).toBe(true);
  });

  it('enterprise plan: full capabilities with daily reports', () => {
    const caps = getPIICapabilities('enterprise');
    expect(caps.maxSensitivity).toBe('high');
    expect(caps.autoScan).toBe(true);
    expect(caps.complianceReportEnabled).toBe(true);
    expect(caps.complianceFrequency).toBe('daily');
    expect(caps.batchScanEnabled).toBe(true);
    expect(caps.customRulesEnabled).toBe(true);
  });

  it('business plan: team-level capabilities', () => {
    const caps = getPIICapabilities('business');
    expect(caps.maxSensitivity).toBe('high');
    expect(caps.complianceFrequency).toBe('weekly');
    expect(caps.customRulesEnabled).toBe(true);
  });

  it('unknown plan defaults to free', () => {
    const caps = getPIICapabilities('unknown_plan');
    expect(caps.maxSensitivity).toBe('medium');
    expect(caps.complianceReportEnabled).toBe(false);
  });

  it('empty string defaults to free', () => {
    const caps = getPIICapabilities('');
    expect(caps.maxSensitivity).toBe('medium');
    expect(caps.complianceReportEnabled).toBe(false);
  });
});

describe('clampSensitivity', () => {
  it('free plan: clamps high → medium', () => {
    expect(clampSensitivity('high', 'free')).toBe('medium');
  });

  it('free plan: allows low unchanged', () => {
    expect(clampSensitivity('low', 'free')).toBe('low');
  });

  it('free plan: allows medium unchanged', () => {
    expect(clampSensitivity('medium', 'free')).toBe('medium');
  });

  it('pro plan: allows high unchanged', () => {
    expect(clampSensitivity('high', 'pro')).toBe('high');
  });

  it('team plan: allows high unchanged', () => {
    expect(clampSensitivity('high', 'team')).toBe('high');
  });

  it('enterprise plan: allows high unchanged', () => {
    expect(clampSensitivity('high', 'enterprise')).toBe('high');
  });

  it('unknown plan: clamps high → medium (free defaults)', () => {
    expect(clampSensitivity('high', 'unknown')).toBe('medium');
  });
});

describe('assertPIIOperationAllowed', () => {
  it('free plan: blocks compliance_report', () => {
    expect(() => assertPIIOperationAllowed('compliance_report', 'free')).toThrow(
      /compliance reports are not available on the Free plan/i
    );
  });

  it('free plan: blocks batch_scan', () => {
    expect(() => assertPIIOperationAllowed('batch_scan', 'free')).toThrow(
      /batch scanning is not available on the Free plan/i
    );
  });

  it('free plan: blocks custom_rules', () => {
    expect(() => assertPIIOperationAllowed('custom_rules', 'free')).toThrow(
      /custom PII detection rules are not available on the Free plan/i
    );
  });

  it('pro plan: allows compliance_report', () => {
    expect(() => assertPIIOperationAllowed('compliance_report', 'pro')).not.toThrow();
  });

  it('pro plan: allows batch_scan', () => {
    expect(() => assertPIIOperationAllowed('batch_scan', 'pro')).not.toThrow();
  });

  it('pro plan: blocks custom_rules (team+ only)', () => {
    expect(() => assertPIIOperationAllowed('custom_rules', 'pro')).toThrow(
      /custom PII detection rules are not available on the Pro plan/i
    );
  });

  it('team plan: allows all operations', () => {
    expect(() => assertPIIOperationAllowed('compliance_report', 'team')).not.toThrow();
    expect(() => assertPIIOperationAllowed('batch_scan', 'team')).not.toThrow();
    expect(() => assertPIIOperationAllowed('custom_rules', 'team')).not.toThrow();
  });

  it('enterprise plan: allows all operations', () => {
    expect(() => assertPIIOperationAllowed('compliance_report', 'enterprise')).not.toThrow();
    expect(() => assertPIIOperationAllowed('batch_scan', 'enterprise')).not.toThrow();
    expect(() => assertPIIOperationAllowed('custom_rules', 'enterprise')).not.toThrow();
  });

  it('error messages mention upgrade path', () => {
    try {
      assertPIIOperationAllowed('compliance_report', 'free');
    } catch (e: any) {
      expect(e.message).toContain('Upgrade to Pro');
    }
  });
});

describe('PII_PLAN_CAPABILITIES table completeness', () => {
  const expectedPlans: PlanTier[] = ['free', 'pro', 'team', 'business', 'enterprise'];

  it('all expected plans are defined', () => {
    for (const plan of expectedPlans) {
      expect(PII_PLAN_CAPABILITIES[plan]).toBeDefined();
    }
  });

  it('capabilities escalate correctly across tiers', () => {
    const freeCaps = getPIICapabilities('free');
    const proCaps = getPIICapabilities('pro');
    const teamCaps = getPIICapabilities('team');
    const entCaps = getPIICapabilities('enterprise');

    // Free is the most restricted
    expect(freeCaps.complianceReportEnabled).toBe(false);
    expect(freeCaps.autoScan).toBe(false);

    // Pro+ unlocks compliance reports and auto-scan
    expect(proCaps.complianceReportEnabled).toBe(true);
    expect(proCaps.autoScan).toBe(true);

    // Team+ unlocks custom rules
    expect(teamCaps.customRulesEnabled).toBe(true);

    // Enterprise gets daily reports
    expect(entCaps.complianceFrequency).toBe('daily');
  });
});

// ─── RAD-35: Monthly PII Scan Quotas ─────────────────────────────────────────
describe('RAD-35: piiScansPerMonth per plan tier', () => {
  it('free plan: 100 scans/month', () => {
    const caps = getPIICapabilities('free');
    expect(caps.piiScansPerMonth).toBe(100);
  });

  it('pro plan: 1000 scans/month', () => {
    const caps = getPIICapabilities('pro');
    expect(caps.piiScansPerMonth).toBe(1000);
  });

  it('team plan: 10000 scans/month', () => {
    const caps = getPIICapabilities('team');
    expect(caps.piiScansPerMonth).toBe(10000);
  });

  it('business plan: 50000 scans/month', () => {
    const caps = getPIICapabilities('business');
    expect(caps.piiScansPerMonth).toBe(50000);
  });

  it('enterprise plan: unlimited', () => {
    const caps = getPIICapabilities('enterprise');
    expect(caps.piiScansPerMonth).toBe(PII_SCANS_UNLIMITED);
  });

  it('quotas escalate free < pro < team < business < enterprise', () => {
    const free = getPIICapabilities('free').piiScansPerMonth;
    const pro = getPIICapabilities('pro').piiScansPerMonth;
    const team = getPIICapabilities('team').piiScansPerMonth;
    const biz = getPIICapabilities('business').piiScansPerMonth;
    const ent = getPIICapabilities('enterprise').piiScansPerMonth;
    expect(free).toBeLessThan(pro);
    expect(pro).toBeLessThan(team);
    expect(team).toBeLessThan(biz);
    expect(biz).toBeLessThan(ent);
  });
});

describe('RAD-35: checkPIIScanQuota (Redis-free / fail-open)', () => {
  // Without Redis these tests use the fail-open path

  it('enterprise plan: always allowed (unlimited, skips Redis)', async () => {
    const result = await checkPIIScanQuota('tenant-ent', 'enterprise');
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(-1);
    expect(result.remaining).toBe(-1);
  });

  it('unknown plan: defaults to free quota, fails open without Redis', async () => {
    const result = await checkPIIScanQuota('tenant-unknown', 'unknown_plan');
    // Fail-open → allowed:true
    expect(result.allowed).toBe(true);
  });

  it('free plan: returns planTier in result', async () => {
    const result = await checkPIIScanQuota('tenant-free', 'free');
    expect(result.planTier).toBe('free');
    expect(result.resetsAt).toBeTruthy();
  });
});

describe('RAD-35: getPIIScanUsage (Redis-free)', () => {
  it('enterprise: limit=-1, remaining=-1', async () => {
    const result = await getPIIScanUsage('tenant-ent', 'enterprise');
    expect(result.limit).toBe(-1);
    expect(result.remaining).toBe(-1);
    expect(result.allowed).toBe(true);
  });

  it('free plan: returns plausible defaults without Redis', async () => {
    const result = await getPIIScanUsage('tenant-free', 'free');
    expect(result.limit).toBe(100);
    expect(result.count).toBeGreaterThanOrEqual(0);
    expect(result.resetsAt).toBeTruthy();
  });
});
