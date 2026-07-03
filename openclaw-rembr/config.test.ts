import { describe, it, expect } from "vitest"
import {
  createRembrConfigSchema,
  normalizeCategory,
  expandEnv,
  DEFAULT_URL,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_TIMEOUT_MS,
} from "./config.js"

describe("createRembrConfigSchema", () => {
  it("applies defaults for an empty config", () => {
    const cfg = createRembrConfigSchema({}).parse({})
    expect(cfg.url).toBe(DEFAULT_URL)
    expect(cfg.apiKey).toBeUndefined()
    expect(cfg.autoRecall).toBe(true)
    expect(cfg.autoCapture).toBe(true)
    expect(cfg.recallLimit).toBe(DEFAULT_RECALL_LIMIT)
    expect(cfg.defaultCategory).toBe("context")
    expect(cfg.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
  })

  it("accepts undefined config", () => {
    expect(createRembrConfigSchema({}).parse(undefined).url).toBe(DEFAULT_URL)
  })

  it("expands ${ENV_VAR} in apiKey and url", () => {
    const env = { MY_KEY: "mb_live_secret", REMBR_HOST: "https://self.hosted" }
    const cfg = createRembrConfigSchema(env).parse({
      apiKey: "${MY_KEY}",
      url: "${REMBR_HOST}/mcp",
    })
    expect(cfg.apiKey).toBe("mb_live_secret")
    expect(cfg.url).toBe("https://self.hosted/mcp")
  })

  it("treats an unresolved ${VAR} apiKey as unset and falls back to REMBR_API_KEY", () => {
    const cfg = createRembrConfigSchema({ REMBR_API_KEY: "mb_live_env" }).parse({
      apiKey: "$KEY",
    })
    expect(cfg.apiKey).toBe("mb_live_env")
  })

  it("falls back to REMBR_API_KEY when apiKey is omitted", () => {
    const cfg = createRembrConfigSchema({ REMBR_API_KEY: "mb_live_env" }).parse({})
    expect(cfg.apiKey).toBe("mb_live_env")
  })

  it("rejects unknown keys", () => {
    expect(() => createRembrConfigSchema({}).parse({ tenant: "acme" })).toThrow(/unknown key "tenant"/)
  })

  it("rejects out-of-bounds numbers", () => {
    expect(() => createRembrConfigSchema({}).parse({ recallLimit: 0 })).toThrow(/recallLimit/)
    expect(() => createRembrConfigSchema({}).parse({ minSimilarity: 2 })).toThrow(/minSimilarity/)
  })

  it("normalizes OpenClaw category aliases for defaultCategory", () => {
    expect(createRembrConfigSchema({}).parse({ defaultCategory: "fact" }).defaultCategory).toBe("facts")
    expect(createRembrConfigSchema({}).parse({ defaultCategory: "decisions" }).defaultCategory).toBe(
      "decisions",
    )
    expect(() => createRembrConfigSchema({}).parse({ defaultCategory: "nonsense" })).toThrow(
      /defaultCategory/,
    )
  })

  it("lowercases custom triggers", () => {
    const cfg = createRembrConfigSchema({}).parse({ customTriggers: ["Log THIS"] })
    expect(cfg.customTriggers).toEqual(["log this"])
  })
})

describe("normalizeCategory", () => {
  it("passes through Rembr categories", () => {
    expect(normalizeCategory("preferences", "context")).toBe("preferences")
  })
  it("maps ecosystem aliases", () => {
    expect(normalizeCategory("preference", "context")).toBe("preferences")
    expect(normalizeCategory("entity", "context")).toBe("facts")
    expect(normalizeCategory("other", "facts")).toBe("context")
  })
  it("falls back for unknown values", () => {
    expect(normalizeCategory("bogus", "context")).toBe("context")
    expect(normalizeCategory(undefined, "facts")).toBe("facts")
  })
})

describe("expandEnv", () => {
  it("leaves unresolved variables intact", () => {
    expect(expandEnv("${NOT_SET}/x", {})).toBe("${NOT_SET}/x")
  })
})
