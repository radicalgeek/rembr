import { describe, it, expect, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, DEFAULT_CONFIG } from "./config.js"

// os.homedir() on Windows does not read HOME or USERPROFILE from process.env,
// so tests that need a controlled home directory override it here.
const fakeHomeDir = vi.hoisted(() => ({ value: undefined as string | undefined }))
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, homedir: () => fakeHomeDir.value ?? actual.homedir() }
})

// Point REMBR_STATE_DIR at an empty directory so a real ~/.rembr/config.json
// on the developer's machine cannot leak into these assertions.
const isolated = () => ({ REMBR_STATE_DIR: mkdtempSync(join(tmpdir(), "rembr-state-")) })

describe("loadConfig", () => {
  it("returns defaults when nothing is configured", () => {
    const config = loadConfig({ env: isolated() })
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(config.apiKey).toBeUndefined()
    expect(config.minSimilarity).toBe(0.5)
  })

  it("reads REMBR_* environment variables", () => {
    const config = loadConfig({
      env: {
        ...isolated(),
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

  it("reads the shared ~/.rembr/config.json, below the opencode-specific file", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rembr-state-"))
    writeFileSync(
      join(stateDir, "config.json"),
      JSON.stringify({ url: "https://shared.rembr/mcp", apiKey: "shared-key", maxRecall: 7 }),
    )

    const config = loadConfig({ env: { REMBR_STATE_DIR: stateDir } })
    expect(config.url).toBe("https://shared.rembr/mcp")
    expect(config.apiKey).toBe("shared-key")
    expect(config.maxRecall).toBe(7)

    // an opencode-specific project file still wins over the shared one
    const worktree = mkdtempSync(join(tmpdir(), "rembr-test-"))
    mkdirSync(join(worktree, ".opencode"))
    writeFileSync(join(worktree, ".opencode", "rembr.json"), JSON.stringify({ url: "https://project.rembr/mcp" }))

    const merged = loadConfig({ env: { REMBR_STATE_DIR: stateDir }, worktree })
    expect(merged.url).toBe("https://project.rembr/mcp")
    expect(merged.apiKey).toBe("shared-key")
  })

  it("reads the OpenCode config file from XDG_CONFIG_HOME when it is set", () => {
    const xdgHome = mkdtempSync(join(tmpdir(), "rembr-xdg-"))
    mkdirSync(join(xdgHome, "opencode"))
    writeFileSync(join(xdgHome, "opencode", "rembr.json"), JSON.stringify({ url: "https://xdg.rembr/mcp" }))

    const config = loadConfig({ env: { ...isolated(), XDG_CONFIG_HOME: xdgHome } })
    expect(config.url).toBe("https://xdg.rembr/mcp")
  })

  it("falls back to ~/.config/opencode when XDG_CONFIG_HOME is empty", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "rembr-home-"))
    mkdirSync(join(fakeHome, ".config", "opencode"), { recursive: true })
    writeFileSync(join(fakeHome, ".config", "opencode", "rembr.json"), JSON.stringify({ url: "https://home.rembr/mcp" }))

    fakeHomeDir.value = fakeHome
    try {
      const config = loadConfig({ env: { ...isolated(), XDG_CONFIG_HOME: "" } })
      expect(config.url).toBe("https://home.rembr/mcp")
    } finally {
      fakeHomeDir.value = undefined
    }
  })

  it("reads the project .opencode/rembr.json", () => {
    const worktree = mkdtempSync(join(tmpdir(), "rembr-test-"))
    mkdirSync(join(worktree, ".opencode"))
    writeFileSync(
      join(worktree, ".opencode", "rembr.json"),
      JSON.stringify({ url: "https://project.rembr/mcp", maxRecall: 3, captureCategory: "projects" }),
    )

    const config = loadConfig({ env: isolated(), worktree })
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

    const config = loadConfig({ env: isolated(), worktree })
    expect(config.captureCategory).toBe(DEFAULT_CONFIG.captureCategory)
    expect(config.maxRecall).toBe(DEFAULT_CONFIG.maxRecall)
  })

  it("tolerates a malformed config file", () => {
    const worktree = mkdtempSync(join(tmpdir(), "rembr-test-"))
    mkdirSync(join(worktree, ".opencode"))
    writeFileSync(join(worktree, ".opencode", "rembr.json"), "{not json")

    expect(loadConfig({ env: isolated(), worktree })).toEqual(DEFAULT_CONFIG)
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
