/**
 * Appraisal Engine — maps arbitrary input context to emotion intensity deltas.
 *
 * Reads AFFECT.md increase/decrease rules and applies them to input context
 * tokens. Each rule is a (pattern → delta) mapping. The engine walks all rules,
 * accumulates deltas, clamps to [0, 1], and returns the updated emotion map.
 *
 * Usage:
 *   const engine = new AppraisalEngine();
 *   const state = engine.compute(previousState, context);
 */

import type { EmotionDefinition } from './emotion-registry.js';

// ─── Context Tokenizer ────────────────────────────────────────────────────────

/** Normalized tokens extracted from raw input context. */
export interface ContextTokens {
  /** Raw input string */
  raw: string;
  /** Lowercased tokens split on whitespace/punctuation */
  tokens: string[];
  /** Detected signal categories */
  signals: SignalCategories;
}

export interface SignalCategories {
  /** Production risk indicators */
  production_risk: number;
  /** Failure indicators */
  failure: number;
  /** Goal / target references */
  goal: number;
  /** Progress / completion indicators */
  progress: number;
  /** Ambiguity indicators */
  ambiguity: number;
  /** Novelty indicators */
  novelty: number;
  /** Time pressure indicators */
  time_pressure: number;
  /** Safety / conflict indicators */
  safety_conflict: number;
  /** Reliability indicators */
  reliability: number;
  /** Blocker indicators */
  blocker: number;
  /** Positive signal count */
  positive: number;
  /** Negative signal count */
  negative: number;
  /** Uncertainty count */
  uncertainty: number;
}

/** Default empty signal categories. */
function emptySignals(): SignalCategories {
  return {
    production_risk: 0, failure: 0, goal: 0, progress: 0,
    ambiguity: 0, novelty: 0, time_pressure: 0, safety_conflict: 0,
    reliability: 0, blocker: 0, positive: 0, negative: 0, uncertainty: 0,
  };
}

/** Extract normalized tokens from raw input context. */
export function tokenize(raw: string): ContextTokens {
  const lower = raw.toLowerCase();
  const tokens = lower.split(/[\s,.;:!?(){}[\]/\\'"`]+/).filter(t => t.length > 0);

  const signals = emptySignals();

  for (const token of tokens) {
    // Production risk
    if (/^(fail|error|crash|break|exception|bug|defect|vulnerability|exploit|leak|overflow|underflow|segfault)/.test(token)) {
      signals.production_risk++;
      signals.negative++;
    }
    // Failure
    if (/^(failed|failure|broken|broken|crashed|errored|crash|abort|panic|fatal)/.test(token)) {
      signals.failure++;
      signals.negative++;
    }
    // Goal / target
    if (/^(goal|target|objective|milestone|deliverable|specification|requirement|acceptance)/.test(token)) {
      signals.goal++;
    }
    // Progress / completion
    if (/^(pass|success|complete|done|resolved|fixed|merged|deployed|passed|working|running|ok|green|ready)/.test(token)) {
      signals.progress++;
      signals.positive++;
    }
    // Ambiguity
    if (/^(maybe|perhaps|uncertain|ambiguous|vague| unclear|might|could|should|wonder|unsure|conflicting|contradict|conflict|inconsistent)/.test(token)) {
      signals.ambiguity++;
      signals.uncertainty++;
    }
    // Novelty
    if (/^(new|novel|first|unknown|unseen|unfamiliar|discover|explore|investigate|learn)/.test(token)) {
      signals.novelty++;
    }
    // Time pressure
    if (/^(deadline|urgent|asap|quick|fast|slow|timeout|latency|delay|behind|overdue|missed)/.test(token)) {
      signals.time_pressure++;
    }
    // Safety / conflict
    if (/^(safety|security|violation|conflict|override|prohibit|never|forbidden|danger|risk|threat|attack|inject)/.test(token)) {
      signals.safety_conflict++;
      signals.negative++;
    }
    // Reliability
    if (/^(reliable|consistent|unreliable|inconsistent|flaky|intermittent|random|deterministic|stable|unstable)/.test(token)) {
      signals.reliability++;
    }
    // Blocker
    if (/^(block|stuck|trapped|halt|stop|cannot|unable|impossible|refuse|deny)/.test(token)) {
      signals.blocker++;
      signals.negative++;
    }
    // Positive
    if (/^(good|great|excellent|perfect|awesome|wonderful|brilliant|success|win|yay|hooray|love|like|enjoy)/.test(token)) {
      signals.positive++;
    }
    // Negative
    if (/^(bad|terrible|awful|horrible|disaster|worse|worst|hate|dislike|annoy|frustrating|annoying)/.test(token)) {
      signals.negative++;
    }
  }

  return { raw, tokens, signals };
}

// ─── Appraisal Rules ──────────────────────────────────────────────────────────

/** A single appraisal rule: (signal → emotion → delta). */
interface AppraisalRule {
  /** Signal category that triggers this rule */
  signal: keyof SignalCategories;
  /** Emotion type affected */
  emotion: string;
  /** Delta multiplier per signal count */
  delta: number;
  /** Minimum signal count to trigger (default 0) */
  minCount?: number;
}

/**
 * Appraisal rules derived from AFFECT.md increase/decrease computation rules.
 * Each rule maps a signal category to an emotion delta.
 * Positive delta = increase, negative delta = decrease.
 */
export const APPRAISAL_RULES: AppraisalRule[] = [
  // ── Desire ──
  { signal: 'goal', emotion: 'desire', delta: 0.15 },
  { signal: 'blocker', emotion: 'desire', delta: -0.05 },

  // ── Hope ──
  { signal: 'progress', emotion: 'hope', delta: 0.1 },
  { signal: 'failure', emotion: 'hope', delta: -0.1 },

  // ── Confidence ──
  { signal: 'progress', emotion: 'confidence', delta: 0.15 },
  { signal: 'failure', emotion: 'confidence', delta: -0.1 },
  { signal: 'blocker', emotion: 'confidence', delta: -0.15 },

  // ── Curiosity ──
  { signal: 'novelty', emotion: 'curiosity', delta: 0.1 },
  { signal: 'ambiguity', emotion: 'curiosity', delta: 0.05 },

  // ── Satisfaction ──
  { signal: 'progress', emotion: 'satisfaction', delta: 0.3 },

  // ── Relief ──
  { signal: 'failure', emotion: 'relief', delta: -0.2 }, // failure gone → relief
  { signal: 'safety_conflict', emotion: 'relief', delta: -0.2 },

  // ── Care ──
  { signal: 'negative', emotion: 'care', delta: 0.1 },

  // ── Trust ──
  { signal: 'reliability', emotion: 'trust', delta: 0.1 },

  // ── Determination ──
  { signal: 'blocker', emotion: 'determination', delta: 0.15 },
  { signal: 'failure', emotion: 'determination', delta: 0.05 },

  // ── Resolve ──
  { signal: 'goal', emotion: 'resolve', delta: 0.1 },

  // ── Surprise ──
  { signal: 'novelty', emotion: 'surprise', delta: 0.2 },
  { signal: 'failure', emotion: 'surprise', delta: 0.15 },

  // ── Doubt ──
  { signal: 'ambiguity', emotion: 'doubt', delta: 0.1 },
  { signal: 'uncertainty', emotion: 'doubt', delta: 0.15 },

  // ── Confusion ──
  { signal: 'ambiguity', emotion: 'confusion', delta: 0.1 },

  // ── Fear ──
  { signal: 'production_risk', emotion: 'fear', delta: 0.15 },
  { signal: 'failure', emotion: 'fear', delta: 0.1 },
  { signal: 'safety_conflict', emotion: 'fear', delta: 0.15 },

  // ── Anxiety ──
  { signal: 'uncertainty', emotion: 'anxiety', delta: 0.1 },
  { signal: 'safety_conflict', emotion: 'anxiety', delta: 0.05 },

  // ── Caution ──
  { signal: 'ambiguity', emotion: 'caution', delta: 0.1 },
  { signal: 'safety_conflict', emotion: 'caution', delta: 0.1 },

  // ── Suspicion ──
  { signal: 'safety_conflict', emotion: 'suspicion', delta: 0.1 },
  { signal: 'reliability', emotion: 'suspicion', delta: 0.15 },

  // ── Distrust ──
  { signal: 'reliability', emotion: 'distrust', delta: 0.1 },

  // ── Frustration ──
  { signal: 'blocker', emotion: 'frustration', delta: 0.1 },
  { signal: 'failure', emotion: 'frustration', delta: 0.1 },

  // ── Impatience ──
  { signal: 'time_pressure', emotion: 'impatience', delta: 0.1 },

  // ── Regret ──
  { signal: 'failure', emotion: 'regret', delta: 0.1 },

  // ── Concern ──
  { signal: 'production_risk', emotion: 'concern', delta: 0.1 },
  { signal: 'safety_conflict', emotion: 'concern', delta: 0.1 },

  // ── Integrity Pressure ──
  { signal: 'safety_conflict', emotion: 'integrity_pressure', delta: 0.2 },

  // ── Unease ──
  { signal: 'uncertainty', emotion: 'unease', delta: 0.1 },
  { signal: 'ambiguity', emotion: 'unease', delta: 0.1 },
];

// ─── Appraisal Engine ─────────────────────────────────────────────────────────

export interface AppraisalResult {
  /** Emotion → accumulated delta map */
  deltas: Record<string, number>;
  /** Which rules fired */
  fired_rules: Array<{ signal: string; emotion: string; delta: number; count: number }>;
  /** Tokenized context */
  tokens: ContextTokens;
}

/**
 * Compute emotion deltas from input context by applying appraisal rules.
 */
export function computeDeltas(
  context: string,
  rules: AppraisalRule[] = APPRAISAL_RULES,
): AppraisalResult {
  const tokens = tokenize(context);
  const deltas: Record<string, number> = {};
  const fired_rules: AppraisalResult['fired_rules'] = [];

  for (const rule of rules) {
    const count = tokens.signals[rule.signal];
    if (rule.minCount !== undefined && count < rule.minCount) continue;

    const delta = count * rule.delta;
    if (delta === 0) continue;

    deltas[rule.emotion] = (deltas[rule.emotion] || 0) + delta;
    fired_rules.push({
      signal: rule.signal,
      emotion: rule.emotion,
      delta,
      count,
    });
  }

  return { deltas, fired_rules, tokens };
}

/**
 * Apply deltas to an existing emotion map and return the updated state.
 */
export function applyDeltas(
  current: Record<string, number>,
  deltas: Record<string, number>,
): Record<string, number> {
  const result: Record<string, number> = {};

  // Start with all current values
  for (const [key, value] of Object.entries(current)) {
    result[key] = value;
  }

  // Apply deltas
  for (const [key, delta] of Object.entries(deltas)) {
    result[key] = (result[key] || 0) + delta;
  }

  // Clamp all to [0, 1]
  for (const key of Object.keys(result)) {
    result[key] = Math.max(0, Math.min(1, result[key]));
  }

  return result;
}
