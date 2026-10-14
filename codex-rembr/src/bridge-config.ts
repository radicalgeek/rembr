import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const REMBR_CATEGORIES = [
  "facts",
  "preferences",
  "conversations",
  "projects",
  "learning",
  "goals",
  "context",
  "reminders",
  "patterns",
  "decisions",
  "workflows",
  "insights",
] as const

export interface BridgeConfig {
  url: string
  apiKey: string
  recallLimit: number
  minSimilarity: number
  timeoutMs: number
}

export function loadBridgeConfig(
  env: Record<string, string | undefined> = process.env,
  configFilePath: string | null = path.join(os.homedir(), ".rembr", "codex.env"),
): BridgeConfig {
  const fileConfig = configFilePath ? readConfigFile(configFilePath) : {}
  const fileHasUrl = Boolean(fileConfig.REMBR_URL)
  const fileHasKey = Boolean(fileConfig.REMBR_API_KEY)
  if (fileHasUrl !== fileHasKey) {
    throw new Error(`codex-rembr: ${configFilePath} must contain both REMBR_URL and REMBR_API_KEY`)
  }

  if (!fileHasUrl) {
    throw new Error("codex-rembr: Rembr is not configured. Run the Rembr setup skill in Codex.")
  }
  const limit = Number(env.REMBR_RECALL_LIMIT)
  const similarity = Number(env.REMBR_MIN_SIMILARITY)
  const timeout = Number(env.REMBR_TIMEOUT_MS)
  return {
    url: fileConfig.REMBR_URL,
    apiKey: fileConfig.REMBR_API_KEY,
    recallLimit: Number.isFinite(limit) && limit >= 1 && limit <= 50 ? limit : 10,
    minSimilarity: Number.isFinite(similarity) && similarity >= 0 && similarity <= 1 ? similarity : 0.5,
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? timeout : 15_000,
  }
}

function readConfigFile(filePath: string): Record<string, string> {
  try {
    const values: Record<string, string> = {}
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?(REMBR_URL|REMBR_API_KEY)\s*=\s*(.*?)\s*$/)
      if (!match) continue
      let value = match[2]
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      values[match[1]] = value
    }
    return values
  } catch {
    return {}
  }
}
