import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  loadDistillConfig,
  extractCwd,
  extractLines,
  buildDigest,
  parseDistillerOutput,
  buildDistillerArgs,
  DISTILLER_SYSTEM_PROMPT,
  stripPrivate,
  looksLikeSecret,
  readCursor,
  writeCursor,
  DIGEST_CAP,
  CATEGORIES,
} from "./distill-lib.mjs"

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rembr-distill-test-"))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

function config(env = {}) {
  return loadDistillConfig({ REMBR_STATE_DIR: tmpDir, ...env })
}

describe("loadDistillConfig", () => {
  it("applies defaults and reads env overrides", () => {
    const cfg = config()
    expect(cfg.enabled).toBe(true)
    expect(cfg.minNewRecords).toBe(3)
    expect(cfg.excludeCwd).toEqual([])

    const custom = config({
      REMBR_DISTILL: "false",
      REMBR_DISTILL_MODEL: "opus",
      REMBR_DISTILL_MIN_RECORDS: "9",
      REMBR_CAPTURE_EXCLUDE: "client-a, client-b",
    })
    expect(custom.enabled).toBe(false)
    expect(custom.model).toBe("opus")
    expect(custom.minNewRecords).toBe(9)
    expect(custom.excludeCwd).toEqual(["client-a", "client-b"])
  })

  it("reads the shared config file and lets env override it", () => {
    const file = { distillMinRecords: 7, distillModel: "sonnet", captureExclude: ["client-a"] }

    const fromFile = loadDistillConfig({ REMBR_STATE_DIR: tmpDir }, file)
    expect(fromFile.minNewRecords).toBe(7)
    expect(fromFile.model).toBe("sonnet")
    // an array reads better than a comma string in JSON, so both are accepted
    expect(fromFile.excludeCwd).toEqual(["client-a"])

    const envWins = loadDistillConfig({ REMBR_STATE_DIR: tmpDir, REMBR_DISTILL_MIN_RECORDS: "5" }, file)
    expect(envWins.minNewRecords).toBe(5)
    expect(envWins.model).toBe("sonnet")

    // distill: false in the file must disable it
    expect(loadDistillConfig({ REMBR_STATE_DIR: tmpDir }, { distill: false }).enabled).toBe(false)
  })
})

describe("extractLines", () => {
  it("extracts user, assistant, tool call and tool result lines", () => {
    const records = [
      { type: "user", message: { content: "fix the login bug" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "let me think" },
            { type: "text", text: "Found the cause." },
            { type: "tool_use", name: "Read", input: { file_path: "/x" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", content: [{ type: "text", text: "line 1\nline 2" }] }],
        },
      },
      { type: "summary", summary: "ignored" },
    ]
    const { lines, excluded } = extractLines(records)
    expect(excluded).toBe(false)
    expect(lines).toEqual([
      "USER: fix the login bug",
      "ASSISTANT: Found the cause.",
      'TOOL CALL Read: {"file_path":"/x"}',
      "TOOL RESULT: line 1 line 2",
    ])
  })

  it("returns excluded when a record cwd matches the exclusion list", () => {
    const records = [
      { type: "user", cwd: "/home/me/client-a/repo", message: { content: "secret work" } },
    ]
    const { lines, excluded } = extractLines(records, ["client-a"])
    expect(excluded).toBe(true)
    expect(lines).toEqual([])
  })

  it("skips subagent sidechain records", () => {
    const records = [
      { type: "user", message: { content: "main thread prompt" } },
      { type: "user", isSidechain: true, message: { content: "subagent prompt" } },
      { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent reply" }] } },
    ]
    expect(extractLines(records).lines).toEqual(["USER: main thread prompt"])
  })

  it("extracts workspace provenance", () => {
    expect(extractCwd([{ type: "user", cwd: "/repo", message: { content: "work" } }])).toBe("/repo")
    expect(extractCwd([{ type: "assistant", message: { content: [] } }])).toBe("")
  })

  it("strips <private> spans from every text kind", () => {
    const records = [
      { type: "user", message: { content: "keep this <private>drop this</private> too" } },
    ]
    const { lines } = extractLines(records)
    expect(lines).toEqual(["USER: keep this  too"])
  })
})

describe("buildDigest", () => {
  it("passes short digests through unchanged", () => {
    expect(buildDigest(["a", "b"])).toBe("a\nb")
  })

  it("truncates the middle of oversized digests", () => {
    const digest = buildDigest(["x".repeat(DIGEST_CAP * 2)])
    expect(digest.length).toBeLessThan(DIGEST_CAP + 100)
    expect(digest).toContain("[... middle of session truncated ...]")
  })
})

describe("parseDistillerOutput", () => {
  it("rejects the entire reply when any proposed memory is invalid", () => {
    const reply = JSON.stringify({
      memories: [
        { content: "User prefers tabs", category: "preferences", tags: [] },
        { content: "", category: "facts", tags: [] },
        { content: "bad category", category: "nope", tags: [] },
        "not an object",
      ],
    })
    expect(parseDistillerOutput(reply)).toBeNull()
  })

  it("tolerates a fenced code block around the JSON", () => {
    const reply = '```json\n{"memories": [{"content": "x", "category": "facts", "tags": []}]}\n```'
    expect(parseDistillerOutput(reply)).toHaveLength(1)
  })

  it("extracts JSON wrapped in prose", () => {
    const reply =
      'Sure [see below]. Here is the result: {"memories": [{"content": "uses {braces} in text", "category": "facts", "tags": []}]} Hope that helps.'
    expect(parseDistillerOutput(reply)).toEqual([
      { content: "uses {braces} in text", category: "facts", tags: [] },
    ])
  })

  it("extracts JSON from prose plus a fence and accepts a bare array", () => {
    const reply = ['Result:', '```json', '[{"content": "x", "category": "facts"}]', '```', 'Done.'].join("\n")
    expect(parseDistillerOutput(reply)).toHaveLength(1)
  })

  it("fails closed on pure prose or truncated JSON", () => {
    expect(parseDistillerOutput("Nothing durable was decided in this session.")).toBeNull()
    expect(parseDistillerOutput('{"memories": [{"content": "x", "cat')).toBeNull()
  })

  it("returns null for non-JSON or missing memories array", () => {
    expect(parseDistillerOutput("I could not find anything.")).toBeNull()
    expect(parseDistillerOutput('{"other": 1}')).toBeNull()
    expect(parseDistillerOutput(undefined)).toBeNull()
  })

  it("accepts every documented category", () => {
    const reply = JSON.stringify({
      memories: CATEGORIES.map((c) => ({ content: `about ${c}`, category: c, tags: [] })),
    })
    expect(parseDistillerOutput(reply)).toHaveLength(CATEGORIES.length)
  })

  it("accepts an intentional empty result", () => {
    expect(parseDistillerOutput('{"memories":[]}')).toEqual([])
  })
})

describe("secret and private filters", () => {
  it("flags common secret shapes", () => {
    expect(looksLikeSecret("the key is mb_live_abcdefgh123")).toBe(true)
    expect(looksLikeSecret("password: hunter22")).toBe(true)
    expect(looksLikeSecret("ghp_" + "a".repeat(24))).toBe(true)
    expect(looksLikeSecret("user prefers dark mode")).toBe(false)
  })

  it("stripPrivate removes spans case-insensitively across lines", () => {
    expect(stripPrivate("a <PRIVATE>x\ny</private> b")).toBe("a  b")
  })
})

describe("cursor state", () => {
  it("round-trips and defaults to 0", () => {
    const cfg = config()
    expect(readCursor(cfg, "session-1")).toBe(0)
    expect(writeCursor(cfg, "session-1", 42)).toBe(true)
    expect(readCursor(cfg, "session-1")).toBe(42)
  })

  it("sanitizes session ids used as filenames", () => {
    const cfg = config()
    expect(writeCursor(cfg, "../weird/../id", 7)).toBe(true)
    expect(readCursor(cfg, "../weird/../id")).toBe(7)
    expect(fs.readdirSync(path.join(tmpDir, "cursors"))).toHaveLength(1)
  })
})

describe("buildDistillerArgs", () => {
  it("locks the child down and keeps it out of session history", () => {
    const args = buildDistillerArgs("test-model")
    expect(args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]))
    expect(args[args.indexOf("--model") + 1]).toBe("test-model")
    expect(args[args.indexOf("--system-prompt") + 1]).toBe(DISTILLER_SYSTEM_PROMPT)
    expect(args[args.indexOf("--tools") + 1]).toBe("")
    expect(args).not.toContain("--mcp-config")
  })
})
