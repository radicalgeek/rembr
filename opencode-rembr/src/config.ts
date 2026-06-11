import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export const MEMORY_CATEGORIES = [
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

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

export interface RembrConfig {
  /** Rembr MCP endpoint, e.g. https://rembr.ai/mcp */
  url: string
  /** Rembr API key (x-api-key). If unset the plugin disables itself gracefully. */
  apiKey?: string
  /** Persist a session summary to Rembr when a session goes idle. */
  autoRemember: boolean
  /** Max memories injected at session start. 0 disables recall injection. */
  maxRecall: number
  /** Minimum similarity score for recall (server default 0.7). */
  minSimilarity: number
  /** Category used for auto-captured session summaries. */
  captureCategory: MemoryCategory
  /** Request timeout in milliseconds. */
  timeoutMs: number
}

export const DEFAULT_CONFIG: RembrConfig = {
  url: "https://rembr.ai/mcp",
  autoRemember: true,
  maxRecall: 10,
  minSimilarity: 0.7,
  captureCategory: "conversations",
  timeoutMs: 15000,
}

function readJsonFile(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return {}
  }
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  return !["false", "0", "no", "off"].includes(value.toLowerCase())
}

function parseNum(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function pick(source: Record<string, unknown>): Partial<RembrConfig> {
  const out: Partial<RembrConfig> = {}
  if (typeof source.url === "string") out.url = source.url
  if (typeof source.apiKey === "string") out.apiKey = source.apiKey
  if (typeof source.autoRemember === "boolean") out.autoRemember = source.autoRemember
  if (typeof source.maxRecall === "number") out.maxRecall = source.maxRecall
  if (typeof source.minSimilarity === "number") out.minSimilarity = source.minSimilarity
  if (
    typeof source.captureCategory === "string" &&
    (MEMORY_CATEGORIES as readonly string[]).includes(source.captureCategory)
  ) {
    out.captureCategory = source.captureCategory as MemoryCategory
  }
  if (typeof source.timeoutMs === "number") out.timeoutMs = source.timeoutMs
  return out
}

export interface LoadConfigInput {
  /** Plugin options from opencode.json: "plugin": [["opencode-rembr", { ... }]] */
  options?: Record<string, unknown>
  env?: Record<string, string | undefined>
  /** Project worktree root, used to locate .opencode/rembr.json */
  worktree?: string
}

/**
 * Precedence (lowest to highest): defaults, ~/.config/opencode/rembr.json,
 * <worktree>/.opencode/rembr.json, REMBR_* env vars, plugin options.
 */
export function loadConfig(input: LoadConfigInput = {}): RembrConfig {
  const env = input.env ?? process.env

  const fromEnv: Partial<RembrConfig> = {}
  if (env.REMBR_URL) fromEnv.url = env.REMBR_URL
  if (env.REMBR_API_KEY) fromEnv.apiKey = env.REMBR_API_KEY
  const autoRemember = parseBool(env.REMBR_AUTO_REMEMBER)
  if (autoRemember !== undefined) fromEnv.autoRemember = autoRemember
  const maxRecall = parseNum(env.REMBR_MAX_RECALL)
  if (maxRecall !== undefined) fromEnv.maxRecall = maxRecall
  const minSimilarity = parseNum(env.REMBR_MIN_SIMILARITY)
  if (minSimilarity !== undefined) fromEnv.minSimilarity = minSimilarity

  return {
    ...DEFAULT_CONFIG,
    ...pick(readJsonFile(join(homedir(), ".config", "opencode", "rembr.json"))),
    ...(input.worktree ? pick(readJsonFile(join(input.worktree, ".opencode", "rembr.json"))) : {}),
    ...fromEnv,
    ...pick(input.options ?? {}),
  }
}
