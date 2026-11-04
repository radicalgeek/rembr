import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"

const spawnMock = vi.fn()
vi.mock("node:child_process", () => ({ spawn: (...args) => spawnMock(...args) }))

const { distillTranscript, loadDistillConfig } = await import("./distill-lib.mjs")

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.kill = () => {}
  return child
}

describe("distillTranscript secret filter logging", () => {
  it("logs only a count for secret-shaped memories, never their content", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-rembr-log-"))
    const transcript = path.join(stateDir, "fixture-session.jsonl")
    const records = Array.from({ length: 3 }, (_, i) => JSON.stringify({ type: "user", message: { content: `Fixture request ${i}` } }))
    fs.writeFileSync(transcript, records.join("\n") + "\n")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const config = loadDistillConfig({ REMBR_STATE_DIR: stateDir, REMBR_DISTILL_MIN_RECORDS: "1", REMBR_DISTILL: "true" })

    const pending = distillTranscript(config, { url: "http://example.test/mcp", apiKey: "" }, transcript, "fixture-session")
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    const result = JSON.stringify({ memories: [{ content: "password=fixture-secret-value", category: "facts" }] })
    child.stdout.end(JSON.stringify({ result }))
    await new Promise((resolve) => setImmediate(resolve))
    child.emit("close", 0)
    await pending

    const log = fs.readFileSync(config.logFile, "utf8")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(log).toContain("skipped-secret-shape: 1 memories")
    expect(log).not.toContain("fixture-secret-value")
    vi.unstubAllGlobals()
  })
})
