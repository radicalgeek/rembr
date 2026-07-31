/**
 * Psyche Rembr — OpenClaw emotion computation plugin.
 *
 * Functional emotion engine for agents: computes affective states from
 * arbitrary input context, derives desires and goals, evaluates action
 * gates, and runs guardrail checks.
 *
 * @module psyche-rembr
 *
 * @example
 * ```ts
 * import { computePsycheState, PsycheEngine } from 'psyche-rembr';
 *
 * // Quick compute
 * const state = await computePsycheState("Production server failed during deployment");
 * console.log(state.dominant_emotion); // "fear" or "frustration"
 *
 * // Incremental engine
 * const engine = new PsycheEngine({ actionThreshold: 0.4 });
 * const state1 = await engine.compute("Tests passing, progress is good");
 * const state2 = await engine.computeIncremental(state1, "But production error rate increased");
 * ```
 */

// ─── Emotion Registry ──────────────────────────────────────────────────────────
export {
  type EmotionDefinition,
  type Valence,
  DEFAULT_DEFINITIONS,
  EMOTION_KEYS,
  PRIORITY_ORDER,
  createEmotion,
  createDefaultState,
} from './emotion-registry.js';

// ─── Appraisal Engine ──────────────────────────────────────────────────────────
export {
  type ContextTokens,
  type SignalCategories,
  type AppraisalRule,
  type AppraisalResult,
  tokenize,
  computeDeltas,
  applyDeltas,
  APPRAISAL_RULES,
} from './appraisal.js';

// ─── Action Gate ───────────────────────────────────────────────────────────────
export {
  type ActionGateResult,
  type GuardrailChecks,
  evaluateActionGate,
  runGuardrailChecks,
  GLOBAL_ACTION_THRESHOLD,
  ESCALATION_THRESHOLD,
  INTEGRITY_ESCALATION_THRESHOLD,
} from './action-gate.js';

// ─── Desire/Goal Model ─────────────────────────────────────────────────────────
export {
  type Desire,
  type Goal,
  type DesireGoalResult,
  deriveDesires,
  deriveGoals,
  clearSatisfied,
} from './desire-goal.js';

// ─── Main Engine ───────────────────────────────────────────────────────────────
export {
  type PsycheState,
  type PsycheEngineOptions,
  PsycheEngine,
  computePsycheState,
} from './engine.js';

// ─── Schema ────────────────────────────────────────────────────────────────────
export const SCHEMA_VERSION = '0.1.0';
export const SCHEMA_ID = 'https://psyche-rembr.dev/schemas/psyche_state.v1.json';

// ─── Plugin Entry ──────────────────────────────────────────────────────────────
/**
 * OpenClaw plugin entry point.
 *
 * Registers the psyche engine as an available tool for agents.
 * In production, this would be invoked by the OpenClaw plugin loader.
 */
export function registerPlugin(): void {
  // Plugin registration happens at plugin load time.
  // This is a no-op stub that can be extended when the plugin API is finalized.
}

export default {
  registerPlugin,
  PsycheEngine,
  computePsycheState,
};

// ─── API Endpoint Exports ─────────────────────────────────────────────────────
// 6 named endpoints for direct agent invocation.

export {
  psyche_state,
  psyche_appraise,
  psyche_feel,
  psyche_confidence,
  psyche_reflect,
  psyche_snapshot,
  reset_store,
  configure,
  type AppraiseRequest,
  type AppraiseResponse,
  type FeelRequest,
  type FeelResponse,
  type ConfidenceRequest,
  type ConfidenceResponse,
  type ReflectionRequest,
  type ReflectionResponse,
  type SnapshotRequest,
  type SnapshotResponse,
} from './api-endpoints.js';

// ─── Hook Exports ─────────────────────────────────────────────────────────────
// These are the OpenClaw plugin hook adapters that connect the psyche engine
// to the OpenClaw plugin lifecycle.

export {
  beforePromptBuild,
  beforePromptBuildHook,
  toCompactSnapshot,
  type CompactPsycheSnapshot,
  type BeforePromptBuildConfig,
} from './hook-before-prompt-build.js';

export {
  agentEndHook,
  type AgentEndConfig,
} from './hook-agent-end.js';

export {
  sessionEndHook,
  type SessionEndConfig,
} from './hook-session-end.js';

// Re-export appraisal for hook composition
export { appraisePrompt } from './hook-before-prompt-build.js';
