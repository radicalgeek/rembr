import { describe, it, expect } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, DEFAULT_CONFIG } from "./config.js"

describe("loadConfig", () => {
  it("returns defaults when nothing is configured", () => {
    const config = loadConfig({ env: {} })
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(config.apiKey).toBeUndefined()
  })

  it("reads REMBR_* environment variables", () => {
    const config = loadConfig({
      env: {
        REMBR_URL: "https://self.hosted/mcp",
        REMBR_API_KEY: "mb_live_key",
        REMBR_AUTO_REMEMBER: "false",
        REMBR_MAX_RECALL: "5",
        REMBR_MIN_SIMILARITY: "0.85",
      },
    })
    expect(config.url).toBe("https://self.hosted/mcp")
    expect(config.apiKey).toBe("mb_live_key")
    expect(config.autoRemember).toBe(false)
    expect(config.maxRecall).toBe(5)
    expect(config.minSimilarity).toBe(0.85)
  })

  it("reads the project .opencode/rembr.json", () => {
    const worktree = mkdtempSync(join(tmpdir(), "rembr-test-"))
    mkdirSync(join(worktree, ".opencode"))
    writeFileSync(
      join(worktree, ".opencode", "rembr.json"),
      JSON.stringify({ url: "https://project.rembr/mcp", maxRecall: 3, captureCategory: "projects" }),
    )

    const config = loadConfig({ env: {}, worktree })
    expect(config.url).toBe("https://project.rembr/mcp")
    expect(config.maxRecall).toBe(3)
    expect(config.captureCategory).toBe("projects")
  })

  it("ignores invalid values in config files", () => {
    const worktree = mkdtempSync(join(tmpdir(), "rembr-test-"))
    mkdirSync(join(worktree, ".opencode"))
    writeFileSync(
      join(worktree, ".opencode", "rembr.json"),
      JSON.stringify({ captureCategory: "not-a-category", maxRecall: "ten" }),
    )

    const config = loadConfig({ env: {}, worktree })
    expect(config.captureCategory).toBe(DEFAULT_CONFIG.captureCategory)
    expect(config.maxRecall).toBe(DEFAULT_CONFIG.maxRecall)
  })

  it("tolerates a malformed config file", () => {
    const worktree = mkdtempSync(join(tmpdir(), "rembr-test-"))
    mkdirSync(join(worktree, ".opencode"))
    writeFileSync(join(worktree, ".opencode", "rembr.json"), "{not json")

    expect(loadConfig({ env: {}, worktree })).toEqual(DEFAULT_CONFIG)
  })

  it("gives plugin options highest precedence", () => {
    const worktree = mkdtempSync(join(tmpdir(), "rembr-test-"))
    mkdirSync(join(worktree, ".opencode"))
    writeFileSync(join(worktree, ".opencode", "rembr.json"), JSON.stringify({ url: "https://file/mcp" }))

    const config = loadConfig({
      env: { REMBR_URL: "https://env/mcp", REMBR_API_KEY: "env-key" },
      worktree,
      options: { url: "https://options/mcp", autoRemember: false },
    })
    expect(config.url).toBe("https://options/mcp")
    expect(config.apiKey).toBe("env-key")
    expect(config.autoRemember).toBe(false)
  })
})
