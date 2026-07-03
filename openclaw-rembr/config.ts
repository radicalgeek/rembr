// memory-rembr config: parsing, env expansion, and category mapping.

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

export type RembrCategory = (typeof REMBR_CATEGORIES)[number]

/** Aliases used by other OpenClaw memory plugins, normalized to Rembr categories. */
export const CATEGORY_ALIASES: Record<string, RembrCategory> = {
  preference: "preferences",
  fact: "facts",
  decision: "decisions",
  entity: "facts",
  other: "context",
}

export function normalizeCategory(value: string | undefined, fallback: RembrCategory): RembrCategory {
  if (!value) return fallback
  if ((REMBR_CATEGORIES as readonly string[]).includes(value)) return value as RembrCategory
  return CATEGORY_ALIASES[value] ?? fallback
}

export type RembrMemoryConfig = {
  url: string
  apiKey?: string
  autoRecall: boolean
  autoCapture: boolean
  recallLimit: number
  minSimilarity: number
  recallMaxChars: number
  captureMaxChars: number
  customTriggers?: string[]
  defaultCategory: RembrCategory
  timeoutMs: number
}

export const DEFAULT_URL = "https://rembr.ai/mcp"
export const DEFAULT_RECALL_LIMIT = 5
export const DEFAULT_MIN_SIMILARITY = 0.7
export const DEFAULT_RECALL_MAX_CHARS = 1000
export const DEFAULT_CAPTURE_MAX_CHARS = 500
export const DEFAULT_TIMEOUT_MS = 15_000

const ALLOWED_KEYS = [
  "url",
  "apiKey",
  "autoRecall",
  "autoCapture",
  "recallLimit",
  "minSimilarity",
  "recallMaxChars",
  "captureMaxChars",
  "customTriggers",
  "defaultCategory",
  "timeoutMs",
] as const

/** Expand ${ENV_VAR} references so secrets never live in config files. */
export function expandEnv(value: string, env: Record<string, string | undefined> = process.env): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (match, name: string) => env[name] ?? match)
}

function readBoundedNumber(
  value: unknown,
  label: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a number between ${min} and ${max}`)
  }
  return value
}

function readBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`)
  return value
}

export function createRembrConfigSchema(env: Record<string, string | undefined> = process.env) {
  return {
    parse(value: unknown): RembrMemoryConfig {
      const cfg = (value ?? {}) as Record<string, unknown>
      if (typeof cfg !== "object" || Array.isArray(cfg)) {
        throw new Error("memory-rembr config must be an object")
      }
      for (const key of Object.keys(cfg)) {
        if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
          throw new Error(`memory-rembr config: unknown key "${key}"`)
        }
      }

      const rawUrl = typeof cfg.url === "string" && cfg.url.trim() ? cfg.url.trim() : DEFAULT_URL
      const url = expandEnv(rawUrl, env)

      let apiKey: string | undefined
      if (cfg.apiKey !== undefined) {
        if (typeof cfg.apiKey !== "string") throw new Error("apiKey must be a string")
        apiKey = expandEnv(cfg.apiKey, env)
        // unresolved ${VAR} → treat as unset rather than sending a literal placeholder
        if (/^\$\{[A-Z0-9_]+\}$/i.test(apiKey)) apiKey = undefined
      }
      apiKey = apiKey || env.REMBR_API_KEY || undefined

      let customTriggers: string[] | undefined
      if (cfg.customTriggers !== undefined) {
        if (
          !Array.isArray(cfg.customTriggers) ||
          cfg.customTriggers.some((t) => typeof t !== "string" || !t.trim())
        ) {
          throw new Error("customTriggers must be an array of non-empty strings")
        }
        customTriggers = (cfg.customTriggers as string[]).map((t) => t.toLowerCase())
      }

      let defaultCategory: RembrCategory = "context"
      if (cfg.defaultCategory !== undefined) {
        if (typeof cfg.defaultCategory !== "string") throw new Error("defaultCategory must be a string")
        const normalized = normalizeCategory(cfg.defaultCategory, "context")
        if (
          !(REMBR_CATEGORIES as readonly string[]).includes(cfg.defaultCategory) &&
          !(cfg.defaultCategory in CATEGORY_ALIASES)
        ) {
          throw new Error(
            `defaultCategory must be one of: ${REMBR_CATEGORIES.join(", ")} (or an alias: ${Object.keys(CATEGORY_ALIASES).join(", ")})`,
          )
        }
        defaultCategory = normalized
      }

      return {
        url,
        apiKey,
        autoRecall: readBoolean(cfg.autoRecall, "autoRecall", true),
        autoCapture: readBoolean(cfg.autoCapture, "autoCapture", true),
        recallLimit: readBoundedNumber(cfg.recallLimit, "recallLimit", DEFAULT_RECALL_LIMIT, 1, 50),
        minSimilarity: readBoundedNumber(cfg.minSimilarity, "minSimilarity", DEFAULT_MIN_SIMILARITY, 0, 1),
        recallMaxChars: readBoundedNumber(
          cfg.recallMaxChars,
          "recallMaxChars",
          DEFAULT_RECALL_MAX_CHARS,
          100,
          10_000,
        ),
        captureMaxChars: readBoundedNumber(
          cfg.captureMaxChars,
          "captureMaxChars",
          DEFAULT_CAPTURE_MAX_CHARS,
          100,
          10_000,
        ),
        customTriggers,
        defaultCategory,
        timeoutMs: readBoundedNumber(cfg.timeoutMs, "timeoutMs", DEFAULT_TIMEOUT_MS, 1_000, 120_000),
      }
    },
  }
}

export const rembrConfigSchema = createRembrConfigSchema()
