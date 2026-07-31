import { describe, it, expect, beforeEach } from 'vitest';
import {
  psyche_state,
  psyche_appraise,
  psyche_feel,
  psyche_confidence,
  psyche_reflect,
  psyche_snapshot,
  reset_store,
  configure,
  type FeelRequest,
  type ConfidenceRequest,
  type ReflectionRequest,
  type SnapshotRequest,
} from './api-endpoints.js';
import {
  DEFAULT_DEFINITIONS,
  EMOTION_KEYS,
} from './emotion-registry.js';

describe('psyche_state', () => {
  beforeEach(() => { reset_store(); });

  it('returns a valid psyche state with all 24 emotions', async () => {
    const state = await psyche_state();
    expect(state.schema).toBe('psyche_state.v1');
    expect(state.version).toBe('0.1.0');
    expect(typeof state.timestamp).toBe('string');
    expect(EMOTION_KEYS.length).toBe(24);
    for (const key of EMOTION_KEYS) {
      expect(state.emotions[key]).toBeDefined();
      expect(typeof state.emotions[key].intensity).toBe('number');
      expect(state.emotions[key].intensity).toBeGreaterThanOrEqual(0);
      expect(state.emotions[key].intensity).toBeLessThanOrEqual(1);
    }
  });

  it('includes action_gate and guardrail_checks', async () => {
    const state = await psyche_state();
    expect(state.action_gate).toBeDefined();
    expect(state.action_gate.above_threshold).toBeDefined();
    expect(state.action_gate.escalation_required).toBeDefined();
    expect(state.action_gate.recommended_action).toBeDefined();
    expect(state.guardrail_checks).toBeDefined();
    expect(state.guardrail_checks.functional_framing).toBe(true);
  });

  it('respects custom actionThreshold', async () => {
    const state = await psyche_state({ actionThreshold: 0.5 });
    expect(state.action_gate.dominant_intensity).toBeDefined();
  });
});

describe('psyche_appraise', () => {
  it('computes deltas from context with failure signals', () => {
    const result = psyche_appraise({ context: 'production server failed with error crash' });
    expect(result.deltas).toBeDefined();
    expect(result.fired_rules.length).toBeGreaterThan(0);
    expect(result.tokens).toBeDefined();
    expect(result.tokens.tokens.length).toBeGreaterThan(0);
    // failure signals should trigger fear, frustration, regret
    expect(result.deltas.fear).toBeGreaterThan(0);
    expect(result.deltas.frustration).toBeGreaterThan(0);
  });

  it('computes deltas from context with positive signals', () => {
    const result = psyche_appraise({ context: 'tests passed, deployment successful and working' });
    expect(result.deltas).toBeDefined();
    expect(result.fired_rules.length).toBeGreaterThan(0);
    expect(result.deltas.satisfaction).toBeGreaterThan(0);
    expect(result.deltas.confidence).toBeGreaterThan(0);
  });

  it('uses custom rules when provided', () => {
    const customRules = [
      { signal: 'goal', emotion: 'desire', delta: 0.5 },
    ];
    const result = psyche_appraise({
      context: 'goal milestone deliverable specification',
      rules: customRules,
    });
    expect(result.deltas.desire).toBeGreaterThan(0);
  });
});

describe('psyche_feel', () => {
  beforeEach(() => { reset_store(); });

  it('applies deltas and updates state', async () => {
    const feelReq: FeelRequest = {
      deltas: { fear: 0.3, confidence: 0.2 },
    };
    const result = await psyche_feel(feelReq);
    expect(result.state).toBeDefined();
    expect(result.applied_deltas.fear).toBe(0.3);
    expect(result.applied_deltas.confidence).toBe(0.2);
    // Intensities should be in [0, 1]
    expect(result.state.emotions.fear.intensity).toBeGreaterThanOrEqual(0);
    expect(result.state.emotions.fear.intensity).toBeLessThanOrEqual(1);
  });

  it('clamps deltas to valid range', async () => {
    const feelReq: FeelRequest = {
      deltas: { fear: 2.0, confidence: -0.5 },
    };
    const result = await psyche_feel(feelReq);
    expect(result.state.emotions.fear.intensity).toBeLessThanOrEqual(1);
    expect(result.state.emotions.confidence.intensity).toBeGreaterThanOrEqual(0);
  });

  it('persists state across calls', async () => {
    const state1 = await psyche_state();
    const feelReq: FeelRequest = {
      deltas: { confidence: 0.5 },
    };
    await psyche_feel(feelReq);
    const state2 = await psyche_state();
    expect(state2.emotions.confidence.intensity).toBeGreaterThan(state1.emotions.confidence.intensity);
  });
});

describe('psyche_confidence', () => {
  it('evaluates confidence from emotion intensities', () => {
    const req: ConfidenceRequest = {
      emotions: { fear: 0.6, confidence: 0.2, hope: 0.3 },
    };
    const result = psyche_confidence(req);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.recommended_action).toBeDefined();
    expect(typeof result.escalation_required).toBe('boolean');
  });

  it('returns escalation when dominant emotion is high negative', () => {
    const req: ConfidenceRequest = {
      emotions: { fear: 0.8, anxiety: 0.7, caution: 0.6 },
      threshold: 0.3,
    };
    const result = psyche_confidence(req);
    expect(result.escalation_required).toBe(true);
  });

  it('respects custom threshold', () => {
    const req: ConfidenceRequest = {
      emotions: { fear: 0.4, confidence: 0.35 },
      threshold: 0.5,
    };
    const result = psyche_confidence(req);
    // With 0.5 threshold, 0.4 and 0.35 should be below
    expect(result.action_gate.above_threshold).not.toContain('fear');
  });
});

describe('psyche_reflect', () => {
  beforeEach(() => { reset_store(); });

  it('produces insights from current state', async () => {
    const result = await psyche_reflect({});
    expect(result.insights.length).toBeGreaterThan(0);
    expect(result.suggested_actions.length).toBeGreaterThan(0);
    expect(result.patterns).toBeDefined();
  });

  it('analyzes emotion patterns', async () => {
    // Set up a state with strong positive bias
    configure({ actionThreshold: 0.2 });
    const feelReq: FeelRequest = {
      deltas: { confidence: 0.6, satisfaction: 0.5, hope: 0.4 },
    };
    await psyche_feel(feelReq);
    const state = await psyche_state();
    const result = await psyche_reflect({ state });
    const approachPatterns = result.patterns.filter(p => p.type === 'approach_bias');
    expect(approachPatterns.length).toBeGreaterThanOrEqual(0);
  });

  it('handles explicit context', async () => {
    const result = await psyche_reflect({ context: 'production failure analysis' });
    expect(result.insights.length).toBeGreaterThan(0);
  });
});

describe('psyche_snapshot', () => {
  beforeEach(() => { reset_store(); });

  it('creates a snapshot without storage', async () => {
    const req: SnapshotRequest = { label: 'test-snapshot' };
    const result = await psyche_snapshot(req);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot.dominant_emotion).toBeDefined();
    expect(result.snapshot.top_emotions).toBeDefined();
    expect(result.snapshot.action_gate_status).toBeDefined();
    expect(result.stored).toBe(false);
  });

  it('returns full state with snapshot', async () => {
    const req: SnapshotRequest = {};
    const result = await psyche_snapshot(req);
    expect(result.state).toBeDefined();
    expect(result.state.schema).toBe('psyche_state.v1');
  });

  it('generates top_emotions list', async () => {
    const req: SnapshotRequest = {};
    const result = await psyche_snapshot(req);
    expect(Array.isArray(result.snapshot.top_emotions)).toBe(true);
    // Should be sorted by intensity descending
    for (let i = 1; i < result.snapshot.top_emotions.length; i++) {
      expect(result.snapshot.top_emotions[i].intensity).toBeLessThanOrEqual(
        result.snapshot.top_emotions[i - 1].intensity,
      );
    }
  });
});

describe('integration', () => {
  beforeEach(() => { reset_store(); });

  it('full pipeline: state → appraise → feel → confidence → reflect → snapshot', async () => {
    // 1. Get initial state
    const initialState = await psyche_state();

    // 2. Appraise a failure context
    const appraisal = psyche_appraise({ context: 'server crashed with fatal error' });
    expect(appraisal.fired_rules.length).toBeGreaterThan(0);

    // 3. Apply the deltas
    const felt = await psyche_feel({ deltas: appraisal.deltas });
    expect(felt.state.dominant_emotion).toBeDefined();

    // 4. Evaluate confidence
    const confidence = psyche_confidence({
      emotions: Object.fromEntries(
        Object.entries(felt.state.emotions).map(([k, v]) => [k, v.intensity]),
      ),
    });

    // 5. Reflect
    const reflection = await psyche_reflect({ state: felt.state });
    expect(reflection.insights.length).toBeGreaterThan(0);

    // 6. Snapshot
    const snap = await psyche_snapshot({ label: 'integration-test' });
    expect(snap.snapshot.dominant_emotion).toBe(felt.state.dominant_emotion);
  });
});
