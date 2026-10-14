import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { loadRecallHookConfig, runRecallHook } from "./recall-hook.js"
import type { RecallClient } from "./recall.js"

const ENV = {
  REMBR_API_KEY: "stale-key",
  REMBR_URL: "https://stale.test/mcp",
}
const home = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-rembr-recall-"))
const profile = path.join(home, "codex.env")
fs.writeFileSync(profile, "REMBR_URL=https://fixture.test/mcp\nREMBR_API_KEY=profile-key\n")
afterAll(() => {
  fs.unlinkSync(profile)
  fs.rmdirSync(home)
})

describe("Codex prompt hook", () => {
  it("uses OpenCode-compatible local defaults", () => {
    const config = loadRecallHookConfig(ENV, profile)
    expect(config.recallLimit).toBe(10)
    expect(config.minSimilarity).toBe(0.3)
    expect(config.url).toBe("https://fixture.test/mcp")
  })

  it("injects once per session", async () => {
    const client: RecallClient = {
      recall: vi.fn().mockResolvedValue(JSON.stringify({
        data: [{ id: "one", category: "facts", content: "Relevant result.", semantic_similarity: 0.7 }],
      })),
      recent: vi.fn().mockResolvedValue('{"data":[]}'),
    }
    const claim = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    const input = { session_id: "ses-1", prompt: "Explain the relevant deployment result", cwd: "/repo" }

    const first = await runRecallHook(input, ENV, client, claim, profile)
    const second = await runRecallHook(input, ENV, client, claim, profile)

    expect(first.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit")
    expect(first.hookSpecificOutput?.additionalContext).toContain("Relevant result")
    expect(second).toEqual({ continue: true })
    expect(client.recall).toHaveBeenCalledTimes(1)
  })

  it("honors recursion and recall disable guards", async () => {
    const client: RecallClient = {
      recall: vi.fn(),
      recent: vi.fn(),
    }
    const input = { session_id: "ses-1", prompt: "Explain the deployment architecture", cwd: "/repo" }
    expect(await runRecallHook(input, { ...ENV, REMBR_CAPTURE_DISABLE: "1" }, client, undefined, null)).toEqual({ continue: true })
    expect(await runRecallHook(input, { ...ENV, REMBR_PROMPT_RECALL: "false" }, client, undefined, null)).toEqual({ continue: true })
    expect(client.recall).not.toHaveBeenCalled()
  })

  it("does not claim a session when configuration is missing", async () => {
    const claim = vi.fn()
    const result = await runRecallHook(
      { session_id: "session-without-config", prompt: "Check durable context" },
      {},
      undefined,
      claim,
      null,
    )
    expect(result).toEqual({ continue: true })
    expect(claim).not.toHaveBeenCalled()
  })
})
