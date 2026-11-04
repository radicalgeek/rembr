import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadBridgeConfig } from "./bridge-config.js"

const tempDirs: string[] = []

function createProfile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-rembr-config-"))
  tempDirs.push(dir)
  const profile = path.join(dir, "codex.env")
  fs.writeFileSync(profile, content)
  return profile
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    for (const entry of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, entry))
    fs.rmdirSync(dir)
  }
})

describe("Codex profile configuration", () => {
  it("applies bounded tuning without taking credentials from the environment", () => {
    const profile = createProfile("REMBR_URL=https://fixture.test/mcp\nREMBR_API_KEY=profile-key\n")
    const config = loadBridgeConfig({ REMBR_RECALL_LIMIT: "5", REMBR_MIN_SIMILARITY: "0.85" }, profile)
    expect(config).toMatchObject({ url: "https://fixture.test/mcp", apiKey: "profile-key", recallLimit: 5, minSimilarity: 0.85 })
    expect(loadBridgeConfig({ REMBR_RECALL_LIMIT: "999" }, profile).recallLimit).toBe(10)
  })

  it("prefers the complete Codex profile over inherited environment values", () => {
    const profile = createProfile('REMBR_URL="https://profile.test/mcp"\nREMBR_API_KEY=profile-key\n')
    const config = loadBridgeConfig({ REMBR_URL: "https://environment.test/mcp", REMBR_API_KEY: "environment-key" }, profile)

    expect(config.url).toBe("https://profile.test/mcp")
    expect(config.apiKey).toBe("profile-key")
  })

  it("rejects a partial profile rather than mixing credentials from different sources", () => {
    const profile = createProfile("REMBR_URL=https://profile.test/mcp\n")

    expect(() => loadBridgeConfig({ REMBR_API_KEY: "environment-key" }, profile)).toThrow(/both REMBR_URL and REMBR_API_KEY/)
  })

  it("rejects inherited credentials when the setup profile is missing", () => {
    expect(() => loadBridgeConfig({ REMBR_URL: "https://environment.test/mcp", REMBR_API_KEY: "environment-key" }, null)).toThrow(/setup skill/)
  })

  it("switches both endpoint and key when setup replaces the profile", () => {
    const profile = createProfile("REMBR_URL=http://127.0.0.1:3000/mcp\nREMBR_API_KEY=local-key\n")
    const env = { REMBR_URL: "https://environment.test/mcp", REMBR_API_KEY: "environment-key" }
    expect(loadBridgeConfig(env, profile)).toMatchObject({ url: "http://127.0.0.1:3000/mcp", apiKey: "local-key" })
    fs.writeFileSync(profile, "REMBR_URL=https://fixture.test/mcp\nREMBR_API_KEY=remote-key\n")
    expect(loadBridgeConfig(env, profile)).toMatchObject({ url: "https://fixture.test/mcp", apiKey: "remote-key" })
  })
})
