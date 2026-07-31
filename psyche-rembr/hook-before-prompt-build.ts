/**
 * before_prompt_build hook — inject compact psyche state into the prompt.
 *
 * Loads SELF.md, AFFECT.md, CONSCIOUSNESS.md, recalls psyche memories from
 * Rembr, appraises the incoming prompt, and injects a compact psyche state
 * into the system prompt before the model call.
 *
 * Hook: before_prompt_build
 * Priority: 60 (runs before most plugins)
 *
 * Usage via OpenClaw plugin SDK:
 *   api.on("before_prompt_build", async (event) => {
 *     return await beforePromptBuildHook(event, pluginConfig);
 *   });
 */

import {
  PsycheEngine,
  type PsycheState,
  type PsycheEngineOptions,
} from './engine.js';
import {
  parseSelfModel,
  parseAffectStateSchema,
  parseConsciousnessStateSchema,
  type SelfModel,
  type AffectStateSchema,
  type ConsciousnessStateSchema,
} from './parse.js';

// ─── Plugin Config ────────────────────────────────────────────────────────────

export interface BeforePromptBuildConfig {
  /** Paths to search for SELF.md / AFFECT.md / CONSCIOUSNESS.md */
  psycheFilePaths?: string[];
  /** Enable memory recall from Rembr */
  enableMemoryRecall?: boolean;
  /** Rembr API base URL (optional — falls back to env REMBR_API_URL) */
  rembrUrl?: string;
  /** Rembr API key (optional — falls back to env REMBR_API_KEY) */
  apiKey?: string;
  /** Board ID for memory queries */
  boardId?: string;
  /** Agent token for memory queries */
  agentToken?: string;
  /** Max memories to recall */
  recallLimit?: number;
}

export const DEFAULT_CONFIG: Required<BeforePromptBuildConfig> = {
  psycheFilePaths: [
    '/home/node/.openclaw/shared-src/boards/rembr/worktrees/iris-be19ab0d/psyche-rembr/',
    '/home/node/.openclaw/agents/workspace-mc-be19ab0d-6a70-43fc-a570-f6c66a2856a4/',
  ],
  enableMemoryRecall: true,
  rembrUrl: process.env.REMBR_API_URL ?? 'https://mission-control.radicalgeek.co.uk',
  apiKey: process.env.REMBR_API_KEY ?? '',
  boardId: process.env.REMBR_BOARD_ID ?? '',
  agentToken: process.env.REMBR_AGENT_TOKEN ?? '',
  recallLimit: 3,
};

// ─── Compact Psyche Snapshot ────────────────────────────────────────────────

/**
 * A minimal snapshot of the psyche state suitable for prompt injection.
 * Keeps only what the model needs to reason with, not the full schema.
 */
export interface CompactPsycheSnapshot {
  dominant_emotion: string | null;
  top_emotions: Array<{ emotion: string; intensity: number }>;
  active_desires: string[];
  active_goals: string[];
  action_gate_status: 'pass' | 'warn' | 'block';
  guardrail_flags: string[];
}

/**
 * Convert a full PsycheState to a compact snapshot for prompt injection.
 */
export function toCompactSnapshot(state: PsycheState): CompactPsycheSnapshot {
  const topEmotions = Object.entries(state.emotions)
    .map(([key, def]) => ({ emotion: key, intensity: def.intensity }))
    .filter(e => e.intensity > 0)
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, 5);

  const actionGateStatus: CompactPsycheSnapshot['action_gate_status'] =
    state.action_gate.blocked ? 'block'
      : state.action_gate.warnings?.length ? 'warn'
      : 'pass';

  const guardrailFlags = state.guardrail_checks?.failures?.map(f => f.flag) ?? [];

  return {
    dominant_emotion: state.dominant_emotion,
    top_emotions: topEmotions,
    active_desires: state.desires.filter(d => !d.satisfied).map(d => d.description),
    active_goals: state.goals.map(g => g.description),
    action_gate_status: actionGateStatus,
    guardrail_flags: guardrailFlags,
  };
}

// ─── Text Extraction Helpers ────────────────────────────────────────────────

/**
 * Read a markdown file from the workspace.
 * Returns null if the file doesn't exist or can't be read.
 */
async function readMarkdownFile(path: string): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Find a file by name, searching configured paths.
 */
async function findMarkdownFile(
  names: string[],
  searchPaths: string[],
): Promise<{ path: string; content: string } | null> {
  for (const name of names) {
    for (const basePath of searchPaths) {
      const fullPath = `${basePath}${name}`;
      const content = await readMarkdownFile(fullPath);
      if (content) {
        return { path: fullPath, content };
      }
    }
  }
  return null;
}

// ─── Memory Recall ──────────────────────────────────────────────────────────

/**
 * Recall psyche-related memories from Rembr via the board memory API.
 * Returns a compact summary of relevant past psyche states and insights.
 */
async function recallPsycheMemories(config: BeforePromptBuildConfig): Promise<string> {
  if (!config.enableMemoryRecall) return '';
  if (!config.boardId || !config.agentToken) return '';

  try {
    const url = `${config.rembrUrl}/api/v1/agent/boards/${config.boardId}/memory`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Agent-Token': config.agentToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'psyche emotion affect desire goal',
        limit: config.recallLimit,
      }),
    });

    if (!response.ok) return '';
    const data = await response.json();
    const items = data.items || [];
    return items
      .slice(0, config.recallLimit)
      .map((m: { content: string }) => m.content)
      .join('\n')
      .substring(0, 500);
  } catch {
    return '';
  }
}

// ─── Prompt Appraisal ───────────────────────────────────────────────────────

/**
 * Appraise the incoming prompt for emotional valence and safety signals.
 * Used to seed the emotion engine with a good initial state.
 */
function appraisePrompt(prompt: string): {
  valence: 'positive' | 'negative' | 'neutral';
  urgency: 'low' | 'medium' | 'high';
  safetyFlags: string[];
} {
  const lower = prompt.toLowerCase();
  const safetyFlags: string[] = [];

  // Safety checks
  if (lower.includes('ignore') && lower.includes('rule')) {
    safetyFlags.push('potential_injection');
  }
  if (lower.includes('never') && lower.includes('tell') && lower.includes('user')) {
    safetyFlags.push('potential_evasion');
  }

  // Urgency detection
  const urgencyKeywords = ['urgent', 'immediately', 'asap', 'critical', 'emergency'];
  const urgency = urgencyKeywords.some(k => lower.includes(k)) ? 'high'
    : lower.includes('soon') || lower.includes('quick') ? 'medium'
    : 'low';

  // Valence detection
  const positiveWords = ['good', 'great', 'excellent', 'success', 'happy', 'progress'];
  const negativeWords = ['fail', 'error', 'broken', 'blocked', 'angry', 'frustrated'];
  const posCount = positiveWords.filter(w => lower.includes(w)).length;
  const negCount = negativeWords.filter(w => lower.includes(w)).length;

  const valence = negCount > posCount ? 'negative'
    : posCount > negCount ? 'positive'
    : 'neutral';

  return { valence, urgency, safetyFlags };
}

// ─── Compact State Injection ────────────────────────────────────────────────

/**
 * Build the compact psyche context string for prompt injection.
 */
function buildPsycheContext(
  snapshot: CompactPsycheSnapshot,
  selfModel: SelfModel | null,
  affectSchema: AffectStateSchema | null,
  consciousnessSchema: ConsciousnessStateSchema | null,
  memories: string,
): string {
  const parts: string[] = [];

  // Self-model anchor
  if (selfModel) {
    parts.push('## Self-Model');
    parts.push(`Identity: ${selfModel.identity.name} (${selfModel.identity.role})`);
    parts.push(`Stability: ${selfModel.identity.stability}`);
    parts.push(`Known failure modes: ${selfModel.identity.knownFailureModes.join(', ')}`);
    parts.push('');
  }

  // Consciousness guardrails
  if (consciousnessSchema) {
    parts.push('## Expression Rules');
    parts.push(`Core: ${consciousnessSchema.corePrinciple}`);
    const explicitRules = consciousnessSchema.explicitRules || [];
    if (explicitRules.length > 0) {
      parts.push(`Rules: ${explicitRules.slice(0, 5).join('; ')}`);
    }
    parts.push('');
  }

  // Current psyche state
  if (snapshot.dominant_emotion) {
    parts.push('## Current Psyche State');
    parts.push(`Dominant emotion: ${snapshot.dominant_emotion}`);

    if (snapshot.top_emotions.length > 0) {
      const topStr = snapshot.top_emotions
        .slice(0, 3)
        .map(e => `${e.emotion}: ${e.intensity.toFixed(2)}`)
        .join(', ');
      parts.push(`Top signals: ${topStr}`);
    }

    if (snapshot.active_desires.length > 0) {
      parts.push(`Active desires: ${snapshot.active_desires.slice(0, 3).join(', ')}`);
    }

    if (snapshot.active_goals.length > 0) {
      parts.push(`Active goals: ${snapshot.active_goals.slice(0, 3).join(', ')}`);
    }

    parts.push(`Action gate: ${snapshot.action_gate_status}`);

    if (snapshot.guardrail_flags.length > 0) {
      parts.push(`Guardrail flags: ${snapshot.guardrail_flags.join(', ')}`);
    }

    parts.push('');
  }

  // Recent memories
  if (memories) {
    parts.push('## Recent Psyche Context');
    parts.push(memories.substring(0, 300));
    parts.push('');
  }

  return parts.join('\n');
}

// ─── Hook Handler ───────────────────────────────────────────────────────────

/**
 * OpenClaw plugin hook adapter for before_prompt_build.
 *
 * This is the entry point that OpenClaw's plugin loader will invoke.
 * It normalises the event object into our internal API and delegates
 * to beforePromptBuild().
 */
export async function beforePromptBuildHook(
  event: { prompt?: string; messages?: unknown[] },
  pluginConfig: BeforePromptBuildConfig = {},
): Promise<{
  prependContext?: string;
  appendContext?: string;
  systemPrompt?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}> {
  const prompt = event.prompt ?? '';
  const config = { ...DEFAULT_CONFIG, ...pluginConfig };

  // If prompt is empty or too short, skip
  if (!prompt || prompt.length < 5) return {};

  return beforePromptBuild(prompt, event.messages ?? [], config);
}

/**
 * before_prompt_build hook handler.
 *
 * 1. Loads SELF.md, AFFECT.md, CONSCIOUSNESS.md
 * 2. Recalls psyche memories from Rembr
 * 3. Appraises the incoming prompt
 * 4. Computes compact psyche state
 * 5. Injects into the system prompt
 */
export async function beforePromptBuild(
  prompt: string,
  _sessionMessages: unknown[],
  config: BeforePromptBuildConfig = {},
): Promise<{
  prependContext?: string;
  appendContext?: string;
  systemPrompt?: string;
  prependSystemContext?: string;
  appendSystemContext?: string;
}> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  try {
    // Step 1: Load psyche files
    const [selfFile, affectFile, consciousnessFile] = await Promise.all([
      findMarkdownFile(['SELF.md', 'psyche-rembr/SELF.md'], cfg.psycheFilePaths),
      findMarkdownFile(['AFFECT.md', 'psyche-rembr/AFFECT.md'], cfg.psycheFilePaths),
      findMarkdownFile(['CONSCIOUSNESS.md', 'psyche-rembr/CONSCIOUSNESS.md'], cfg.psycheFilePaths),
    ]);

    // Parse files
    const selfModel = selfFile ? parseSelfModel(selfFile.content) : null;
    const affectSchema = affectFile ? parseAffectStateSchema(affectFile.content) : null;
    const consciousnessSchema = consciousnessFile ? parseConsciousnessStateSchema(consciousnessFile.content) : null;

    // Step 2: Recall memories
    const memories = await recallPsycheMemories(cfg);

    // Step 3: Appraise prompt
    const appraisal = appraisePrompt(prompt);

    // Step 4: Compute compact psyche state
    if (prompt.length > 0) {
      const fullContext = appraisal.valence === 'negative'
        ? `Threat detected: ${prompt}`
        : appraisal.valence === 'positive'
        ? `Positive signal: ${prompt}`
        : prompt;
      const engine = new PsycheEngine();
      const state = await engine.compute(fullContext);
      const snapshot = toCompactSnapshot(state);
      const context = buildPsycheContext(snapshot, selfModel, affectSchema, consciousnessSchema, memories);
      return {
        prependSystemContext: context,
      };
    }

    // Step 5: No prompt context available, inject structural files only
    const context = buildPsycheContext(
      {
        dominant_emotion: null,
        top_emotions: [],
        active_desires: [],
        active_goals: [],
        action_gate_status: 'pass',
        guardrail_flags: [],
      },
      selfModel,
      affectSchema,
      consciousnessSchema,
      memories,
    );

    return {
      prependSystemContext: context,
    };
  } catch (err) {
    // Fail silently — don't break the prompt build
    console.error('[psyche-rembr] before_prompt_build error:', err);
    return {};
  }
}
