import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import entry from "./plugin.js"
import serverEntry from "./server.js"
import { RembrPlugin } from "./index.js"
import { RembrPluginV2, isTurnEnd, toSessionMessages } from "./v2.js"

function toolResult(text: string) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

/** Last fetch call made to the Rembr /mcp endpoint (skips /health). */
function lastMcpBody(fetchMock: ReturnType<typeof vi.fn>) {
  const call = [...fetchMock.mock.calls].reverse().find(([url]) => String(url).endsWith("/mcp"))
  return call ? JSON.parse(call[1].body) : undefined
}

function mcpCalls() {
  return vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith("/mcp"))
}

const PLUGIN_OPTIONS = { apiKey: "test-key", url: "https://rembr.test/mcp" }

function userMessage(text: string, created: number) {
  return { id: `msg_u${created}`, type: "user", text, time: { created } }
}

function assistantMessage(text: string, created: number) {
  return {
    id: `msg_a${created}`,
    type: "assistant",
    time: { created, completed: created + 1 },
    content: [{ type: "text", text }],
  }
}

/** Minimal fake of the v2 plugin context; records every registration. */
function makeContext(options: Record<string, unknown> = PLUGIN_OPTIONS, directory = "/proj") {
  const mcp = new Map<string, unknown>()
  const tools: Array<Record<string, any>> = []
  const hooks = new Map<string, (event: any) => Promise<void> | void>()
  const events: unknown[] = []
  let wake: (() => void) | undefined
  let subscribedSignal: AbortSignal | undefined

  const ctx = {
    location: { directory, project: { id: "prj_1", directory, canonical: directory } },
    options,
    mcp: {
      transform: vi.fn(async (callback: (editor: any) => void) => {
        callback({
          get: (name: string) => mcp.get(name),
          set: (name: string, config: unknown) => mcp.set(name, config),
        })
        return { dispose: async () => {} }
      }),
    },
    tool: {
      transform: vi.fn(async (callback: (editor: any) => void) => {
        callback({ add: (tool: Record<string, any>) => tools.push(tool) })
        return { dispose: async () => {} }
      }),
    },
    session: {
      hook: vi.fn(async (name: string, callback: (event: any) => Promise<void> | void) => {
        hooks.set(name, callback)
        return { dispose: async () => {} }
      }),
      get: vi.fn().mockResolvedValue({ id: "ses_1", title: "Fix OAuth token refresh" }),
      context: vi.fn().mockResolvedValue([
        userMessage("fix the bug", 1000),
        assistantMessage("Fixed by rotating the refresh token.", 2000),
      ]),
    },
    generate: {
      text: vi.fn().mockResolvedValue({ text: '{"memories": []}' }),
    },
    event: {
      subscribe: vi.fn((requestOptions?: { signal?: AbortSignal }) => {
        subscribedSignal = requestOptions?.signal
        return (async function* () {
          while (!subscribedSignal?.aborted) {
            if (!events.length) await new Promise<void>((resolve) => (wake = resolve))
            while (events.length) yield events.shift()
          }
        })()
      }),
    },
  }

  return {
    ctx,
    mcp,
    tools,
    hooks,
    signal: () => subscribedSignal,
    emit(event: unknown) {
      events.push(event)
      wake?.()
    },
    /** Resolve the pending iterator so an aborted loop can exit. */
    flush() {
      wake?.()
    },
  }
}

async function setup(fake: ReturnType<typeof makeContext>) {
  return (await RembrPluginV2.setup(fake.ctx as never)) as (() => void) | undefined
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv("REMBR_API_KEY", "")
  vi.stubEnv("REMBR_URL", "")
  vi.stubEnv("REMBR_DISTILL", "false")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolResult("ok")))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("package entry point", () => {
  it("satisfies the OpenCode v1 object entrypoint rules", () => {
    const value = entry as unknown as Record<string, unknown>
    expect(typeof value.id).toBe("string")
    expect(value.server).toBe(RembrPlugin)
    expect("tui" in value).toBe(false)
  })

  it("satisfies the OpenCode v2 definition rules", () => {
    expect(entry.id).toBe("opencode-rembr")
    expect(typeof entry.setup).toBe("function")
  })

  it("exposes the same definition as the v2 directory entry (server)", () => {
    expect(serverEntry).toBe(entry)
  })
})

describe("RembrPluginV2", () => {
  it("registers the bundled MCP server with v2 timeouts without overwriting explicit config", async () => {
    const fake = makeContext()
    const cleanup = await setup(fake)
    expect(fake.mcp.get("rembr")).toEqual({
      type: "remote",
      url: "https://rembr.test/mcp",
      headers: { "x-api-key": "test-key" },
      oauth: false,
      timeout: { startup: 15000, catalog: 15000 },
    })
    cleanup?.()

    const explicit = makeContext()
    explicit.mcp.set("rembr", { type: "remote", url: "https://explicit.test/mcp" })
    const cleanupExplicit = await setup(explicit)
    expect((explicit.mcp.get("rembr") as { url: string }).url).toBe("https://explicit.test/mcp")
    cleanupExplicit?.()
  })

  it("can disable bundled MCP registration", async () => {
    const fake = makeContext({ ...PLUGIN_OPTIONS, registerMcp: false })
    const cleanup = await setup(fake)
    expect(fake.ctx.mcp.transform).not.toHaveBeenCalled()
    cleanup?.()
  })

  it("registers the three curated tools as direct tools", async () => {
    const fake = makeContext()
    const cleanup = await setup(fake)
    expect(fake.tools.map((tool) => tool.name)).toEqual(["rembr_remember", "rembr_recall", "rembr_forget"])
    for (const tool of fake.tools) {
      expect(tool.options).toEqual({ codemode: false })
      expect(tool.input.type).toBe("object")
      expect(tool.input.additionalProperties).toBe(false)
    }
    expect(fake.tools[0].input.properties.category.enum).toContain("facts")
    cleanup?.()
  })

  it("tool execution returns structured content and stores with source metadata", async () => {
    const fake = makeContext()
    const cleanup = await setup(fake)
    const remember = fake.tools.find((tool) => tool.name === "rembr_remember")!

    const result = await remember.execute({ content: "prefers tabs", category: "preferences" }, {})

    expect(result).toEqual({ content: "ok" })
    const body = lastMcpBody(vi.mocked(fetch))
    expect(body.params.arguments.content).toBe("prefers tabs")
    expect(body.params.arguments.category).toBe("preferences")
    expect(body.params.arguments.metadata.source).toBe("opencode-rembr")
    expect(body.params.arguments.metadata.directory).toBe("/proj")
    cleanup?.()
  })

  it("tools explain how to configure when no API key is set", async () => {
    const fake = makeContext({ url: "https://rembr.test/mcp", apiKey: "" })
    const cleanup = await setup(fake)
    const recall = fake.tools.find((tool) => tool.name === "rembr_recall")!
    const result = await recall.execute({ query: "anything" }, {})
    expect(result.content).toContain("REMBR_API_KEY")
    expect(fake.ctx.mcp.transform).not.toHaveBeenCalled()
    expect(mcpCalls()).toHaveLength(0)
    cleanup?.()
  })

  describe("recall injection", () => {
    it("recalls on the first prompt and adds the memories to every model request of that session", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolResult("- [mem_1] user prefers tabs")))
      const fake = makeContext()
      const cleanup = await setup(fake)
      const prompt = fake.hooks.get("prompt")!
      const context = fake.hooks.get("context")!

      const first = { sessionID: "ses_1", messageID: "msg_1", prompt: { text: "help me format this file" } }
      await prompt(first)
      // the prompt itself is never rewritten
      expect(first.prompt.text).toBe("help me format this file")

      for (let i = 0; i < 2; i++) {
        const request = { sessionID: "ses_1", system: [] as Array<{ type: string; text: string }> }
        await context(request)
        expect(request.system).toHaveLength(1)
        expect(request.system[0].text).toContain("<rembr-memories>")
        expect(request.system[0].text).toContain("user prefers tabs")
      }

      const recallCalls = mcpCalls().length
      await prompt({ sessionID: "ses_1", messageID: "msg_2", prompt: { text: "now run the tests" } })
      expect(mcpCalls().length).toBe(recallCalls)

      const other = { sessionID: "ses_2", system: [] as unknown[] }
      await context(other)
      expect(other.system).toHaveLength(0)
      cleanup?.()
    })

    it("does not inject when recall returns nothing", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolResult("")))
      const fake = makeContext()
      const cleanup = await setup(fake)
      await fake.hooks.get("prompt")!({ sessionID: "ses_3", messageID: "m", prompt: { text: "explain the deployment pipeline stages" } })
      const request = { sessionID: "ses_3", system: [] as unknown[] }
      await fake.hooks.get("context")!(request)
      expect(request.system).toHaveLength(0)
      cleanup?.()
    })

    it("swallows recall failures", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")))
      const fake = makeContext()
      const cleanup = await setup(fake)
      await expect(
        fake.hooks.get("prompt")!({ sessionID: "ses_4", messageID: "m", prompt: { text: "how do we deploy" } }),
      ).resolves.toBeUndefined()
      cleanup?.()
    })
  })

  describe("turn end (session.execution.*)", () => {
    it("auto-captures title + last assistant message when distillation is off", async () => {
      const fake = makeContext()
      const cleanup = await setup(fake)

      fake.emit({ type: "session.execution.succeeded", location: { directory: "/proj" }, data: { sessionID: "ses_9" } })
      await vi.waitFor(() => expect(mcpCalls().length).toBeGreaterThan(0))

      const body = lastMcpBody(vi.mocked(fetch))
      expect(body.params.arguments.content).toContain('OpenCode session "Fix OAuth token refresh"')
      expect(body.params.arguments.content).toContain("rotating the refresh token")
      expect(body.params.arguments.category).toBe("conversations")
      expect(body.params.arguments.metadata.session_id).toBe("ses_9")
      cleanup?.()
    })

    it("ignores idle events from another location", async () => {
      const fake = makeContext()
      const cleanup = await setup(fake)

      fake.emit({ type: "session.execution.succeeded", location: { directory: "/other" }, data: { sessionID: "ses_x" } })
      fake.emit({ type: "session.created", location: { directory: "/proj" }, data: { sessionID: "ses_y" } })
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(fake.ctx.session.get).not.toHaveBeenCalled()
      expect(mcpCalls()).toHaveLength(0)
      cleanup?.()
    })

    it("distills with stateless generation and a timestamp cursor", async () => {
      vi.stubEnv("REMBR_DISTILL", "true")
      vi.stubEnv("REMBR_DISTILL_MIN_MESSAGES", "2")
      vi.stubEnv("REMBR_STATE_DIR", mkdtempSync(join(tmpdir(), "rembr-v2-")))
      const fake = makeContext({ ...PLUGIN_OPTIONS, distillModel: "example-provider/example-model" })
      fake.ctx.generate.text.mockResolvedValue({
        text: '{"memories": [{"content": "Team prefers pnpm", "category": "preferences", "tags": []}]}',
      })
      const cleanup = await setup(fake)

      fake.emit({ type: "session.execution.succeeded", location: { directory: "/proj" }, data: { sessionID: "ses_d" } })
      await vi.waitFor(() => expect(mcpCalls().length).toBeGreaterThan(0))

      expect(fake.ctx.generate.text).toHaveBeenCalledTimes(1)
      const [input, requestOptions] = fake.ctx.generate.text.mock.calls[0]
      expect(input.model).toEqual({ providerID: "example-provider", id: "example-model" })
      expect(input.prompt).toContain("USER: fix the bug")
      expect(input.prompt).toContain("ASSISTANT: Fixed by rotating the refresh token.")
      expect(requestOptions.signal).toBeInstanceOf(AbortSignal)
      const body = lastMcpBody(vi.mocked(fetch))
      expect(body.params.arguments.content).toBe("Team prefers pnpm")
      expect(body.params.arguments.metadata.distilled).toBe(true)
      expect(body.params.arguments.metadata.session_id).toBe("ses_d")

      // Same messages again: the cursor holds, nothing new to distill.
      fake.emit({ type: "session.execution.succeeded", location: { directory: "/proj" }, data: { sessionID: "ses_d" } })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(fake.ctx.generate.text).toHaveBeenCalledTimes(1)

      // After a compaction the context shrinks to newer messages only; they
      // are still detected as new because the cursor is a timestamp.
      fake.ctx.session.context.mockResolvedValue([
        userMessage("switch to pnpm workspaces", 3000),
        assistantMessage("Done.", 4000),
      ])
      fake.emit({ type: "session.execution.succeeded", location: { directory: "/proj" }, data: { sessionID: "ses_d" } })
      await vi.waitFor(() => expect(fake.ctx.generate.text).toHaveBeenCalledTimes(2))
      expect(fake.ctx.generate.text.mock.calls[1][0].prompt).toContain("switch to pnpm workspaces")
      expect(fake.ctx.generate.text.mock.calls[1][0].prompt).not.toContain("fix the bug")
      cleanup?.()
    })

    it("does not capture when REMBR_CAPTURE_DISABLE is set", async () => {
      vi.stubEnv("REMBR_DISTILL", "true")
      vi.stubEnv("REMBR_CAPTURE_DISABLE", "1")
      const fake = makeContext()
      const cleanup = await setup(fake)

      fake.emit({ type: "session.execution.succeeded", location: { directory: "/proj" }, data: { sessionID: "ses_d" } })
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(fake.ctx.generate.text).not.toHaveBeenCalled()
      expect(mcpCalls()).toHaveLength(0)
      cleanup?.()
    })
  })

  it("cleanup aborts the event subscription", async () => {
    const fake = makeContext()
    const cleanup = await setup(fake)
    expect(fake.signal()?.aborted).toBe(false)
    cleanup?.()
    fake.flush()
    expect(fake.signal()?.aborted).toBe(true)
  })
})

describe("toSessionMessages", () => {
  it("keeps user and assistant content, summarizes tools and drops other message types", () => {
    const messages = toSessionMessages([
      { type: "agent-selected", time: { created: 1 } },
      userMessage("run the tests", 2),
      { type: "synthetic", text: "injected", time: { created: 3 } },
      {
        type: "assistant",
        time: { created: 4 },
        content: [
          { type: "reasoning", text: "thinking" },
          {
            type: "tool",
            name: "shell",
            state: { status: "completed", input: { command: "npm test" }, content: [{ type: "text", text: "80 passed" }] },
          },
          {
            type: "tool",
            name: "read",
            state: { status: "error", input: { path: "missing" }, error: { message: "not found" } },
          },
          { type: "text", text: "All tests pass." },
        ],
      },
      { type: "idle", outcome: "succeeded", time: { created: 5 } },
    ])

    expect(messages).toEqual([
      { info: { role: "user" }, cursor: 2, parts: [{ type: "text", text: "run the tests" }] },
      {
        info: { role: "assistant" },
        cursor: 4,
        parts: [
          { type: "tool", tool: "shell", state: { input: { command: "npm test" }, output: "80 passed", status: "completed" } },
          { type: "tool", tool: "read", state: { input: { path: "missing" }, output: "not found", status: "error" } },
          { type: "text", text: "All tests pass." },
        ],
      },
    ])
  })
})

describe("isTurnEnd", () => {
  it("treats execution outcomes as turn end, except shutdown interruptions", () => {
    const end = (type: string, reason?: string) => isTurnEnd({ type, data: { sessionID: "s", reason } })
    expect(end("session.execution.succeeded")).toBe(true)
    expect(end("session.execution.failed")).toBe(true)
    expect(end("session.execution.interrupted", "user")).toBe(true)
    expect(end("session.execution.interrupted", "shutdown")).toBe(false)
    expect(end("session.execution.started")).toBe(false)
    // v1-only event name; v2 never emits it
    expect(end("session.idle")).toBe(false)
  })
})
