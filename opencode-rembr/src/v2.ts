/**
 * OpenCode v2 entry point (`@opencode/plugin`).
 *
 * Type-only import: `Plugin.define` is an identity function, so the
 * definition is a plain object and v1 hosts never need `@opencode/plugin`
 * at runtime. All behaviour lives in `createRembrCore`, shared with v1.
 */
import type { Plugin } from "@opencode/plugin"
import { createRembrCore, TOOL_DESCRIPTIONS, type RembrCore } from "./index.js"
import { MEMORY_CATEGORIES } from "./config.js"
import type { SessionMessage } from "./distill.js"

export const PLUGIN_ID = "opencode-rembr"

/** Loose shape of a v2 session message (`ctx.session.context()`). */
interface V2Message {
  type?: string
  text?: string
  time?: { created?: number }
  content?: Array<{
    type?: string
    text?: string
    name?: string
    state?: {
      status?: string
      input?: unknown
      content?: Array<{ type?: string; text?: string }>
      error?: { message?: string }
    }
  }>
}

/**
 * Convert v2 messages to the v1 shape the distiller digests. Only user and
 * assistant messages carry conversation content; synthetic, system, shell,
 * compaction and selection messages are dropped. The cursor is the message
 * creation time, because `session.context()` only returns messages after the
 * last compaction, so a position-based cursor would break.
 */
export function toSessionMessages(messages: readonly unknown[]): SessionMessage[] {
  const result: SessionMessage[] = []
  for (const raw of messages as readonly V2Message[]) {
    const cursor = typeof raw?.time?.created === "number" ? raw.time.created : undefined
    if (raw?.type === "user" && typeof raw.text === "string") {
      result.push({ info: { role: "user" }, cursor, parts: [{ type: "text", text: raw.text }] })
    } else if (raw?.type === "assistant") {
      const parts: NonNullable<SessionMessage["parts"]> = []
      for (const item of raw.content ?? []) {
        if (item.type === "text" && typeof item.text === "string") {
          parts.push({ type: "text", text: item.text })
        } else if (item.type === "tool") {
          const output =
            item.state?.content
              ?.filter((content) => content.type === "text" && typeof content.text === "string")
              .map((content) => content.text)
              .join("\n") || item.state?.error?.message
          parts.push({
            type: "tool",
            tool: item.name,
            state: { input: item.state?.input, output, status: item.state?.status },
          })
        }
        // reasoning is skipped, as in v1
      }
      result.push({ info: { role: "assistant" }, cursor, parts })
    }
  }
  return result
}

type Context = Plugin.Context

function log(level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) {
  // v2 has no app.log equivalent. Debug output is dropped to keep the host
  // console quiet, matching v1's default log level.
  if (level === "debug") return Promise.resolve()
  const line = `[${PLUGIN_ID}] ${message}`
  const write = level === "error" ? console.error : level === "warn" ? console.warn : console.info
  try {
    if (extra) write(line, extra)
    else write(line)
  } catch {
    // logging must never break the agent loop
  }
  return Promise.resolve()
}

function createCore(ctx: Context): RembrCore {
  return createRembrCore({
    directory: ctx.location.directory,
    worktree: ctx.location.project.directory,
    options: ctx.options as Record<string, unknown>,
    log,
    sessionTitle: async (sessionID) => (await ctx.session.get({ sessionID })).title,
    sessionMessages: async (sessionID) => toSessionMessages(await ctx.session.context({ sessionID })),
    // v2 offers stateless generation, so no side session is needed.
    generate: async (prompt, model, timeoutMs) => {
      const signal = AbortSignal.timeout(timeoutMs)
      const response = await ctx.generate.text(
        { prompt, ...(model ? { model: { providerID: model.providerID, id: model.modelID } } : {}) },
        { signal },
      )
      return response.text
    },
    // v1 cursors count messages; v2 cursors are timestamps.
    cursorNamespace: "opencode-v2",
  })
}

const STRING = { type: "string" } as const

/** v1 `tool` map -> direct v2 tools (`codemode: false`), same names and executors. */
function registerTools(ctx: Context, core: RembrCore) {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: "rembr_remember",
      description: TOOL_DESCRIPTIONS.rembr_remember,
      input: {
        type: "object",
        properties: {
          content: { ...STRING, description: "The content to remember" },
          category: {
            type: "string",
            enum: [...MEMORY_CATEGORIES],
            description: "Category for organizing memories (defaults to 'facts')",
          },
        },
        required: ["content"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input) => ({
        content: await core.tools.rembr_remember(input as Parameters<RembrCore["tools"]["rembr_remember"]>[0]),
      }),
    })
    editor.add({
      name: "rembr_recall",
      description: TOOL_DESCRIPTIONS.rembr_recall,
      input: {
        type: "object",
        properties: {
          query: { ...STRING, description: "What to search for" },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Max results (default 10)" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input) => ({
        content: await core.tools.rembr_recall(input as Parameters<RembrCore["tools"]["rembr_recall"]>[0]),
      }),
    })
    editor.add({
      name: "rembr_forget",
      description: TOOL_DESCRIPTIONS.rembr_forget,
      input: {
        type: "object",
        properties: { id: { ...STRING, description: "The memory ID to delete" } },
        required: ["id"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (input) => ({
        content: await core.tools.rembr_forget(input as Parameters<RembrCore["tools"]["rembr_forget"]>[0]),
      }),
    })
  })
}

/** Loose shape of a public v2 server event. */
interface V2Event {
  type?: string
  data?: { sessionID?: string; reason?: string }
  location?: { directory?: string }
}

/**
 * v2 has no `session.idle`. A turn ends with one of the execution events, the
 * same set the v2 server uses to mark a session idle. An interruption for
 * shutdown is skipped because the turn resumes after restart.
 */
export function isTurnEnd(event: V2Event): boolean {
  if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed") return true
  return event.type === "session.execution.interrupted" && event.data?.reason !== "shutdown"
}

export const RembrPluginV2: Plugin.Plugin = {
  id: PLUGIN_ID,
  async setup(ctx) {
    const core = createCore(ctx)

    // v1 `config` hook -> MCP transform. Never overwrite an explicit entry.
    const server = core.mcpServer()
    if (server) {
      await ctx.mcp.transform((editor) => {
        if (editor.get("rembr")) return
        editor.set("rembr", {
          type: "remote",
          url: server.url,
          headers: server.headers,
          oauth: false,
          // v2 splits the v1 single MCP timeout into phases.
          timeout: { startup: server.timeoutMs, catalog: server.timeoutMs },
        })
      })
    }

    await registerTools(ctx, core)

    // v1 `chat.message` -> prompt hook for the first prompt of a session. v2
    // prompts have no parts array, so the recalled block is kept per session
    // and added to the system prompt of each model request via the context
    // hook. It never becomes user text, so distillation cannot recapture it.
    const recalled = new Map<string, string>()
    await ctx.session.hook("prompt", async (event) => {
      const injection = await core.recallForPrompt(event.sessionID, event.prompt.text)
      if (!injection) return
      recalled.set(event.sessionID, injection.context)
      void log("info", injection.status.split("\n", 1)[0], { sessionID: event.sessionID })
    })
    await ctx.session.hook("context", (event) => {
      const context = recalled.get(event.sessionID)
      if (context) event.system.push({ type: "text", text: context })
    })

    // v1 `event` hook -> event subscription, aborted by the cleanup function.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          const event = raw as V2Event
          // Each plugin instance belongs to one location; ignore other locations
          // so two instances never distill the same session.
          if (event.location?.directory && event.location.directory !== ctx.location.directory) continue
          try {
            if (isTurnEnd(event) && event.data?.sessionID) {
              await core.onSessionIdle(event.data.sessionID)
            } else if (event.type === "session.deleted" && event.data?.sessionID) {
              recalled.delete(event.data.sessionID)
              core.forgetSession(event.data.sessionID)
            }
          } catch (error) {
            void log("warn", "event handling failed", {
              type: event.type,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          void log("warn", "event subscription ended", {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    })()

    return () => controller.abort()
  },
}
