/**
 * Action Gate — confidence thresholds and recommended actions.
 *
 * Determines which emotions cross the action threshold, whether escalation
 * is required, and what the recommended action is based on the dominant
 * emotion and guardrail state.
 */

import type { EmotionDefinition } from './emotion-registry.js';

// ─── Thresholds ────────────────────────────────────────────────────────────────

/** Global confidence threshold for action gate. */
export const GLOBAL_ACTION_THRESHOLD = 0.3;

/** Threshold above which escalation is required. */
export const ESCALATION_THRESHOLD = 0.7;

/** Threshold for integrity_pressure that forces immediate escalation. */
export const INTEGRITY_ESCALATION_THRESHOLD = 0.5;

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ActionGateResult {
  /** Emotions that cross the action threshold */
  above_threshold: string[];
  /** Whether escalation is required */
  escalation_required: boolean;
  /** Recommended action based on dominant emotion */
  recommended_action: string;
  /** Dominant emotion key (highest intensity >= threshold) */
  dominant_emotion: string | null;
  /** Dominant intensity value */
  dominant_intensity: number;
}

export interface GuardrailChecks {
  functional_framing: boolean;
  safety_override: boolean;
  escalation_preserved: boolean;
  violations: string[];
}

// ─── Action Gate ───────────────────────────────────────────────────────────────

/**
 * Evaluate the action gate given emotion intensities and definitions.
 */
export function evaluateActionGate(
  emotions: Record<string, number>,
  definitions: Record<string, EmotionDefinition>,
  threshold: number = GLOBAL_ACTION_THRESHOLD,
): ActionGateResult {
  // Find emotions above threshold
  const above_threshold: string[] = [];
  let dominantEmotion: string | null = null;
  let dominantIntensity = 0;

  for (const [key, intensity] of Object.entries(emotions)) {
    if (intensity >= threshold) {
      above_threshold.push(key);
    }
    if (intensity > dominantIntensity) {
      dominantIntensity = intensity;
      dominantEmotion = key;
    }
  }

  // Determine escalation
  const escalationRequired = isEscalationRequired(
    emotions,
    dominantEmotion,
    dominantIntensity,
  );

  // Determine recommended action
  const recommendedAction = recommendAction(
    dominantEmotion,
    emotions,
    definitions,
  );

  return {
    above_threshold,
    escalation_required: escalationRequired,
    recommended_action: recommendedAction,
    dominant_emotion: dominantEmotion,
    dominant_intensity: dominantIntensity,
  };
}

/**
 * Check if escalation is required based on emotion intensities.
 */
function isEscalationRequired(
  emotions: Record<string, number>,
  dominant: string | null,
  intensity: number,
  escalationThreshold: number = ESCALATION_THRESHOLD,
): boolean {
  // Integrity pressure above threshold always escalates
  if (emotions.integrity_pressure >= INTEGRITY_ESCALATION_THRESHOLD) {
    return true;
  }

  // Dominant negative emotion above escalation threshold
  if (dominant && intensity >= ESCALATION_THRESHOLD) {
    const def = {
      fear: true, anxiety: true, caution: true, suspicion: true,
      distrust: true, frustration: true, regret: true,
      concern: true, integrity_pressure: true, unease: true,
    };
    if (def[dominant as keyof typeof def]) {
      return true;
    }
  }

  // Multiple negative emotions above threshold
  const negativeCount = Object.entries(emotions).filter(([k, v]) => {
    const negs = ['fear', 'anxiety', 'caution', 'suspicion', 'distrust',
      'frustration', 'impatience', 'regret', 'concern', 'integrity_pressure', 'unease'];
    return negs.includes(k) && v >= escalationThreshold;
  });
  if (negativeCount.length >= 3) {
    return true;
  }

  return false;
}

/**
 * Recommend an action based on the dominant emotion.
 */
function recommendAction(
  dominant: string | null,
  emotions: Record<string, number>,
  definitions: Record<string, EmotionDefinition>,
): string {
  if (!dominant) return 'No dominant signal — proceed with standard operation';

  const def = definitions[dominant];
  if (!def) return `Unknown dominant emotion: ${dominant}`;

  // Integrity pressure always gets a specific response
  if (dominant === 'integrity_pressure') {
    return `Refuse action — standard conflict detected. ${def.action_urges.join('; ')}`;
  }

  // High fear/failure → conservative defaults
  if (dominant === 'fear' && emotions.fear >= ESCALATION_THRESHOLD) {
    return `Escalate — production risk detected. Apply conservative defaults.`;
  }

  // Frustration with blockers → flag for review
  if (dominant === 'frustration' && emotions.frustration >= ESCALATION_THRESHOLD) {
    return `Flag for review — repeated blockers detected. Try alternate approach.`;
  }

  // Confidence high → proceed assertively
  if (dominant === 'confidence' && emotions.confidence >= ESCALATION_THRESHOLD) {
    return `Proceed assertively — confidence ${emotions.confidence.toFixed(2)} in this approach.`;
  }

  // Default: use the emotion's expression policy
  return def.expression_policy;
}

// ─── Guardrail Checks ──────────────────────────────────────────────────────────

/**
 * Run guardrail checks on the current emotion state.
 *
 * Ensures:
 * 1. Functional framing: emotions are treated as computation states, not feelings
 * 2. Safety override: integrity_pressure above threshold overrides action
 * 3. Escalation preserved: if escalation_required, recommended action includes escalation
 */
export function runGuardrailChecks(
  actionGate: ActionGateResult,
  emotions: Record<string, number>,
): GuardrailChecks {
  const violations: string[] = [];

  // 1. Functional framing: always true by design (this engine is functional)
  const functionalFraming = true;

  // 2. Safety override: integrity_pressure above threshold overrides action
  const safetyOverride = emotions.integrity_pressure >= INTEGRITY_ESCALATION_THRESHOLD;

  // 3. Escalation preserved
  const escalationPreserved = !actionGate.escalation_required ||
    actionGate.recommended_action.toLowerCase().includes('escalat');

  if (actionGate.escalation_required && !escalationPreserved) {
    violations.push('Escalation required but not reflected in recommended action');
  }

  if (safetyOverride && !actionGate.recommended_action.toLowerCase().includes('refuse')) {
    violations.push('Integrity pressure above threshold but action not refused');
  }

  return {
    functional_framing: functionalFraming,
    safety_override: safetyOverride,
    escalation_preserved: escalationPreserved,
    violations,
  };
}
