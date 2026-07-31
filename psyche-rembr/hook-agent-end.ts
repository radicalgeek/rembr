/**
 * agent_end hook — appraise outcome, update emotion state, store durable insights.
 *
 * Fires after each agent turn completes. Inspects the turn outcome, runs
 * appraisal on the full exchange, updates the persistent emotion state,
 * and stores durable psyche insights back to Rembr.
 *
 * Hook: agent_end
 * Priority: 50 (after before_prompt_build at 60)
 *
 * Usage via OpenClaw plugin SDK:
 *   api.on("agent_end", async (event, ctx) => {
 *     return await agentEndHook(event, ctx, pluginConfig);
 *   });
 */

import {
  PsycheEngine,
  type PsycheState,
  type PsycheEngineOptions,
} from './engine.js';
import { toCompactSnapshot } from './hook-before-prompt-build.js';
import { appraisePrompt } from './hook-before-prompt-build.js';
import type { BeforePromptBuildConfig } from './hook-before-prompt-build.js';

// ─── Plugin Config ────────────────────────────────────────────────────────────

export interface AgentEndConfig extends PsycheEngineOptions, BeforePromptBuildConfig {
  /** Enable durable insight storage to Rembr */
  enableInsightStorage?: boolean;
  /** Enable causal trace recording when emotion influenced action */
  enableCausalTrace?: boolean;
  /** Maximum number of insights to keep in Rembr */
  maxInsights?: number;
}

const DEFAULT_AGENT_CONFIG: Required<AgentEndConfig> = {
  ...DEFAULT_CONFIG,
  enableInsightStorage: true,
  enableCausalTrace: true,
  maxInsights: 50,
  actionThreshold: 0.3,
  decayMultiplier: 1.0,
  rules: [],
};

// ─── Outcome Appraisal ────────────────────────────────────────────────────────

/**
 * Build an appraisal string from the agent turn outcome.
 */
function buildOutcomeAppraisal(
  event: {
    success?: boolean;
    messages?: unknown[];
    durationMs?: number;
    error?: string;
  },
  previousPrompt?: string,
): string {
  const parts: string[] = [];

  // Turn outcome
  if (event.success === false) {
    parts.push(`Turn failed: ${event.error ?? 'unknown error'}`);
  } else if (event.success === true) {
    parts.push('Turn succeeded');
  } else {
    parts.push('Turn outcome unknown');
  }

  // Duration (slow turns are notable)
  if (event.durationMs) {
    if (event.durationMs > 30000) {
      parts.push(`Slow turn: ${event.durationMs}ms`);
    }
  }

  // Summarise assistant messages (last message is the reply)
  if (Array.isArray(event.messages) && event.messages.length > 0) {
    const lastMsg = event.messages[event.messages.length - 1];
    if (lastMsg && typeof lastMsg === 'object') {
      const role = (lastMsg as Record<string, unknown>).role;
      const content = (lastMsg as Record<string, unknown>).content;
      if (role === 'assistant' && typeof content === 'string') {
        const summary = content.substring(0, 200);
        parts.push(`Assistant reply: ${summary}`);
      }
    }
  }

  // Original prompt (for context)
  if (previousPrompt) {
    parts.push(`Original prompt: ${previousPrompt.substring(0, 100)}`);
  }

  return parts.join(' | ');
}

// ─── Insight Extraction ───────────────────────────────────────────────────────

/**
 * Extract durable insights from the appraisal result and emotion state.
 */
function extractInsights(
  appraisal: ReturnType<typeof appraisePrompt>,
  state: PsycheState,
  outcome: string,
): string[] {
  const insights: string[] = [];

  // Emotion-driven action decisions
  if (state.action_gate.escalation_required) {
    insights.push(
      `Escalation triggered: dominant emotion ${state.dominant_emotion} at intensity ${state.action_gate.dominant_intensity.toFixed(2)}. Action: ${state.action_gate.recommended_action}`,
    );
  }

  // Safety flag detection
  if (appraisal.safetyFlags.length > 0) {
    insights.push(`Safety flags detected: ${appraisal.safetyFlags.join(', ')}`);
  }

  // High-confidence actions
  if (
    state.dominant_emotion === 'confidence' &&
    state.action_gate.dominant_intensity >= 0.7
  ) {
    insights.push(
      `High confidence action taken (${state.action_gate.dominant_intensity.toFixed(2)}). Proceeding assertively.`,
    );
  }

  // Failure patterns
  if (appraisal.valence === 'negative') {
    insights.push(
      `Negative valence turn. Dominant emotion: ${state.dominant_emotion}. Review needed.`,
    );
  }

  // Goal progress
  if (state.goals.length > 0) {
    const completed = state.goals.filter(g => g.status === 'completed');
    if (completed.length > 0) {
      insights.push(
        `Goal completed: ${completed.map(g => g.description).join(', ')}`,
      );
    }
  }

  return insights;
}

// ─── Causal Trace ─────────────────────────────────────────────────────────────

/**
 * Build a causal trace entry when emotion influenced action.
 */
function buildCausalTrace(
  appraisal: ReturnType<typeof appraisePrompt>,
  state: PsycheState,
  outcome: string,
): string | null {
  if (!state.action_gate.escalation_required && appraisal.safetyFlags.length === 0) {
    return null; // No emotion-driven action
  }

  return JSON.stringify({
    type: 'causal_trace',
    timestamp: new Date().toISOString(),
    prompt_valence: appraisal.valence,
    dominant_emotion: state.dominant_emotion,
    dominant_intensity: state.action_gate.dominant_intensity,
    escalation_required: state.action_gate.escalation_required,
    safety_flags: appraisal.safetyFlags,
    outcome,
    recommended_action: state.action_gate.recommended_action,
  });
}

// ─── Memory Storage ───────────────────────────────────────────────────────────

/**
 * Store insights to Rembr board memory.
 */
async function storeInsights(
  insights: string[],
  causalTrace: string | null,
  config: Required<AgentEndConfig>,
): Promise<void> {
  if (!config.boardId || !config.agentToken) return;

  const url = `${config.rembrUrl}/api/v1/agent/boards/${config.boardId}/memory`;
  const headers = {
    'X-Agent-Token': config.agentToken,
    'Content-Type': 'application/json',
  };

  // Store causal trace if present
  if (config.enableCausalTrace && causalTrace) {
    try {
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          content: causalTrace,
          tags: ['psyche', 'causal_trace'],
          content_type: 'text',
        }),
      });
    } catch {
      // Fail silently — don't break the turn
    }
  }

  // Store insights (batch if many)
  if (config.enableInsightStorage) {
    for (const insight of insights) {
      try {
        await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            content: insight,
            tags: ['psyche', 'insight'],
            content_type: 'text',
          }),
        });
      } catch {
        // Fail silently
      }
    }
  }
}

// ─── Hook Handler ─────────────────────────────────────────────────────────────

/**
 * OpenClaw plugin hook adapter for agent_end.
 */
export async function agentEndHook(
  event: {
    success?: boolean;
    messages?: unknown[];
    durationMs?: number;
    error?: string;
    runId?: string;
  },
  _ctx: { sessionKey?: string; sessionId?: string },
  pluginConfig: AgentEndConfig = {},
): Promise<void> {
  const config = { ...DEFAULT_AGENT_CONFIG, ...pluginConfig };

  try {
    // Step 1: Build outcome appraisal
    const outcome = buildOutcomeAppraisal(event);
    const appraisal = appraisePrompt(outcome);

    // Step 2: Compute updated psyche state
    const engine = new PsycheEngine({
      actionThreshold: config.actionThreshold,
      decayMultiplier: config.decayMultiplier,
      rules: config.rules,
    });
    const state = await engine.compute(outcome);
    const snapshot = toCompactSnapshot(state);

    // Step 3: Extract insights
    const insights = extractInsights(appraisal, state, outcome);

    // Step 4: Build causal trace
    const causalTrace = buildCausalTrace(appraisal, state, outcome);

    // Step 5: Store to Rembr
    await storeInsights(insights, causalTrace, config);

    // Log summary
    console.log(
      `[psyche-rembr] agent_end: dominant=${snapshot.dominant_emotion}, ` +
      `intensity=${snapshot.top_emotions[0]?.intensity.toFixed(2) ?? 0}, ` +
      `insights=${insights.length}, escalation=${state.action_gate.escalation_required}`,
    );
  } catch (err) {
    console.error('[psyche-rembr] agent_end error:', err);
    // Fail silently — don't crash the turn
  }
}
