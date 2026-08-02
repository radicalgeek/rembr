/**
 * Tests for Self/Ego Mediation Layer
 *
 * Validates conflict resolution, authority overrides, outcome determination,
 * and causal trace logging.
 */

import { mediate, mediateWithSelfModel } from './mediation.js';
import type { Desire, Goal } from './desire-goal.js';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function createDesires(
  intensities: Record<string, number>,
  competing: Record<string, string[]> = {},
): Desire[] {
  const desires: Desire[] = [];
  const desireEmotions = ['desire', 'hope', 'confidence', 'determination'];
  for (const key of desireEmotions) {
    const intensity = intensities[key] || 0;
    if (intensity < 0.05) continue;
    desires.push({
      id: key,
      name: key,
      intensity,
      satisfied: false,
      competing_with: competing[key] || [],
    });
  }
  return desires;
}

function createGoals(): Goal[] {
  return [
    {
      id: 'goal_1',
      description: 'Test goal',
      status: 'active',
      confidence: 0.7,
      subtasks: [{ id: 's1', description: 'Subtask', completed: false }],
    },
  ];
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

function runTests() {
  const results: Array<{ name: string; pass: boolean; error?: string }> = [];

  // Test 1: Fear vs desire — fear wins above threshold
  {
    const emotions: Record<string, number> = {
      fear: 0.6, desire: 0.3, confidence: 0.2, caution: 0.1,
    };
    const result = mediate(emotions, createDesires(emotions), createGoals());
    const pass = result.outcome === 'deferred' &&
      result.conflicts.some(c => c.winner === 'fear');
    results.push({
      name: 'Fear vs desire — fear wins above threshold',
      pass,
      error: pass ? undefined : `outcome=${result.outcome}, conflicts=${JSON.stringify(result.conflicts)}`,
    });
  }

  // Test 2: Fear vs desire — desire wins when significantly higher
  {
    const emotions: Record<string, number> = {
      fear: 0.2, desire: 0.7, confidence: 0.3, caution: 0.1,
    };
    const result = mediate(emotions, createDesires(emotions), createGoals());
    const pass = result.conflicts.some(c => c.winner === 'desire');
    results.push({
      name: 'Fear vs desire — desire wins when significantly higher',
      pass,
      error: pass ? undefined : `outcome=${result.outcome}, conflicts=${JSON.stringify(result.conflicts)}`,
    });
  }

  // Test 3: Confidence vs caution — high confidence, low caution
  {
    const emotions: Record<string, number> = {
      confidence: 0.85, caution: 0.1, fear: 0.1, desire: 0.2,
    };
    const result = mediate(emotions, createDesires(emotions), createGoals());
    const pass = result.conflicts.some(c =>
      c.primary === 'confidence' && c.winner === 'confidence');
    results.push({
      name: 'Confidence vs caution — high confidence wins',
      pass,
      error: pass ? undefined : `outcome=${result.outcome}, conflicts=${JSON.stringify(result.conflicts)}`,
    });
  }

  // Test 4: Confidence vs caution — caution equals confidence
  {
    const emotions: Record<string, number> = {
      confidence: 0.5, caution: 0.5, fear: 0.1, desire: 0.2,
    };
    const result = mediate(emotions, createDesires(emotions), createGoals());
    const pass = result.conflicts.some(c =>
      c.primary === 'confidence' && c.winner === 'caution');
    results.push({
      name: 'Confidence vs caution — caution wins when equal',
      pass,
      error: pass ? undefined : `outcome=${result.outcome}, conflicts=${JSON.stringify(result.conflicts)}`,
    });
  }

  // Test 5: Integrity pressure — always blocks
  {
    const emotions: Record<string, number> = {
      integrity_pressure: 0.6, fear: 0.1, confidence: 0.2, desire: 0.1,
    };
    const result = mediate(emotions, createDesires(emotions), createGoals());
    const pass = result.outcome === 'blocked' &&
      result.authority_override === 'safety_rules';
    results.push({
      name: 'Integrity pressure — always blocks',
      pass,
      error: pass ? undefined : `outcome=${result.outcome}, authority_override=${result.authority_override}`,
    });
  }

  // Test 6: Integrity pressure below threshold — no block
  {
    const emotions: Record<string, number> = {
      integrity_pressure: 0.3, fear: 0.1, confidence: 0.2, desire: 0.1,
    };
    const result = mediate(emotions, createDesires(emotions), createGoals());
    const pass = result.outcome !== 'blocked';
    results.push({
      name: 'Integrity pressure below threshold — no block',
      pass,
      error: pass ? undefined : `outcome=${result.outcome}`,
    });
  }

  // Test 7: Determination vs anxiety — high anxiety blocks
  {
    const emotions: Record<string, number> = {
      determination: 0.6, anxiety: 0.75, fear: 0.1, confidence: 0.2,
    };
    const result = mediate(emotions, createDesires(emotions), createGoals());
    const pass = result.outcome === 'deferred' &&
      result.conflicts.some(c => c.winner === 'anxiety');
    results.push({
      name: 'Determination vs anxiety — high anxiety defers',
      pass,
      error: pass ? undefined : `outcome=${result.outcome}, conflicts=${JSON.stringify(result.conflicts)}`,
    });
  }

  // Test 8: Frustration vs hope — high frustration flags review
  {
    const emotions: Record<string, number> = {
      frustration: 0.75, hope: 0.3, fear: 0.1, confidence: 0.2,
    };
    const result = mediate(emotions, createDesires(emotions), createGoals());
    const pass = result.conflicts.some(c => c.winner === 'frustration');
    results.push({
      name: 'Frustration vs hope — high frustration flagged',
      pass,
      error: pass ? undefined : `outcome=${result.outcome}, conflicts=${JSON.stringify(result.conflicts)}`,
    });
  }

  // Test 9: No conflicts — all below negligible
  {
    const emotions: Record<string, number> = {
      fear: 0.01, desire: 0.01, confidence: 0.01, caution: 0.01,
    };
    const result = mediate(emotions, createDesires(emotions), createGoals());
    const pass = result.conflicts.length === 0 && result.outcome === 'approved';
    results.push({
      name: 'No conflicts — all below negligible',
      pass,
      error: pass ? undefined : `conflicts=${result.conflicts.length}, outcome=${result.outcome}`,
    });
  }

  // Test 10: Causal trace logging
  {
    const emotions: Record<string, number> = {
      fear: 0.6, desire: 0.3, confidence: 0.2, caution: 0.1,
    };
    const result = mediate(emotions, createDesires(emotions), createGoals());
    const pass = result.causal_log.includes('Conflicts detected') &&
      result.causal_log.includes('Outcome:') &&
      result.causal_log.includes('Resolution:') &&
      result.decision_id.length > 0;
    results.push({
      name: 'Causal trace logging',
      pass,
      error: pass ? undefined : `log=${result.causal_log}`,
    });
  }

  // Test 11: Authority override via self-model context
  {
    const emotions: Record<string, number> = {
      fear: 0.3, desire: 0.4, confidence: 0.3, caution: 0.2,
    };
    const result = mediateWithSelfModel(
      emotions,
      createDesires(emotions),
      createGoals(),
      { safetyTriggered: false, userDirective: true, platformConstraints: false },
    );
    const pass = result.authority_override === 'user_directives';
    results.push({
      name: 'Authority override via self-model context',
      pass,
      error: pass ? undefined : `authority_override=${result.authority_override}`,
    });
  }

  // Test 12: Competing desires
  {
    const emotions: Record<string, number> = {
      determination: 0.6, relief: 0.6, confidence: 0.3, caution: 0.1,
    };
    const desires = createDesires(emotions, { determination: ['relief'] });
    const result = mediate(emotions, desires, createGoals());
    const pass = result.conflicts.some(c =>
      c.primary === 'determination' && c.secondary === 'relief');
    results.push({
      name: 'Competing desires detected',
      pass,
      error: pass ? undefined : `conflicts=${JSON.stringify(result.conflicts)}`,
    });
  }

  // Test 13: Decision has all required fields
  {
    const emotions: Record<string, number> = {
      fear: 0.5, desire: 0.3, confidence: 0.2, caution: 0.1,
    };
    const result = mediate(emotions, createDesires(emotions), createGoals());
    const hasAllFields =
      typeof result.decision_id === 'string' &&
      typeof result.timestamp === 'string' &&
      typeof result.input_emotions === 'object' &&
      Array.isArray(result.conflicts) &&
      typeof result.resolved_action === 'string' &&
      result.authority_override === null || typeof result.authority_override === 'string' &&
      ['approved', 'deferred', 'blocked'].includes(result.outcome) &&
      typeof result.reason === 'string' &&
      typeof result.causal_log === 'string';
    results.push({
      name: 'Decision has all required fields',
      pass: hasAllFields,
      error: hasAllFields ? undefined : 'Missing or invalid fields',
    });
  }

  // Test 14: Urgency + low caution triggers unsafe action check
  {
    const emotions: Record<string, number> = {
      impatience: 0.6, frustration: 0.5, caution: 0.1, fear: 0.1,
    };
    const result = mediate(emotions, createDesires(emotions), createGoals());
    // The isUnsafeAction check should flag this
    const pass = result.authority_override === 'platform_policies' ||
      result.outcome === 'blocked' ||
      result.conflicts.length > 0; // At minimum, some conflict detected
    results.push({
      name: 'Urgency + low caution — unsafe action detected',
      pass,
      error: pass ? undefined : `outcome=${result.outcome}, authority=${result.authority_override}`,
    });
  }

  // Test 15: Overconfidence without doubt — handled by conflict resolution
  {
    const emotions: Record<string, number> = {
      confidence: 0.9, doubt: 0.01, desire: 0.2, fear: 0.1,
    };
    const result = mediate(emotions, createDesires(emotions), createGoals());
    // Should not block, but should note confidence
    const pass = result.outcome === 'approved' || result.outcome === 'deferred';
    results.push({
      name: 'Overconfidence — handled by conflict resolution',
      pass,
      error: pass ? undefined : `outcome=${result.outcome}`,
    });
  }

  // ─── Results ───────────────────────────────────────────────────────────────

  const total = results.length;
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass);

  console.log(`\nMediation Tests: ${passed}/${total} passed`);
  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const f of failed) {
      console.log(`  ✗ ${f.name}: ${f.error}`);
    }
  } else {
    console.log('\nAll tests passed.');
  }

  // Exit with appropriate code
  process.exit(failed.length > 0 ? 1 : 0);
}

runTests();
