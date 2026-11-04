import { describe, it, expect } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DIGEST_CAP,
  buildDigest,
  extractLines,
  loadDistillConfig,
  looksLikeSecret,
  parseDistillerOutput,
  parseModelRef,
  readCursor,
  stripPrivate,
  stripPrivateDeep,
  OBSERVER_PROMPT,
  writeCursor,
  type SessionMessage,
} from "./distill.js"

describe("loadDistillConfig", () => {
  it("returns defaults for an empty environment", () => {
    const config = loadDistillConfig({})
    expect(config.enabled).toBe(true)
    expect(config.model).toBe("")
    expect(config.minNewMessages).toBe(10)
    expect(config.timeoutMs).toBe(120_000)
    expect(config.excludeDirs).toEqual([])
  })

  it("honours REMBR_DISTILL=false and overrides", () => {
    const config = loadDistillConfig({
      REMBR_DISTILL: "false",
      REMBR_DISTILL_MODEL: "anthropic/claude-haiku-4-5",
      REMBR_DISTILL_MIN_MESSAGES: "3",
      REMBR_DISTILL_TIMEOUT_MS: "5000",
      REMBR_CAPTURE_EXCLUDE: "secret-client, other",
    })
    expect(config.enabled).toBe(false)
    expect(config.model).toBe("anthropic/claude-haiku-4-5")
    expect(config.minNewMessages).toBe(3)
    expect(config.timeoutMs).toBe(5000)
    expect(config.excludeDirs).toEqual(["secret-client", "other"])
  })

  it("prefers an inline model override", () => {
    const config = loadDistillConfig(
      { REMBR_DISTILL_MODEL: "anthropic/claude-haiku-4-5" },
      "fixture-provider/fixture-model",
    )
    expect(config.model).toBe("fixture-provider/fixture-model")
  })
})

describe("extractLines", () => {
  const messages: SessionMessage[] = [
    {
      info: { role: "user" },
      parts: [{ type: "text", text: "Investigate the 502s <private>on client X</private> please" }],
    },
    {
      info: { role: "assistant" },
      parts: [
        { type: "text", text: "Checking the proxy config." },
        { type: "tool", tool: "read", state: { input: { path: "/etc/nginx.conf" }, output: "proxy_read_timeout 5s;" } },
        { type: "reasoning" as const, text: "thinking about it" },
      ],
    },
    {
      info: { role: "assistant" },
      parts: [{ type: "text", text: "injected", synthetic: true }],
    },
  ]

  it("extracts user/assistant text and summarized tool parts", () => {
    const lines = extractLines(messages)
    expect(lines[0]).toBe("USER: Investigate the 502s  please")
    expect(lines[1]).toBe("ASSISTANT: Checking the proxy config.")
    expect(lines[2]).toContain("TOOL CALL read:")
    expect(lines[3]).toContain("TOOL RESULT: proxy_read_timeout 5s;")
  })

  it("skips synthetic and reasoning parts", () => {
    const lines = extractLines(messages)
    expect(lines.join("\n")).not.toContain("injected")
    expect(lines.join("\n")).not.toContain("thinking about it")
  })
})

describe("private spans in tool parts", () => {
  const toolMessage = (input: unknown, output: unknown): SessionMessage[] => [
    { info: { role: "assistant" }, parts: [{ type: "tool", tool: "fixture_tool", state: { input, output } }] },
  ]

  it("strips private spans from nested tool inputs", () => {
    const lines = extractLines(toolMessage({ query: { text: "find <private>fixture-secret</private> now" }, list: ["<private>x</private>ok"] }, ""))
    expect(lines.join("\n")).not.toContain("fixture-secret")
    expect(lines.join("\n")).toContain("ok")
  })

  it("strips before truncating so a long span cannot lose its closing tag", () => {
    const output = `${"a".repeat(250)}<private>${"fixture-secret ".repeat(20)}</private>tail`
    const lines = extractLines(toolMessage({}, output))
    expect(lines.join("\n")).not.toContain("fixture-secret")
  })

  it("redacts nested mixed-case spans in every text and tool path", () => {
    const text = "keep <PrIvAtE>outer <private>inner</private>NESTED_CANARY</PRIVATE> end"
    const lines = extractLines([
      { info: { role: "user" }, parts: [{ type: "text", text }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text }] },
      ...toolMessage({ text }, text),
    ])
    expect(lines).toHaveLength(4)
    for (const line of lines) {
      expect(line).not.toContain("CANARY")
      expect(line).not.toMatch(/private/i)
      expect(line).toContain("keep")
      expect(line).toContain("end")
    }
  })

  it("drops private object keys and values before input and output truncation", () => {
    const value = { "public<private>KEY_CANARY</private>key": { safe: "kept", value: "<private>VALUE_CANARY</private>visible" } }
    const lines = extractLines(toolMessage(value, value))
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line).not.toContain("CANARY")
      expect(line).toContain("publickey")
      expect(line).toContain("kept")
      expect(line).toContain("visible")
    }
  })

  it.each(["object", "array"])("omits over-depth %s subtrees without exposing raw private values", (kind) => {
    let deep: unknown = { "<private>DEEP_KEY_CANARY</private>": "<private>DEEP_VALUE_CANARY</private>" }
    for (let i = 0; i < 23; i++) deep = kind === "array" ? [deep] : { x: deep }
    const value = { before: "safe-before", deep, after: "safe-after" }
    expect(stripPrivateDeep(value)).toEqual(expect.objectContaining({ before: "safe-before", after: "safe-after" }))
    const lines = extractLines(toolMessage(value, value))
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line).not.toContain("CANARY")
      expect(line).not.toMatch(/private/i)
      expect(line).toContain("safe-before")
      expect(line).toContain("[omitted]")
    }
  })

  it("fails closed when private spans cross object fields", () => {
    const value = { "<private>": "CROSS_FIELD_CANARY</private>" }
    for (const line of extractLines(toolMessage(value, value))) {
      expect(line).not.toContain("CANARY")
      expect(line).toContain("[omitted]")
    }
  })

  it("bounds cyclic values without a raw fallback", () => {
    const value: Record<string, unknown> = { text: "keep <private>CYCLE_CANARY</private> end" }
    value.self = value
    for (const line of extractLines(toolMessage(value, value))) {
      expect(line).not.toContain("CANARY")
      expect(line).toContain("keep")
    }
  })

  it("drops an unclosed private span to the end", () => {
    expect(stripPrivate("keep <private>fixture-secret")).toBe("keep ")
  })
})

describe("stripPrivate / looksLikeSecret", () => {
  it("removes private spans", () => {
    expect(stripPrivate("a <private>hidden</private> b")).toBe("a  b")
  })

  it("flags common secret shapes", () => {
    expect(looksLikeSecret("the key is mb_live_abcdefgh12345678")).toBe(true)
    expect(looksLikeSecret("password: hunter22")).toBe(true)
    expect(looksLikeSecret("AKIAABCDEFGHIJKLMNOP")).toBe(true)
    expect(looksLikeSecret("nginx proxy_read_timeout is 60s")).toBe(false)
  })
})

describe("buildDigest", () => {
  it("keeps short digests intact", () => {
    expect(buildDigest(["a", "b"])).toBe("a\nb")
  })

  it("truncates long digests to 60% head / 30% tail", () => {
    const digest = buildDigest(["x".repeat(DIGEST_CAP * 2)])
    expect(digest.length).toBeLessThan(DIGEST_CAP + 100)
    expect(digest).toContain("[... middle of session truncated ...]")
  })
})

describe("parseDistillerOutput", () => {
  it("parses a plain JSON reply", () => {
    const memories = parseDistillerOutput('{"memories": [{"content": "Root cause was X", "category": "insights", "tags": ["nginx"]}]}')
    expect(memories).toHaveLength(1)
    expect(memories![0].category).toBe("insights")
  })

  it("strips markdown code fences", () => {
    const memories = parseDistillerOutput('```json\n{"memories": []}\n```')
    expect(memories).toEqual([])
  })

  it("rejects the entire reply when any proposed memory is invalid", () => {
    const memories = parseDistillerOutput(
      '{"memories": [{"content": "ok", "category": "facts"}, {"content": "bad", "category": "nope"}, {"content": " ", "category": "facts"}]}',
    )
    expect(memories).toBeNull()
  })

  it("returns null for non-JSON and wrong shapes", () => {
    expect(parseDistillerOutput("I could not comply")).toBeNull()
    expect(parseDistillerOutput('{"other": true}')).toBeNull()
    expect(parseDistillerOutput(undefined)).toBeNull()
  })
})

describe("OBSERVER_PROMPT", () => {
  it("makes iterative test and tuning chatter ineligible for durable capture", () => {
    expect(OBSERVER_PROMPT).toContain("test prompts or results")
    expect(OBSERVER_PROMPT).toContain("troubleshooting progress")
    expect(OBSERVER_PROMPT).toContain("repeated reformulations")
    expect(OBSERVER_PROMPT).toContain("Later verified outcomes override earlier checkpoints")
    expect(OBSERVER_PROMPT).toContain("never describe a completed validation or prerequisite as still pending")
    expect(OBSERVER_PROMPT).toContain("single strongest non-overlapping conclusion")
    expect(OBSERVER_PROMPT).toContain("Never recapture recalled or injected memory content")
    expect(OBSERVER_PROMPT).toContain("Category must exactly match")
  })
})

describe("cursor round-trip", () => {
  it("persists and sanitizes session ids", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "rembr-distill-"))
    const config = loadDistillConfig({ REMBR_STATE_DIR: stateDir })
    expect(readCursor(config, "ses/../weird id")).toBe(0)
    expect(writeCursor(config, "ses/../weird id", 42)).toBe(true)
    expect(readCursor(config, "ses/../weird id")).toBe(42)
  })
})

describe("parseModelRef", () => {
  it("splits provider/model", () => {
    expect(parseModelRef("anthropic/claude-haiku-4-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
    })
  })

  it("returns undefined for empty or malformed refs", () => {
    expect(parseModelRef("")).toBeUndefined()
    expect(parseModelRef("no-slash")).toBeUndefined()
    expect(parseModelRef("trailing/")).toBeUndefined()
  })
})

describe("nested and incomplete private spans", () => {
  it.each([
    ["left <private>outer <private>inner</private>hidden-tail</private> right", "left  right"],
    ["left <PrIvAtE>outer <PRIVATE>inner</PRIVATE>hidden-tail</pRiVaTe> right", "left  right"],
    ["left <private>outer <private>inner</private>hidden-tail", "left "],
    ["left <private>outer <private>unclosed-inner", "left "],
  ])("redacts the complete private region: %s", (input, expected) => {
    expect(stripPrivate(input)).toBe(expected)
  })
})


describe("private spans across same-message text fragments", () => {
  it.each(["user", "assistant"])("keeps %s private state across fragments but resets it for the next message", (role) => {
    const lines = extractLines([
      { info: { role }, parts: [
        { type: "text", text: "public-before <private>" },
        { type: "text", text: "CROSS_PART_CANARY</private> public-after" },
        { type: "text", text: "<private>UNCLOSED_CANARY" },
      ] },
      { info: { role }, parts: [{ type: "text", text: "next-message-public" }] },
    ])
    const digest = lines.join("\n")
    expect(digest).not.toContain("CANARY")
    expect(digest).toContain("public-before")
    expect(digest).toContain("public-after")
    expect(digest).toContain("next-message-public")
  })
})
