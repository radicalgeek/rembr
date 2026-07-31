/**
 * session_end hook — snapshot psyche state, clear ephemeral session state.
 *
 * Fires when a session ends (reset, idle, compaction, shutdown, restart, etc.).
 * Persists the current psyche state as a durable snapshot and clears any
 * ephemeral/session-scoped emotion state.
 *
 * Hook: session_end
 * Priority: 40 (after agent_end at 50, before_prompt_build at 60)
 *
 * Usage via OpenClaw plugin SDK:
 *   api.on("session_end", async (event, ctx) => {
 *     await sessionEndHook(event, ctx, pluginConfig);
 *   });
 */

import {
  PsycheEngine,
  type PsycheState,
  type PsycheEngineOptions,
} from './engine.js';
import type { BeforePromptBuildConfig } from './hook-before-prompt-build.js';

// ─── Plugin Config ────────────────────────────────────────────────────────────

export interface SessionEndConfig extends PsycheEngineOptions, BeforePromptBuildConfig {
  /** Enable snapshot storage to Rembr */
  enableSnapshotStorage?: boolean;
  /** Clear ephemeral state after snapshot */
  clearEphemeralState?: boolean;
  /** Ephemeral state key prefix for cleanup */
  ephemeralKeyPrefix?: string;
}

const DEFAULT_SESSION_CONFIG: Required<SessionEndConfig> = {
  ...DEFAULT_CONFIG,
  enableSnapshotStorage: true,
  clearEphemeralState: true,
  ephemeralKeyPrefix: 'psyche_ephemeral_',
  actionThreshold: 0.3,
  decayMultiplier: 1.0,
  rules: [],
};

// ─── Session State Snapshot ───────────────────────────────────────────────────

/**
 * A persistent snapshot of the psyche state at session boundary.
 */
interface SessionSnapshot {
  type: 'session_snapshot';
  timestamp: string;
  sessionKey: string;
  sessionId: string;
  reason: string;
  dominant_emotion: string | null;
  top_emotions: Array<{ emotion: string; intensity: number }>;
  active_desires: string[];
  active_goals: string[];
  action_gate_status: 'pass' | 'warn' | 'block';
  escalation_required: boolean;
  context_hash: string;
}

/**
 * Convert PsycheState to a session snapshot.
 */
function toSessionSnapshot(
  state: PsycheState,
  event: {
    sessionKey?: string;
    sessionId?: string;
    reason?: string;
  },
): SessionSnapshot {
  const topEmotions = Object.entries(state.emotions)
    .map(([key, def]) => ({ emotion: key, intensity: def.intensity }))
    .filter(e => e.intensity > 0)
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, 5);

  const actionGateStatus: SessionSnapshot['action_gate_status'] =
    state.action_gate.dominant_intensity >= 0.7 ? 'block'
      : state.action_gate.dominant_intensity >= 0.3 ? 'warn'
      : 'pass';

  return {
    type: 'session_snapshot',
    timestamp: new Date().toISOString(),
    sessionKey: event.sessionKey ?? event.sessionId ?? 'unknown',
    sessionId: event.sessionId ?? 'unknown',
    reason: event.reason ?? 'unknown',
    dominant_emotion: state.dominant_emotion,
    top_emotions,
    active_desires: state.desires.filter(d => !d.satisfied).map(d => d.description),
    active_goals: state.goals.map(g => g.description),
    action_gate_status: actionGateStatus,
    escalation_required: state.action_gate.escalation_required,
    context_hash: state.context_hash ?? '',
  };
}

// ─── Ephemeral State Cleanup ──────────────────────────────────────────────────

/**
 * Clear ephemeral session-scoped psyche state.
 *
 * In a full implementation this would use OpenClaw's session extension
 * API. For now, it logs the cleanup action and returns the keys that
 * would be cleared.
 */
function clearEphemeralState(config: Required<SessionEndConfig>): string[] {
  if (!config.clearEphemeralState) return [];

  // These would be session extension keys in production
  const keysToClear = [
    `${config.ephemeralKeyPrefix}emotion_state`,
    `${config.ephemeralKeyPrefix}desire_state`,
    `${config.ephemeralKeyPrefix}session_context`,
  ];

  console.log(
    `[psyche-rembr] session_end: clearing ephemeral keys: ${keysToClear.join(', ')}`,
  );

  return keysToClear;
}

// ─── Snapshot Storage ─────────────────────────────────────────────────────────

/**
 * Store session snapshot to Rembr board memory.
 */
async function storeSnapshot(
  snapshot: SessionSnapshot,
  config: Required<SessionEndConfig>,
): Promise<boolean> {
  if (!config.boardId || !config.agentToken) return false;
  if (!config.enableSnapshotStorage) return false;

  try {
    const url = `${config.rembrUrl}/api/v1/agent/boards/${config.boardId}/memory`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Agent-Token': config.agentToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: JSON.stringify(snapshot, null, 2),
        tags: ['psyche', 'session_snapshot', snapshot.reason],
        content_type: 'text',
      }),
    });

    return response.ok;
  } catch {
    return false;
  }
}

// ─── Hook Handler ─────────────────────────────────────────────────────────────

/**
 * OpenClaw plugin hook adapter for session_end.
 */
export async function sessionEndHook(
  event: {
    sessionKey?: string;
    sessionId?: string;
    reason?: string;
    nextSessionKey?: string;
    nextSessionId?: string;
  },
  _ctx: { sessionKey?: string; sessionId?: string },
  pluginConfig: SessionEndConfig = {},
): Promise<void> {
  const config = { ...DEFAULT_SESSION_CONFIG, ...pluginConfig };

  try {
    // Step 1: Compute current psyche state from session context
    // (In production, this would receive the accumulated state from the session)
    const engine = new PsycheEngine({
      actionThreshold: config.actionThreshold,
      decayMultiplier: config.decayMultiplier,
      rules: config.rules,
    });
    const state = await engine.compute(
      `Session ended: ${event.reason ?? 'unknown'} for ${event.sessionKey ?? event.sessionId ?? 'unknown'}`,
    );

    // Step 2: Create snapshot
    const snapshot = toSessionSnapshot(state, event);

    // Step 3: Store snapshot
    const stored = await storeSnapshot(snapshot, config);

    // Step 4: Clear ephemeral state
    const clearedKeys = clearEphemeralState(config);

    // Step 5: Log result
    console.log(
      `[psyche-rembr] session_end: reason=${event.reason}, ` +
      `snapshot_stored=${stored}, ` +
      `ephemeral_cleared=${clearedKeys.length}, ` +
      `dominant=${snapshot.dominant_emotion}, ` +
      `escalation=${snapshot.escalation_required}`,
    );
  } catch (err) {
    console.error('[psyche-rembr] session_end error:', err);
    // Fail silently — don't crash the shutdown
  }
}
