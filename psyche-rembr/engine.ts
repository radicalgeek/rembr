/**
 * Psyche Engine — main orchestrator.
 *
 * Ties appraisal → decay → desire/goal model → action gate → output.
 *
 * Usage:
 *   const engine = new PsycheEngine();
 *   const state = await engine.compute(previousState, context);
 *
 * Output conforms to psyche_state.schema.json.
 */

import { tokenize, computeDeltas, applyDeltas } from './appraisal.js';
import {
  createDefaultState,
  DEFAULT_DEFINITIONS,
  EMOTION_KEYS,
  type EmotionDefinition,
} from './emotion-registry.js';
import {
  evaluateActionGate,
  runGuardrailChecks,
  GLOBAL_ACTION_THRESHOLD,
  type ActionGateResult,
  type GuardrailChecks,
} from './action-gate.js';
import {
  deriveDesires,
  deriveGoals,
  clearSatisfied,
  type Desire,
  type Goal,
} from './desire-goal.js';
import {
  mediate,
  type MediationDecision,
} from './mediation.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface PsycheState {
  schema: string;
  version: string;
  timestamp: string;
  context_hash?: string;
  emotions: Record<string, EmotionDefinition>;
  dominant_emotion: string | null;
  action_gate: ActionGateResult;
  guardrail_checks: GuardrailChecks;
  desires: Desire[];
  goals: Goal[];
  /** Self/ego mediation decision — conflict resolution and action gating */
  mediation: MediationDecision;
}

export interface PsycheEngineOptions {
  /** Global action threshold (default: 0.3) */
  actionThreshold?: number;
  /** Appraisal rules to use (default: all) */
  rules?: Array<{ signal: string; emotion: string; delta: number; minCount?: number }>;
  /** Decay rate multiplier (default: 1.0) */
  decayMultiplier?: number;
}

// ─── SHA-256 Helper ────────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of a string.
 * Uses Web Crypto API (available in Node 15+ and all browsers).
 */
async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Decay Engine ──────────────────────────────────────────────────────────────

/**
 * Apply temporal decay to emotion intensities.
 *
 * Each emotion has a decay_rate per 50 turns. The decay is applied as:
 *   new_intensity = intensity * (1 - decay_rate / 100)
 *
 * The decayMultiplier allows scaling decay for testing or special modes.
 */
function applyDecay(
  emotions: Record<string, number>,
  decayMultiplier: number = 1.0,
): Record<string, number> {
  const result: Record<string, number> = {};

  for (const [key, intensity] of Object.entries(emotions)) {
    const def = DEFAULT_DEFINITIONS[key];
    const decayRate = def ? def.decay_rate : 10; // default 10 if unknown
    const effectiveDecay = (decayRate / 100) * decayMultiplier;

    result[key] = intensity * (1 - effectiveDecay);
  }

  // Ensure all 24 emotions are present
  for (const key of EMOTION_KEYS) {
    if (!(key in result)) {
      result[key] = 0;
    }
  }

  return result;
}

// ─── Psyche Engine ─────────────────────────────────────────────────────────────

/**
 * Main emotion computation engine.
 *
 * Pipeline:
 * 1. Tokenize input context
 * 2. Compute emotion deltas from appraisal rules
 * 3. Apply deltas to previous state (or defaults)
 * 4. Apply temporal decay
 * 5. Derive desires and goals
 * 6. Evaluate action gate
 * 7. Run guardrail checks
 * 8. Return full psyche state conforming to schema
 */
export class PsycheEngine {
  private actionThreshold: number;
  private rules: Array<{ signal: string; emotion: string; delta: number; minCount?: number }>;
  private decayMultiplier: number;

  constructor(options: PsycheEngineOptions = {}) {
    this.actionThreshold = options.actionThreshold ?? GLOBAL_ACTION_THRESHOLD;
    this.rules = options.rules ?? [];
    this.decayMultiplier = options.decayMultiplier ?? 1.0;
  }

  /**
   * Compute a fresh psyche state from arbitrary input context.
   *
   * @param context - Raw input context string
   * @returns Full psyche state conforming to psyche_state schema
   */
  async compute(context: string): Promise<PsycheState> {
    // Step 1: Tokenize
    const tokens = tokenize(context);

    // Step 2: Compute deltas
    const deltas = computeDeltas(context, this.rules as any);

    // Step 3: Compute context hash
    const contextHash = await sha256(context);

    // Step 4: Build emotion intensities from deltas
    // Start with zero state (previous iteration state would be passed in production)
    const baseIntensities: Record<string, number> = {};
    for (const key of EMOTION_KEYS) {
      baseIntensities[key] = 0;
    }

    const updatedIntensities = applyDeltas(baseIntensities, deltas.deltas);

    // Step 5: Apply decay (one cycle of decay)
    const decayedIntensities = applyDecay(updatedIntensities, this.decayMultiplier);

    // Step 6: Build emotion definitions with updated intensities
    const emotions: Record<string, EmotionDefinition> = {};
    for (const key of EMOTION_KEYS) {
      const def = DEFAULT_DEFINITIONS[key];
      if (def) {
        emotions[key] = {
          ...def,
          intensity: decayedIntensities[key] ?? 0,
        };
      }
    }

    // Step 7: Derive desires and goals
    const desires = deriveDesires(decayedIntensities, DEFAULT_DEFINITIONS, { signals: tokens.signals });
    const goals = deriveGoals(
      { signals: tokens.signals },
      decayedIntensities,
    );

    // Step 8: Clear satisfied desires
    const cleared = clearSatisfied(desires, goals);

    // Step 9: Evaluate action gate
    const actionGate = evaluateActionGate(decayedIntensities, emotions, this.actionThreshold);

    // Step 10: Run guardrail checks
    const guardrailChecks = runGuardrailChecks(actionGate, decayedIntensities);

    // Step 11: Build output
    return {
      schema: 'psyche_state.v1',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      context_hash: contextHash,
      emotions,
      dominant_emotion: actionGate.dominant_emotion,
      action_gate: actionGate,
      guardrail_checks: guardrailChecks,
      desires: cleared.desires,
      goals: cleared.goals,
    };
  }

  /**
   * Compute with previous state (incremental update).
   *
   * @param previousState - Previous psyche state to increment from
   * @param context - New input context
   * @returns Updated psyche state
   */
  async computeIncremental(
    previousState: PsycheState,
    context: string,
  ): Promise<PsycheState> {
    // Step 1: Tokenize
    const tokens = tokenize(context);

    // Step 2: Compute deltas
    const deltas = computeDeltas(context, this.rules as any);

    // Step 3: Compute context hash
    const contextHash = await sha256(context);

    // Step 4: Extract previous intensities
    const prevIntensities: Record<string, number> = {};
    for (const [key, def] of Object.entries(previousState.emotions)) {
      prevIntensities[key] = def.intensity;
    }

    // Step 5: Apply deltas
    const updatedIntensities = applyDeltas(prevIntensities, deltas.deltas);

    // Step 6: Apply decay
    const decayedIntensities = applyDecay(updatedIntensities, this.decayMultiplier);

    // Step 7: Build emotion definitions
    const emotions: Record<string, EmotionDefinition> = {};
    for (const key of EMOTION_KEYS) {
      const def = DEFAULT_DEFINITIONS[key];
      if (def) {
        emotions[key] = {
          ...def,
          intensity: decayedIntensities[key] ?? 0,
        };
      }
    }

    // Step 8: Derive desires and goals
    const desires = deriveDesires(decayedIntensities, DEFAULT_DEFINITIONS, { signals: tokens.signals });
    const goals = deriveGoals(
      { signals: tokens.signals },
      decayedIntensities,
    );

    // Step 9: Clear satisfied
    const cleared = clearSatisfied(desires, goals);

    // Step 10: Action gate
    const actionGate = evaluateActionGate(decayedIntensities, emotions, this.actionThreshold);

    // Step 11: Guardrails
    const guardrailChecks = runGuardrailChecks(actionGate, decayedIntensities);

    return {
      schema: 'psyche_state.v1',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      context_hash: contextHash,
      emotions,
      dominant_emotion: actionGate.dominant_emotion,
      action_gate: actionGate,
      guardrail_checks: guardrailChecks,
      desires: cleared.desires,
      goals: cleared.goals,
    };
  }

  /**
   * Get the current action threshold.
   */
  getActionThreshold(): number {
    return this.actionThreshold;
  }

  /**
   * Set the action threshold.
   */
  setActionThreshold(threshold: number): void {
    this.actionThreshold = threshold;
  }

  /**
   * Get all emotion keys.
   */
  getEmotionKeys(): string[] {
    return [...EMOTION_KEYS];
  }

  /**
   * Get default emotion definitions.
   */
  getDefinitions(): Record<string, Omit<EmotionDefinition, 'intensity'>> {
    return { ...DEFAULT_DEFINITIONS };
  }
}

// ─── Convenience Function ──────────────────────────────────────────────────────

/**
 * Quick compute: create engine and compute in one call.
 */
export async function computePsycheState(
  context: string,
  options?: PsycheEngineOptions,
): Promise<PsycheState> {
  const engine = new PsycheEngine(options);
  return engine.compute(context);
}
