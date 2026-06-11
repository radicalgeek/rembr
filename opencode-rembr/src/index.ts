import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadConfig, MEMORY_CATEGORIES, type RembrConfig } from "./config.js"
import { RembrClient } from "./rembr-client.js"

export { loadConfig, MEMORY_CATEGORIES } from "./config.js"
export type { RembrConfig } from "./config.js"
export { RembrClient, RembrError } from "./rembr-client.js"

const SERVICE = "opencode-rembr"
const NOT_CONFIGURED =
  "Rembr is not configured. Set the REMBR_API_KEY environment variable (and REMBR_URL " +
  "for self-hosted servers), or pass options via opencode.json: " +
  '"plugin": [["opencode-rembr", { "apiKey": "...", "url": "..." }]]'

/** Truncate to a budget without splitting surrogate pairs mid-way. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

export const RembrPlugin: Plugin = async ({ client, directory, worktree }, options) => {
  const config: RembrConfig = loadConfig({
    options: options as Record<string, unknown> | undefined,
    worktree,
  })

  const rembr = config.apiKey
    ? new RembrClient({ url: config.url, apiKey: config.apiKey, timeoutMs: config.timeoutMs })
    : null

  const log = async (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => {
    try {
      await client.app.log({ body: { service: SERVICE, level, message, extra } })
    } catch {
      // logging must never break the agent loop
    }
  }

  if (!rembr) {
    void log("warn", "no API key found; Rembr memory is disabled", { url: config.url })
  } else {
    void rembr.health().then((ok) => {
      if (ok) return log("info", "connected to Rembr", { url: config.url })
      return log("warn", "Rembr health check failed; memory operations may not work", { url: config.url })
    })
  }

  /** Sessions that already had memories injected into their first message. */
  const injected = new Set<string>()
  /** Last auto-captured summary per session, to avoid storing duplicates on repeated idles. */
  const captured = new Map<string, string>()

  /** Build a short summary of the session for auto-capture. */
  const summarizeSession = async (sessionID: string): Promise<string | undefined> => {
    const session = (await client.session.get({ path: { id: sessionID } }))?.data as
      | { title?: string }
      | undefined
    const title = session?.title?.trim()
    if (!title) return undefined

    let lastAssistant = ""
    try {
      const messages = (await client.session.messages({ path: { id: sessionID } }))?.data as
        | Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }>
        | undefined
      const assistant = [...(messages ?? [])].reverse().find((m) => m.info?.role === "assistant")
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

  return {
    tool: {
      rembr_remember: tool({
        description:
          "Store a memory in Rembr so it persists across sessions and projects. Use for " +
          "decisions, user preferences, learnings, and project facts worth keeping long-term.",
        args: {
          content: tool.schema.string().describe("The content to remember"),
          category: tool.schema
            .enum(MEMORY_CATEGORIES)
            .optional()
            .describe("Category for organizing memories (defaults to 'facts')"),
        },
        async execute(args) {
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
      }),

      rembr_recall: tool({
        description:
          "Search Rembr long-term memory (hybrid text + semantic search) for relevant " +
          "memories from past sessions. Use before re-deriving decisions or preferences.",
        args: {
          query: tool.schema.string().describe("What to search for"),
          limit: tool.schema.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
        },
        async execute(args) {
          if (!rembr) return NOT_CONFIGURED
          try {
            const result = await rembr.recall(args.query, {
              limit: args.limit ?? config.maxRecall,
              minSimilarity: config.minSimilarity,
            })
            return result || "No matching memories found."
          } catch (error) {
            return `Failed to search memories: ${error instanceof Error ? error.message : String(error)}`
          }
        },
      }),

      rembr_forget: tool({
        description: "Delete a memory from Rembr by its ID (IDs appear in rembr_recall results).",
        args: {
          id: tool.schema.string().describe("The memory ID to delete"),
        },
        async execute(args) {
          if (!rembr) return NOT_CONFIGURED
          try {
            const result = await rembr.forget(args.id)
            return result || "Memory deleted."
          } catch (error) {
            return `Failed to delete memory: ${error instanceof Error ? error.message : String(error)}`
          }
        },
      }),
    },

    // Recall injection: on the first user message of a session, search Rembr with the
    // prompt text and append the matches as an extra context part (Mem0/Supermemory pattern).
    "chat.message": async (input, output) => {
      if (!rembr || config.maxRecall <= 0) return
      const sessionID = input.sessionID ?? output.message?.sessionID
      if (!sessionID || injected.has(sessionID)) return
      injected.add(sessionID)

      const prompt = (output.parts ?? [])
        .filter((part) => part.type === "text" && typeof (part as { text?: unknown }).text === "string")
        .map((part) => (part as { text: string }).text)
        .join("\n")
        .trim()
      if (!prompt) return

      try {
        const memories = await rembr.recall(clip(prompt, 2000), {
          limit: config.maxRecall,
          minSimilarity: config.minSimilarity,
        })
        if (!memories) return
        output.parts.push({
          id: `rembr-${sessionID}`,
          sessionID,
          messageID: output.message.id,
          type: "text",
          synthetic: true,
          text:
            "<rembr-memories>\nRelevant long-term memories from previous sessions " +
            `(via Rembr):\n${memories}\n</rembr-memories>`,
        } as (typeof output.parts)[number])
        void log("debug", "injected memories into session start", { sessionID })
      } catch (error) {
        void log("warn", "memory recall failed; continuing without injection", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },

    // Auto-capture: when a session goes idle, persist its title + last assistant
    // message as a "conversations" memory. Deduped per session per summary.
    event: async ({ event }) => {
      if (!rembr || !config.autoRemember) return
      if (event.type !== "session.idle") return
      const sessionID = (event as { properties?: { sessionID?: string } }).properties?.sessionID
      if (!sessionID) return

      try {
        const summary = await summarizeSession(sessionID)
        if (!summary || captured.get(sessionID) === summary) return
        captured.set(sessionID, summary)
        await rembr.remember(summary, config.captureCategory, {
          source: SERVICE,
          sessionID,
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
  }
}
