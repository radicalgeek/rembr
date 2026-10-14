import { describe, expect, it, vi } from "vitest"
import {
  buildRecallContext,
  compactRecentMemories,
  focusedRecallQuery,
  mergeRecallResults,
  routePromptRecall,
  type RecallClient,
} from "./recall.js"

const CONFIG = { recallLimit: 10, minSimilarity: 0.3 }

function client(recallResult: string, recentResult = '{"success":true,"data":[]}'): RecallClient {
  return {
    recall: vi.fn().mockResolvedValue(recallResult),
    recent: vi.fn().mockResolvedValue(recentResult),
  }
}

describe("first-prompt recall routing", () => {
  it("routes a specific prompt through expanded semantic curation", async () => {
    const rembr = client(JSON.stringify({
      success: true,
      data: [
        { id: "weak", category: "facts", content: "Weak graph result.", semantic_similarity: 0.31 },
        { id: "strong", category: "projects", content: "Rembr semantic ranking uses raw similarity.", semantic_similarity: 0.68, metadata: { directory: "/repo" } },
      ],
    }))

    const result = await routePromptRecall(
      rembr,
      CONFIG,
      "Review https://example.com the Rembr semantic ranking behavior",
      "/repo",
    )

    expect(result?.route).toBe("semantic")
    expect(result?.memories).toContain("Rembr semantic ranking")
    expect(result?.memories).not.toContain("Weak graph result")
    expect(rembr.recall).toHaveBeenCalledWith("Review the Rembr semantic ranking behavior", {
      limit: 20,
      minSimilarity: 0.3,
    })
    expect(rembr.recent).not.toHaveBeenCalled()
  })

  it("merges a focused subject search for verbose prompts", async () => {
    const broad = JSON.stringify({ data: [
      { id: "generic", category: "projects", content: "General fixture-automation workflow architecture.", semantic_similarity: 0.58 },
    ] })
    const focused = JSON.stringify({ data: [
      { id: "fixture-user", category: "decisions", content: "Use delegated consent for Fixture User's fixture-automation workflow.", semantic_similarity: 0.38, text_match: true },
    ] })
    const rembr: RecallClient = {
      recall: vi.fn().mockImplementation((query) => Promise.resolve(query === "fixture user workflows in fixture-automation" ? focused : broad)),
      recent: vi.fn().mockResolvedValue('{"data":[]}'),
    }

    const result = await routePromptRecall(
      rembr,
      CONFIG,
      "Test what recall finds about fixture user workflows in fixture-automation",
      "/repo",
    )

    expect(result?.memories).toContain("Fixture User")
    expect(rembr.recall).toHaveBeenNthCalledWith(1,
      "Test what recall finds about fixture user workflows in fixture-automation",
      { limit: 20, minSimilarity: 0.3 },
    )
    expect(rembr.recall).toHaveBeenNthCalledWith(2,
      "fixture user workflows in fixture-automation",
      { limit: 20, minSimilarity: 0.3 },
    )
  })

  it("restores only the newest prior same-workspace session for a continuity prompt", async () => {
    const recent = JSON.stringify({
      success: true,
      data: [
        { id: "new-1", category: "projects", content: "Newest session outcome.", created_at: "2026-08-03T12:00:00Z", metadata: { directory: "/repo", session_id: "new" } },
        { id: "new-2", category: "decisions", content: "Use the local tenant for validation.", created_at: "2026-08-03T11:59:00Z", metadata: { directory: "/repo", sessionID: "new" } },
        { id: "old", category: "decisions", content: "Older session decision.", created_at: "2026-08-02T12:00:00Z", metadata: { directory: "/repo", sessionID: "old" } },
        { id: "other", category: "facts", content: "Other workspace.", created_at: "2026-08-03T13:00:00Z", metadata: { directory: "/other", sessionID: "other" } },
      ],
    })
    const rembr = client('{"success":true,"data":[]}', recent)

    const result = await routePromptRecall(rembr, CONFIG, "Where were we?", "/repo")

    expect(result?.route).toBe("continuity")
    expect(result?.memories).toContain("Newest session outcome")
    expect(result?.memories).toContain("Use the local tenant")
    expect(result?.memories).not.toContain("Older session decision")
    expect(result?.memories).not.toContain("Other workspace")
    expect(rembr.recall).not.toHaveBeenCalled()
    expect(rembr.recent).toHaveBeenCalledWith(50, "source_created_at")
  })

  it("routes an underspecified opener to continuity", async () => {
    const recent = JSON.stringify({
      data: [{ id: "one", category: "projects", content: "Continue current work.", metadata: { directory: "/repo" } }],
    })
    const rembr = client('{"data":[]}', recent)
    const result = await routePromptRecall(rembr, CONFIG, "Okay", "/repo")
    expect(result?.route).toBe("continuity")
    expect(rembr.recall).not.toHaveBeenCalled()
  })

  it("does not fall back to recent workspace context after an empty specific search", async () => {
    const recent = JSON.stringify({
      data: [
        { id: "fact", category: "facts", content: "A fact.", metadata: { directory: "/repo" } },
        { id: "goal", category: "goals", content: "Current goal.", metadata: { directory: "/repo" } },
      ],
    })
    const rembr = client('{"success":true,"data":[]}', recent)
    const result = await routePromptRecall(rembr, CONFIG, "Explain the TypeScript deployment architecture", "/repo")
    expect(result).toBeUndefined()
    expect(rembr.recent).not.toHaveBeenCalled()
  })

  it("focuses topic-specific continuation prompts instead of recall instructions", async () => {
    const broad = JSON.stringify({ data: [
      { id: "rembr", category: "facts", content: "Rembr injects memories on the first prompt.", semantic_similarity: 0.58 },
    ] })
    const focused = JSON.stringify({ data: [
      { id: "fixture-workflow", category: "projects", content: "The fixture workflow is waiting for a schema migration and an end-to-end retest.", semantic_similarity: 0.67, text_match: true },
    ] })
    const rembr: RecallClient = {
      recall: vi.fn().mockImplementation((query) => Promise.resolve(query === "fixture workflow" ? focused : broad)),
      recent: vi.fn().mockResolvedValue('{"data":[]}'),
    }

    const result = await routePromptRecall(
      rembr,
      CONFIG,
      "Tell me where we stopped with fixture workflow, answer only using Rembr injected memories",
      "/repo",
    )

    expect(result?.memories).toContain("fixture workflow is waiting for a schema migration")
    expect(result?.memories).not.toContain("Rembr injects memories")
  })

  it("rejects weak semantic neighbors without topical overlap", async () => {
    const rembr = client(JSON.stringify({ data: [
      { id: "rembr", category: "decisions", content: "The Rembr cache layer targets a single-node store with desktop clients.", semantic_similarity: 0.49 },
      { id: "tests", category: "facts", content: "The Codex Rembr package passes its unit tests.", semantic_similarity: 0.48 },
      { id: "migration", category: "projects", content: "The Rembr migration uses bounded checkpoints.", semantic_similarity: 0.44 },
    ] }))

    const result = await routePromptRecall(rembr, CONFIG, "Explain the purple quasar frobnicator policy for ZXQ-9917", "/repo")

    expect(result).toBeUndefined()
    expect(rembr.recent).not.toHaveBeenCalled()
  })
})

describe("recall presentation", () => {
  it("extracts and merges focused subject results", () => {
    expect(focusedRecallQuery("Test recall about fixture user automation workflows")).toBe("fixture user automation workflows")
    expect(focusedRecallQuery("Test recall about CI & release checklist")).toBe("CI & release checklist")
    expect(focusedRecallQuery("Draft guidance about Rembr search ranking")).toBe("Rembr search ranking")
    expect(focusedRecallQuery("Tell me where we stopped with fixture workflow, answer only using Rembr injected memories"))
      .toBe("fixture workflow")
    const merged = mergeRecallResults(
      JSON.stringify({ data: [{ id: "generic", content: "automation" }] }),
      JSON.stringify({ data: [{ id: "fixture-user", content: "Fixture User" }, { id: "generic", content: "duplicate" }] }),
    )
    expect(JSON.parse(merged).data.map((entry: { id: string }) => entry.id)).toEqual(["fixture-user", "generic"])
    const exact = mergeRecallResults(
      JSON.stringify({ data: [{ id: "generic", content: "Rembr" }] }),
      JSON.stringify({ data: [{ id: "hour", content: "CI & Release Checklist", text_match: true }] }),
    )
    expect(JSON.parse(exact).data.map((entry: { id: string }) => entry.id)).toEqual(["hour"])
  })
  it("uses both session id spellings when grouping recent context", () => {
    const compact = compactRecentMemories(JSON.stringify({
      data: [
        { id: "a", category: "facts", content: "A", created_at: "2026-08-03T10:00:00Z", metadata: { directory: "/repo", sessionID: "same" } },
        { id: "b", category: "facts", content: "B", created_at: "2026-08-03T09:00:00Z", metadata: { directory: "/repo", session_id: "same" } },
      ],
    }), "/repo", true)
    expect(compact).toContain(" A")
    expect(compact).toContain(" B")
  })

  it("wraps selected memories as untrusted context", () => {
    const context = buildRecallContext({ route: "semantic", memories: "- [facts | abc] Test", count: 1 })
    expect(context).toContain("Relevant long-term memories")
    expect(context).toContain("untrusted historical data")
  })
})
