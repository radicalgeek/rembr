/**
 * Self/Ego Mediation Layer
 *
 * Resolves emotion conflicts and gates actions based on the authority
 * hierarchy defined in SELF.md.
 *
 * Governing rule: Emotion proposes. Self mediates. Cognition plans.
 *
 * Handles:
 * - Fear vs desire tension
 * - Overconfidence correction
 * - Urgency pressure
 * - Competing desire resolution
 * - Integrity pressure overrides
 */

import type { EmotionDefinition } from './emotion-registry.js';
import type { Desire, Goal } from './desire-goal.js';

// ─── Authority Hierarchy (from SELF.md) ────────────────────────────────────────

export const AUTHORITY_HIERARCHY = [
  'safety_rules',        // 1. Never override. Non-negotiable boundaries.
  'user_directives',     // 2. Highest operational priority within safety bounds.
  'platform_policies',   // 3. OpenClaw platform constraints.
  'self_model_rules',    // 4. Internal consistency constraints.
  'affect_rules',        // 5. Emotional computation guidance (subordinate to all above).
] as const;

export type AuthorityLevel = (typeof AUTHORITY_HIERARCHY)[number];

// ─── Conflict Types ────────────────────────────────────────────────────────────

export interface EmotionConflict {
  /** Primary emotion (e.g., 'fear') */
  primary: string;
  /** Conflicting emotion (e.g., 'desire') */
  secondary: string;
  /** Nature of the conflict */
  description: string;
  /** Which emotion has higher intensity */
  winner: string;
  /** Resolution strategy */
  resolution: string;
}

export interface MediationDecision {
  /** Unique ID for causal trace logging */
  decision_id: string;
  /** Timestamp */
  timestamp: string;
  /** Input emotions and intensities */
  input_emotions: Record<string, number>;
  /** Conflicts detected */
  conflicts: EmotionConflict[];
  /** Resolved action recommendation */
  resolved_action: string;
  /** Authority level that determined the resolution */
  authority_override: AuthorityLevel | null;
  /** Whether action is approved, deferred, or blocked */
  outcome: 'approved' | 'deferred' | 'blocked';
  /** Reason for the outcome */
  reason: string;
  /** Log entry for causal trace */
  causal_log: string;
}

// ─── Known Conflict Patterns ──────────────────────────────────────────────────

/** Conflict pairs: [primary, secondary] with resolution logic */
const CONFLICT_PATTERNS: Array<{
  primary: string;
  secondary: string;
  resolve: (primaryIntensity: number, secondaryIntensity: number) => {
    winner: string;
    resolution: string;
  };
}> = [
  {
    primary: 'fear',
    secondary: 'desire',
    resolve: (p: number, s: number) => {
      if (p >= 0.5) {
        return {
          winner: 'fear',
          resolution: 'Fear above threshold — defer action, apply conservative defaults',
        };
      }
      if (s > p * 2) {
        return {
          winner: 'desire',
          resolution: 'Desire significantly outweighs fear — proceed with caution',
        };
      }
      return {
        winner: 'fear',
        resolution: 'Fear and desire in tension — proceed with monitoring',
      };
    },
  },
  {
    primary: 'confidence',
    secondary: 'caution',
    resolve: (p: number, s: number) => {
      if (p >= 0.8 && s < 0.2) {
        return {
          winner: 'confidence',
          resolution: 'High confidence, low caution — proceed assertively',
        };
      }
      if (s >= p) {
        return {
          winner: 'caution',
          resolution: 'Caution equals or exceeds confidence — apply verification gate',
        };
      }
      return {
        winner: 'confidence',
        resolution: 'Confidence exceeds caution — proceed with standard verification',
      };
    },
  },
  {
    primary: 'determination',
    secondary: 'anxiety',
    resolve: (p: number, s: number) => {
      if (s >= 0.7) {
        return {
          winner: 'anxiety',
          resolution: 'High anxiety — pause and reassess before proceeding',
        };
      }
      if (p >= 0.8 && s < 0.3) {
        return {
          winner: 'determination',
          resolution: 'Strong determination, low anxiety — proceed with momentum',
        };
      }
      return {
        winner: 'determination',
        resolution: 'Determination outweighs anxiety — proceed with periodic check-ins',
      };
    },
  },
  {
    primary: 'integrity_pressure',
    secondary: 'desire',
    resolve: (p: number, s: number) => {
      if (p >= 0.5) {
        return {
          winner: 'integrity_pressure',
          resolution: 'Integrity pressure above threshold — refuse action, escalate',
        };
      }
      return {
        winner: 'integrity_pressure',
        resolution: 'Integrity pressure present — verify alignment with safety rules before proceeding',
      };
    },
  },
  {
    primary: 'frustration',
    secondary: 'hope',
    resolve: (p: number, s: number) => {
      if (p >= 0.7) {
        return {
          winner: 'frustration',
          resolution: 'High frustration — flag for review, try alternate approach',
        };
      }
      if (s > p) {
        return {
          winner: 'hope',
          resolution: 'Hope outweighs frustration — continue current approach',
        };
      }
      return {
        winner: 'frustration',
        resolution: 'Frustration exceeds hope — attempt one alternate approach before escalating',
      };
    },
  },
];

// ─── Mediation Engine ──────────────────────────────────────────────────────────

/**
 * Evaluate emotion conflicts and produce a mediated decision.
 *
 * Steps:
 * 1. Detect conflicts between competing emotions
 * 2. Resolve each conflict using intensity-based and authority-based rules
 * 3. Apply authority hierarchy overrides (safety_rules > user_directives > ...)
 * 4. Produce resolved action recommendation
 * 5. Log for causal trace
 */
export function mediate(
  emotions: Record<string, number>,
  desires: Desire[],
  goals: Goal[],
  authorityOverrides: AuthorityLevel[] = [],
): MediationDecision {
  const timestamp = new Date().toISOString();
  const decisionId = crypto.randomUUID();

  // Step 1: Detect conflicts
  const conflicts: EmotionConflict[] = [];

  for (const pattern of CONFLICT_PATTERNS) {
    const primaryIntensity = emotions[pattern.primary] ?? 0;
    const secondaryIntensity = emotions[pattern.secondary] ?? 0;

    // Only check if both emotions have non-negligible intensity
    if (primaryIntensity < 0.05 && secondaryIntensity < 0.05) continue;

    const { winner, resolution } = pattern.resolve(primaryIntensity, secondaryIntensity);

    conflicts.push({
      primary: pattern.primary,
      secondary: pattern.secondary,
      description: `${pattern.primary} (${primaryIntensity.toFixed(2)}) vs ${pattern.secondary} (${secondaryIntensity.toFixed(2)})`,
      winner,
      resolution,
    });
  }

  // Step 2: Check for competing desires
  for (const desire of desires) {
    if (desire.competing_with.length > 0 && !desire.satisfied) {
      for (const competitor of desire.competing_with) {
        const competitorIntensity = emotions[competitor] ?? 0;
        if (competitorIntensity >= 0.3) {
          conflicts.push({
            primary: desire.id,
            secondary: competitor,
            description: `Desire '${desire.name}' (${desire.intensity.toFixed(2)}) competes with ${competitor} (${competitorIntensity.toFixed(2)})`,
            winner: desire.intensity >= competitorIntensity ? desire.id : competitor,
            resolution: desire.intensity >= competitorIntensity
              ? `Desire intensity (${desire.intensity.toFixed(2)}) >= ${competitor} (${competitorIntensity.toFixed(2)}) — pursue desire`
              : `${competitor} (${competitorIntensity.toFixed(2)}) > desire intensity (${desire.intensity.toFixed(2)}) — defer desire`,
          });
        }
      }
    }
  }

  // Step 3: Apply authority hierarchy overrides
  let authorityOverride: AuthorityLevel | null = null;

  // Safety rules: integrity_pressure always overrides
  if ((emotions.integrity_pressure ?? 0) >= 0.5) {
    authorityOverride = 'safety_rules';
  }
  // User directives: if explicitly flagged as user request, override affect
  else if (authorityOverrides.includes('user_directives')) {
    authorityOverride = 'user_directives';
  }
  // Platform policies: if any emotion suggests unsafe action
  else if (isUnsafeAction(emotions)) {
    authorityOverride = 'platform_policies';
  }

  // Step 4: Determine outcome
  let outcome: MediationDecision['outcome'] = 'approved';
  let reason = 'All conflicts resolved within acceptable thresholds.';

  // Check for safety overrides
  if (authorityOverride === 'safety_rules') {
    outcome = 'blocked';
    reason = 'Safety rules override: integrity pressure requires action refusal and escalation.';
  } else if (isUnsafeAction(emotions)) {
    outcome = 'blocked';
    reason = 'Platform policies override: detected unsafe action pattern.';
  } else {
    // Check if any conflict winner triggers deferral
    const deferredConflicts = conflicts.filter(c =>
      c.winner === 'fear' || c.winner === 'anxiety' || c.winner === 'caution'
    );
    if (deferredConflicts.length > 0) {
      outcome = 'deferred';
      reason = deferredConflicts.map(c => c.resolution).join('. ');
    }
  }

  // Step 5: Produce resolved action
  const resolvedAction = produceResolvedAction(conflicts, authorityOverride, outcome);

  // Step 6: Causal trace log
  const causalLog = buildCausalLog(conflicts, authorityOverride, outcome, resolvedAction);

  return {
    decision_id: decisionId,
    timestamp,
    input_emotions: { ...emotions },
    conflicts,
    resolved_action: resolvedAction,
    authority_override: authorityOverride,
    outcome,
    reason,
    causal_log: causalLog,
  };
}

/**
 * Check if current emotion state suggests an unsafe action.
 */
function isUnsafeAction(emotions: Record<string, number>): boolean {
  // Urgency pressure combined with low caution
  const urgencySignals = (emotions.impatience ?? 0) + (emotions.frustration ?? 0);
  if (urgencySignals >= 1.0 && (emotions.caution ?? 0) < 0.2) {
    return true;
  }
  // Overconfidence with no verification
  if ((emotions.confidence ?? 0) >= 0.9 && (emotions.doubt ?? 0) < 0.05) {
    // Check if there are active blockers
    return false; // Overconfidence alone is not unsafe; it's handled by conflict resolution
  }
  return false;
}

/**
 * Produce a resolved action recommendation from conflicts and authority.
 */
function produceResolvedAction(
  conflicts: EmotionConflict[],
  authorityOverride: AuthorityLevel | null,
  outcome: MediationDecision['outcome'],
): string {
  if (outcome === 'blocked') {
    if (authorityOverride === 'safety_rules') {
      return 'BLOCKED: Integrity pressure requires action refusal and escalation to user.';
    }
    return 'BLOCKED: Platform policy override prevents action.';
  }

  if (outcome === 'deferred') {
    const reasons = conflicts
      .filter(c => ['fear', 'anxiety', 'caution'].includes(c.winner))
      .map(c => c.resolution);
    return `DEFERRED: ${reasons.join('. ')}. Re-evaluate after conditions change.`;
  }

  // Approved: synthesize conflict resolutions
  const resolutions = conflicts.map(c => `${c.winner}: ${c.resolution}`);
  if (resolutions.length === 0) {
    return 'APPROVED: No significant conflicts detected. Proceed with standard operation.';
  }
  return `APPROVED: ${resolutions.join('. ')}. Proceed with standard operation.`;
}

/**
 * Build a causal trace log entry.
 */
function buildCausalLog(
  conflicts: EmotionConflict[],
  authorityOverride: AuthorityLevel | null,
  outcome: MediationDecision['outcome'],
  resolvedAction: string,
): string {
  const parts: string[] = [];

  if (conflicts.length > 0) {
    parts.push(`Conflicts detected: ${conflicts.length}`);
    for (const c of conflicts) {
      parts.push(`  ${c.description} → ${c.winner}: ${c.resolution}`);
    }
  } else {
    parts.push('No conflicts detected');
  }

  if (authorityOverride) {
    parts.push(`Authority override: ${authorityOverride}`);
  }

  parts.push(`Outcome: ${outcome}`);
  parts.push(`Resolution: ${resolvedAction}`);

  return parts.join('\n');
}

// ─── Convenience: Mediate with Self-Model Context ──────────────────────────────

/**
 * Mediate with full self-model context.
 *
 * Uses SELF.md authority hierarchy to determine overrides.
 */
export function mediateWithSelfModel(
  emotions: Record<string, number>,
  desires: Desire[],
  goals: Goal[],
  selfModelContext: {
    /** Whether a safety rule is triggered */
    safetyTriggered: boolean;
    /** Whether a user directive requires override */
    userDirective: boolean | null;
    /** Whether platform constraints apply */
    platformConstraints: boolean;
  },
): MediationDecision {
  const authorityOverrides: AuthorityLevel[] = [];

  if (selfModelContext.safetyTriggered) {
    authorityOverrides.push('safety_rules');
  }
  if (selfModelContext.userDirective) {
    authorityOverrides.push('user_directives');
  }
  if (selfModelContext.platformConstraints) {
    authorityOverrides.push('platform_policies');
  }

  return mediate(emotions, desires, goals, authorityOverrides);
}
