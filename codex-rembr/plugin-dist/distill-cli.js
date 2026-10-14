#!/usr/bin/env node

// src/distill.ts
import fs2 from "node:fs";
import os2 from "node:os";
import path2 from "node:path";
import { spawn } from "node:child_process";

// src/bridge-config.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
var REMBR_CATEGORIES = [
  "facts",
  "preferences",
  "conversations",
  "projects",
  "learning",
  "goals",
  "context",
  "reminders",
  "patterns",
  "decisions",
  "workflows",
  "insights"
];
function loadBridgeConfig(env = process.env, configFilePath = path.join(os.homedir(), ".rembr", "codex.env")) {
  const fileConfig = configFilePath ? readConfigFile(configFilePath) : {};
  const fileHasUrl = Boolean(fileConfig.REMBR_URL);
  const fileHasKey = Boolean(fileConfig.REMBR_API_KEY);
  if (fileHasUrl !== fileHasKey) {
    throw new Error(`codex-rembr: ${configFilePath} must contain both REMBR_URL and REMBR_API_KEY`);
  }
  if (!fileHasUrl) {
    throw new Error("codex-rembr: Rembr is not configured. Run the Rembr setup skill in Codex.");
  }
  const limit = Number(env.REMBR_RECALL_LIMIT);
  const similarity = Number(env.REMBR_MIN_SIMILARITY);
  const timeout = Number(env.REMBR_TIMEOUT_MS);
  return {
    url: fileConfig.REMBR_URL,
    apiKey: fileConfig.REMBR_API_KEY,
    recallLimit: Number.isFinite(limit) && limit >= 1 && limit <= 50 ? limit : 10,
    minSimilarity: Number.isFinite(similarity) && similarity >= 0 && similarity <= 1 ? similarity : 0.5,
    timeoutMs: Number.isFinite(timeout) && timeout >= 1e3 ? timeout : 15e3
  };
}
function readConfigFile(filePath) {
  try {
    const values = {};
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?(REMBR_URL|REMBR_API_KEY)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      let value = match[2];
      if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      values[match[1]] = value;
    }
    return values;
  } catch {
    return {};
  }
}

// src/rembr-client.ts
var RembrError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "RembrError";
  }
};
function parseSseBody(body) {
  const messages = [];
  for (const chunk of body.split(/\n\n/)) {
    const data = chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
    }
  }
  return messages;
}
var RembrClient = class {
  url;
  headers;
  timeoutMs;
  fetchOverride;
  nextId = 1;
  constructor(options) {
    this.url = options.url;
    this.timeoutMs = options.timeoutMs ?? 15e3;
    this.fetchOverride = options.fetchImpl;
    this.headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    };
    if (options.apiKey) this.headers["x-api-key"] = options.apiKey;
    else if (options.bearerToken) this.headers["authorization"] = `Bearer ${options.bearerToken}`;
  }
  /**
   * Call an MCP tool and return the concatenated text content of the result.
   * Retries once on network failure or 5xx.
   */
  async callTool(name, args) {
    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args }
    });
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const fetchImpl = this.fetchOverride ?? fetch;
      let response;
      try {
        response = await fetchImpl(this.url, {
          method: "POST",
          headers: this.headers,
          body: payload,
          signal: controller.signal
        });
      } catch (error) {
        lastError = error;
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (response.status >= 500) {
        lastError = new RembrError(`Rembr server error (HTTP ${response.status})`, response.status);
        continue;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new RembrError(
          `Rembr request failed (HTTP ${response.status})${text ? `: ${text.slice(0, 300)}` : ""}`,
          response.status
        );
      }
      return this.extractText(await this.parseResponse(response, id));
    }
    throw lastError instanceof Error ? lastError : new RembrError(String(lastError));
  }
  async parseResponse(response, id) {
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    if (contentType.includes("text/event-stream")) {
      const messages = parseSseBody(body);
      const match = messages.find((m) => m.id === id && (m.result || m.error));
      const fallback = messages.find((m) => m.result || m.error);
      const message = match ?? fallback;
      if (!message) throw new RembrError("No JSON-RPC response found in event stream");
      return message;
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new RembrError(`Invalid JSON response from Rembr: ${body.slice(0, 300)}`);
    }
  }
  extractText(message) {
    if (message.error) {
      throw new RembrError(`Rembr error ${message.error.code}: ${message.error.message}`);
    }
    const text = (message.result?.content ?? []).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
    if (message.result?.isError) {
      throw new RembrError(text || "Rembr tool call failed");
    }
    return text;
  }
  /** Store a memory. Returns the server's confirmation text. */
  remember(content, category, metadata) {
    return this.callTool("memory", {
      operation: "create",
      content,
      ...category ? { category } : {},
      ...metadata ? { metadata } : {}
    });
  }
  /** Hybrid text+semantic search. Returns the server's result text ("" if none). */
  recall(query, options = {}) {
    return this.callTool("search", {
      operation: "query",
      query,
      ...options.limit !== void 0 ? { limit: options.limit } : {},
      ...options.minSimilarity !== void 0 ? { min_similarity: options.minSimilarity } : {},
      ...options.category ? { category: options.category } : {}
    });
  }
  /** List recent memories using native or source-aware ordering. */
  recent(limit = 50, sortBy = "source_created_at") {
    return this.callTool("memory", { operation: "list", limit, sort_by: sortBy });
  }
  /** Delete a memory by id. */
  forget(id) {
    return this.callTool("memory", { operation: "delete", id });
  }
  /** Liveness check against the server's /health endpoint. */
  async health() {
    try {
      const healthUrl = new URL(this.url);
      healthUrl.pathname = healthUrl.pathname.replace(/\/mcp\/?$/, "") + "/health";
      healthUrl.search = "";
      const response = await (this.fetchOverride ?? fetch)(healthUrl.toString(), {
        method: "GET",
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      return response.ok;
    } catch {
      return false;
    }
  }
};

// src/distill.ts
var DIGEST_CAP = 24e3;
var SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /(bearer|token|api[_-]?key|password|secret)\s*[=:]\s*\S+/i,
  /-----BEGIN\s+[A-Z ]*PRIVATE KEY-----/,
  /\b(mb_live_|sk-)[A-Za-z0-9_-]{8,}/,
  /ghp_[A-Za-z0-9]{20,}/
];
var OBSERVER_PROMPT = `You are an observer creating searchable long-term memory for future AI sessions. You are NOT the one doing the work described below.

Read the session digest and extract ONLY durable conclusions worth recalling weeks later: final decisions, root causes, verified fixes, lasting preferences, and stable project facts. Be selective: an empty memories array is preferred over low-value capture.

Never capture iterative implementation chatter, test prompts or results, troubleshooting progress, temporary validation observations, proposed-but-unconfirmed behavior, repeated reformulations, or commentary about the memory system itself. Never recapture recalled or injected memory content as a new conclusion. Do not repeat credentials, identifiers, endpoints, mailbox addresses, or other sensitive configuration merely surfaced from historical context.

Each memory must be ONE self-contained statement understandable without the session. Prefer the single strongest non-overlapping conclusion. Category must exactly match one of these pluralized values: ${REMBR_CATEGORIES.join(", ")}. An empty memories array is a valid and common answer.

Reply with ONLY a JSON object of the shape {"memories": [{"content": "...", "category": "...", "tags": ["..."]}]} and nothing else.

Session digest:
`;
function retryAfterSeconds(error) {
  if (!(error instanceof RembrError) || error.status !== 429) return null;
  const match = error.message.match(/"retry_after"\s*:\s*(\d+)/);
  return match ? Number(match[1]) : 60;
}
function resumeCursor(cursor, totalLines) {
  return cursor > totalLines ? 0 : cursor;
}
function loadDistillConfig(env = process.env) {
  const stateDir = env.REMBR_STATE_DIR || path2.join(os2.homedir(), ".rembr");
  return {
    enabled: !["false", "0", "no", "off"].includes(String(env.REMBR_DISTILL ?? "true").toLowerCase()),
    model: env.REMBR_DISTILL_MODEL || "",
    minNewRecords: Number(env.REMBR_DISTILL_MIN_RECORDS) || 10,
    timeoutMs: Number(env.REMBR_DISTILL_TIMEOUT_MS) || 12e4,
    excludeCwd: (env.REMBR_CAPTURE_EXCLUDE || "").split(",").map((s) => s.trim()).filter(Boolean),
    stateDir,
    logFile: env.REMBR_LOG || path2.join(stateDir, "capture.log")
  };
}
function logLine(config, msg) {
  try {
    fs2.mkdirSync(config.stateDir, { recursive: true });
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19);
    fs2.appendFileSync(config.logFile, `${stamp} distill(codex) ${msg}
`);
  } catch {
  }
}
function stripPrivate(text) {
  return text.replace(/<private>[\s\S]*?<\/private>/gi, "");
}
function looksLikeSecret(text) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}
function compact(text, max) {
  return stripPrivate(text).replace(/\s+/g, " ").trim().slice(0, max);
}
function textContent(content) {
  return (content ?? []).filter((part) => ["input_text", "output_text"].includes(part.type ?? "") && typeof part.text === "string").map((part) => part.text).map((text) => stripPrivate(text ?? "")).join("\n");
}
function extractSessionId(records, fallback) {
  for (const record of records) {
    const payload = record.payload;
    const id = payload?.session_id ?? payload?.id;
    if (typeof id === "string" && id.trim()) return id;
  }
  return path2.basename(fallback).replace(/\.jsonl$/i, "");
}
function extractCwd(records) {
  for (const record of records) {
    const payload = record.payload;
    if (typeof payload?.cwd === "string") return payload.cwd;
  }
  return "";
}
function extractLines(records) {
  const lines = [];
  for (const record of records) {
    if (record.type !== "response_item") continue;
    const payload = record.payload;
    if (payload?.type === "message" && ["user", "assistant"].includes(payload.role ?? "")) {
      const text = textContent(payload.content).trim();
      if (text) lines.push(`${payload.role === "assistant" ? "ASSISTANT" : "USER"}: ${text}`);
    } else if (payload?.type === "function_call") {
      lines.push(`TOOL CALL ${payload.name ?? "?"}: ${compact(payload.arguments ?? "", 200)}`);
    } else if (payload?.type === "function_call_output") {
      const output = compact(payload.output ?? "", 300);
      if (output) lines.push(`TOOL RESULT: ${output}`);
    }
  }
  return lines;
}
function buildDigest(lines) {
  const digest = lines.join("\n");
  if (digest.length <= DIGEST_CAP) return digest;
  const head = Math.floor(DIGEST_CAP * 0.6);
  const tail = Math.floor(DIGEST_CAP * 0.3);
  return `${digest.slice(0, head)}
[... middle of session truncated ...]
${digest.slice(-tail)}`;
}
function parseDistillerOutput(text) {
  if (typeof text !== "string") return null;
  const candidates = distillerJsonCandidates(text);
  for (const candidate of candidates) {
    const memories = parseMemoryJson(candidate);
    if (memories !== null) return memories;
  }
  return null;
}
function distillerJsonCandidates(text) {
  const candidates = [text];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      const eventText = event.item?.type === "agent_message" ? event.item.text : event.text;
      if (typeof eventText === "string") candidates.push(eventText);
    } catch {
    }
  }
  return candidates;
}
function parseMemoryJson(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let payload;
  try {
    payload = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const memories = payload?.memories;
  if (!Array.isArray(memories)) return null;
  const valid = memories.filter(
    (m) => !!m && typeof m.content === "string" && m.content.trim().length > 0 && REMBR_CATEGORIES.includes(m.category)
  );
  return valid.length === memories.length ? valid : null;
}
function cursorFile(config, sessionId) {
  return path2.join(config.stateDir, "cursors", `codex-${sessionId.replace(/[^\w.-]/g, "_")}`);
}
function readCursor(config, sessionId) {
  try {
    const n = parseInt(fs2.readFileSync(cursorFile(config, sessionId), "utf8").trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
function writeCursor(config, sessionId, value) {
  try {
    const file = cursorFile(config, sessionId);
    fs2.mkdirSync(path2.dirname(file), { recursive: true });
    fs2.writeFileSync(file, String(value));
    return true;
  } catch (error) {
    logLine(config, `cursor write failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
function runDistiller(config, digest) {
  return new Promise((resolve) => {
    const args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral"];
    if (config.model) args.push("--model", config.model);
    const child = spawn("codex", args, {
      shell: process.platform === "win32",
      env: { ...process.env, REMBR_CAPTURE_DISABLE: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value, note) => {
      if (settled) return;
      settled = true;
      if (note) logLine(config, note);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null, `distiller timed out after ${config.timeoutMs}ms`);
    }, config.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      finish(null, `distiller spawn failed: ${error.message}`);
    });
    child.stdout.on("data", (data) => stdout += data);
    child.stderr.on("data", (data) => stderr += data);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish(null, `distiller exited ${code}: ${stderr.trim().slice(0, 300)}`);
      const memories = parseDistillerOutput(stdout);
      if (memories === null) {
        return finish(null, `distiller result unusable: ${stdout.trim().slice(0, 200)}`);
      }
      finish(memories);
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(OBSERVER_PROMPT + digest);
  });
}
async function distillTranscript(config, rembrConfig, transcriptPath, client = new RembrClient({ url: rembrConfig.url, apiKey: rembrConfig.apiKey, timeoutMs: rembrConfig.timeoutMs })) {
  let raw;
  try {
    raw = fs2.readFileSync(transcriptPath, "utf8");
  } catch {
    logLine(config, `transcript not readable: ${transcriptPath}`);
    return false;
  }
  const allLines = raw.split("\n");
  const totalLines = allLines.length - (allLines.at(-1) === "" ? 1 : 0);
  const allRecords = allLines.slice(0, totalLines).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return void 0;
    }
  }).filter((record) => !!record);
  const sessionId = extractSessionId(allRecords, transcriptPath);
  const cwd = extractCwd(allRecords);
  if (config.excludeCwd.some((marker) => cwd.includes(marker))) {
    logLine(config, `excluded cwd, skipping session ${sessionId}`);
    return true;
  }
  const storedCursor = readCursor(config, sessionId);
  const cursor = resumeCursor(storedCursor, totalLines);
  if (cursor !== storedCursor) {
    logLine(config, `transcript shrank from cursor ${storedCursor} to ${totalLines} lines; restarting session ${sessionId}`);
  }
  const records = allLines.slice(cursor, totalLines).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return void 0;
    }
  }).filter((record) => !!record);
  if (!records.length) return true;
  if (records.length < config.minNewRecords) {
    logLine(config, `debounce: ${records.length} new records < ${config.minNewRecords}, session ${sessionId}`);
    return true;
  }
  const lines = extractLines(records);
  if (!lines.length) {
    logLine(config, `no distillable content in ${records.length} new records, session ${sessionId}`);
    return true;
  }
  const memories = await runDistiller(config, buildDigest(lines));
  if (memories === null) return false;
  let failed = false;
  for (const memory of memories) {
    if (looksLikeSecret(memory.content)) {
      logLine(config, `skipped-secret-shape: ${memory.content.slice(0, 80)}`);
      continue;
    }
    try {
      await client.remember(memory.content, memory.category, {
        source: "codex-rembr",
        distilled: true,
        session_id: sessionId,
        ...cwd ? { directory: cwd } : {},
        tags: memory.tags ?? []
      });
      logLine(config, `stored: ${memory.content.slice(0, 120)}`);
    } catch (error) {
      const retryAfter = retryAfterSeconds(error);
      if (retryAfter !== null) {
        logLine(config, `rate limited, aborting watcher pass; retry_after=${retryAfter}s`);
        throw error;
      }
      failed = true;
      logLine(config, `store failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed) {
    logLine(config, `partial failure, cursor kept at ${cursor}, session ${sessionId}`);
    return false;
  }
  if (!memories.length) logLine(config, `nothing durable this pass, session ${sessionId}`);
  if (writeCursor(config, sessionId, totalLines)) {
    logLine(config, `cursor ${cursor} -> ${totalLines}, session ${sessionId}`);
  }
  return true;
}
async function runDistillCli(args, env = process.env) {
  if (env.REMBR_CAPTURE_DISABLE) return 0;
  const transcriptPath = args[0];
  if (!transcriptPath) {
    console.error("codex-rembr-distill: usage: codex-rembr-distill <codex-session.jsonl>");
    return 2;
  }
  const config = loadDistillConfig(env);
  if (!config.enabled) return 0;
  const rembrConfig = loadBridgeConfig(env);
  return await distillTranscript(config, rembrConfig, transcriptPath) ? 0 : 1;
}

// src/distill-cli.ts
runDistillCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`codex-rembr-distill: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
);
