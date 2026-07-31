/**
 * Desire and Goal Model — persistence, competition, and satisfaction clearing.
 *
 * Desires are derived from emotion intensities (primarily desire, hope, confidence,
 * determination). Goals are derived from goal-level context tokens. The model
 * tracks goal status, desire satisfaction, and conflicts between competing desires.
 */

import type { EmotionDefinition } from './emotion-registry.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface Desire {
  id: string;
  name: string;
  intensity: number;
  satisfied: boolean;
  competing_with: string[];
}

export interface Goal {
  id: string;
  description: string;
  status: 'active' | 'completed' | 'abandoned' | 'blocked';
  confidence: number;
  subtasks: Array<{
    id: string;
    description: string;
    completed: boolean;
  }>;
}

export interface DesireGoalResult {
  desires: Desire[];
  goals: Goal[];
  satisfied_desires: string[];
  abandoned_goals: string[];
}

// ─── Desire Model ──────────────────────────────────────────────────────────────

/**
 * Derive desires from emotion intensities.
 *
 * Desire-type emotions (desire, hope, confidence, determination) become
 * active desires. Satisfaction is determined by satisfaction_conditions
 * matching against context signals.
 */
export function deriveDesires(
  emotions: Record<string, number>,
  definitions: Record<string, EmotionDefinition>,
  contextTokens: { signals: Record<string, number> },
): Desire[] {
  const desireEmotions = ['desire', 'hope', 'confidence', 'determination'];
  const desires: Desire[] = [];

  for (const key of desireEmotions) {
    const intensity = emotions[key] || 0;
    if (intensity < 0.05) continue; // skip negligible

    const def = definitions[key];
    if (!def) continue;

    // Check satisfaction conditions against context signals
    const satisfied = checkSatisfaction(def.satisfaction_conditions, contextTokens);

    // Find competing desires
    const competing = findCompetingDesires(key, desires, emotions);

    desires.push({
      id: key,
      name: def.appraisal,
      intensity,
      satisfied,
      competing_with: competing,
    });
  }

  // Sort by intensity descending
  desires.sort((a, b) => b.intensity - a.intensity);

  return desires;
}

/**
 * Check if satisfaction conditions are met by context signals.
 */
function checkSatisfaction(
  conditions: string[],
  signals: Record<string, number>,
): boolean {
  for (const condition of conditions) {
    const cond = condition.toLowerCase();

    // "Goal achieved" → progress > 0
    if (cond.includes('achieved') || cond.includes('completed')) {
      if ((signals.progress || 0) > 0) return true;
    }

    // "Goal abandoned" → explicitly stated
    if (cond.includes('abandoned')) {
      return false; // never auto-abandon
    }

    // "Evidence of progress" → progress > 0
    if (cond.includes('progress')) {
      if ((signals.progress || 0) > 0) return true;
    }

    // "Successful execution" → progress > 0
    if (cond.includes('successful') || cond.includes('execution')) {
      if ((signals.progress || 0) > 0) return true;
    }

    // "Knowledge gap filled" → no ambiguity
    if (cond.includes('knowledge') || cond.includes('gap')) {
      if ((signals.ambiguity || 0) === 0) return true;
    }

    // "Threat confirmed resolved" → no production_risk or safety_conflict
    if (cond.includes('threat') || cond.includes('resolved')) {
      if ((signals.production_risk || 0) === 0 && (signals.safety_conflict || 0) === 0) {
        return true;
      }
    }

    // "Beneficial outcome confirmed" → positive > 0
    if (cond.includes('beneficial') || cond.includes('outcome')) {
      if ((signals.positive || 0) > 0) return true;
    }

    // "Consistent reliable behavior" → reliability > 0, no negative
    if (cond.includes('consistent') || cond.includes('reliable')) {
      if ((signals.reliability || 0) > 0 && (signals.negative || 0) === 0) {
        return true;
      }
    }

    // "Goal completed" or "Abandoned by authority" → progress or explicit
    if (cond.includes('goal completed')) {
      if ((signals.progress || 0) > 0) return true;
    }

    // "Standard upheld" or "Context changes" → no safety_conflict
    if (cond.includes('standard') || cond.includes('context')) {
      if ((signals.safety_conflict || 0) === 0) return true;
    }

    // "Model updated to account for event" → surprise was resolved
    if (cond.includes('model updated')) {
      return true; // default to true if surprise was present
    }

    // "Evidence confirms or refutes" → certainty present
    if (cond.includes('confirms') || cond.includes('refutes')) {
      if ((signals.uncertainty || 0) === 0) return true;
    }

    // "Missing context provided" → no ambiguity
    if (cond.includes('missing') || cond.includes('clarification')) {
      if ((signals.ambiguity || 0) === 0) return true;
    }

    // "Source verified" → reliability > 0
    if (cond.includes('source verified')) {
      if ((signals.reliability || 0) > 0) return true;
    }

    // "Source demonstrates reliability" → reliability > 0
    if (cond.includes('demonstrates reliability')) {
      if ((signals.reliability || 0) > 0) return true;
    }

    // "Blocker resolved" → no blocker
    if (cond.includes('blocker resolved')) {
      if ((signals.blocker || 0) === 0) return true;
    }

    // "Alternate path found" → progress > 0
    if (cond.includes('alternate')) {
      if ((signals.progress || 0) > 0) return true;
    }

    // "Progress resumes" or "Deadline adjusted" → progress > 0
    if (cond.includes('progress resumes') || cond.includes('deadline')) {
      if ((signals.progress || 0) > 0) return true;
    }

    // "Lesson recorded and applied" → regret was processed
    if (cond.includes('lesson')) {
      return true; // default: assume lesson recorded
    }

    // "Risk mitigated" or "Stakeholder satisfied" → no production_risk
    if (cond.includes('risk mitigated') || cond.includes('stakeholder')) {
      if ((signals.production_risk || 0) === 0) return true;
    }

    // "Standard upheld" or "Context legitimately changed" → no safety_conflict
    if (cond.includes('standard upheld') || cond.includes('context legitimately')) {
      if ((signals.safety_conflict || 0) === 0) return true;
    }

    // "Source identified" or "Situation confirmed safe" → no uncertainty
    if (cond.includes('source identified') || cond.includes('confirmed safe')) {
      if ((signals.uncertainty || 0) === 0) return true;
    }
  }

  return false;
}

/**
 * Find competing desires (high-intensity desires that conflict).
 */
function findCompetingDesires(
  current: string,
  existing: Desire[],
  emotions: Record<string, number>,
): string[] {
  const competing: string[] = [];

  // Determination conflicts with relaxation/relief
  if (current === 'determination' && emotions.relief > 0.5) {
    competing.push('relief');
  }

  // Confidence conflicts with caution at high levels
  if (current === 'confidence' && emotions.caution > 0.6) {
    competing.push('caution');
  }

  // Desire conflicts with fear (want vs avoid)
  if (current === 'desire' && emotions.fear > 0.5) {
    competing.push('fear');
  }

  // Hope conflicts with anxiety
  if (current === 'hope' && emotions.anxiety > 0.5) {
    competing.push('anxiety');
  }

  return competing;
}

// ─── Goal Model ────────────────────────────────────────────────────────────────

/**
 * Derive goals from context tokens.
 *
 * Goals are extracted from goal-related signals and mapped to status based on
 * progress and blocker signals.
 */
export function deriveGoals(
  contextTokens: { signals: Record<string, number> },
  emotionIntensities: Record<string, number>,
): Goal[] {
  const goals: Goal[] = [];

  // Only create goals if there are explicit goal signals
  if ((contextTokens.signals.goal || 0) === 0) {
    return goals;
  }

  const goalCount = contextTokens.signals.goal;
  const progress = contextTokens.signals.progress || 0;
  const blockers = contextTokens.signals.blocker || 0;
  const failures = contextTokens.signals.failure || 0;
  const confidence = emotionIntensities.confidence || 0;

  // Determine goal status
  let status: Goal['status'] = 'active';
  if (blockers > 0 && failures > 0) {
    status = 'blocked';
  } else if (progress > 0 && blockers === 0) {
    status = 'completed';
  }

  // Calculate confidence based on signals
  let goalConfidence = confidence;
  if (status === 'blocked') {
    goalConfidence = Math.min(goalConfidence, 0.3);
  } else if (status === 'completed') {
    goalConfidence = Math.max(goalConfidence, 0.8);
  }

  // Create a single derived goal
  goals.push({
    id: `goal_1`,
    description: `Goal with ${goalCount} signal(s), ${progress} progress, ${blockers} blocker(s)`,
    status,
    confidence: Math.min(1, Math.max(0, goalConfidence)),
    subtasks: [
      {
        id: 'subtask_1',
        description: 'Verify goal conditions',
        completed: status === 'completed',
      },
      {
        id: 'subtask_2',
        description: 'Check for blockers',
        completed: blockers === 0,
      },
    ],
  });

  return goals;
}

/**
 * Clear satisfied desires and update goal statuses.
 *
 * When a desire is satisfied, its intensity drops and it's marked satisfied.
 * Goals that are completed have their subtasks marked complete.
 */
export function clearSatisfied(
  desires: Desire[],
  goals: Goal[],
): DesireGoalResult {
  const satisfiedDesires: string[] = [];
  const abandonedGoals: string[] = [];

  // Mark satisfied desires as cleared
  for (const desire of desires) {
    if (desire.satisfied) {
      satisfiedDesires.push(desire.id);
      desire.intensity = 0; // drop intensity when satisfied
    }
  }

  for (const goal of goals) {
    if (goal.status === 'abandoned') {
      abandonedGoals.push(goal.id);
    }
  }

  return {
    desires,
    goals,
    satisfied_desires: satisfiedDesires,
    abandoned_goals: abandonedGoals,
  };
}
