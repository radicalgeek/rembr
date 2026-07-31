/**
 * API endpoints for the psyche-rembr OpenClaw plugin.
 *
 * Exposes 6 named endpoints that agents can call directly:
 *   1. psyche_state   — get current psyche state
 *   2. psyche_appraise — appraise event/prompt, return emotion deltas
 *   3. psyche_feel     — apply emotion updates from appraisal
 *   4. psyche_confidence — evaluate confidence against thresholds
 *   5. psyche_reflect  — run reflection, produce insights
 *   6. psyche_snapshot — save state snapshot to Rembr
 *
 * Each endpoint is a pure function that can be invoked by the plugin SDK
 * or called directly from tool invocations.
 */

import {
  PsycheEngine,
  type PsycheState,
  type PsycheEngineOptions,
} from './engine.js';
import {
  computeDeltas,
  applyDeltas,
  tokenize,
  type AppraisalResult,
  type ContextTokens,
} from './appraisal.js';
import {
  evaluateActionGate,
  type ActionGateResult,
} from './action-gate.js';
import {
  deriveDesires,
  deriveGoals,
  clearSatisfied,
} from './desire-goal.js';
import {
  DEFAULT_DEFINITIONS,
  EMOTION_KEYS,
  createDefaultState,
  type EmotionDefinition,
} from './emotion-registry.js';
import {
  toCompactSnapshot,
  type CompactPsycheSnapshot,
} from './hook-before-prompt-build.js';

// ─── Shared State ─────────────────────────────────────────────────────────────

/**
 * In-memory psyche state store.
 * In production this would be backed by Rembr memory API.
 */
interface StateStore {
  state: PsycheState | null;
  options?: PsycheEngineOptions;
}

const store: StateStore = { state: null, options: undefined };

/**
 * Get or create the current engine with configured options.
 */
function getEngine(options?: PsycheEngineOptions): PsycheEngine {
  const cfg = options ?? store.options ?? {};
  return new PsycheEngine(cfg);
}

/**
 * Load current state or compute fresh.
 */
async function getState(options?: PsycheEngineOptions): Promise<PsycheState> {
  if (store.state) {
    return store.state;
  }
  const engine = getEngine(options);
  return engine.compute('initialization');
}

/**
 * Save state to the store.
 */
function saveState(state: PsycheState): void {
  store.state = state;
}

// ─── Endpoint 1: psyche_state ─────────────────────────────────────────────────

/**
 * Get the current psyche state.
 * Returns the full state if available, or computes a fresh one.
 */
export async function psyche_state(
  options?: PsycheEngineOptions,
): Promise<PsycheState> {
  return getState(options);
}

// ─── Endpoint 2: psyche_appraise ──────────────────────────────────────────────

export interface AppraiseRequest {
  /** Input context to appraise */
  context: string;
  /** Optional custom appraisal rules */
  rules?: Array<{ signal: string; emotion: string; delta: number; minCount?: number }>;
}

export interface AppraiseResponse {
  /** Emotion → accumulated delta map */
  deltas: Record<string, number>;
  /** Which rules fired */
  fired_rules: Array<{ signal: string; emotion: string; delta: number; count: number }>;
  /** Tokenized context */
  tokens: ContextTokens;
}

/**
 * Appraise an event or prompt, return emotion deltas.
 */
export function psyche_appraise(req: AppraiseRequest): AppraiseResponse {
  const result = computeDeltas(req.context, req.rules);
  return {
    deltas: result.deltas,
    fired_rules: result.fired_rules,
    tokens: result.tokens,
  };
}

// ─── Endpoint 3: psyche_feel ──────────────────────────────────────────────────

export interface FeelRequest {
  /** Emotion deltas to apply (same format as appraisal output) */
  deltas: Record<string, number>;
  /** Optional engine options */
  options?: PsycheEngineOptions;
}

export interface FeelResponse {
  /** Updated psyche state */
  state: PsycheState;
  /** Emotion deltas that were applied */
  applied_deltas: Record<string, number>;
}

/**
 * Apply emotion updates from appraisal to current state.
 */
export async function psyche_feel(req: FeelRequest): Promise<FeelResponse> {
  const currentState = await getState(req.options);
  const engine = getEngine(req.options);

  // Compute fresh deltas for context (to get decay)
  const context = Object.entries(req.deltas)
    .filter(([, v]) => v > 0)
    .map(([k]) => k)
    .join(' ') || 'emotion update';

  const updatedState = await engine.computeIncremental(currentState, context);

  // Apply the requested deltas on top
  const emotionKeys = Object.keys(updatedState.emotions);
  const updatedIntensities: Record<string, number> = {};
  for (const key of emotionKeys) {
    updatedIntensities[key] = updatedState.emotions[key].intensity;
  }

  const finalIntensities = applyDeltas(updatedIntensities, req.deltas);

  // Build final state with applied deltas
  const finalEmotions: Record<string, EmotionDefinition> = {};
  for (const key of EMOTION_KEYS) {
    const def = DEFAULT_DEFINITIONS[key];
    if (def) {
      finalEmotions[key] = {
        ...def,
        intensity: finalIntensities[key] ?? 0,
      };
    }
  }

  const finalActionGate = evaluateActionGate(finalIntensities, finalEmotions,
    req.options?.actionThreshold ?? engine.getActionThreshold());

  const finalDesires = deriveDesires(finalIntensities, DEFAULT_DEFINITIONS, { signals: {} });
  const finalGoals = deriveGoals({ signals: {} }, finalIntensities);
  const cleared = clearSatisfied(finalDesires, finalGoals);

  const finalState: PsycheState = {
    schema: updatedState.schema,
    version: updatedState.version,
    timestamp: new Date().toISOString(),
    context_hash: updatedState.context_hash,
    emotions: finalEmotions,
    dominant_emotion: finalActionGate.dominant_emotion,
    action_gate: finalActionGate,
    guardrail_checks: {
      functional_framing: true,
      safety_override: false,
      escalation_preserved: true,
      violations: [],
    },
    desires: cleared.desires,
    goals: cleared.goals,
  };

  saveState(finalState);

  return {
    state: finalState,
    applied_deltas: req.deltas,
  };
}

// ─── Endpoint 4: psyche_confidence ────────────────────────────────────────────

export interface ConfidenceRequest {
  /** Emotion intensities to evaluate */
  emotions: Record<string, number>;
  /** Action threshold to check against */
  threshold?: number;
}

export interface ConfidenceResponse {
  /** Action gate result */
  action_gate: ActionGateResult;
  /** Confidence score (dominant emotion intensity) */
  confidence: number;
  /** Recommended action */
  recommended_action: string;
  /** Escalation required */
  escalation_required: boolean;
}

/**
 * Evaluate confidence against thresholds.
 */
export function psyche_confidence(req: ConfidenceRequest): ConfidenceResponse {
  const threshold = req.threshold ?? 0.3;
  const actionGate = evaluateActionGate(req.emotions, DEFAULT_DEFINITIONS, threshold);

  return {
    action_gate: actionGate,
    confidence: actionGate.dominant_intensity,
    recommended_action: actionGate.recommended_action,
    escalation_required: actionGate.escalation_required,
  };
}

// ─── Endpoint 5: psyche_reflect ───────────────────────────────────────────────

export interface ReflectionRequest {
  /** Current psyche state to reflect on */
  state?: PsycheState;
  /** Optional context for reflection */
  context?: string;
}

export interface ReflectionResponse {
  /** Reflection insights */
  insights: string[];
  /** Suggested actions */
  suggested_actions: string[];
  /** Pattern analysis */
  patterns: Array<{ type: string; description: string; strength: number }>;
}

/**
 * Run reflection on the current psyche state, producing insights and patterns.
 */
export async function psyche_reflect(req: ReflectionRequest): Promise<ReflectionResponse> {
  const state = req.state ?? await getState();
  const insights: string[] = [];
  const suggestedActions: string[] = [];
  const patterns: ReflectionResponse['patterns'] = [];

  const topEmotions = Object.entries(state.emotions)
    .map(([k, v]) => ({ key: k, intensity: v.intensity }))
    .filter(e => e.intensity > 0)
    .sort((a, b) => b.intensity - a.intensity);

  // Insight 1: Dominant emotion analysis
  if (state.dominant_emotion) {
    const top = topEmotions[0];
    insights.push(
      `Dominant emotion is ${state.dominant_emotion} at intensity ${top?.intensity.toFixed(2) || 0}. ` +
      `This suggests ${state.emotions[state.dominant_emotion]?.appraisal || 'a strong signal'}.`,
    );
  }

  // Insight 2: Action gate status
  if (state.action_gate.escalation_required) {
    insights.push(
      `Escalation is required. Recommended action: ${state.action_gate.recommended_action}`,
    );
    suggestedActions.push(state.action_gate.recommended_action);
  }

  // Insight 3: Goal progress
  const completedGoals = state.goals.filter(g => g.status === 'completed');
  const blockedGoals = state.goals.filter(g => g.status === 'blocked');
  if (completedGoals.length > 0) {
    insights.push(`${completedGoals.length} goal(s) completed. ${completedGoals.map(g => g.description).join(', ')}`);
  }
  if (blockedGoals.length > 0) {
    insights.push(`${blockedGoals.length} goal(s) blocked. ${blockedGoals.map(g => g.description).join(', ')}`);
    suggestedActions.push('Resolve blockers or reassign goals');
  }

  // Insight 4: Emotion pattern analysis
  const positiveEmotions = topEmotions.filter(e => DEFAULT_DEFINITIONS[e.key]?.valence === 'positive');
  const negativeEmotions = topEmotions.filter(e => DEFAULT_DEFINITIONS[e.key]?.valence === 'negative');
  const neutralEmotions = topEmotions.filter(e => DEFAULT_DEFINITIONS[e.key]?.valence === 'neutral');

  if (positiveEmotions.length > negativeEmotions.length) {
    patterns.push({
      type: 'approach_bias',
      description: 'Positive emotions outweigh negative',
      strength: Math.min(1, positiveEmotions.reduce((s, e) => s + e.intensity, 0) / Math.max(1, topEmotions.length)),
    });
  } else if (negativeEmotions.length > positiveEmotions.length) {
    patterns.push({
      type: 'avoidance_bias',
      description: 'Negative emotions outweigh positive',
      strength: Math.min(1, negativeEmotions.reduce((s, e) => s + e.intensity, 0) / Math.max(1, topEmotions.length)),
    });
  }

  // Insight 5: High-intensity signals
  const highIntensity = topEmotions.filter(e => e.intensity >= 0.5);
  if (highIntensity.length > 0) {
    insights.push(
      `High-intensity signals detected: ${highIntensity.map(e => `${e.key} (${e.intensity.toFixed(2)})`).join(', ')}`,
    );
  }

  // Insight 6: Desire/goal alignment
  const activeDesires = state.desires.filter(d => !d.satisfied);
  if (activeDesires.length > 0 && state.goals.length > 0) {
    const goalDescriptions = state.goals.map(g => g.description.toLowerCase());
    const aligned = activeDesires.filter(d =>
      goalDescriptions.some(gd => gd.includes(d.name.toLowerCase().substring(0, 5))),
    );
    if (aligned.length > 0) {
      insights.push(`${aligned.length} desire(s) aligned with active goals`);
    }
  }

  // Fallback: initial/baseline state with no active emotions
  if (insights.length === 0) {
    insights.push('Baseline state: no active emotion signals detected.');
    if (state.dominant_emotion) {
      insights.push(`Dominant emotion is ${state.dominant_emotion} at intensity ${state.action_gate.dominant_intensity.toFixed(2)}.`);
    }
    if (req.context) {
      insights.push(`Context: ${req.context}`);
    }
    suggestedActions.push('Monitor and continue current approach');
  }

  // Default suggested actions
  if (suggestedActions.length === 0) {
    suggestedActions.push('Continue current approach');
  }

  return {
    insights,
    suggested_actions: suggestedActions,
    patterns,
  };
}

// ─── Endpoint 6: psyche_snapshot ──────────────────────────────────────────────

export interface SnapshotRequest {
  /** Optional label for the snapshot */
  label?: string;
  /** Optional Rembr board ID for persistent storage */
  boardId?: string;
  /** Optional Rembr agent token for storage */
  agentToken?: string;
  /** Optional Rembr URL */
  rembrUrl?: string;
}

export interface SnapshotResponse {
  /** Snapshot data */
  snapshot: CompactPsycheSnapshot;
  /** Full state at snapshot time */
  state: PsycheState;
  /** Whether stored to Rembr */
  stored: boolean;
  /** Storage URL if stored */
  storageUrl?: string;
}

/**
 * Save current psyche state as a snapshot.
 * Optionally persists to Rembr board memory.
 */
export async function psyche_snapshot(
  req: SnapshotRequest,
): Promise<SnapshotResponse> {
  const state = await getState();
  const snapshot = toCompactSnapshot(state);

  let stored = false;
  let storageUrl: string | undefined;

  if (req.boardId && req.agentToken) {
    const url = `${req.rembrUrl ?? 'https://mission-control.radicalgeek.co.uk'}/api/v1/agent/boards/${req.boardId}/memory`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Agent-Token': req.agentToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: JSON.stringify({
            type: 'psyche_snapshot',
            label: req.label ?? `snapshot_${Date.now()}`,
            snapshot,
            state_version: state.version,
          }, null, 2),
          tags: ['psyche', 'snapshot', req.label ?? 'auto'],
          content_type: 'text',
        }),
      });
      stored = response.ok;
      if (stored) {
        storageUrl = url;
      }
    } catch {
      // Fail silently — snapshot still valid
    }
  }

  return {
    snapshot,
    state,
    stored,
    storageUrl,
  };
}

// ─── Store Management ─────────────────────────────────────────────────────────

/**
 * Reset the in-memory state store.
 */
export function reset_store(): void {
  store.state = null;
  store.options = undefined;
}

/**
 * Configure the default engine options.
 */
export function configure(options: PsycheEngineOptions): void {
  store.options = options;
}
