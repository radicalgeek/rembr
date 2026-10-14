// codex-rembr: a stdio MCP bridge exposing a curated memory tool surface
// (memory_recall / memory_store / memory_forget) backed by a Rembr server.
//
// Codex supports remote streamable-HTTP MCP servers natively, so for most
// setups you should register Rembr directly (see README). This bridge exists
// for: stdio-only MCP clients, network-restricted environments where only the
// bridge host can reach Rembr, and a curated three-tool surface consistent
// with Rembr's OpenClaw and OpenCode plugins.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { RembrClient } from "./rembr-client.js"
import { compactRelevantMemories, UNTRUSTED_PREAMBLE } from "./recall.js"
import { REMBR_CATEGORIES, type BridgeConfig } from "./bridge-config.js"
export { REMBR_CATEGORIES, loadBridgeConfig, type BridgeConfig } from "./bridge-config.js"

const INJECTION_PATTERNS = [
  /ignore (all|any|previous|prior|the) .{0,40}(instructions|context|rules)/i,
  /disregard .{0,40}(instructions|context|rules)/i,
  /you (are|must|should) now (act|behave|respond|pretend)/i,
  /new (system )?instructions\s*:/i,
  /system prompt/i,
  /<\/?(system|assistant|instructions?)>/i,
]

export function looksLikePromptInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text))
}

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] }
}

function errorText(prefix: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return { ...text(`${prefix}: ${message}`), isError: true }
}

export function createServer(config: BridgeConfig, client?: RembrClient): McpServer {
  const rembr =
    client ?? new RembrClient({ url: config.url, apiKey: config.apiKey, timeoutMs: config.timeoutMs })

  const server = new McpServer({ name: "codex-rembr", version: "0.1.1" })

  server.registerTool(
    "memory_recall",
    {
      description:
        "Search long-term memories stored in Rembr (hybrid text + semantic search). Use when " +
        "you need context about user preferences, past decisions, or previously discussed topics.",
      inputSchema: {
        query: z.string().describe("Search query"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results"),
      },
    },
    async ({ query, limit }) => {
      try {
        const stripped = query.replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim()
        const results = await rembr.recall(stripped, {
          limit: Math.min((limit ?? config.recallLimit) * 2, 50),
          minSimilarity: config.minSimilarity,
        })
        if (!results.trim()) return text("No relevant memories found.")
        const compact = compactRelevantMemories(
          results,
          stripped,
          undefined,
          limit ?? config.recallLimit,
          config.minSimilarity,
        )
        if (!compact) return text("No relevant memories found.")
        return text(`${UNTRUSTED_PREAMBLE}\n\n${compact}`)
      } catch (error) {
        return errorText("Memory recall unavailable", error)
      }
    },
  )

  server.registerTool(
    "memory_store",
    {
      description:
        "Save important information to Rembr long-term memory. Use for preferences, facts, " +
        "decisions, and learnings worth keeping across sessions.",
      inputSchema: {
        text: z.string().describe("Information to remember"),
        category: z.enum(REMBR_CATEGORIES).optional().describe("Memory category (default: context)"),
      },
    },
    async ({ text: content, category }) => {
      if (looksLikePromptInjection(content)) {
        return text(
          "Memory was not stored because it looks like prompt instructions rather than a " +
            "durable user fact, preference, or decision.",
        )
      }
      try {
        const response = await rembr.remember(content, category ?? "context", {
          source: "codex-rembr",
        })
        return text(response || `Stored: "${content.slice(0, 100)}"`)
      } catch (error) {
        return errorText("Failed to store memory", error)
      }
    },
  )

  server.registerTool(
    "memory_forget",
    {
      description:
        "Delete a memory from Rembr by ID. Use memory_recall first to find the memory ID.",
      inputSchema: {
        memoryId: z.string().describe("Memory ID to delete"),
      },
    },
    async ({ memoryId }) => {
      try {
        const response = await rembr.forget(memoryId)
        return text(response || `Memory ${memoryId} forgotten.`)
      } catch (error) {
        return errorText("Failed to delete memory", error)
      }
    },
  )

  return server
}
