import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadConfig, MEMORY_CATEGORIES, type RembrConfig } from "./config.js"
import { RembrClient } from "./rembr-client.js"
import {
  buildDigest,
  extractLines,
  loadDistillConfig,
  logLine,
  looksLikeSecret,
  parseDistillerOutput,
  parseModelRef,
  readCursor,
  writeCursor,
  OBSERVER_PROMPT,
  type SessionMessage,
} from "./distill.js"

export { loadConfig, MEMORY_CATEGORIES } from "./config.js"
export type { RembrConfig } from "./config.js"
export { RembrClient, RembrError } from "./rembr-client.js"

const SERVICE = "opencode-rembr"

function countRecalledMemories(memories: string): number {
  try {
    const parsed = JSON.parse(memories) as { data?: unknown; memories?: unknown; results?: unknown }
    for (const value of [parsed.data, parsed.memories, parsed.results]) {
      if (Array.isArray(value)) return value.length
    }
  } catch {
    // Older Rembr endpoints can return a Markdown result rather than JSON.
  }

  const markdownMatches = memories.match(/^\s*[-*]\s+\[/gm)
  return markdownMatches?.length ?? 1
}

type RecallEntry = {
  id?: unknown
  content?: unknown
  category?: unknown
  created_at?: unknown
  score?: unknown
  semantic_similarity?: unknown
  text_match?: unknown
  metadata?: { directory?: unknown; sessionID?: unknown; session_id?: unknown; source_created_at?: unknown; superseded_by_migration_id?: unknown }
}

function parseRecallEntries(memories: string): RecallEntry[] | undefined {
  try {
    const parsed = JSON.parse(memories) as { data?: unknown; memories?: unknown; results?: unknown }
    return [parsed.data, parsed.memories, parsed.results].find(Array.isArray) as RecallEntry[] | undefined
  } catch {
    return undefined
  }
}

function semanticRecallFailure(memories: string): string | undefined {
  try {
    const parsed = JSON.parse(memories) as { semantic_status?: unknown; semantic_error?: unknown }
    if (parsed.semantic_status !== "failed" && parsed.semantic_status !== "unavailable") return undefined
    return typeof parsed.semantic_error === "string" ? parsed.semantic_error : String(parsed.semantic_status)
  } catch {
    return undefined
  }
}

function formatMemory(entry: RecallEntry, maxContent: number): string {
  const category = typeof entry.category === "string" ? entry.category : "memory"
  const id = typeof entry.id === "string" ? entry.id.slice(0, 8) : "unknown"
  const content = (entry.content as string).replace(/\s+/g, " ").trim()
  return `- [${category} | ${id}] ${clip(content, maxContent)}`
}

const SEARCH_STOP_WORDS = new Set([
  "about", "after", "again", "all", "also", "and", "are", "but", "can", "could", "for",
  "does", "explain", "find", "from", "have", "how", "into", "its", "just", "let", "message", "more", "my", "not",
  "an", "as", "at", "be", "by", "do", "if", "in", "is", "it", "me", "no", "of", "ok", "okay", "on", "or", "our", "please", "see", "should", "so", "that", "the", "their", "this", "up", "us", "we",
  "only", "project", "reply", "test", "through", "to", "was", "what", "when", "where", "which", "will", "with", "work", "would", "your",
])

function searchTerms(text: string): Set<string> {
  const terms = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(terms.map((term) => {
    if (term.length > 5 && term.endsWith("ies")) return `${term.slice(0, -3)}y`
    if (term.length > 5 && term.endsWith("ing")) return term.slice(0, -3)
    if (term.length > 4 && term.endsWith("ed")) return term.slice(0, -2)
    if (term.length > 4 && term.endsWith("s")) return term.slice(0, -1)
    return term
  }).filter((term) => term.length > 2 && !SEARCH_STOP_WORDS.has(term)))
}

function focusedRecallQuery(prompt: string): string {
  const tail = recallQuery(prompt).match(
    /\b(?:about|regarding|concerning|where\s+(?:we\s+)?(?:stopped|left off)\s+(?:with|on))\s+(.+)$/i,
  )?.[1]
  if (!tail) return ""
  const subject = tail.split(/[?!.,](?:\s|$)/, 1)[0].trim()
  const terms = subject.match(/[\p{L}\p{N}]+/gu)?.filter(
    (term) => term.length > 1 && !SEARCH_STOP_WORDS.has(term.toLowerCase()),
  ) ?? []
  if (terms.length < 2) return ""
  return terms.length <= 8 ? subject : terms.slice(0, 4).join(" ")
}

function mergeRecallResults(primary: string, focused: string): string {
  if (!focused.trim()) return primary
  if (!primary.trim()) return focused
  try {
    const parsedPrimary = JSON.parse(primary) as Record<string, unknown>
    const parsedFocused = JSON.parse(focused) as Record<string, unknown>
    const primaryKey = ["data", "memories", "results"].find((key) => Array.isArray(parsedPrimary[key]))
    const focusedEntries = [parsedFocused.data, parsedFocused.memories, parsedFocused.results]
      .find(Array.isArray) as RecallEntry[] | undefined
    if (!primaryKey || !focusedEntries) return primary
    const seen = new Set<unknown>()
    const entries = focusedEntries.some((entry) => entry.text_match === true)
      ? focusedEntries
      : [...focusedEntries, ...(parsedPrimary[primaryKey] as RecallEntry[])]
    parsedPrimary[primaryKey] = entries
      .filter((entry) => {
        const key = typeof entry.id === "string" ? entry.id : entry.content
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
    return JSON.stringify(parsedPrimary)
  } catch {
    return primary
  }
}

function termOverlap(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0
  let intersection = 0
  for (const term of left) if (right.has(term)) intersection++
  return intersection / new Set([...left, ...right]).size
}

function sharedTermCount(left: Set<string>, right: Set<string>): number {
  let count = 0
  for (const term of left) if (right.has(term)) count++
  return count
}

function parseTimestamp(value: unknown): number {
  const ts = typeof value === "string" ? Date.parse(value) : 0
  return Number.isFinite(ts) ? ts : 0
}

function createdAt(entry: RecallEntry): number {
  const candidate = parseTimestamp(entry.metadata?.source_created_at)
  return candidate > 0 ? candidate : parseTimestamp(entry.created_at)
}

function sessionId(entry: RecallEntry): unknown {
  return entry.metadata?.sessionID ?? entry.metadata?.session_id
}

function selectDiverseMemories(entries: RecallEntry[], limit: number): RecallEntry[] {
  const selected: RecallEntry[] = []
  const terms = new Map(entries.map((entry) => [entry, searchTerms(entry.content as string)]))
  for (const entry of entries) {
    const duplicate = selected.some((chosen) => termOverlap(terms.get(entry)!, terms.get(chosen)!) >= 0.3)
    if (!duplicate) selected.push(entry)
    if (selected.length === limit) break
  }
  return selected
}

function selectRelevantMemories(
  memories: string,
  query: string,
  directory: string | undefined,
  maxRecall: number,
  minSimilarity: number,
  resultCap = 5,
): RecallEntry[] | undefined {
  const entries = parseRecallEntries(memories)
  if (!entries) return undefined

  const candidates = entries.filter((entry) =>
    typeof entry.content === "string" && !entry.metadata?.superseded_by_migration_id,
  )
  if (!candidates.length) return []
  const bestSimilarity = Math.max(
    ...candidates.map((entry) =>
      typeof entry.semantic_similarity === "number" ? entry.semantic_similarity : Number.NEGATIVE_INFINITY,
    ),
  )
  const similarityFloor = Number.isFinite(bestSimilarity)
    ? Math.max(minSimilarity, bestSimilarity - 0.08)
    : minSimilarity
  const queryTerms = searchTerms(query)
  const contentTerms = new Map(candidates.map((entry) => [entry, searchTerms(entry.content as string)]))
  const similarities = candidates
    .filter((entry) => typeof entry.semantic_similarity === "number")
    .sort((left, right) => (right.semantic_similarity as number) - (left.semantic_similarity as number))
  const secondSimilarity = similarities.length > 1 ? similarities[1].semantic_similarity as number : undefined
  const requiredTermMatches = Math.min(2, queryTerms.size)
  const remaining = candidates.filter((entry) => {
    if (typeof entry.semantic_similarity !== "number") return true
    if (entry.semantic_similarity < similarityFloor) return false
    const matchedTerms = sharedTermCount(queryTerms, contentTerms.get(entry)!)
    const topicalMatch = requiredTermMatches > 0 && matchedTerms >= requiredTermMatches
    const supportedTopicalMatch = matchedTerms > 0 && entry.semantic_similarity >= 0.5
    const strongSemanticMatch = entry.semantic_similarity >= 0.55
    const isolatedSemanticMatch = entry === similarities[0] && secondSimilarity !== undefined &&
      entry.semantic_similarity - secondSimilarity >= 0.08
    return topicalMatch || supportedTopicalMatch || strongSemanticMatch || isolatedSemanticMatch
  })
  const now = Date.now()
  const rank = (entry: RecallEntry) => {
    const content = (entry.content as string).toLowerCase()
    const ageDays = createdAt(entry) ? Math.max(0, (now - createdAt(entry)) / 86_400_000) : 365
    const freshness = 0.05 / (1 + ageDays / 14)
    const clientAffinity = content.includes("opencode")
      ? 0.06
      : /\b(?:codex|claude-code|claude code|openclaw)\b/.test(content) ? -0.05 : 0
    const olderOverlappingDecision = entry.category === "decisions" && remaining.some((other) =>
      other !== entry &&
      other.category === "decisions" &&
      createdAt(other) > createdAt(entry) &&
      termOverlap(contentTerms.get(entry)!, contentTerms.get(other)!) >= 0.22
    )

    return (typeof entry.semantic_similarity === "number" ? entry.semantic_similarity : 0) +
      (entry.text_match === true ? 0.15 : 0) +
      (directory && entry.metadata?.directory === directory ? 0.04 : 0) +
      termOverlap(queryTerms, contentTerms.get(entry)!) * 0.12 +
      freshness +
      clientAffinity -
      (olderOverlappingDecision ? 0.15 : 0)
  }
  const rankScores = new Map(remaining.map((entry) => [entry, rank(entry)]))
  const ranked: RecallEntry[] = []
  while (remaining.length) {
    remaining.sort((left, right) => {
      const diversityPenalty = (entry: RecallEntry) => ranked.length
        ? Math.max(...ranked.map((chosen) => termOverlap(contentTerms.get(entry)!, contentTerms.get(chosen)!))) * 0.1
        : 0
      return (rankScores.get(right)! - diversityPenalty(right)) - (rankScores.get(left)! - diversityPenalty(left))
    })
    ranked.push(remaining.shift()!)
  }

  return selectDiverseMemories(ranked, Math.min(maxRecall, resultCap))
}

function compactRelevantMemories(
  memories: string,
  query: string,
  directory: string | undefined,
  maxRecall: number,
  minSimilarity: number,
): string {
  const selected = selectRelevantMemories(memories, query, directory, maxRecall, minSimilarity)
  if (!selected) return memories
  return selected.map((entry) => formatMemory(entry, 500)).join("\n")
}

function curateRelevantMemoryResult(
  memories: string,
  query: string,
  directory: string | undefined,
  maxRecall: number,
  minSimilarity: number,
): string {
  const selected = selectRelevantMemories(memories, query, directory, maxRecall, minSimilarity, maxRecall)
  if (!selected) return memories
  const parsed = JSON.parse(memories) as Record<string, unknown>
  const resultKey = ["data", "memories", "results"].find((key) => Array.isArray(parsed[key]))
  if (!resultKey) return memories
  parsed[resultKey] = selected
  if (parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata)) {
    parsed.metadata = { ...parsed.metadata as Record<string, unknown>, returned: selected.length }
  }
  return JSON.stringify(parsed, null, 2)
}

function compactRecentMemories(memories: string, directory?: string, newestFirst = false): string {
  try {
    const entries = parseRecallEntries(memories)
    if (!entries?.length) return ""
    const categoryPriority = ["reminders", "decisions", "goals", "workflows", "projects"]
    const workspaceEntries = directory
      ? entries.filter((entry) => entry.metadata?.directory === directory)
      : entries
    const candidates = workspaceEntries.filter((entry) =>
      typeof entry.content === "string" && !entry.metadata?.superseded_by_migration_id,
    )
    const latestSession = newestFirst
      ? [...candidates]
          .filter((entry) => typeof sessionId(entry) === "string")
          .sort((left, right) => createdAt(right) - createdAt(left))[0]
      : undefined
    const latestSessionId = latestSession ? sessionId(latestSession) : undefined
    const sessionCandidates = latestSessionId
      ? candidates.filter((entry) => sessionId(entry) === latestSessionId)
      : candidates
    const ranked = sessionCandidates
      .sort((left, right) => {
        if (newestFirst) {
          return createdAt(right) - createdAt(left)
        }
        const leftPriority = categoryPriority.indexOf(typeof left.category === "string" ? left.category : "")
        const rightPriority = categoryPriority.indexOf(typeof right.category === "string" ? right.category : "")
        return (leftPriority === -1 ? categoryPriority.length : leftPriority) -
          (rightPriority === -1 ? categoryPriority.length : rightPriority)
      })
    const selected = selectDiverseMemories(ranked, 5)
    return selected.map((entry) => formatMemory(entry, 500)).join("\n")
  } catch {
    return ""
  }
}

function isContinuityPrompt(prompt: string): boolean {
  return [
    /\b(?:current|latest|recent)\s+(?:status|progress|update)\b/i,
    /\bwhat\s+(?:we(?:'ve| have)?|was|has been)\s+(?:done|completed|working on)\b/i,
    /\bwhere\s+(?:are|were)\s+we\b/i,
    /\b(?:continue|resume|pick up)\s+(?:our\s+)?(?:work|where we left off|from last time)\b/i,
    /\b(?:restarted|reopened)\s+(?:open\s*code|opencode|the\s+(?:app(?:lication)?|client|session))\b/i,
    /\b(?:new|fresh)\s+(?:(?:open\s*code|opencode)\s+)?session\b/i,
  ].some((pattern) => pattern.test(prompt))
}

function isUnderspecifiedPrompt(prompt: string): boolean {
  // A new session's conversational opener carries too little task information
  // for semantic retrieval; continuity is more useful than arbitrary matches.
  return searchTerms(recallQuery(prompt)).size <= 2
}

function recallQuery(prompt: string): string {
  return prompt.replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim()
}

function previewMemories(memories: string): string {
  try {
    const parsed = JSON.parse(memories) as { data?: unknown; memories?: unknown; results?: unknown }
    const entries = [parsed.data, parsed.memories, parsed.results].find(Array.isArray) as
      | Array<{ id?: unknown; content?: unknown; category?: unknown }>
      | undefined
    if (!entries?.length) return ""
    return entries
      .filter((entry) => typeof entry.content === "string")
      .map((entry) => {
        const category = typeof entry.category === "string" ? entry.category : "memory"
        const id = typeof entry.id === "string" ? entry.id.slice(0, 8) : "unknown"
        return `- [${category} | ${id}] ${clip(entry.content as string, 180)}`
      })
      .join("\n")
  } catch {
    return memories
      .split("\n")
      .filter((line) => /^\s*[-*]\s+\[/.test(line))
      .map((line) => clip(line, 220))
      .join("\n")
  }
}
const NOT_CONFIGURED =
  "Rembr is not configured. Set the REMBR_API_KEY environment variable (and REMBR_URL " +
  "for self-hosted servers), or pass options via opencode.json: " +
  '"plugin": [["opencode-rembr", { "apiKey": "...", "url": "..." }]]'

/** Truncate to a budget without splitting surrogate pairs mid-way. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

type LogLevel = "debug" | "info" | "warn" | "error"

/** Model reference parsed from `distillModel` ("provider/model"). */
export type DistillModel = NonNullable<ReturnType<typeof parseModelRef>>

/**
 * What the shared plugin logic needs from an OpenCode host. The v1 plugin
 * implements it with the v1 SDK client, the v2 plugin with the v2 context.
 */
export interface RembrHost {
  directory?: string
  worktree?: string
  options?: Record<string, unknown>
  /** Must never throw. */
  log: (level: LogLevel, message: string, extra?: Record<string, unknown>) => Promise<void>
  sessionTitle: (sessionID: string) => Promise<string | undefined>
  /** Session messages in order, in the v1 message shape. */
  sessionMessages: (sessionID: string) => Promise<SessionMessage[]>
  /** Run the distiller prompt on a model and return the reply text. */
  generate: (prompt: string, model: DistillModel | undefined, timeoutMs: number) => Promise<string>
  /** Sessions the host created for itself; never inject into or distill them. */
  isInternalSession?: (sessionID: string) => boolean
  /** Cursor file namespace; hosts with different cursor semantics must differ. */
  cursorNamespace?: string
}

export const TOOL_DESCRIPTIONS = {
  rembr_remember:
    "Store a memory in Rembr so it persists across sessions and projects. Use for " +
    "decisions, user preferences, learnings, and project facts worth keeping long-term.",
  rembr_recall:
    "Search Rembr long-term memory (hybrid text + semantic search) for relevant " +
    "memories from past sessions. Use before re-deriving decisions or preferences.",
  rembr_forget: "Delete a memory from Rembr by its ID (IDs appear in rembr_recall results).",
} as const

export interface RecallInjection {
  /** User-visible status line with a short preview. */
  status: string
  /** Model-visible context block. */
  context: string
}

/** Host-independent plugin state and behaviour shared by the v1 and v2 entry points. */
export function createRembrCore(host: RembrHost) {
  const { directory, worktree, options, log } = host
  const config: RembrConfig = loadConfig({ options, worktree })

  const rembr = config.apiKey
    ? new RembrClient({ url: config.url, apiKey: config.apiKey, timeoutMs: config.timeoutMs })
    : null

  if (!rembr) {
    void log("warn", "no API key found; Rembr memory is disabled", { url: config.url })
  } else {
    void rembr.health().then((ok) => {
      if (ok) return log("info", "connected to Rembr", { url: config.url })
      return log("warn", "Rembr health check failed; memory operations may not work", { url: config.url })
    })
  }

  const distillModel = typeof options?.distillModel === "string" ? options.distillModel : ""
  const distillConfig = loadDistillConfig(process.env, distillModel)
  const cursorNamespace = host.cursorNamespace ?? "opencode"
  // Directory-level exclusion and the recursion kill-switch apply to the whole
  // plugin instance: no capture, no distillation.
  const captureDisabled =
    !!process.env.REMBR_CAPTURE_DISABLE ||
    distillConfig.excludeDirs.some((marker) => (worktree || directory || "").includes(marker))

  /** Sessions that already had memories injected into their first message. */
  const injected = new Set<string>()
  /** Last auto-captured summary per session, to avoid storing duplicates on repeated idles. */
  const captured = new Map<string, string>()
  /** Sessions with a distillation pass in flight. */
  const distilling = new Set<string>()
  const isInternal = (sessionID: string) => distilling.has(sessionID) || !!host.isInternalSession?.(sessionID)

  /** Build a short summary of the session for auto-capture. */
  const summarizeSession = async (sessionID: string): Promise<string | undefined> => {
    const title = (await host.sessionTitle(sessionID))?.trim()
    if (!title) return undefined

    let lastAssistant = ""
    try {
      const messages = await host.sessionMessages(sessionID)
      const assistant = [...messages].reverse().find((m) => m.info?.role === "assistant")
      lastAssistant = (assistant?.parts ?? [])
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
        .trim()
    } catch {
      // title-only capture is still useful
    }

    return lastAssistant
      ? `OpenCode session "${title}"\n\nOutcome:\n${clip(lastAssistant, 1500)}`
      : `OpenCode session "${title}"`
  }

  /**
   * LLM distillation pass for an idle session: digest the messages added
   * since the cursor, ask the host's model to extract durable memories,
   * store them in Rembr. Fail-silent; the cursor advances only after a fully
   * successful pass.
   */
  const runDistillSession = async (sessionID: string): Promise<void> => {
    if (!rembr) return

    const messages = await host.sessionMessages(sessionID)
    const cursorOf = (message: SessionMessage, index: number) => message.cursor ?? index + 1
    const cursor = readCursor(distillConfig, sessionID, cursorNamespace)
    const fresh = messages.filter((message, index) => cursorOf(message, index) > cursor)
    if (!fresh.length) return
    const nextCursor = Math.max(...messages.map(cursorOf))
    // Debounce: distilling tiny increments produces distorted memories. Below
    // the threshold the cursor stays put, so the messages join the next pass.
    if (fresh.length < distillConfig.minNewMessages) {
      logLine(distillConfig, `debounce: ${fresh.length} new messages < ${distillConfig.minNewMessages}, session ${sessionID}`)
      return
    }
    const lines = extractLines(fresh)
    if (!lines.length) {
      logLine(distillConfig, `no distillable content in ${fresh.length} new messages, session ${sessionID}`)
      return
    }

    let reply: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      reply = await Promise.race([
        host.generate(OBSERVER_PROMPT + buildDigest(lines), parseModelRef(distillConfig.model), distillConfig.timeoutMs),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`distiller timed out after ${distillConfig.timeoutMs}ms`)),
            distillConfig.timeoutMs,
          )
        }),
      ])
    } catch (error) {
      logLine(distillConfig, `distiller failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    } finally {
      if (timer) clearTimeout(timer)
    }

    const memories = parseDistillerOutput(reply)
    if (memories === null) {
      logLine(distillConfig, `distiller result unusable: ${String(reply).slice(0, 200)}`)
      return
    }

    let failed = false
    for (const memory of memories) {
      if (looksLikeSecret(memory.content)) {
        logLine(distillConfig, `skipped-secret-shape: ${memory.content.slice(0, 80)}`)
        continue
      }
      try {
        await rembr.remember(memory.content, memory.category as (typeof MEMORY_CATEGORIES)[number], {
          source: SERVICE,
          distilled: true,
          session_id: sessionID,
          directory,
          tags: memory.tags ?? [],
        })
        logLine(distillConfig, `stored: ${memory.content.slice(0, 120)}`)
      } catch (error) {
        failed = true
        logLine(distillConfig, `store failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (failed) {
      logLine(distillConfig, `partial failure, cursor kept at ${cursor}, session ${sessionID}`)
      return
    }
    if (!memories.length) logLine(distillConfig, `nothing durable this pass, session ${sessionID}`)
    if (writeCursor(distillConfig, sessionID, nextCursor, cursorNamespace)) {
      logLine(distillConfig, `cursor ${cursor} -> ${nextCursor}, session ${sessionID}`)
    }
  }

  const distillSession = async (sessionID: string): Promise<void> => {
    if (isInternal(sessionID)) return
    distilling.add(sessionID)
    try {
      await runDistillSession(sessionID)
    } finally {
      distilling.delete(sessionID)
    }
  }

  return {
    config,

    /** The remote MCP server to register, or undefined when disabled. */
    mcpServer: () =>
      rembr && config.registerMcp
        ? { url: config.url, headers: { "x-api-key": config.apiKey! }, timeoutMs: config.timeoutMs }
        : undefined,

    tools: {
      async rembr_remember(args: { content: string; category?: (typeof MEMORY_CATEGORIES)[number] }) {
        if (!rembr) return NOT_CONFIGURED
        try {
          const result = await rembr.remember(args.content, args.category ?? "facts", {
            source: SERVICE,
            directory,
          })
          return result || "Memory stored."
        } catch (error) {
          return `Failed to store memory: ${error instanceof Error ? error.message : String(error)}`
        }
      },

      async rembr_recall(args: { query: string; limit?: number }) {
        if (!rembr) return NOT_CONFIGURED
        try {
          const limit = args.limit ?? config.maxRecall
          const query = recallQuery(args.query)
          const candidateLimit = Math.min(limit * 2, 50)
          const focusedQuery = focusedRecallQuery(args.query)
          const [result, focusedResult] = await Promise.all([
            rembr.recall(clip(query, 2000), {
              limit: candidateLimit,
              minSimilarity: config.minSimilarity,
            }),
            focusedQuery
              ? rembr.recall(focusedQuery, { limit: candidateLimit, minSimilarity: config.minSimilarity })
              : Promise.resolve(""),
          ])
          const merged = mergeRecallResults(result, focusedResult)
          const curated = merged
            ? curateRelevantMemoryResult(merged, focusedQuery || query, directory, limit, config.minSimilarity)
            : ""
          return curated || "No matching memories found."
        } catch (error) {
          return `Failed to search memories: ${error instanceof Error ? error.message : String(error)}`
        }
      },

      async rembr_forget(args: { id: string }) {
        if (!rembr) return NOT_CONFIGURED
        try {
          const result = await rembr.forget(args.id)
          return result || "Memory deleted."
        } catch (error) {
          return `Failed to delete memory: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    },

    /**
     * Recall injection for the first user message of a session: search Rembr
     * with the prompt text and return the matches to inject (Mem0/Supermemory
     * pattern). Returns undefined when nothing should be injected.
     */
    async recallForPrompt(sessionID: string, prompt: string): Promise<RecallInjection | undefined> {
      if (!rembr || config.maxRecall <= 0) return
      if (injected.has(sessionID) || isInternal(sessionID)) return
      injected.add(sessionID)

      prompt = prompt.trim()
      if (!prompt) {
        injected.delete(sessionID)
        return
      }

      try {
        const continuityPrompt = isContinuityPrompt(prompt) || isUnderspecifiedPrompt(prompt)
        let recentFallback = continuityPrompt
          ? compactRecentMemories(await rembr.recent(50, "source_created_at"), directory, true)
          : ""
        const query = recallQuery(prompt)
        const candidateLimit = Math.min(config.maxRecall * 2, 50)
        const focusedQuery = focusedRecallQuery(prompt)
        const [primaryRecall, focusedRecall] = !recentFallback && query
          ? await Promise.all([
              rembr.recall(clip(query, 2000), {
                limit: candidateLimit,
                minSimilarity: config.minSimilarity,
              }),
              focusedQuery
                ? rembr.recall(focusedQuery, { limit: candidateLimit, minSimilarity: config.minSimilarity })
                : Promise.resolve(""),
            ])
          : ["", ""]
        const recalled = mergeRecallResults(primaryRecall, focusedRecall)
        const memories = recalled
          ? compactRelevantMemories(recalled, focusedQuery || query, directory, config.maxRecall, config.minSimilarity)
          : ""
        const memoryCount = memories ? countRecalledMemories(memories) : 0
        if (!memoryCount && !recentFallback) {
          const semanticError = semanticRecallFailure(recalled)
          if (semanticError) {
            void log("warn", "semantic memory recall unavailable; skipped unrelated recent fallback", {
              sessionID,
              error: semanticError,
            })
          }
          return
        }
        const preview = recentFallback || previewMemories(memories)
        void log("debug", "injected memories into session start", { sessionID })
        return {
          status: recentFallback
            ? `Rembr: continuity prompt; injected ${recentFallback.split("\n").length} recent context ${recentFallback.split("\n").length === 1 ? "memory" : "memories"}.\n${preview}`
            : `Rembr: injected ${memoryCount} relevant ${memoryCount === 1 ? "memory" : "memories"}.\n${preview}`,
          context: recentFallback
            ? `<rembr-recent-context>\nRecent working context from previous sessions:\n${recentFallback}\n</rembr-recent-context>`
            : `<rembr-memories>\nRelevant long-term memories from previous sessions (via Rembr):\n${memories}\n</rembr-memories>`,
        }
      } catch (error) {
        injected.delete(sessionID)
        void log("warn", "memory recall failed; continuing without injection", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },

    /**
     * Auto-capture when a session goes idle: LLM distillation when enabled
     * (REMBR_DISTILL, default true), otherwise the session title + last
     * assistant message as a "conversations" memory, deduped per session.
     */
    async onSessionIdle(sessionID: string): Promise<void> {
      if (!rembr || !config.autoRemember || captureDisabled) return

      if (distillConfig.enabled) {
        try {
          await distillSession(sessionID)
        } catch (error) {
          logLine(distillConfig, `distill pass threw: ${error instanceof Error ? error.message : String(error)}`)
        }
        return
      }

      try {
        const summary = await summarizeSession(sessionID)
        if (!summary || captured.get(sessionID) === summary) return
        captured.set(sessionID, summary)
        await rembr.remember(summary, config.captureCategory, {
          source: SERVICE,
          session_id: sessionID,
          directory,
          capturedAt: new Date().toISOString(),
        })
        void log("debug", "auto-captured session summary", { sessionID })
      } catch (error) {
        void log("warn", "session auto-capture failed", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },

    /** Drop per-session state for a deleted session. */
    forgetSession(sessionID: string): void {
      injected.delete(sessionID)
      captured.delete(sessionID)
    },
  }
}

export type RembrCore = ReturnType<typeof createRembrCore>

/** OpenCode v1 plugin function (`@opencode-ai/plugin`). */
export const RembrPlugin: Plugin = async ({ client, directory, worktree }, options) => {
  /** Side sessions created as distillers; never inject into or distill them. */
  const sideSessions = new Set<string>()

  const core = createRembrCore({
    directory,
    worktree,
    options: options as Record<string, unknown> | undefined,
    log: async (level, message, extra) => {
      try {
        await client.app.log({ body: { service: SERVICE, level, message, extra } })
      } catch {
        // logging must never break the agent loop
      }
    },
    sessionTitle: async (sessionID) =>
      ((await client.session.get({ path: { id: sessionID } }))?.data as { title?: string } | undefined)?.title,
    sessionMessages: async (sessionID) =>
      ((await client.session.messages({ path: { id: sessionID } }))?.data ?? []) as SessionMessage[],
    isInternalSession: (sessionID) => sideSessions.has(sessionID),
    // v1 has no stateless generation API: prompt a throwaway side session on
    // the SAME opencode server and delete it afterwards.
    generate: async (prompt, modelRef, timeoutMs) => {
      const side = (await client.session.create({ body: { title: "rembr-distill (auto)" } }))?.data as
        | { id?: string }
        | undefined
      if (!side?.id) throw new Error("side session create failed")
      const sideID = side.id
      sideSessions.add(sideID)

      try {
        const textFromParts = (parts: Array<{ type?: string; text?: string }> | undefined) =>
          (parts ?? [])
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n")
        const deadline = Date.now() + timeoutMs

        const response = (await client.session.prompt({
          path: { id: sideID },
          body: {
            ...(modelRef ? { model: modelRef } : {}),
            parts: [{ type: "text", text: prompt }],
          },
        })) as {
          data?: {
            info?: { role?: string }
            parts?: Array<{ type?: string; text?: string }>
          }
        }
        if (response?.data?.info?.role === "assistant") return textFromParts(response.data.parts)

        // OpenCode 1.17 can return the created user message immediately when
        // prompting from a session.idle hook. Keep the hook alive and poll the
        // side session until its assistant response is complete.
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250))
          const sideMessages = ((await client.session.messages({ path: { id: sideID } }))?.data ?? []) as Array<{
            info?: { role?: string; time?: { completed?: number } }
            parts?: Array<{ type?: string; text?: string }>
          }>
          const assistant = [...sideMessages]
            .reverse()
            .find((message) => message.info?.role === "assistant" && message.info.time?.completed)
          if (assistant) return textFromParts(assistant.parts)
        }
        throw new Error(`distiller timed out after ${timeoutMs}ms`)
      } finally {
        try {
          await client.session.delete({ path: { id: sideID } })
        } catch {
          // leftover side session is cosmetic
        }
        sideSessions.delete(sideID)
      }
    },
  })

  return {
    config: async (opencodeConfig) => {
      const server = core.mcpServer()
      if (!server) return
      opencodeConfig.mcp ??= {}
      if (opencodeConfig.mcp.rembr) return
      opencodeConfig.mcp.rembr = {
        type: "remote",
        url: server.url,
        headers: server.headers,
        oauth: false,
        timeout: server.timeoutMs,
      }
    },

    tool: {
      rembr_remember: tool({
        description: TOOL_DESCRIPTIONS.rembr_remember,
        args: {
          content: tool.schema.string().describe("The content to remember"),
          category: tool.schema
            .enum(MEMORY_CATEGORIES)
            .optional()
            .describe("Category for organizing memories (defaults to 'facts')"),
        },
        execute: (args) => core.tools.rembr_remember(args),
      }),

      rembr_recall: tool({
        description: TOOL_DESCRIPTIONS.rembr_recall,
        args: {
          query: tool.schema.string().describe("What to search for"),
          limit: tool.schema.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
        },
        execute: (args) => core.tools.rembr_recall(args),
      }),

      rembr_forget: tool({
        description: TOOL_DESCRIPTIONS.rembr_forget,
        args: {
          id: tool.schema.string().describe("The memory ID to delete"),
        },
        execute: (args) => core.tools.rembr_forget(args),
      }),
    },

    // Recall injection: on the first user message of a session, append a
    // visible status part and the matches as a synthetic context part.
    "chat.message": async (input, output) => {
      const sessionID = input.sessionID ?? output.message?.sessionID
      if (!sessionID) return

      const prompt = (output.parts ?? [])
        .filter((part) => part.type === "text" && typeof (part as { text?: unknown }).text === "string")
        .map((part) => (part as { text: string }).text)
        .join("\n")
      const injection = await core.recallForPrompt(sessionID, prompt)
      if (!injection) return

      output.parts.push({
        id: `prt_rembr_status_${output.message.id}`,
        sessionID,
        messageID: output.message.id,
        type: "text",
        text: injection.status,
      } as (typeof output.parts)[number])
      output.parts.push({
        id: `prt_rembr_${output.message.id}`,
        sessionID,
        messageID: output.message.id,
        type: "text",
        synthetic: true,
        text: injection.context,
      } as (typeof output.parts)[number])
    },

    // Auto-capture / distillation when a session goes idle.
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = (event as { properties?: { sessionID?: string } }).properties?.sessionID
      if (!sessionID) return
      await core.onSessionIdle(sessionID)
    },
  }
}

export default RembrPlugin
