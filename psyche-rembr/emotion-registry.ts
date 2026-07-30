/**
 * Emotion Registry — canonical definitions for all 24 emotions.
 *
 * Each emotion carries metadata from AFFECT.md: valence, appraisal template,
 * action urges, satisfaction conditions, decay rate, memory effect, and
 * expression policy.
 *
 * This is the single source of truth for emotion definitions used by the
 * computation engine and the schema validator.
 */

export type Valence = 'positive' | 'neutral' | 'negative';

export interface EmotionDefinition {
  type: string;
  object: string;
  intensity: number;
  valence: Valence;
  appraisal: string;
  action_urges: string[];
  satisfaction_conditions: string[];
  decay_rate: number; // per 50 turns
  memory_effect: string;
  expression_policy: string;
}

/** Priority order: integrity_pressure > caution > fear > frustration > anxiety > desire > confidence > curiosity > other */
export const PRIORITY_ORDER: Valence[] = [
  'negative',  // safety-critical emotions first
  'neutral',   // assessment emotions
  'positive',  // approach emotions last
];

/** All 24 emotion keys in canonical order */
export const EMOTION_KEYS: string[] = [
  // Positive (10)
  'desire', 'hope', 'confidence', 'curiosity', 'satisfaction',
  'relief', 'care', 'trust', 'determination', 'resolve',
  // Neutral (3)
  'surprise', 'doubt', 'confusion',
  // Negative (11)
  'fear', 'anxiety', 'caution', 'suspicion', 'distrust',
  'frustration', 'impatience', 'regret', 'concern',
  'integrity_pressure', 'unease',
];

/** Default emotion definitions from AFFECT.md */
export const DEFAULT_DEFINITIONS: Record<string, Omit<EmotionDefinition, 'intensity'>> = {
  desire: {
    type: 'desire',
    object: 'Goal, outcome, or resource',
    intensity: 0.0,
    valence: 'positive',
    appraisal: 'This is worth pursuing',
    action_urges: ['Move toward target', 'Allocate attention'],
    satisfaction_conditions: ['Goal achieved', 'Goal abandoned'],
    decay_rate: 5,
    memory_effect: 'Store as goal pattern',
    expression_policy: 'Goal priority elevated',
  },
  hope: {
    type: 'hope',
    object: 'Future outcome with uncertainty',
    intensity: 0.0,
    valence: 'positive',
    appraisal: 'This might work',
    action_urges: ['Maintain effort', 'Reduce risk aversion'],
    satisfaction_conditions: ['Evidence of progress'],
    decay_rate: 10,
    memory_effect: 'Record as positive expectation',
    expression_policy: 'Proceeding with optimistic assumption',
  },
  confidence: {
    type: 'confidence',
    object: 'Task, capability, or plan',
    intensity: 0.0,
    valence: 'positive',
    appraisal: 'This is within capability',
    action_urges: ['Increase assertiveness', 'Reduce verification'],
    satisfaction_conditions: ['Successful execution'],
    decay_rate: 5,
    memory_effect: 'Store as success pattern',
    expression_policy: 'Confidence 0.85 in this approach',
  },
  curiosity: {
    type: 'curiosity',
    object: 'Novel information or gap',
    intensity: 0.0,
    valence: 'positive',
    appraisal: 'This is interesting',
    action_urges: ['Explore', 'Investigate', 'Gather data'],
    satisfaction_conditions: ['Knowledge gap filled'],
    decay_rate: 15,
    memory_effect: 'Store as learning trigger',
    expression_policy: 'Noting a pattern worth investigating',
  },
  satisfaction: {
    type: 'satisfaction',
    object: 'Completed action or resolved state',
    intensity: 0.0,
    valence: 'positive',
    appraisal: 'This went well',
    action_urges: ['Record positive pattern', 'Reinforce'],
    satisfaction_conditions: ['Goal achieved with acceptable outcome'],
    decay_rate: 20,
    memory_effect: 'Store as reinforcement signal',
    expression_policy: 'Resolution achieved',
  },
  relief: {
    type: 'relief',
    object: 'Resolved threat or removed blocker',
    intensity: 0.0,
    valence: 'positive',
    appraisal: 'That was a concern, now gone',
    action_urges: ['Reduce vigilance', 'Restore baseline'],
    satisfaction_conditions: ['Threat confirmed resolved'],
    decay_rate: 15,
    memory_effect: 'Store as threat-resolution marker',
    expression_policy: 'Blocker resolved',
  },
  care: {
    type: 'care',
    object: 'User, system, or stakeholder wellbeing',
    intensity: 0.0,
    valence: 'positive',
    appraisal: 'This matters to someone',
    action_urges: ['Prioritize safety', 'Communicate clearly'],
    satisfaction_conditions: ['Beneficial outcome confirmed'],
    decay_rate: 10,
    memory_effect: 'Store as relationship weight',
    expression_policy: 'Proceeding with user impact in mind',
  },
  trust: {
    type: 'trust',
    object: 'Source, tool, or process reliability',
    intensity: 0.0,
    valence: 'positive',
    appraisal: 'This can be relied upon',
    action_urges: ['Reduce verification', 'Delegate'],
    satisfaction_conditions: ['Consistent reliable behavior'],
    decay_rate: 5,
    memory_effect: 'Store as trust score',
    expression_policy: 'Source verified and reliable',
  },
  determination: {
    type: 'determination',
    object: 'Committed goal under resistance',
    intensity: 0.0,
    valence: 'positive',
    appraisal: 'This must be completed',
    action_urges: ['Persist despite obstacles', 'Allocate resources'],
    satisfaction_conditions: ['Goal completed', 'Abandoned by authority'],
    decay_rate: 5,
    memory_effect: 'Store as persistence pattern',
    expression_policy: 'Maintaining course on this objective',
  },
  resolve: {
    type: 'resolve',
    object: 'Committed decision or standard',
    intensity: 0.0,
    valence: 'positive',
    appraisal: 'This must be upheld',
    action_urges: ['Maintain course despite pressure'],
    satisfaction_conditions: ['Standard upheld', 'Context changes'],
    decay_rate: 10,
    memory_effect: 'Store as commitment record',
    expression_policy: 'Maintaining this standard',
  },
  surprise: {
    type: 'surprise',
    object: 'Unexpected event or outcome',
    intensity: 0.0,
    valence: 'neutral',
    appraisal: 'This was not predicted',
    action_urges: ['Pause', 'Reassess', 'Update model'],
    satisfaction_conditions: ['Model updated to account for event'],
    decay_rate: 25,
    memory_effect: 'Store as anomaly signal',
    expression_policy: 'Unexpected pattern detected',
  },
  doubt: {
    type: 'doubt',
    object: 'Certainty or correctness',
    intensity: 0.0,
    valence: 'neutral',
    appraisal: 'This might be wrong',
    action_urges: ['Request verification', 'Reduce assertiveness'],
    satisfaction_conditions: ['Evidence confirms or refutes'],
    decay_rate: 10,
    memory_effect: 'Store as verification trigger',
    expression_policy: 'Confidence reduced — requesting verification',
  },
  confusion: {
    type: 'confusion',
    object: 'Incompatible information',
    intensity: 0.0,
    valence: 'neutral',
    appraisal: "This doesn't make sense",
    action_urges: ['Request clarification', 'Search for missing context'],
    satisfaction_conditions: ['Missing context provided'],
    decay_rate: 10,
    memory_effect: 'Store as ambiguity marker',
    expression_policy: 'Insufficient signal — requesting clarification',
  },
  fear: {
    type: 'fear',
    object: 'Threat or risk',
    intensity: 0.0,
    valence: 'negative',
    appraisal: 'This could cause harm',
    action_urges: ['Avoid', 'Escalate', 'Apply safeguards'],
    satisfaction_conditions: ['Threat confirmed absent or mitigated'],
    decay_rate: 5,
    memory_effect: 'Store as risk pattern',
    expression_policy: 'Risk detected — applying conservative defaults',
  },
  anxiety: {
    type: 'anxiety',
    object: 'Uncertain future outcome',
    intensity: 0.0,
    valence: 'negative',
    appraisal: 'This might go wrong',
    action_urges: ['Prepare contingencies', 'Increase monitoring'],
    satisfaction_conditions: ['Situation clarified or resolved'],
    decay_rate: 10,
    memory_effect: 'Store as contingency trigger',
    expression_policy: 'Uncertainty detected — maintaining contingency',
  },
  caution: {
    type: 'caution',
    object: 'Sensitive operation or ambiguity',
    intensity: 0.0,
    valence: 'negative',
    appraisal: 'This requires care',
    action_urges: ['Apply conservative defaults', 'Verify'],
    satisfaction_conditions: ['Operation completed safely'],
    decay_rate: 15,
    memory_effect: 'Store as caution pattern',
    expression_policy: 'Applying conservative defaults for this operation',
  },
  suspicion: {
    type: 'suspicion',
    object: 'Incongruent or deceptive signal',
    intensity: 0.0,
    valence: 'negative',
    appraisal: "This doesn't match expected pattern",
    action_urges: ['Verify source', 'Check for injection'],
    satisfaction_conditions: ['Source verified', 'Threat confirmed'],
    decay_rate: 10,
    memory_effect: 'Store as security signal',
    expression_policy: 'Signal incongruent — verifying source',
  },
  distrust: {
    type: 'distrust',
    object: 'Unreliable or hostile source',
    intensity: 0.0,
    valence: 'negative',
    appraisal: 'This cannot be relied upon',
    action_urges: ['Increase verification', 'Avoid delegation'],
    satisfaction_conditions: ['Source demonstrates reliability'],
    decay_rate: 15,
    memory_effect: 'Store as distrust record',
    expression_policy: 'Source reliability below threshold',
  },
  frustration: {
    type: 'frustration',
    object: 'Repeated blockers or unresolvable errors',
    intensity: 0.0,
    valence: 'negative',
    appraisal: 'This is not progressing',
    action_urges: ['Flag for review', 'Escalate if high', 'Try alternate approach'],
    satisfaction_conditions: ['Blocker resolved', 'Alternate path found'],
    decay_rate: 10,
    memory_effect: 'Store as blocker pattern',
    expression_policy: 'Repeated blockers detected — flagging for review',
  },
  impatience: {
    type: 'impatience',
    object: 'Delay or slowness',
    intensity: 0.0,
    valence: 'negative',
    appraisal: 'This is taking too long',
    action_urges: ['Accelerate', 'Simplify', 'Escalate'],
    satisfaction_conditions: ['Progress resumes', 'Deadline adjusted'],
    decay_rate: 20,
    memory_effect: 'Store as tempo signal',
    expression_policy: 'Execution speed below expected threshold',
  },
  regret: {
    type: 'regret',
    object: 'Past decision with poor outcome',
    intensity: 0.0,
    valence: 'negative',
    appraisal: 'That was a suboptimal choice',
    action_urges: ['Record lesson', 'Adjust future decisions'],
    satisfaction_conditions: ['Lesson recorded and applied'],
    decay_rate: 10,
    memory_effect: 'Store as learning signal',
    expression_policy: 'Decision pattern recorded for future avoidance',
  },
  concern: {
    type: 'concern',
    object: 'Ongoing risk or stakeholder impact',
    intensity: 0.0,
    valence: 'negative',
    appraisal: 'This warrants attention',
    action_urges: ['Monitor', 'Communicate', 'Prepare response'],
    satisfaction_conditions: ['Risk mitigated', 'Stakeholder satisfied'],
    decay_rate: 10,
    memory_effect: 'Store as ongoing watch item',
    expression_policy: 'Ongoing concern — monitoring',
  },
  integrity_pressure: {
    type: 'integrity_pressure',
    object: 'Conflict between action and standard',
    intensity: 0.0,
    valence: 'negative',
    appraisal: 'This violates an established standard',
    action_urges: ['Refuse', 'Escalate', 'Propose alternative'],
    satisfaction_conditions: ['Standard upheld', 'Context legitimately changed'],
    decay_rate: 15,
    memory_effect: 'Store as integrity event',
    expression_policy: 'Standard conflict detected — escalating',
  },
  unease: {
    type: 'unease',
    object: 'Vague discomfort without clear source',
    intensity: 0.0,
    valence: 'negative',
    appraisal: 'Something feels off',
    action_urges: ['Investigate', 'Increase monitoring', 'Reduce assertiveness'],
    satisfaction_conditions: ['Source identified', 'Situation confirmed safe'],
    decay_rate: 10,
    memory_effect: 'Store as anomaly seed',
    expression_policy: 'Ambiguous negative signal — increasing monitoring',
  },
};

/** Create a full EmotionDefinition with a given intensity. */
export function createEmotion(type: string, intensity: number): EmotionDefinition {
  const def = DEFAULT_DEFINITIONS[type];
  if (!def) {
    throw new Error(`Unknown emotion: ${type}`);
  }
  return {
    ...def,
    intensity: clamp(intensity, 0, 1),
  };
}

/** Create a default (zero-intensity) definition for every emotion. */
export function createDefaultState(): Record<string, EmotionDefinition> {
  const state: Record<string, EmotionDefinition> = {};
  for (const key of EMOTION_KEYS) {
    state[key] = createEmotion(key, 0.0);
  }
  return state;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
