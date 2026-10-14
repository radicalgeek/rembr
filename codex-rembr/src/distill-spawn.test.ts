import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"

const spawnMock = vi.fn()
vi.mock("node:child_process", () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

import { loadDistillConfig, runDistiller } from "./distill.js"

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => void }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.kill = () => {}
  return child
}

describe("runDistiller codex invocation", () => {
  it("runs codex exec outside a git repo without persisting a session", async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const config = loadDistillConfig({ REMBR_DISTILL_MODEL: "example-model" })
    const pending = runDistiller(config, "USER: hello")
    child.emit("close", 1)
    await pending

    const [command, args, options] = spawnMock.mock.calls[0]
    expect(command).toBe("codex")
    expect(args).toEqual(["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--model", "example-model"])
    expect((options as { env: Record<string, string> }).env.REMBR_CAPTURE_DISABLE).toBe("1")
  })
})
