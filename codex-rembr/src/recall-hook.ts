import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadBridgeConfig, type BridgeConfig } from "./bridge-config.js"
import { RembrClient } from "./rembr-client.js"
import { buildRecallContext, routePromptRecall, type RecallClient } from "./recall.js"

export interface CodexPromptHookInput {
  session_id?: string
  prompt?: string
  cwd?: string
}

export interface CodexPromptHookResult {
  continue: true
  hookSpecificOutput?: {
    hookEventName: "UserPromptSubmit"
    additionalContext: string
  }
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback
  return !["false", "0", "no", "off"].includes(value.toLowerCase())
}

export function loadRecallHookConfig(
  env: Record<string, string | undefined> = process.env,
  configFilePath?: string | null,
): BridgeConfig {
  return loadBridgeConfig({
    ...env,
    REMBR_RECALL_LIMIT: env.REMBR_RECALL_LIMIT || "10",
    REMBR_MIN_SIMILARITY: env.REMBR_MIN_SIMILARITY || "0.3",
  }, configFilePath)
}

export function claimRecallSession(
  sessionId: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!sessionId) return false
  try {
    const stateDir = env.REMBR_STATE_DIR || path.join(os.homedir(), ".rembr")
    const flagDir = path.join(stateDir, "codex-recall-flags")
    fs.mkdirSync(flagDir, { recursive: true })
    const safeSessionId = sessionId.replace(/[^\w.-]/g, "_")
    const fd = fs.openSync(path.join(flagDir, `${safeSessionId}.flag`), "wx")
    fs.writeFileSync(fd, new Date().toISOString(), "utf8")
    fs.closeSync(fd)
    return true
  } catch {
    return false
  }
}

export async function runRecallHook(
  input: CodexPromptHookInput,
  env: Record<string, string | undefined> = process.env,
  client?: RecallClient,
  claimSession = claimRecallSession,
  configFilePath?: string | null,
): Promise<CodexPromptHookResult> {
  const empty: CodexPromptHookResult = { continue: true }
  if (env.REMBR_CAPTURE_DISABLE || !parseBool(env.REMBR_PROMPT_RECALL, true)) return empty
  if (!input.session_id || !input.prompt?.trim()) return empty

  let config: BridgeConfig
  try {
    config = loadRecallHookConfig(env, configFilePath)
  } catch {
    return empty
  }
  if (!claimSession(input.session_id, env)) return empty

  try {
    const rembr = client ?? new RembrClient({
      url: config.url,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
    })
    const result = await routePromptRecall(rembr, config, input.prompt, input.cwd)
    if (!result) return empty
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: buildRecallContext(result),
      },
    }
  } catch {
    return empty
  }
}
