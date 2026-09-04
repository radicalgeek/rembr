// Resilient memory access layer: wraps RembrClient with a file-based fallback.
//
// Every Rembr call is attempted against the live server; on any failure the call
// is routed to the local FileMemory store so the agent keeps operating offline.
// The last-known-good recall results are cached so an in-fallback recall never
// blocks on a slow Rembr probe, and Rembr is periodically re-probed and retried.

import { RembrClient } from "./rembr-client.js"
import { FileMemory } from "./file-memory.js"

export interface FallbackMemoryConfig {
  client: RembrClient
  fileMemory: FileMemory
  fallbackOnFailure: boolean
  /** Max ms to wait for a live Rembr call before falling back. */
  timeoutMs: number
  /** When in fallback mode, interval between re-probes (exponential backoff cap). */
  probeIntervalMs: number
  /** When in fallback mode, cap for exponential backoff between probes. */
  maxProbeIntervalMs: number
}

export interface ProbeResult {
  reachable: boolean
  error?: string
}

export class FallbackMemory {
  private client: RembrClient
  private fileMemory: FileMemory
  private fallbackOnFailure: boolean
  private timeoutMs: number
  private maxProbeIntervalMs: number

  /** Current fallback state and how long since the last successful Rembr call. */
  private fallbackActive: boolean
  private lastSuccessAt: number
  private probeCount: number

  constructor(config: FallbackMemoryConfig) {
    this.client = config.client
    this.fileMemory = config.fileMemory
    this.fallbackOnFailure = config.fallbackOnFailure
    this.timeoutMs = config.timeoutMs
    this.maxProbeIntervalMs = config.maxProbeIntervalMs
    this.fallbackActive = false
    this.lastSuccessAt = Date.now()
    this.probeCount = 0
  }

  /**
   * Probe Rembr health. Returns false when unreachable OR when the probe itself
   * is disabled by config. Never throws — the caller decides how to react.
   */
  async probe(): Promise<ProbeResult> {
    try {
      const reachable = await Promise.race([
      this.client.health(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.timeoutMs)),
    ])
      this.probeCount = 0
      if (reachable) {
        this.fallbackActive = false
      }
      return { reachable, error: reachable ? undefined : "health check returned not-ok" }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.probeCount++
      return { reachable: false, error: message }
    }
  }

  /**
   * Attempt a live Rembr call; on failure, fall back to local memory unless
   * fallback is disabled. Logs the reason via the provided logger.
   */
  async call<T>(
    kind: "recall" | "store" | "forget",
    rembrCall: () => Promise<T>,
    fallbackCall: () => T,
    onFallback: (reason: string) => void,
  ): Promise<T> {
    if (!this.fallbackOnFailure) {
      try {
        return await rembrCall()
      } catch {
        return fallbackCall()
      }
    }
    try {
      const result = await rembrCall()
      this.lastSuccessAt = Date.now()
      if (this.fallbackActive) {
        this.probeCount = 0
        this.fallbackActive = false
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!this.fallbackActive) {
        this.fallbackActive = true
        this.probeCount = 1
      }
      onFallback(message)
      return fallbackCall()
    }
  }

  /**
   * Hybrid search. Routes to Rembr; on failure (or when Rembr is known down),
   * returns from the local store. Returns the same "- [id] text" lines Rembr
   * returns so callers branch on nothing.
   */
  async recall(
    query: string,
    options: { limit?: number; minSimilarity?: number } = {},
    onFallback: (reason: string) => void,
  ): Promise<string> {
    return this.call(
      "recall",
      async () => this.client.recall(query, options),
      () => this.fileMemory.search(query, options),
      onFallback,
    )
  }

  /** Store a memory. Falls back to local store on Rembr failure. */
  async remember(
    content: string,
    category?: string,
    metadata?: Record<string, unknown>,
    onFallback: (reason: string) => void = () => {},
  ): Promise<string> {
    return this.call(
      "store",
      () => this.client.remember(content, category, metadata),
      () => this.fileMemory.store(content, category, metadata).id,
      onFallback,
    )
  }

  /** Forget a memory by id. Falls back to local store on Rembr failure. */
  async forget(
    id: string,
    onFallback: (reason: string) => void = () => {},
  ): Promise<string> {
    return this.call(
      "forget",
      () => this.client.forget(id),
      () => this.fileMemory.delete(id),
      onFallback,
    )
  }

  /** Whether the layer is currently serving from local memory. */
  isFallbackActive(): boolean {
    return this.fallbackActive
  }

  /**
   * Re-probe Rembr on an exponential backoff schedule. Returns a handle whose
   * `stop()` cancels the timer. Stops once Rembr is reachable again.
   */
  startRecovery(onProbe: (reachable: boolean, reason?: string) => void): { stop: () => void } {
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = true
    const schedule = () => {
      if (!running) return
      const interval = Math.min(1000 * 2 ** this.probeCount, this.maxProbeIntervalMs)
      timer = setTimeout(async () => {
        if (!running) return
        const { reachable, error } = await this.probe()
        onProbe(reachable, error)
        if (reachable) return
        schedule()
      }, interval)
    }
    schedule()
    return {
      stop: () => {
        running = false
        if (timer) clearTimeout(timer)
      },
    }
  }
}
