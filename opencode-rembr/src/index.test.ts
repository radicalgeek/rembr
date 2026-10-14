import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import RembrPluginDefault, { RembrPlugin } from "./index.js"

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
  vi.unstubAllEnvs()
  // Isolate from the host machine: a developer's real REMBR_* variables must
  // not leak into plugin config under test.
  vi.stubEnv("REMBR_API_KEY", "")
  vi.stubEnv("REMBR_URL", "")
  vi.stubEnv("REMBR_DISTILL", "false")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolResult("ok")))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("RembrPlugin", () => {
  it("exports the plugin as the default module entry point", () => {
    expect(RembrPluginDefault).toBe(RembrPlugin)
  })

  it("registers the three curated tools", async () => {
    const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
    expect(Object.keys(hooks.tool ?? {})).toEqual(["rembr_remember", "rembr_recall", "rembr_forget"])
  })

  it("registers the bundled MCP server without overwriting explicit config", async () => {
    const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
    const config = { mcp: {} } as Record<string, any>
    await hooks.config!(config)
    expect(config.mcp.rembr).toEqual({
      type: "remote",
      url: "https://rembr.test/mcp",
      headers: { "x-api-key": "test-key" },
      oauth: false,
      timeout: 15000,
    })

    const explicit = { mcp: { rembr: { type: "remote", url: "https://explicit.test/mcp" } } } as Record<string, any>
    await hooks.config!(explicit)
    expect(explicit.mcp.rembr.url).toBe("https://explicit.test/mcp")
  })

  it("can disable bundled MCP registration", async () => {
    const hooks = await RembrPlugin(makeInput(), { ...PLUGIN_OPTIONS, registerMcp: false })
    const config = {} as Record<string, any>
    await hooks.config!(config)
    expect(config.mcp).toBeUndefined()
  })

  it("tools explain how to configure when no API key is set", async () => {
    vi.stubEnv("REMBR_API_KEY", "")
    const hooks = await RembrPlugin(makeInput(), { url: "https://rembr.test/mcp", apiKey: "" })
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

  it("rembr_recall reranks a wider candidate pool and excludes stale results", async () => {
    const results = JSON.stringify({
      success: true,
      data: [
        { id: "superseded-id", category: "projects", content: "Superseded 10-record migration draft.", score: 1, semantic_similarity: 0.91, metadata: { superseded_by_migration_id: "current-id" } },
        { id: "stale-id", category: "projects", content: "Migration paused at the bounded 10-record batch.", score: 0.9, semantic_similarity: 0.62, created_at: "2026-07-14T10:00:00Z", metadata: { directory: "/proj" } },
        { id: "current-id", category: "projects", content: "Migration completed with 120 sample records and a verification pass.", score: 0.4, semantic_similarity: 0.74, created_at: "2026-07-15T17:00:00Z", metadata: { directory: "/proj" } },
      ],
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolResult(results)))
    const hooks = await RembrPlugin(makeInput(), { ...PLUGIN_OPTIONS, minSimilarity: 0.3 })

    const result = String(await hooks.tool!.rembr_recall.execute({
      query: "Rembr migration status https://example.test/private",
      limit: 10,
    } as never, {} as never))

    const parsed = JSON.parse(result)
    expect(parsed.data.map((entry: { id: string }) => entry.id)).toEqual(["current-id"])
    expect(result).not.toContain("Superseded 10-record")
    expect(result).not.toContain("bounded 10-record batch")
    const body = lastMcpBody(vi.mocked(fetch))
    expect(body.params.arguments).toMatchObject({
      query: "Rembr migration status",
      limit: 20,
    })
  })

  it("rembr_recall returns an empty structured result when all candidates are superseded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolResult(JSON.stringify({
      success: true,
      data: [{ id: "stale", content: "Stale state.", metadata: { superseded_by_migration_id: "current" } }],
    }))))
    const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)

    const result = await hooks.tool!.rembr_recall.execute({ query: "state" } as never, {} as never)

    expect(JSON.parse(String(result)).data).toEqual([])
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

      expect(output.parts).toHaveLength(3)
      const statusPart = output.parts[1] as { text: string; synthetic?: boolean }
      expect(statusPart.text).toContain("Rembr: injected 1 relevant memory")
      expect(statusPart.text).toContain("user prefers tabs")
      expect(statusPart.synthetic).toBeUndefined()
      const injectedPart = output.parts[2] as { id: string; text: string; synthetic?: boolean }
      expect(injectedPart.id).toMatch(/^prt/)
      expect(injectedPart.synthetic).toBe(true)
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

    it("uses recent workspace context for a vague status prompt with a chat URL", async () => {
      const recentJson = JSON.stringify({
        success: true,
        data: [
          { id: "old-project", category: "projects", content: "Older project state.", created_at: "2026-07-10T10:00:00Z", metadata: { directory: "/proj" } },
          { id: "current-project", category: "projects", content: "Current Rembr starter injection work is ready for review.", created_at: "2026-07-14T10:00:00Z", metadata: { directory: "/proj" } },
          { id: "other-project", category: "projects", content: "Other workspace status.", created_at: "2026-07-14T11:00:00Z", metadata: { directory: "/other" } },
        ],
      })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) =>
        Promise.resolve(String(url).endsWith("/health")
          ? new Response("ok", { status: 200 })
          : toolResult(recentJson)),
      ))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      const output = {
        message: { id: "msg_status", sessionID: "ses_status" },
        parts: [{
          type: "text",
          text: "Okay, let's share current status with Fixture Reviewer https://chat.example.test/message/fixture, draft concise information about what was done",
        }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_status" } as never, output as never)

      expect((output.parts[1] as { text: string }).text).toContain("continuity prompt; injected 2 recent context memories")
      expect((output.parts[1] as { text: string }).text.indexOf("Current Rembr")).toBeLessThan((output.parts[1] as { text: string }).text.indexOf("Older project"))
      expect((output.parts[1] as { text: string }).text).not.toContain("Other workspace status")
      const mcpBodies = vi.mocked(fetch).mock.calls
        .filter(([url]) => String(url).endsWith("/mcp"))
        .map((call) => JSON.parse(call[1].body))
      expect(mcpBodies).toHaveLength(1)
      expect(mcpBodies[0].params).toMatchObject({ name: "memory", arguments: { operation: "list", limit: 50, sort_by: "source_created_at" } })
    })

    it("treats an OpenCode restart message as continuity and keeps the newest prior session", async () => {
      const recentJson = JSON.stringify({
        success: true,
        data: [
          { id: "current-1", category: "facts", content: "The theme setting persists but its render cache is process-memory only.", created_at: "2026-08-05T13:11:32Z", metadata: { directory: "/proj", sessionID: "browser-session" } },
          { id: "other", category: "decisions", content: "Unrelated starter repository decision.", created_at: "2026-08-05T13:10:00Z", metadata: { directory: "/proj", sessionID: "other-session" } },
          { id: "current-2", category: "projects", content: "The settings reload path is under test after restart.", created_at: "2026-08-05T13:09:00Z", metadata: { directory: "/proj", session_id: "browser-session" } },
        ],
      })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) =>
        Promise.resolve(String(url).endsWith("/health")
          ? new Response("ok", { status: 200 })
          : toolResult(recentJson)),
      ))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      const output = {
        message: { id: "msg_restarted", sessionID: "ses_restarted" },
        parts: [{
          type: "text",
          text: "Let's test it, I restarted open code, try sending me a message in this chat, just a test https://chat.example.test/conversation/fixture",
        }],
      }

      await hooks["chat.message"]!({ sessionID: "ses_restarted" } as never, output as never)

      const status = (output.parts[1] as { text: string }).text
      expect(status).toContain("continuity prompt; injected 2 recent context memories")
      expect(status).toContain("theme setting persists")
      expect(status).toContain("settings reload path")
      expect(status).not.toContain("starter repository")
      const mcpBodies = vi.mocked(fetch).mock.calls
        .filter(([url]) => String(url).endsWith("/mcp"))
        .map((call) => JSON.parse(call[1].body))
      expect(mcpBodies).toHaveLength(1)
      expect(mcpBodies[0].params.name).toBe("memory")
    })

    it("does not repeat near-duplicate memories in recent continuity context", async () => {
      const recentJson = JSON.stringify({
        success: true,
        data: [
          { id: "newest", category: "decisions", content: "Use semantic recall with workspace context for a resumed session.", created_at: "2026-07-14T16:00:00Z", metadata: { directory: "/proj" } },
          { id: "duplicate", category: "decisions", content: "Use workspace context with semantic recall when a session is resumed.", created_at: "2026-07-14T15:00:00Z", metadata: { directory: "/proj" } },
          { id: "preference", category: "preferences", content: "Keep the five-memory context budget while improving relevance.", created_at: "2026-07-14T14:00:00Z", metadata: { directory: "/proj" } },
          { id: "other", category: "projects", content: "The local console runs through Docker Compose on port 8081.", created_at: "2026-07-14T13:00:00Z", metadata: { directory: "/proj" } },
        ],
      })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) =>
        Promise.resolve(String(url).endsWith("/health")
          ? new Response("ok", { status: 200 })
          : toolResult(recentJson)),
      ))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      const output = {
        message: { id: "msg_diverse", sessionID: "ses_diverse" },
        parts: [{ type: "text", text: "Okay, let's see how it works." }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_diverse" } as never, output as never)

      const status = (output.parts[1] as { text: string }).text
      expect(status).toContain("injected 3 recent context memories")
      expect(status).toContain("Use semantic recall")
      expect(status).not.toContain("Use workspace context with semantic recall")
      expect(status).toContain("five-memory context budget")
      expect(status).toContain("local console")
    })

    it("prioritizes the newest prior session for topic-free continuity", async () => {
      const recentJson = JSON.stringify({
        success: true,
        data: [
          { id: "main-1", category: "decisions", content: "Current migration decision one.", created_at: "2026-07-15T18:22:56Z", metadata: { directory: "/proj", sessionID: "main" } },
          { id: "other", category: "decisions", content: "Unrelated security assessment decision.", created_at: "2026-07-15T18:22:55Z", metadata: { directory: "/proj", sessionID: "other" } },
          { id: "main-2", category: "projects", content: "Current migration result two.", created_at: "2026-07-15T18:22:54Z", metadata: { directory: "/proj", session_id: "main" } },
          { id: "main-3", category: "facts", content: "Current restore result three.", created_at: "2026-07-15T18:22:53Z", metadata: { directory: "/proj", sessionID: "main" } },
          { id: "main-4", category: "workflows", content: "Current provenance workflow four.", created_at: "2026-07-15T18:22:52Z", metadata: { directory: "/proj", sessionID: "main" } },
          { id: "main-5", category: "learning", content: "Current recall finding five.", created_at: "2026-07-15T18:22:51Z", metadata: { directory: "/proj", sessionID: "main" } },
        ],
      })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) =>
        Promise.resolve(String(url).endsWith("/health")
          ? new Response("ok", { status: 200 })
          : toolResult(recentJson)),
      ))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      const output = {
        message: { id: "msg_prior_session", sessionID: "ses_prior_session" },
        parts: [{ type: "text", text: "Restarted the session" }],
      }

      await hooks["chat.message"]!({ sessionID: "ses_prior_session" } as never, output as never)

      const injected = (output.parts[2] as { text: string }).text
      expect(injected).toContain("Current migration decision one")
      expect(injected).toContain("Current recall finding five")
      expect(injected).not.toContain("Unrelated security assessment")
    })

    it("orders recent continuity context by metadata.source_created_at when present", async () => {
      const recentJson = JSON.stringify({
        success: true,
        data: [
          { id: "migrated", category: "facts", content: "Migrated old memory.", created_at: "2026-07-14T12:00:00Z", metadata: { directory: "/proj", source_created_at: "2025-01-01T00:00:00Z" } },
          { id: "native", category: "facts", content: "Native newer memory.", created_at: "2025-06-01T00:00:00Z", metadata: { directory: "/proj" } },
        ],
      })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) =>
        Promise.resolve(String(url).endsWith("/health")
          ? new Response("ok", { status: 200 })
          : toolResult(recentJson)),
      ))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      const output = {
        message: { id: "msg_source", sessionID: "ses_source" },
        parts: [{ type: "text", text: "What is our current status?" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_source" } as never, output as never)

      const injected = (output.parts[2] as { text: string }).text
      expect(injected.indexOf("Native newer memory")).toBeLessThan(injected.indexOf("Migrated old memory"))
    })

    it("uses continuity for an underspecified conversational opener", async () => {
      const recentJson = JSON.stringify({
        success: true,
        data: [
          { id: "current", category: "projects", content: "Current OpenCode Rembr ranking work is ready to validate.", created_at: "2026-07-14T15:00:00Z", metadata: { directory: "/proj" } },
          { id: "codex", category: "facts", content: "Codex recall implementation detail.", created_at: "2026-07-14T16:00:00Z", metadata: { directory: "/other" } },
        ],
      })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) =>
        Promise.resolve(String(url).endsWith("/health")
          ? new Response("ok", { status: 200 })
          : toolResult(recentJson)),
      ))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      const output = {
        message: { id: "msg_restart", sessionID: "ses_restart" },
        parts: [{ type: "text", text: "Okay, let's see how it works." }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_restart" } as never, output as never)

      expect((output.parts[1] as { text: string }).text).toContain("continuity prompt; injected 1 recent context memory")
      expect((output.parts[1] as { text: string }).text).toContain("Current OpenCode Rembr ranking work")
      expect((output.parts[1] as { text: string }).text).not.toContain("Codex recall")

      const anotherOpener = {
        message: { id: "msg_after_restart", sessionID: "ses_after_restart" },
        parts: [{ type: "text", text: "Can we carry on from before?" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_after_restart" } as never, anotherOpener as never)
      expect((anotherOpener.parts[1] as { text: string }).text).toContain("continuity prompt; injected 1 recent context memory")
    })

    it("removes URLs and reranks structured results by semantic similarity", async () => {
      const results = JSON.stringify({
        success: true,
        data: [
          { id: "superseded", category: "facts", content: "Stale superseded result.", score: 0.95, semantic_similarity: 0.9, metadata: { superseded_by_migration_id: "replacement" } },
          { id: "graph-winner", category: "facts", content: "Graph-boosted but weak result.", score: 0.9, semantic_similarity: 0.31 },
          { id: "semantic-winner", category: "projects", content: "Relevant semantic result.", score: 0.4, semantic_similarity: 0.62, metadata: { directory: "/proj" } },
          { id: "semantic-near", category: "decisions", content: "Closely related result.", score: 0.3, semantic_similarity: 0.57 },
        ],
      })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) =>
        Promise.resolve(String(url).endsWith("/health")
          ? new Response("ok", { status: 200 })
          : toolResult(results)),
      ))
      const hooks = await RembrPlugin(makeInput(), { ...PLUGIN_OPTIONS, minSimilarity: 0.3 })
      const output = {
        message: { id: "msg_rank", sessionID: "ses_rank" },
        parts: [{ type: "text", text: "Draft guidance for https://example.test/private/path about Rembr search ranking" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_rank" } as never, output as never)

      const status = (output.parts[1] as { text: string }).text
      expect(status).toContain("injected 2 relevant memories")
      expect(status.indexOf("Relevant semantic result")).toBeLessThan(status.indexOf("Closely related result"))
      expect(status).not.toContain("Graph-boosted but weak result")
      expect(status).not.toContain("Stale superseded result")
      const bodies = vi.mocked(fetch).mock.calls
        .filter(([url]) => String(url).endsWith("/mcp"))
        .map(([, init]) => JSON.parse(init.body))
      expect(bodies.map((body) => body.params.arguments.query)).toEqual([
        "Draft guidance for about Rembr search ranking",
        "Rembr search ranking",
      ])
      expect(bodies.every((body) => body.params.arguments.limit === 20)).toBe(true)
    })

    it("keeps five detailed memories while demoting an older overlapping decision", async () => {
      const longDetail = "x".repeat(300)
      const results = JSON.stringify({
        success: true,
        data: [
          { id: "ui-current", category: "facts", content: `OpenCode Rembr injects detailed model context and a visible status preview. ${longDetail}`, semantic_similarity: 0.60, created_at: "2026-07-13T10:00:00Z", metadata: { directory: "/proj" } },
          { id: "old-decision", category: "decisions", content: "The Rembr OpenCode starter recall uses semantic matches and injects three compact memories for continuity context.", semantic_similarity: 0.61, created_at: "2026-07-10T10:00:00Z", metadata: { directory: "/proj" } },
          { id: "new-decision", category: "decisions", content: "The Rembr OpenCode starter recall uses semantic matches and injects five compact memories for continuity context with URL removal and raw similarity reranking.", semantic_similarity: 0.57, created_at: "2026-07-14T10:00:00Z", metadata: { directory: "/proj" } },
          { id: "preview", category: "projects", content: "OpenCode shows compact Rembr memory previews while retaining detailed synthetic context.", semantic_similarity: 0.56, created_at: "2026-07-13T11:00:00Z", metadata: { directory: "/proj" } },
          { id: "preference", category: "preferences", content: "Retain the five-memory Rembr context budget while improving ranking quality.", semantic_similarity: 0.55, created_at: "2026-07-14T11:00:00Z", metadata: { directory: "/proj" } },
          { id: "codex", category: "facts", content: "Codex UserPromptSubmit injects Rembr context through additionalContext.", semantic_similarity: 0.59, created_at: "2026-07-13T12:00:00Z", metadata: { directory: "/proj" } },
          { id: "ranking", category: "insights", content: "Rembr semantic ranking should resist graph-score noise.", semantic_similarity: 0.54, created_at: "2026-07-14T09:00:00Z", metadata: { directory: "/proj" } },
        ],
      })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) =>
        Promise.resolve(String(url).endsWith("/health")
          ? new Response("ok", { status: 200 })
          : toolResult(results)),
      ))
      const hooks = await RembrPlugin(makeInput(), { ...PLUGIN_OPTIONS, minSimilarity: 0.3 })
      const output = {
        message: { id: "msg_quality", sessionID: "ses_quality" },
        parts: [{ type: "text", text: "What Rembr features inject context into my OpenCode prompt?" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_quality" } as never, output as never)

      const status = (output.parts[1] as { text: string }).text
      const injected = (output.parts[2] as { text: string }).text
      expect(status).toContain("injected 5 relevant memories")
      expect(injected).toContain("injects five compact memories")
      expect(injected).not.toContain("injects three compact memories")
      expect(injected).toContain(longDetail)
    })

    it("does not pad a specific operational prompt with weaker adjacent memories", async () => {
      const results = JSON.stringify({
        success: true,
        data: [
          { id: "console", category: "facts", content: "A local rembr-viewer package exists at ./rembr-viewer; it is a lightweight local proxy/static UI and not the published Rembr UI.", semantic_similarity: 0.82, created_at: "2026-07-14T10:00:00Z", metadata: { directory: "/proj" } },
          { id: "recall", category: "facts", content: "The OpenCode Rembr plugin injects searchable long-term memories into the first prompt.", semantic_similarity: 0.69, created_at: "2026-07-14T10:00:00Z", metadata: { directory: "/proj" } },
          { id: "capture", category: "facts", content: "OpenCode Rembr idle distillation captures durable session outcomes.", semantic_similarity: 0.67, created_at: "2026-07-14T10:00:00Z", metadata: { directory: "/proj" } },
        ],
      })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) =>
        Promise.resolve(String(url).endsWith("/health")
          ? new Response("ok", { status: 200 })
          : toolResult(results)),
      ))
      const hooks = await RembrPlugin(makeInput(), { ...PLUGIN_OPTIONS, minSimilarity: 0.3 })
      const output = {
        message: { id: "msg_console", sessionID: "ses_console" },
        parts: [{ type: "text", text: "Why rembr ui is down, please wire it into ./docker/compose.yml and run it" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_console" } as never, output as never)

      const status = (output.parts[1] as { text: string }).text
      expect(status).toContain("injected 1 relevant memory")
      expect(status).toContain("local rembr-viewer package")
      expect(status).not.toContain("idle distillation")
    })

    it("merges a focused subject search for verbose prompts", async () => {
      const broad = JSON.stringify({ data: [
        { id: "generic", category: "projects", content: "General automation workflow architecture.", semantic_similarity: 0.58 },
      ] })
      const focused = JSON.stringify({ data: [
        { id: "fixture-user", category: "decisions", content: "Use delegated API consent for Fixture User's automation workflow.", semantic_similarity: 0.38, text_match: true },
      ] })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url, init) => {
        if (String(url).endsWith("/health")) return Promise.resolve(new Response("ok", { status: 200 }))
        const query = JSON.parse(init.body).params.arguments.query
        return Promise.resolve(toolResult(query === "fixture user automation workflows" ? focused : broad))
      }))
      const hooks = await RembrPlugin(makeInput(), { ...PLUGIN_OPTIONS, minSimilarity: 0.3 })
      const output = {
        message: { id: "msg_focused", sessionID: "ses_focused" },
        parts: [{ type: "text", text: "Test what recall finds about fixture user automation workflows" }],
      }

      await hooks["chat.message"]!({ sessionID: "ses_focused" } as never, output as never)

      expect((output.parts[1] as { text: string }).text).toContain("Fixture User")
      const queries = vi.mocked(fetch).mock.calls
        .filter(([url]) => String(url).endsWith("/mcp"))
        .map(([, init]) => JSON.parse(init.body).params.arguments.query)
      expect(queries).toEqual([
        "Test what recall finds about fixture user automation workflows",
        "fixture user automation workflows",
      ])
    })

    it("focuses topic-specific continuation prompts instead of recall instructions", async () => {
      const broad = JSON.stringify({ data: [
        { id: "rembr", category: "facts", content: "Rembr injects memories on the first prompt.", semantic_similarity: 0.58 },
      ] })
      const focused = JSON.stringify({ data: [
        { id: "fixture-workflow", category: "projects", content: "The fixture workflow is waiting for a schema migration and an end-to-end retest.", semantic_similarity: 0.67, text_match: true },
      ] })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url, init) => {
        if (String(url).endsWith("/health")) return Promise.resolve(new Response("ok", { status: 200 }))
        const query = JSON.parse(init.body).params.arguments.query
        return Promise.resolve(toolResult(query === "fixture workflow" ? focused : broad))
      }))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      const output = {
        message: { id: "msg_fixture_workflow", sessionID: "ses_fixture_workflow" },
        parts: [{ type: "text", text: "Tell me where we stopped with fixture workflow, answer only using Rembr injected memories" }],
      }

      await hooks["chat.message"]!({ sessionID: "ses_fixture_workflow" } as never, output as never)

      const status = (output.parts[1] as { text: string }).text
      expect(status).toContain("fixture workflow is waiting for a schema migration")
      expect(status).not.toContain("Rembr injects memories")
      const queries = vi.mocked(fetch).mock.calls
        .filter(([url]) => String(url).endsWith("/mcp"))
        .map(([, init]) => JSON.parse(init.body).params.arguments.query)
      expect(queries).toEqual([
        "Tell me where we stopped with fixture workflow, answer only using Rembr injected memories",
        "fixture workflow",
      ])
    })

    it("preserves a short acronym subject as the focused query", async () => {
      const broad = JSON.stringify({ data: [
        { id: "rembr", category: "projects", content: "Rembr integration work.", semantic_similarity: 0.58 },
      ] })
      const focused = JSON.stringify({ data: [
        { id: "hour", category: "projects", content: "CI + Release Checklist review 3 was completed.", semantic_similarity: 0.66, text_match: true },
      ] })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url, init) => {
        if (String(url).endsWith("/health")) return Promise.resolve(new Response("ok", { status: 200 }))
        const query = JSON.parse(init.body).params.arguments.query
        return Promise.resolve(toolResult(query === "CI & release checklist" ? focused : broad))
      }))
      const hooks = await RembrPlugin(makeInput(), { ...PLUGIN_OPTIONS, minSimilarity: 0.3 })
      const output = {
        message: { id: "msg_acronym", sessionID: "ses_acronym" },
        parts: [{ type: "text", text: "Test Rembr recall about CI & release checklist" }],
      }

      await hooks["chat.message"]!({ sessionID: "ses_acronym" } as never, output as never)

      expect((output.parts[1] as { text: string }).text).toContain("CI + Release Checklist review 3")
      expect((output.parts[1] as { text: string }).text).not.toContain("Rembr integration work")
      const queries = vi.mocked(fetch).mock.calls
        .filter(([url]) => String(url).endsWith("/mcp"))
        .map(([, init]) => JSON.parse(init.body).params.arguments.query)
      expect(queries).toEqual([
        "Test Rembr recall about CI & release checklist",
        "CI & release checklist",
      ])
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

    it("does not inject unrelated recent context when a specific semantic search has no matches", async () => {
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(new Response("ok", { status: 200 }))
        .mockResolvedValueOnce(toolResult('{"success":true,"data":[]}'))
        .mockResolvedValueOnce(toolResult('{"success":true,"data":[{"id":"fact-001","category":"facts","content":"A generic unrelated fact.","metadata":{"directory":"/proj"}}]}')))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      const output = {
        message: { id: "msg_empty", sessionID: "ses_empty" },
        parts: [{ type: "text", text: "Find the SBOM generation decision" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_empty" } as never, output as never)

      expect(output.parts).toHaveLength(1)
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/mcp"))).toHaveLength(1)
    })

    it("rejects weak semantic neighbors without topical overlap", async () => {
      const results = JSON.stringify({ data: [
        { id: "rembr", category: "decisions", content: "The Rembr cache layer targets a single-node store with desktop clients.", semantic_similarity: 0.49 },
        { id: "tests", category: "facts", content: "The OpenCode Rembr package passes its unit tests.", semantic_similarity: 0.48 },
        { id: "migration", category: "projects", content: "The Rembr migration uses bounded checkpoints.", semantic_similarity: 0.44 },
        { id: "rule", category: "learning", content: "A proxy rule caused an unrelated deployment incident.", semantic_similarity: 0.32, text_match: true },
      ] })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) =>
        Promise.resolve(String(url).endsWith("/health")
          ? new Response("ok", { status: 200 })
          : toolResult(results)),
      ))
      const hooks = await RembrPlugin(makeInput(), { ...PLUGIN_OPTIONS, minSimilarity: 0.3 })
      const output = {
        message: { id: "msg_weak", sessionID: "ses_weak" },
        parts: [{ type: "text", text: "Explain the purple quasar frobnicator policy for ZXQ-9917" }],
      }

      await hooks["chat.message"]!({ sessionID: "ses_weak" } as never, output as never)

      expect(output.parts).toHaveLength(1)
    })

    it("fails closed when semantic recall is unavailable instead of injecting recent noise", async () => {
      const logs = vi.fn().mockResolvedValue({})
      const client = makeOpencodeClient()
      client.app.log = logs
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(new Response("ok", { status: 200 }))
        .mockResolvedValueOnce(toolResult(JSON.stringify({
          success: true,
          data: [],
          semantic_status: "failed",
          fallback_used: true,
          semantic_error: "embedding endpoint rejected the key",
        }))))
      const hooks = await RembrPlugin(makeInput(client), PLUGIN_OPTIONS)
      const output = {
        message: { id: "msg_semantic_down", sessionID: "ses_semantic_down" },
        parts: [{ type: "text", text: "Find the editor theme persistence decision" }],
      }

      await hooks["chat.message"]!({ sessionID: "ses_semantic_down" } as never, output as never)

      expect(output.parts).toHaveLength(1)
      expect(logs).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          level: "warn",
          message: "semantic memory recall unavailable; skipped unrelated recent fallback",
        }),
      }))
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

    it("retries starter recall after a transient failure", async () => {
      let mcpCalls = 0
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) => {
        if (String(url).endsWith("/health")) return Promise.resolve(new Response("ok", { status: 200 }))
        mcpCalls++
        if (mcpCalls <= 2) return Promise.reject(new TypeError("down"))
        return Promise.resolve(toolResult("- [mem_retry] recovered starter context"))
      }))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      const first = {
        message: { id: "msg_retry_1", sessionID: "ses_retry" },
        parts: [{ type: "text", text: "continue the work" }],
      }
      const second = {
        message: { id: "msg_retry_2", sessionID: "ses_retry" },
        parts: [{ type: "text", text: "continue the work" }],
      }

      await hooks["chat.message"]!({ sessionID: "ses_retry" } as never, first as never)
      expect(first.parts).toHaveLength(1)
      await hooks["chat.message"]!({ sessionID: "ses_retry" } as never, second as never)

      expect(second.parts).toHaveLength(3)
      expect((second.parts[1] as { text: string }).text).toContain("recovered starter context")
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
      expect(body.params.arguments.metadata.session_id).toBe("ses_9")
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

  describe("session.idle distillation", () => {
    const idleEvent = { type: "session.idle", properties: { sessionID: "ses_d" } }

    function makeDistillClient(reply: string) {
      const client = makeOpencodeClient() as ReturnType<typeof makeOpencodeClient> & {
        session: ReturnType<typeof makeOpencodeClient>["session"] & {
          create: ReturnType<typeof vi.fn>
          prompt: ReturnType<typeof vi.fn>
          delete: ReturnType<typeof vi.fn>
        }
      }
      // Ten messages to clear the default debounce threshold.
      client.session.messages = vi.fn().mockResolvedValue({
        data: Array.from({ length: 10 }, (_, i) => ({
          info: { role: i % 2 ? "assistant" : "user" },
          parts: [{ type: "text", text: `message ${i}` }],
        })),
      })
      client.session.create = vi.fn().mockResolvedValue({ data: { id: "ses_side" } })
      client.session.prompt = vi.fn().mockResolvedValue({
        data: { info: { role: "assistant" }, parts: [{ type: "text", text: reply }] },
      })
      client.session.delete = vi.fn().mockResolvedValue({ data: true })
      return client
    }

    it("distills via a side session and stores the memories", async () => {
      vi.stubEnv("REMBR_DISTILL", "true")
      vi.stubEnv("REMBR_STATE_DIR", mkdtempSync(join(tmpdir(), "rembr-idx-")))
      const client = makeDistillClient('{"memories": [{"content": "Team prefers pnpm", "category": "preferences", "tags": []}]}')
      const hooks = await RembrPlugin(makeInput(client as never), PLUGIN_OPTIONS)

      await hooks.event!({ event: idleEvent as never })

      expect(client.session.create).toHaveBeenCalled()
      expect(client.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ path: { id: "ses_side" } }),
      )
      expect(client.session.delete).toHaveBeenCalled()
      const body = lastMcpBody(vi.mocked(fetch))
      expect(body.params.arguments.content).toBe("Team prefers pnpm")
      expect(body.params.arguments.category).toBe("preferences")
      expect(body.params.arguments.metadata.distilled).toBe(true)
    })

    it("polls for the assistant when prompt returns the user message", async () => {
      vi.stubEnv("REMBR_DISTILL", "true")
      vi.stubEnv("REMBR_STATE_DIR", mkdtempSync(join(tmpdir(), "rembr-idx-")))
      const client = makeDistillClient('{"memories": [{"content": "OpenCode polling works", "category": "facts"}]}')
      const sourceMessages = Array.from({ length: 10 }, (_, i) => ({
        info: { role: i % 2 ? "assistant" : "user" },
        parts: [{ type: "text", text: `message ${i}` }],
      }))
      client.session.prompt.mockResolvedValue({
        data: { info: { role: "user" }, parts: [{ type: "text", text: "observer prompt" }] },
      })
      client.session.messages = vi
        .fn()
        .mockResolvedValueOnce({ data: sourceMessages })
        .mockResolvedValue({
          data: [
            {
              info: { role: "assistant", time: { completed: Date.now() } },
              parts: [
                {
                  type: "text",
                  text: '{"memories": [{"content": "OpenCode polling works", "category": "facts"}]}',
                },
              ],
            },
          ],
        })
      const hooks = await RembrPlugin(makeInput(client as never), PLUGIN_OPTIONS)

      await hooks.event!({ event: idleEvent as never })

      expect(lastMcpBody(vi.mocked(fetch)).params.arguments.content).toBe("OpenCode polling works")
    })

    it("debounces below the minimum message threshold", async () => {
      vi.stubEnv("REMBR_DISTILL", "true")
      vi.stubEnv("REMBR_STATE_DIR", mkdtempSync(join(tmpdir(), "rembr-idx-")))
      const client = makeDistillClient('{"memories": []}')
      client.session.messages = vi.fn().mockResolvedValue({
        data: [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }],
      })
      const hooks = await RembrPlugin(makeInput(client as never), PLUGIN_OPTIONS)

      await hooks.event!({ event: idleEvent as never })

      expect(client.session.create).not.toHaveBeenCalled()
      expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith("/mcp"))).toHaveLength(0)
    })

    it("advances the cursor so a repeated idle is a no-op", async () => {
      vi.stubEnv("REMBR_DISTILL", "true")
      vi.stubEnv("REMBR_STATE_DIR", mkdtempSync(join(tmpdir(), "rembr-idx-")))
      const client = makeDistillClient('{"memories": []}')
      const hooks = await RembrPlugin(makeInput(client as never), PLUGIN_OPTIONS)

      await hooks.event!({ event: idleEvent as never })
      expect(client.session.create).toHaveBeenCalledTimes(1)
      await hooks.event!({ event: idleEvent as never })
      expect(client.session.create).toHaveBeenCalledTimes(1)
    })

    it("does not start a second distillation pass for concurrent idle events", async () => {
      vi.stubEnv("REMBR_DISTILL", "true")
      vi.stubEnv("REMBR_STATE_DIR", mkdtempSync(join(tmpdir(), "rembr-idx-")))
      const client = makeDistillClient('{"memories": []}')
      let releasePrompt: (() => void) | undefined
      client.session.prompt.mockImplementation(() => new Promise((resolve) => {
        releasePrompt = () => resolve({
          data: { info: { role: "assistant" }, parts: [{ type: "text", text: '{"memories": []}' }] },
        })
      }))
      const hooks = await RembrPlugin(makeInput(client as never), PLUGIN_OPTIONS)

      const first = hooks.event!({ event: idleEvent as never })
      await vi.waitFor(() => expect(client.session.prompt).toHaveBeenCalledTimes(1))
      await hooks.event!({ event: idleEvent as never })
      expect(client.session.create).toHaveBeenCalledTimes(1)

      releasePrompt?.()
      await first
    })

    it("does not capture when REMBR_CAPTURE_DISABLE is set", async () => {
      vi.stubEnv("REMBR_DISTILL", "true")
      vi.stubEnv("REMBR_CAPTURE_DISABLE", "1")
      const client = makeDistillClient('{"memories": []}')
      const hooks = await RembrPlugin(makeInput(client as never), PLUGIN_OPTIONS)

      await hooks.event!({ event: idleEvent as never })

      expect(client.session.create).not.toHaveBeenCalled()
      expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith("/mcp"))).toHaveLength(0)
    })
  })
})
