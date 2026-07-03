import { describe, it, expect, vi, beforeEach } from "vitest"
import { RembrPlugin } from "./index.js"

function toolResult(text: string) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function makeOpencodeClient() {
  return {
    app: { log: vi.fn().mockResolvedValue({}) },
    session: {
      get: vi.fn().mockResolvedValue({ data: { title: "Fix OAuth token refresh" } }),
      messages: vi.fn().mockResolvedValue({
        data: [
          { info: { role: "user" }, parts: [{ type: "text", text: "fix the bug" }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "Fixed by rotating the refresh token." }] },
        ],
      }),
    },
  }
}

function makeInput(client = makeOpencodeClient()) {
  return { client, directory: "/proj", worktree: "/proj" } as never
}

const PLUGIN_OPTIONS = { apiKey: "test-key", url: "https://rembr.test/mcp" }

/** Last fetch call made to the Rembr /mcp endpoint (skips /health). */
function lastMcpBody(fetchMock: ReturnType<typeof vi.fn>) {
  const call = [...fetchMock.mock.calls].reverse().find(([url]) => String(url).endsWith("/mcp"))
  return call ? JSON.parse(call[1].body) : undefined
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolResult("ok")))
})

describe("RembrPlugin", () => {
  it("registers the three curated tools", async () => {
    const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
    expect(Object.keys(hooks.tool ?? {})).toEqual(["rembr_remember", "rembr_recall", "rembr_forget"])
  })

  it("tools explain how to configure when no API key is set", async () => {
    const hooks = await RembrPlugin(makeInput(), { url: "https://rembr.test/mcp" })
    const result = await hooks.tool!.rembr_remember.execute({ content: "x" } as never, {} as never)
    expect(String(result)).toContain("REMBR_API_KEY")
    // and no fetch was attempted
    expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).endsWith("/mcp"))).toBe(true)
  })

  it("rembr_remember stores with category and source metadata", async () => {
    const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
    const result = await hooks.tool!.rembr_remember.execute(
      { content: "prefer pnpm", category: "preferences" } as never,
      {} as never,
    )
    expect(result).toBe("ok")
    const body = lastMcpBody(vi.mocked(fetch))
    expect(body.params.name).toBe("memory")
    expect(body.params.arguments).toMatchObject({
      operation: "create",
      content: "prefer pnpm",
      category: "preferences",
      metadata: { source: "opencode-rembr", directory: "/proj" },
    })
  })

  it("rembr_recall returns a friendly message when nothing matches", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolResult("")))
    const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
    const result = await hooks.tool!.rembr_recall.execute({ query: "anything" } as never, {} as never)
    expect(result).toBe("No matching memories found.")
  })

  it("tool errors are returned as strings, not thrown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")))
    const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
    const result = await hooks.tool!.rembr_recall.execute({ query: "x" } as never, {} as never)
    expect(String(result)).toContain("Failed to search memories")
  })

  describe("chat.message recall injection", () => {
    it("injects recalled memories once per session", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolResult("- [mem_1] user prefers tabs")))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)

      const output = {
        message: { id: "msg_1", sessionID: "ses_1" },
        parts: [{ type: "text", text: "help me format this file" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_1" } as never, output as never)

      expect(output.parts).toHaveLength(2)
      const injectedPart = output.parts[1] as { text: string }
      expect(injectedPart.text).toContain("<rembr-memories>")
      expect(injectedPart.text).toContain("user prefers tabs")

      // second message in the same session: no further injection
      const output2 = {
        message: { id: "msg_2", sessionID: "ses_1" },
        parts: [{ type: "text", text: "now run the tests" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_1" } as never, output2 as never)
      expect(output2.parts).toHaveLength(1)
    })

    it("does not inject when recall returns nothing", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolResult("")))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      const output = {
        message: { id: "msg_1", sessionID: "ses_2" },
        parts: [{ type: "text", text: "hello" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_2" } as never, output as never)
      expect(output.parts).toHaveLength(1)
    })

    it("swallows recall failures and leaves the message untouched", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("down")))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      const output = {
        message: { id: "msg_1", sessionID: "ses_3" },
        parts: [{ type: "text", text: "hello" }],
      }
      await expect(hooks["chat.message"]!({ sessionID: "ses_3" } as never, output as never)).resolves.toBeUndefined()
      expect(output.parts).toHaveLength(1)
    })

    it("respects maxRecall: 0 as an off switch", async () => {
      const hooks = await RembrPlugin(makeInput(), { ...PLUGIN_OPTIONS, maxRecall: 0 })
      const output = {
        message: { id: "msg_1", sessionID: "ses_4" },
        parts: [{ type: "text", text: "hello" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_4" } as never, output as never)
      expect(output.parts).toHaveLength(1)
    })
  })

  describe("session.idle auto-capture", () => {
    const idleEvent = { type: "session.idle", properties: { sessionID: "ses_9" } }

    it("stores title + last assistant message on idle", async () => {
      const client = makeOpencodeClient()
      const hooks = await RembrPlugin(makeInput(client), PLUGIN_OPTIONS)

      await hooks.event!({ event: idleEvent as never })

      const body = lastMcpBody(vi.mocked(fetch))
      expect(body.params.name).toBe("memory")
      expect(body.params.arguments.operation).toBe("create")
      expect(body.params.arguments.content).toContain('OpenCode session "Fix OAuth token refresh"')
      expect(body.params.arguments.content).toContain("rotating the refresh token")
      expect(body.params.arguments.category).toBe("conversations")
      expect(body.params.arguments.metadata.sessionID).toBe("ses_9")
    })

    it("dedupes repeated idles with the same summary", async () => {
      const client = makeOpencodeClient()
      const hooks = await RembrPlugin(makeInput(client), PLUGIN_OPTIONS)

      await hooks.event!({ event: idleEvent as never })
      const callsAfterFirst = vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith("/mcp")).length
      await hooks.event!({ event: idleEvent as never })
      const callsAfterSecond = vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith("/mcp")).length

      expect(callsAfterSecond).toBe(callsAfterFirst)
    })

    it("does nothing when autoRemember is false", async () => {
      const hooks = await RembrPlugin(makeInput(), { ...PLUGIN_OPTIONS, autoRemember: false })
      await hooks.event!({ event: idleEvent as never })
      expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith("/mcp"))).toHaveLength(0)
    })

    it("ignores unrelated events", async () => {
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      await hooks.event!({ event: { type: "session.created", properties: {} } as never })
      expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith("/mcp"))).toHaveLength(0)
    })
  })
})
