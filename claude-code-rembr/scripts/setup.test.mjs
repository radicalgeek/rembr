import { describe, it, expect } from "vitest"
import { spawn } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const setupPath = fileURLToPath(new URL("./setup.mjs", import.meta.url))

describe("local setup page", () => {
  it("uses a masked field and reports rejected request metadata without reading the key", async () => {
    const child = spawn(process.execPath, [setupPath], {
      env: { ...process.env, REMBR_SETUP_NO_BROWSER: "1", REMBR_STATE_DIR: "/nonexistent-rembr-path-xyz" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    try {
      const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Setup page did not start")), 5000)
        child.stdout.once("data", (chunk) => {
          clearTimeout(timer)
          resolve(chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+/)?.[0])
        })
        child.on("error", reject)
      })
      expect(url).toBeTruthy()
      const get = await fetch(url)
      expect(get.status).toBe(200)
      const html = await get.text()
      expect(html).toContain('type="password"')
      expect(html).toContain('name="endpoint"')
      expect(html).toContain('value="https://')
      const post = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", Origin: "http://example.test" },
        body: new URLSearchParams({ endpoint: "https://rembr.test/mcp", key: "fixture-key" }),
      })
      expect(post.status).toBe(403)
      expect(await post.text()).toBe("Request rejected: origin (not-loopback)")

      const wrongContentType = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", Origin: new URL(url).origin },
        body: JSON.stringify({ key: "fixture-key" }),
      })
      expect(wrongContentType.status).toBe(403)
      expect(await wrongContentType.text()).toBe("Request rejected: content-type")

      const wrongMethod = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/x-www-form-urlencoded", Origin: new URL(url).origin },
        body: "key=fixture-key",
      })
      expect(wrongMethod.status).toBe(403)
      expect(await wrongMethod.text()).toBe("Request rejected: method")
    } finally {
      child.kill()
    }
  })

  it("accepts browser loopback, opaque, and absent origins while still checking the key", async () => {
    const cases = [
      { name: "same origin", origin: (url) => new URL(url).origin },
      { name: "loopback origin without port", origin: () => "http://127.0.0.1" },
      { name: "loopback origin with another port", origin: () => "http://127.0.0.1:1" },
      { name: "opaque origin", origin: () => "null" },
      { name: "missing origin", origin: () => undefined },
    ]
    for (const testCase of cases) {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-rembr-"))
      const mock = `globalThis.fetch = async () => new Response(JSON.stringify({jsonrpc:"2.0",id:1,result:{content:[{type:"text",text:JSON.stringify({success:true,data:[]})}]}}),{status:200,headers:{"content-type":"application/json"}}); await import(${JSON.stringify(pathToFileURL(setupPath).href)});`
      const child = spawn(process.execPath, ["--input-type=module", "-e", mock], {
        env: { ...process.env, REMBR_SETUP_NO_BROWSER: "1", REMBR_STATE_DIR: stateDir },
        stdio: ["ignore", "pipe", "pipe"],
      })
      try {
        const url = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Setup page did not start for ${testCase.name}`)), 5000)
          child.stdout.once("data", (chunk) => {
            clearTimeout(timer)
            resolve(chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+/)?.[0])
          })
          child.on("error", reject)
        })
        expect(url, testCase.name).toBeTruthy()
        const headers = { "content-type": "application/x-www-form-urlencoded" }
        const origin = testCase.origin(url)
        if (origin !== undefined) headers.Origin = origin
        const result = await fetch(url, {
          method: "POST",
          headers,
          body: new URLSearchParams({ endpoint: "https://rembr.test/mcp", key: "fixture-key" }),
        })
        expect(result.status, testCase.name).toBe(200)
        expect(await result.text()).toContain("Rembr is connected")
        const config = fs.readFileSync(path.join(stateDir, ".env"), "utf8")
        expect(config).toContain("REMBR_API_KEY=fixture-key\n")
        expect(config).toBe("REMBR_URL=https://rembr.test/mcp\nREMBR_API_KEY=fixture-key\n")
      } finally {
        child.kill()
        const secretPath = path.join(stateDir, ".env")
        if (fs.existsSync(secretPath)) fs.unlinkSync(secretPath)
        fs.rmdirSync(stateDir)
      }
    }
  })

  it("accepts a loopback HTTP endpoint for a local Rembr database", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-rembr-local-endpoint-"))
    const mock = `globalThis.fetch = async () => new Response(JSON.stringify({jsonrpc:"2.0",id:1,result:{content:[{type:"text",text:JSON.stringify({success:true,data:[]})}]}}),{status:200,headers:{"content-type":"application/json"}}); await import(${JSON.stringify(pathToFileURL(setupPath).href)});`
    const child = spawn(process.execPath, ["--input-type=module", "-e", mock], {
      env: { ...process.env, REMBR_SETUP_NO_BROWSER: "1", REMBR_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    })
    try {
      const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Setup page did not start")), 5000)
        child.stdout.once("data", (chunk) => {
          clearTimeout(timer)
          resolve(chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+/)?.[0])
        })
        child.on("error", reject)
      })
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", Origin: new URL(url).origin },
        body: new URLSearchParams({ endpoint: "http://127.0.0.1:3000/mcp", key: "fixture-key" }),
      })
      expect(response.status).toBe(200)
      expect(fs.readFileSync(path.join(stateDir, ".env"), "utf8")).toBe(
        "REMBR_URL=http://127.0.0.1:3000/mcp\nREMBR_API_KEY=fixture-key\n",
      )
    } finally {
      child.kill()
      const secretPath = path.join(stateDir, ".env")
      if (fs.existsSync(secretPath)) fs.unlinkSync(secretPath)
      fs.rmdirSync(stateDir)
    }
  })

  it("rejects insecure remote endpoints and URLs outside the MCP path", async () => {
    for (const endpoint of ["http://example.test/mcp", "https://example.test/not-mcp"]) {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-rembr-invalid-endpoint-"))
      const mock = `globalThis.fetch = async () => { throw new Error("unexpected request") }; await import(${JSON.stringify(pathToFileURL(setupPath).href)});`
      const child = spawn(process.execPath, ["--input-type=module", "-e", mock], {
        env: { ...process.env, REMBR_SETUP_NO_BROWSER: "1", REMBR_STATE_DIR: stateDir },
        stdio: ["ignore", "pipe", "pipe"],
      })
      try {
        const url = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Setup page did not start")), 5000)
          child.stdout.once("data", (chunk) => {
            clearTimeout(timer)
            resolve(chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+/)?.[0])
          })
          child.on("error", reject)
        })
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", Origin: new URL(url).origin },
          body: new URLSearchParams({ endpoint, key: "fixture-key" }),
        })
        expect(response.status).toBe(400)
        expect(fs.existsSync(path.join(stateDir, ".env"))).toBe(false)
      } finally {
        child.kill()
        fs.rmdirSync(stateDir)
      }
    }
  })
})
