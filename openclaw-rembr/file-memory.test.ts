import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { FileMemory } from "./file-memory.js"
import * as fs from "node:fs"

beforeEach(() => {
  if (!fs.existsSync("cache")) fs.mkdirSync("cache", { recursive: true })
})

afterEach(() => {
  if (fs.existsSync("mem.jsonl")) fs.rmSync("mem.jsonl")
  if (fs.existsSync("cache/mem.jsonl.json")) fs.rmSync("cache/mem.jsonl.json")
})

function makeStore(path = "mem.jsonl") {
  return new FileMemory({ storePath: path, cachePath: `cache/${path}.json` })
}

describe("FileMemory", () => {
  it("stores an entry and returns the same recall lines Rembr returns", () => {
    const store = makeStore()
    const entry = store.store("deploys happen on fridays", "facts", { importance: 0.9 })
    const results = store.search("deploys fridays")
    expect(results).toContain(`- [${entry.id}] deploys happen on fridays`)
  })

  it("returns a matching line when the category matches", () => {
    const store = makeStore()
    store.store("user prefers tabs", "preferences", {})
    const results = store.search("preferences")
    expect(results).toContain(`- [${store["readAll"]()[0].id}] user prefers tabs`)
  })

  it("deletes an entry by id and returns the id", () => {
    const store = makeStore()
    const entry = store.store("delete me", "facts", {})
    expect(store.delete(entry.id)).toBe(entry.id)
    expect(store.search("delete me")).toBe("")
    expect(store.delete("missing")).toBe("")
  })

  it("persists across instances (durable JSONL append)", () => {
    const store = makeStore()
    store.store("durable entry", "facts", {})
    const reopened = new FileMemory({ storePath: "mem.jsonl", cachePath: "cache/mem.jsonl.json" })
    expect(reopened.search("durable")).toContain("durable entry")
  })

  it("skips corrupt lines without losing the store", () => {
    const store = makeStore()
    store.store("good entry", "facts", {})
    fs.appendFileSync("mem.jsonl", "not-json\n")
    const reopened = new FileMemory({ storePath: "mem.jsonl", cachePath: "cache/mem.jsonl.json" })
    expect(reopened.search("good entry")).toContain("good entry")
    expect(reopened.search("not-json")).toBe("")
  })

  it("respects the limit option", () => {
    const store = makeStore()
    store.store("alpha one", "facts", {})
    store.store("beta two", "facts", {})
    const results = store.search("facts", { limit: 1 })
    expect(results.split("\n")).toHaveLength(1)
  })

  it("reports size", () => {
    const store = makeStore()
    expect(store.size()).toBe(0)
    store.store("entry one", "facts", {})
    expect(store.size()).toBe(1)
  })
})
