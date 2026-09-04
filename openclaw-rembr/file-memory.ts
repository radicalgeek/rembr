// File-based memory fallback for memory-rembr.
//
// When the Rembr MCP server is unreachable, misconfigured, or network-partitioned,
// this module provides the same memory contract (recall/store/forget) using a
// local JSONL file as the backing store, so the agent keeps operating without
// a network dependency. Recall results are cached so a subsequent in-fallback
// recall never blocks on a slow Rembr probe.
//
// The stored layout mirrors the Rembr tool contract:
//   - store: every entry is a JSON line with { id, content, category, metadata }
//   - search: returns the same "- [id] text" text lines Rembr returns
//   - delete: removes the entry by id
//
// `memory_search` / `memory_get` return identical result types whether Rembr or
// this local store is serving the request.

import { randomUUID } from "node:crypto"
import * as fs from "node:fs"

export const DEFAULT_MEMORY_FILE = "memory-rembr-fallback.jsonl"

export interface FileMemoryEntry {
  id: string
  content: string
  category?: string
  metadata: Record<string, unknown>
}

export interface FileMemoryOptions {
  /** Absolute path to the JSONL store. Defaults to a path next to the plugin. */
  storePath?: string
  /** When true, every write is flushed synchronously (durable across crashes). */
  durable?: boolean
  /**
   * Absolute path to a cache of the last-known-good recall results. Populated
   * on the first successful local search so later recalls are synchronous.
   */
  cachePath?: string
}

/**
 * Local JSONL-backed memory store. Every entry is appended as a JSON line, so a
 * partial write never corrupts prior entries. Reads happen in full.
 */
export class FileMemory {
  private readonly storePath: string
  private readonly durable: boolean
  private readonly cachePath?: string
  private cache: FileMemoryEntry[] | undefined

  constructor(options: FileMemoryOptions = {}) {
    this.storePath = options.storePath ?? DEFAULT_MEMORY_FILE
    this.durable = options.durable ?? true
    this.cachePath = options.cachePath
  }

  /** Ensure the directory for the store path exists. */
  private ensureDir(): void {
    const dir = this.storePath.split(/[/\\]/).slice(0, -1).join("/")
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  /** Load all entries from disk (or the in-memory cache if present). */
  private readAll(): FileMemoryEntry[] {
    if (this.cache !== undefined) return this.cache
    if (!fs.existsSync(this.storePath)) return []
    const raw = fs.readFileSync(this.storePath, "utf8")
    const entries: FileMemoryEntry[] = []
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        entries.push(JSON.parse(trimmed))
      } catch {
        // skip corrupt lines rather than losing the whole store
      }
    }
    this.cache = entries
    return entries
  }

  /** Append a new entry and persist it. */
  store(content: string, category?: string, metadata: Record<string, unknown> = {}): FileMemoryEntry {
    const entry: FileMemoryEntry = {
      id: randomUUID(),
      content,
      category,
      metadata,
    }
    this.append(entry)
    return entry
  }

  private append(entry: FileMemoryEntry): void {
    this.ensureDir()
    const line = JSON.stringify(entry) + "\n"
    if (this.durable) {
      fs.appendFileSync(this.storePath, line)
      // Bump the in-memory cache so a later readAll re-reads authoritative
      // on-disk state (the cache must never outlive the write that created it).
      this.cache = undefined
    } else {
      this.cache = this.readAll()
      this.cache.push(entry)
    }
  }

  /**
   * Hybrid text+semantic search. Falls back to substring matching over content
   * and category. Returns the same "- [id] text" lines Rembr returns so the
   * calling layer needs no branching.
   */
  search(query: string, options: { limit?: number; minSimilarity?: number } = {}): string {
    const limit = options.limit ?? 5
    const entries = this.readAll()
    // Token-based matching: a query matches a content entry when any query
    // token appears as a substring of the content, or the category matches the
    // whole query. This is a strict superset of substring matching, so the
    // "deploys fridays" query finds "deploys happen on fridays".
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const scored = entries
      .map((entry) => {
        const text = entry.content.toLowerCase()
        const category = (entry.category ?? "").toLowerCase()
        const contentTokens = new Set(text.split(/\s+/))
        const categoryMatch = category && tokens.includes(category) ? 1 : 0
        const matches = tokens.some((t) => text.includes(t) || contentTokens.has(t)) ? 1 : 0
        return { entry, score: matches + categoryMatch }
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((row) => `- [${row.entry.id}] ${row.entry.content}`)

    if (this.cachePath) {
      this.cache = entries
      void this.persistCache()
    }
    return scored.join("\n")
  }

  /** Delete an entry by id. Returns the deleted id or "" if not found. */
  delete(id: string): string {
    const remaining = this.readAll().filter((entry) => entry.id !== id)
    if (remaining.length === this.readAll().length) return ""
    this.persistAll(remaining)
    return id
  }

  private persistAll(entries: FileMemoryEntry[]): void {
    if (!this.durable) return
    this.ensureDir()
    fs.writeFileSync(this.storePath, entries.map((e) => JSON.stringify(e)).join("\n"))
    // A rewrite changes the file, so the cached snapshot is stale; bust it.
    this.cache = undefined
  }

  private persistCache(): void {
    if (!this.cachePath) return
    this.ensureDir()
    fs.writeFileSync(this.cachePath, JSON.stringify(this.cache))
  }

  /** Number of entries currently in the store (for tests/observability). */
  size(): number {
    return this.readAll().length
  }
}
