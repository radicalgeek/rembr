import { describe, it, expect } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { idleSessionFiles, listSessionFiles, loadWatchConfig } from "./watch.js"

describe("loadWatchConfig", () => {
  it("uses Codex defaults and env overrides", () => {
    const config = loadWatchConfig({
      CODEX_SESSIONS_DIR: "C:/tmp/codex",
      REMBR_CODEX_WATCH_POLL_MS: "500",
      REMBR_CODEX_WATCH_IDLE_MS: "1500",
    })
    expect(config.sessionsDir).toBe("C:/tmp/codex")
    expect(config.pollMs).toBe(500)
    expect(config.idleMs).toBe(1500)
  })
})

describe("session file discovery", () => {
  it("lists JSONL session files recursively newest first", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-watch-"))
    const nested = join(root, "2026", "07", "08")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(root, "ignore.txt"), "x")
    writeFileSync(join(nested, "a.jsonl"), "{}\n")
    writeFileSync(join(nested, "b.jsonl"), "{}\n")

    const files = listSessionFiles(root)
    expect(files).toHaveLength(2)
    expect(files.every((file) => file.path.endsWith(".jsonl"))).toBe(true)
  })

  it("filters files that have been idle long enough", () => {
    const files = [
      { path: "old.jsonl", mtimeMs: 1_000 },
      { path: "fresh.jsonl", mtimeMs: 9_500 },
    ]
    expect(idleSessionFiles(files, 10_000, 1_000).map((file) => file.path)).toEqual(["old.jsonl"])
  })
})
