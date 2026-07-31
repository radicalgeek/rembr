/**
 * psyche-rembr OpenClaw plugin entry.
 *
 * Registers three lifecycle hooks:
 *   before_prompt_build — inject compact psyche state into prompts
 *   agent_end           — appraise outcomes, store insights & causal traces
 *   session_end         — snapshot psyche state, clear ephemeral session state
 *
 * All hooks are observation or prompt-mutation hooks. The before_prompt_build
 * hook requires `allowConversationAccess: true` in the plugin config.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { beforePromptBuildHook } from "./hook-before-prompt-build.js";
import { agentEndHook } from "./hook-agent-end.js";
import { sessionEndHook } from "./hook-session-end.js";

export default definePluginEntry({
  id: "psyche-rembr",
  name: "Psyche Rembr",
  description:
    "Functional emotion computation engine: prompt injection, outcome appraisal, and session persistence.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      psycheFilePaths: {
        type: "array",
        items: { type: "string" },
        description:
          "Paths to search for SELF.md / AFFECT.md / CONSCIOUSNESS.md",
      },
      enableMemoryRecall: {
        type: "boolean",
        description: "Enable memory recall from Rembr for psyche state",
      },
      rembrUrl: {
        type: "string",
        description: "Rembr API base URL",
      },
      apiKey: {
        type: "string",
        description: "Rembr API key (also reads REMBR_API_KEY env)",
        sensitive: true,
      },
      boardId: {
        type: "string",
        description: "Rembr board ID for memory queries",
      },
      agentToken: {
        type: "string",
        description: "Rembr agent token (also reads REMBR_AGENT_TOKEN env)",
        sensitive: true,
      },
      recallLimit: {
        type: "integer",
        description: "Max memories to recall",
      },
      enableInsightStorage: {
        type: "boolean",
        description: "Store durable psyche insights to Rembr on agent_end",
      },
      enableCausalTrace: {
        type: "boolean",
        description:
          "Record causal trace when emotion influenced action on agent_end",
      },
      enableSnapshotStorage: {
        type: "boolean",
        description: "Store session snapshots to Rembr on session_end",
      },
      clearEphemeralState: {
        type: "boolean",
        description: "Clear ephemeral session-scoped psyche state on session_end",
      },
      actionThreshold: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Global action threshold for emotion engine",
      },
      decayMultiplier: {
        type: "number",
        description: "Decay rate multiplier for emotion engine",
      },
    },
  },
  activation: {
    onStartup: false,
    onCapabilities: ["hook"],
  },
  register(api) {
    // ── before_prompt_build ──────────────────────────────────────────────
    // Priority 60 — runs before most prompt hooks. Adds compact psyche state
    // to the system prompt before the model call.
    api.on(
      "before_prompt_build",
      async (event) => {
        const config = event.context.pluginConfig;
        return beforePromptBuildHook(event, config);
      },
      { priority: 60 },
    );

    // ── agent_end ────────────────────────────────────────────────────────
    // Priority 50 — observes turn outcome, appraises, stores insights.
    api.on(
      "agent_end",
      async (event, _ctx) => {
        const config = event.context.pluginConfig;
        return agentEndHook(event, _ctx, config);
      },
      { priority: 50 },
    );

    // ── session_end ──────────────────────────────────────────────────────
    // Priority 40 — snapshots psyche state, clears ephemeral state.
    api.on(
      "session_end",
      async (event, _ctx) => {
        const config = event.context.pluginConfig;
        return sessionEndHook(event, _ctx, config);
      },
      { priority: 40 },
    );
  },
});
