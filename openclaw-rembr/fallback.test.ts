import { describe, it, expect, vi, afterEach } from "vitest"
import { FallbackMemory } from "./fallback.js"
import { FileMemory } from "./file-memory.js"
import * as fs from "node:fs"

// Minimal stand-in for RembrClient used to exercise FallbackMemory in isolation.
class FakeRembrClient {
  public calls: Array<{ op: string; args: unknown[] }> = []
  private behavior: () => Promise<string>
  private fail: boolean
  constructor(behavior: () => Promise<string>, fail = false) {
    this.behavior = behavior
    this.fail = fail
  }
  async remember(_content: string, _category?: string, _metadata?: Record<string, unknown>) {
    this.calls.push({ op: "store", args: arguments as unknown as unknown[] })
    return this.behavior()
  }
  async recall(_query: string, _options?: { limit?: number; minSimilarity?: number }) {
    this.calls.push({ op: "recall", args: arguments as unknown as unknown[] })
    return this.behavior()
  }
  async forget(_id: string) {
    this.calls.push({ op: "forget", args: arguments as unknown as unknown[] })
    return this.behavior()
  }
  async health() {
    if (this.fail) throw new Error("down")
    return true
  }
}

function makeFallback(client: FakeRembrClient, opts: { fallbackOnFailure?: boolean } = {}) {
  const file = new FileMemory({ storePath: "mem.jsonl" })
  return new FallbackMemory({
    client: client as never,
    fileMemory: file,
    fallbackOnFailure: opts.fallbackOnFailure ?? true,
    timeoutMs: 2000,
    maxProbeIntervalMs: 60000,
  })
}

afterEach(() => {
  if (fs.existsSync("mem.jsonl")) fs.rmSync("mem.jsonl")
})

describe("FallbackMemory", () => {
  it("routes recall to Rembr and returns its results", async () => {
    const client = new FakeRembrClient(async () => "- [mem_1] user prefers tabs")
    const fb = makeFallback(client)
    const results = await fb.recall("formatting", {}, () => {})
    expect(results).toContain("user prefers tabs")
    expect(client.calls[0].op).toBe("recall")
    expect(fb.isFallbackActive()).toBe(false)
  })

  it("falls back to local file memory when Rembr throws", async () => {
    const failing = new FakeRembrClient(async () => {
      throw new Error("network down")
    })
    const fb = makeFallback(failing)
    const results = await fb.recall("formatting", {}, () => {})
    expect(results).toBe("")
    expect(fb.isFallbackActive()).toBe(true)
  })

  it("stores to Rembr and falls back to local store on failure", async () => {
    const failing = new FakeRembrClient(async () => {
      throw new Error("boom")
    })
    const fb = makeFallback(failing)
    const response = await fb.remember("deploys happen on fridays", "facts", { source: "x" }, () => {})
    // FileMemory returns the same id-form result Rembr returns (a confirmation
    // string carrying the entry id), so the caller branches on nothing.
    expect(response).toMatch(/^[0-9a-f-]{36}$/)
    expect(fb.isFallbackActive()).toBe(true)
  })

  it("forgets locally on Rembr failure", async () => {
    const failing = new FakeRembrClient(async () => {
      throw new Error("boom")
    })
    const fb = makeFallback(failing)
    await fb.remember("delete me", "facts", {}, () => {})
    const resp = await fb.forget("whatever", () => {})
    expect(resp).toBe("")
  })

  it("returns the fallback result when fallbackOnFailure is disabled", async () => {
    const failing = new FakeRembrClient(async () => {
      throw new Error("boom")
    })
    const fb = makeFallback(failing, { fallbackOnFailure: false })
    const response = await fb.recall("x", {}, () => {})
    expect(response).toBe("")
    expect(fb.isFallbackActive()).toBe(false)
  })

  it("resumes Rembr after a successful call once it recovers", async () => {
    let down = true
    const toggle = new FakeRembrClient(async () => {
      if (down) throw new Error("down")
      return "- [mem_1] recovered"
    })
    const fb = makeFallback(toggle)
    const first = await fb.recall("formatting", {}, () => {})
    expect(first).toBe("")
    expect(fb.isFallbackActive()).toBe(true)
    down = false
    const second = await fb.recall("formatting", {}, () => {})
    expect(second).toContain("recovered")
    expect(fb.isFallbackActive()).toBe(false)
  })

  it("probes Rembr health without throwing", async () => {
    const ok = new FakeRembrClient(async () => "ok")
    const fb = makeFallback(ok)
    const res = await fb.probe()
    expect(res.reachable).toBe(true)

    const bad = new FakeRembrClient(async () => "ok", true)
    const fb2 = makeFallback(bad)
    const res2 = await fb2.probe()
    expect(res2.reachable).toBe(false)
    expect(res2.error).toBeTruthy()
  })

  it("logs a fallback reason via the onFallback callback", async () => {
    const failing = new FakeRembrClient(async () => {
      throw new Error("transient")
    })
    const fb = makeFallback(failing)
    const onFallback = vi.fn()
    await fb.recall("formatting", {}, onFallback)
    expect(onFallback).toHaveBeenCalledWith(expect.stringContaining("transient"))
  })
})
