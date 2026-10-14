// rembr-console UI. Talks only to this console's /api/* proxy.

const CATEGORY_COLORS = {
  facts: "#4c8dff",
  preferences: "#7dc74f",
  conversations: "#5fa8d3",
  projects: "#9a6bff",
  learning: "#38b26e",
  goals: "#d94f4f",
  context: "#8a97a8",
  reminders: "#d9a824",
  patterns: "#b08b5e",
  decisions: "#f07f3c",
  workflows: "#2fb3c7",
  insights: "#e05fa0",
}

const CLUSTER_COLORS = ["#58c6b5", "#6fa8ff", "#aa86ff", "#e88961", "#e2b84f", "#5fc785", "#d875a5", "#75b9d1"]

const state = {
  memories: [],
  memoryPage: 0,
  memoryPageSize: 50,
  memoryHasMore: false,
  totalMemories: null,
  authMode: "static",
  authenticated: false,
  writable: false,
  filter: "all",
  selectedId: null,
  graphNodes: [],
  graphEdges: [],
  activeGraphEdges: [],
  graphThreshold: 0.78,
  graphCategories: new Set(),
  graphTodayOnly: false,
  graphFilter: "",
  graphView: { x: 0, y: 0, k: 1 },
  graphFitScale: 1,
  graphSelectedId: null,
  graphHoveredId: null,
  graphError: null,
  graphAnimation: null,
  graphFrames: 0,
  graphMode: "semantic",
  graphMemories: [],
  graphClusters: [],
  graphHoveredCategory: null,
  graphCluster: null,
  graphClusterLinks: [],
  graphBreadcrumbs: [],
  graphHierarchyLoaded: false,
  graphLoading: false,
  graphTotalChildren: 0,
  graphRequest: 0,
  graphCache: new Map(),
}

// Keep the browser-to-console bearer token in this page process only. A reload
// deliberately requires re-entry so browser storage cannot persist it.
let consoleToken = ""

function currentToken() {
  return consoleToken
}

async function call(tool, args) {
  const token = currentToken()
  if (state.authMode === "static" && !token) return { ok: false, error: "Enter the console access token" }
  if (state.authMode === "session" && !state.authenticated) return { ok: false, error: "Enter your Rembr API key" }
  const response = await fetch("/api/call", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(state.authMode === "static" ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ tool, args }),
    credentials: "same-origin",
    redirect: "error",
  })
  const payload = await response.json().catch(() => ({ ok: false, error: "Bad response from console server" }))
  if (response.status === 401 && state.authMode === "session") clearConsoleState("Session expired", true)
  return payload
}

function parsePayload(payload) {
  if (!payload.ok || !payload.text) return null
  try {
    return JSON.parse(payload.text)
  } catch {
    return null
  }
}

function formatPayload(payload, emptyMessage = "Nothing found.") {
  if (!payload.ok) return `Error: ${payload.error}`
  const parsed = parsePayload(payload)
  if (parsed) return JSON.stringify(parsed, null, 2)
  return payload.text?.trim() || emptyMessage
}

function showOutput(id, payload, emptyMessage) {
  const el = document.getElementById(id)
  el.textContent = formatPayload(payload, emptyMessage)
  el.classList.toggle("error", !payload.ok)
}

function memoriesFromPayload(payload) {
  const parsed = parsePayload(payload)
  if (!parsed) return []
  if (Array.isArray(parsed.data)) return parsed.data
  if (Array.isArray(parsed.memories)) return parsed.memories
  if (Array.isArray(parsed.results)) return parsed.results.map((r) => r.memory ?? r)
  return []
}

function pageFromPayload(payload) {
  const parsed = parsePayload(payload)
  const page = parsed?.pagination ?? parsed?.metadata?.pagination
  if (!page || typeof page !== "object") return null
  return page
}

function statsFromPayload(payload) {
  const parsed = parsePayload(payload)
  return parsed?.stats ?? parsed
}

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function formatDate(value) {
  if (!value) return "unknown"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

function sourceOf(memory) {
  return memory.metadata?.source ?? memory.metadata?.captured_by ?? "manual"
}

function idOf(memory) {
  return memory.id ?? memory.memory_id ?? ""
}

function contentOf(memory) {
  return memory.content ?? memory.text ?? ""
}

function categoryOf(memory) {
  return memory.category ?? "context"
}

function visibilityOf(memory) {
  return memory.visibility ?? "unscoped"
}

function categoryClass(category) {
  return Object.hasOwn(CATEGORY_COLORS, category) ? category : "context"
}

function tagsOf(memory) {
  if (Array.isArray(memory.tags) && memory.tags.length) return memory.tags
  return Array.isArray(memory.metadata?.tags) ? memory.metadata.tags : []
}

// Harness plugins historically disagreed on the session key: OpenCode wrote
// sessionID, Claude and Codex wrote session_id. Accept both so memories
// stored before the plugins were aligned still show their origin.
function sessionOf(memory) {
  const id = memory.metadata?.session_id ?? memory.metadata?.sessionID
  return typeof id === "string" ? id : ""
}

function directoryOf(memory) {
  const dir = memory.metadata?.directory
  return typeof dir === "string" ? dir : ""
}

// Full paths and UUIDs would dominate a card, so show a recognisable
// fragment and keep the full value in the title attribute.
function shortSession(id) {
  return id.slice(0, 8)
}

function shortDirectory(dir) {
  const parts = dir.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : dir
}

function originChips(memory) {
  const session = sessionOf(memory)
  const directory = directoryOf(memory)
  let html = ""
  if (session) {
    html += `<span class="origin" title="session ${escapeHtml(session)}">${escapeHtml(shortSession(session))}</span>`
  }
  if (directory) {
    html += `<span class="origin" title="${escapeHtml(directory)}">${escapeHtml(shortDirectory(directory))}</span>`
  }
  return html
}

function effectiveDateOf(memory) {
  return memory.metadata?.source_created_at ?? memory.created_at ?? memory.createdAt
}

function isToday(memory) {
  const value = effectiveDateOf(memory)
  if (!value) return false
  return new Date(value).toDateString() === new Date().toDateString()
}

function filteredMemories() {
  if (state.filter === "today") return state.memories.filter(isToday)
  if (state.filter === "distilled") return state.memories.filter((m) => m.metadata?.distilled)
  if (state.filter === "manual") return state.memories.filter((m) => !m.metadata?.distilled)
  if (state.filter.startsWith("scope:")) {
    const visibility = state.filter.slice(6)
    return state.memories.filter((m) => visibilityOf(m) === visibility)
  }
  if (state.filter.startsWith("cat:")) {
    const category = state.filter.slice(4)
    return state.memories.filter((m) => categoryOf(m) === category)
  }
  return state.memories
}

function setStatus(ok, text) {
  const el = document.getElementById("status")
  el.className = ok ? "status ok" : "status err"
  document.getElementById("status-text").textContent = text
}

function renderStats() {
  const categories = new Set(state.memories.map(categoryOf))
  const distilled = state.memories.filter((m) => m.metadata?.distilled).length
  const today = state.memories.filter(isToday).length
  const sources = new Set(state.memories.map(sourceOf))
  const total = Number.isFinite(Number(state.totalMemories)) ? Number(state.totalMemories) : state.memories.length
  const stats = [
    [total, "memories"],
    [today, "today"],
    [distilled, "distilled"],
    [categories.size, "categories"],
    [sources.size, "sources"],
    [state.memories.length, "on page"],
  ]
  document.getElementById("stats-strip").innerHTML = stats
    .map(([value, label]) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`)
    .join("")
}

function renderFilters() {
  const counts = new Map()
  for (const memory of state.memories) counts.set(categoryOf(memory), (counts.get(categoryOf(memory)) ?? 0) + 1)
  const visibilityCounts = new Map()
  for (const memory of state.memories) visibilityCounts.set(visibilityOf(memory), (visibilityCounts.get(visibilityOf(memory)) ?? 0) + 1)
  const filters = [
    ["all", `all ${state.memories.length}`],
    ["today", `today ${state.memories.filter(isToday).length}`],
    ["distilled", `distilled ${state.memories.filter((m) => m.metadata?.distilled).length}`],
    ["manual", `manual ${state.memories.filter((m) => !m.metadata?.distilled).length}`],
    ...["personal", "shared", "project", "unscoped"].flatMap((visibility) => {
      const count = visibilityCounts.get(visibility) ?? 0
      return count ? [[`scope:${visibility}`, `${visibility} ${count}`]] : []
    }),
    ...[...counts.entries()].sort().map(([category, count]) => [`cat:${category}`, `${category} ${count}`]),
  ]
  const container = document.getElementById("filters")
  container.replaceChildren(...filters.map(([key, label]) => {
    const button = document.createElement("button")
    button.className = `filter ${state.filter === key ? "active" : ""}`
    button.dataset.filter = key
    button.textContent = label
    return button
  }))
  document.querySelectorAll("#filters .filter").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter
      renderAll()
    })
  })
}

function renderFeed() {
  const list = filteredMemories()
  const first = state.memoryPage * state.memoryPageSize + (state.memories.length ? 1 : 0)
  const last = state.memoryPage * state.memoryPageSize + state.memories.length
  const total = Number.isFinite(Number(state.totalMemories)) ? ` of ${Number(state.totalMemories).toLocaleString()}` : ""
  document.getElementById("feed-count").textContent = list.length === state.memories.length
    ? (state.memories.length ? `${first}-${last}${total}` : "No memories")
    : `${list.length} shown · ${first}-${last}${total}`
  document.getElementById("memory-prev").disabled = state.memoryPage === 0
  document.getElementById("memory-next").disabled = !state.memoryHasMore
  document.getElementById("memory-feed").innerHTML = list
    .map((memory) => {
      const id = idOf(memory)
      const category = categoryOf(memory)
      const visibility = visibilityOf(memory)
      const tags = tagsOf(memory)
      return `<article class="memory-card ${state.selectedId === id ? "selected" : ""}" data-id="${escapeHtml(id)}">
        <div class="card-head">
          <span class="badge category-${categoryClass(category)}">${escapeHtml(category)}</span>
          <span class="scope scope-${escapeHtml(visibility)}">${escapeHtml(visibility)}</span>
          <span class="source">${escapeHtml(sourceOf(memory))}</span>
          ${memory.metadata?.distilled ? '<span class="mark">distilled</span>' : ""}
          ${isToday(memory) ? '<span class="mark today">today</span>' : ""}
          ${originChips(memory)}
          <time>${escapeHtml(formatDate(effectiveDateOf(memory)))}</time>
        </div>
        <div class="memory-body">${escapeHtml(contentOf(memory))}</div>
        ${tags.length ? `<div class="tags">${tags.map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      </article>`
    })
    .join("")
  document.querySelectorAll(".memory-card").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedId = card.dataset.id
      renderAll()
    })
  })
}

function renderDetail() {
  const memory = state.memories.find((m) => idOf(m) === state.selectedId) ?? filteredMemories()[0]
  if (!memory) {
    document.getElementById("detail").innerHTML = '<p class="muted">No memory selected.</p>'
    return
  }
  state.selectedId = idOf(memory)
  const category = categoryOf(memory)
  const related = state.memories
    .filter((m) => idOf(m) !== idOf(memory))
    .filter((m) => categoryOf(m) === category || tagsOf(m).some((tag) => tagsOf(memory).includes(tag)))
    .slice(0, 6)
  document.getElementById("detail").innerHTML = `
    <span class="badge category-${categoryClass(category)}">${escapeHtml(category)}</span>
    <h3>${escapeHtml(idOf(memory).slice(0, 12) || "memory")}</h3>
    <p>${escapeHtml(contentOf(memory))}</p>
    <dl>
      <dt>Source</dt><dd>${escapeHtml(sourceOf(memory))}</dd>
      <dt>Audience</dt><dd>${escapeHtml(visibilityOf(memory))}</dd>
      <dt>Effective date</dt><dd>${escapeHtml(formatDate(effectiveDateOf(memory)))}</dd>
      <dt>Tags</dt><dd>${tagsOf(memory).map(escapeHtml).join(", ") || "none"}</dd>
    </dl>
    <h4>Nearby by category/tags</h4>
    <div class="nearby">
      ${related.length ? related.map((m) => `<button data-id="${escapeHtml(idOf(m))}">${escapeHtml(contentOf(m).slice(0, 120))}</button>`).join("") : '<span class="muted">No nearby memories in the current snapshot.</span>'}
    </div>`
  document.querySelectorAll(".nearby button").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedId = button.dataset.id
      renderAll()
    })
  })
}

function graphMemories() {
  return state.graphMemories
}

function clusterColor(cluster) {
  const categoryColor = CATEGORY_COLORS[cluster?.dominant_category]
  if (categoryColor) return categoryColor
  let hash = 0
  for (const char of cluster.id ?? "") hash = (hash * 31 + char.charCodeAt(0)) | 0
  return CLUSTER_COLORS[Math.abs(hash) % CLUSTER_COLORS.length]
}

function clusterDisplayLabel(cluster) {
  const prefix = cluster?.dominant_category ? `${cluster.dominant_category} / ` : ""
  return prefix && cluster.label.startsWith(prefix) ? cluster.label.slice(prefix.length) : cluster.label
}

function positionGraphClusters(clusters, links) {
  const maxCount = Math.max(1, ...clusters.map((cluster) => Number(cluster.memory_count)))
  const columns = Math.max(1, Math.ceil(Math.sqrt(clusters.length * 1.4)))
  const positioned = clusters.map((cluster, index) => ({
    ...cluster,
    count: Number(cluster.memory_count),
    radius: 38 + Math.sqrt(Number(cluster.memory_count) / maxCount) * 50,
    x: index % columns,
    y: Math.floor(index / columns),
  }))
  const spacing = (positioned.length ? Math.max(...positioned.map(cluster => cluster.radius)) : 38) * 2 + 100
  const rows = Math.ceil(positioned.length / columns)
  for (const cluster of positioned) {
    cluster.x = (cluster.x - (columns - 1) / 2) * spacing
    cluster.y = (cluster.y - (rows - 1) / 2) * spacing
  }
  const byId = new Map(positioned.map((cluster) => [cluster.id, cluster]))
  for (let iteration = 0; iteration < 120; iteration++) {
    for (const link of links) {
      const a = byId.get(link.source)
      const b = byId.get(link.target)
      if (!a || !b || Number(link.similarity) < 0.5) continue
      const pull = (Number(link.similarity) - 0.5) * 0.005
      const dx = b.x - a.x
      const dy = b.y - a.y
      a.x += dx * pull
      a.y += dy * pull
      b.x -= dx * pull
      b.y -= dy * pull
    }
    for (let left = 0; left < positioned.length; left++) {
      for (let right = left + 1; right < positioned.length; right++) {
        const a = positioned[left]
        const b = positioned[right]
        let dx = b.x - a.x
        let dy = b.y - a.y
        const distance = Math.hypot(dx, dy) || 1
        const minimum = a.radius + b.radius + 100
        if (distance < minimum) {
          const shift = (minimum - distance) * 0.5
          dx /= distance
          dy /= distance
          a.x -= dx * shift
          a.y -= dy * shift
          b.x += dx * shift
          b.y += dy * shift
        }
      }
    }
  }
  const bounds = positioned.reduce((result, cluster) => ({
    minX: Math.min(result.minX, cluster.x - cluster.radius),
    maxX: Math.max(result.maxX, cluster.x + cluster.radius),
    minY: Math.min(result.minY, cluster.y - cluster.radius),
    maxY: Math.max(result.maxY, cluster.y + cluster.radius),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity })
  const centerX = Number.isFinite(bounds.minX) ? (bounds.minX + bounds.maxX) / 2 : 0
  const centerY = Number.isFinite(bounds.minY) ? (bounds.minY + bounds.maxY) / 2 : 0
  for (const cluster of positioned) {
    cluster.x -= centerX
    cluster.y -= centerY
  }
  state.graphClusters = positioned
}

function graphClusterById(id) {
  return state.graphClusters.find((cluster) => cluster.id === id) ?? null
}

function visibleGraphClusters() {
  return state.graphClusters
}

function graphEdgesFromPayload(payload, list) {
  const edges = parsePayload(payload)?.graph?.edges
  if (!Array.isArray(edges)) return []
  const indexes = new Map(list.map((memory, index) => [idOf(memory), index]))
  return edges
    .map((edge) => ({
      a: indexes.get(edge.source),
      b: indexes.get(edge.target),
      similarity: Number(edge.weight),
    }))
    .filter((edge) => Number.isInteger(edge.a) && Number.isInteger(edge.b) && Number.isFinite(edge.similarity))
}

function ensureGraphNodes(list) {
  const previous = new Map(state.graphNodes.map((node) => [idOf(node.memory), node]))
  state.graphNodes = list.map((memory, index) => {
    const id = idOf(memory)
    const existing = previous.get(id)
    if (existing) return { ...existing, memory, index, degree: 0 }
    return {
      index,
      memory,
      x: Math.cos(index * 2.399) * (80 + index * 2.2),
      y: Math.sin(index * 2.399) * (80 + index * 2.2),
      vx: 0,
      vy: 0,
      degree: 0,
    }
  })
}

function visibleGraphNodes() {
  return state.graphNodes.filter((node) => {
    if (state.graphCategories.has(categoryOf(node.memory))) return false
    if (state.graphTodayOnly && !isToday(node.memory)) return false
    if (state.graphFilter) {
      const haystack = `${contentOf(node.memory)} ${categoryOf(node.memory)} ${tagsOf(node.memory).join(" ")}`.toLowerCase()
      if (!haystack.includes(state.graphFilter.toLowerCase())) return false
    }
    return true
  })
}

function rebuildGraphEdges() {
  const visible = new Set(visibleGraphNodes().map((node) => node.index))
  state.activeGraphEdges = state.graphEdges.filter(
    (edge) => edge.similarity >= state.graphThreshold && visible.has(edge.a) && visible.has(edge.b),
  )
  state.graphNodes.forEach((node) => (node.degree = 0))
  for (const edge of state.activeGraphEdges) {
    state.graphNodes[edge.a].degree += 1
    state.graphNodes[edge.b].degree += 1
  }
}

function tickGraph() {
  const nodes = visibleGraphNodes()
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      const n1 = nodes[a]
      const n2 = nodes[b]
      let dx = n2.x - n1.x
      let dy = n2.y - n1.y
      let d2 = dx * dx + dy * dy
      if (d2 < 1) d2 = 1
      const force = 900 / d2
      const distance = Math.sqrt(d2)
      dx /= distance
      dy /= distance
      n1.vx -= dx * force
      n1.vy -= dy * force
      n2.vx += dx * force
      n2.vy += dy * force
    }
  }

  for (const edge of state.activeGraphEdges) {
    const n1 = state.graphNodes[edge.a]
    const n2 = state.graphNodes[edge.b]
    let dx = n2.x - n1.x
    let dy = n2.y - n1.y
    const distance = Math.hypot(dx, dy) || 1
    const target = 60 + (0.92 - edge.similarity) * 260
    const force = Math.max(-3, Math.min(3, (distance - target) * 0.012))
    dx /= distance
    dy /= distance
    n1.vx += dx * force
    n1.vy += dy * force
    n2.vx -= dx * force
    n2.vy -= dy * force
  }

  for (const node of nodes) {
    node.vx += -node.x * 0.004
    node.vy += -node.y * 0.004
    if (node.dragging) {
      node.vx = 0
      node.vy = 0
      continue
    }
    node.vx *= 0.85
    node.vy *= 0.85
    node.x += node.vx
    node.y += node.vy
  }
}

function nodeRadius(node) {
  return 4 + Math.min(10, node.degree * 0.9)
}

function linkedTo(a, b) {
  return state.activeGraphEdges.some(
    (edge) =>
      (state.graphNodes[edge.a] === a && state.graphNodes[edge.b] === b) ||
      (state.graphNodes[edge.a] === b && state.graphNodes[edge.b] === a),
  )
}

function graphNodeById(id) {
  return state.graphNodes.find((node) => idOf(node.memory) === id) ?? null
}

function wrappedClusterLabel(ctx, label, maxWidth) {
  const words = label.split(/\s+/).filter(Boolean).slice(0, 2)
  const combined = words.join(" ")
  return combined && ctx.measureText(combined).width <= maxWidth ? [combined] : words
}

function drawSemanticClusters(ctx, width, height) {
  const clusters = visibleGraphClusters()
  if (!clusters.length) {
    state.graphFitScale = 1
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted")
    ctx.fillText("No topics match this filter.", 20, 30)
    return
  }
  const view = state.graphView
  const bounds = clusters.reduce((result, cluster) => ({
    minX: Math.min(result.minX, cluster.x - cluster.radius),
    maxX: Math.max(result.maxX, cluster.x + cluster.radius),
    minY: Math.min(result.minY, cluster.y - cluster.radius),
    maxY: Math.max(result.maxY, cluster.y + cluster.radius),
  }), { minX: 0, maxX: 0, minY: 0, maxY: 0 })
  const fitScale = clusters.length
    ? Math.min(1, (width - 24) / Math.max(1, bounds.maxX - bounds.minX), (height - 24) / Math.max(1, bounds.maxY - bounds.minY))
    : 1
  state.graphFitScale = fitScale
  const scale = view.k * fitScale
  ctx.translate(width / 2 + view.x, height / 2 + view.y)
  ctx.scale(scale, scale)

  const byId = new Map(clusters.map((cluster) => [cluster.id, cluster]))
  const linkDegrees = new Map()
  const visibleLinks = [...state.graphClusterLinks]
    .sort((left, right) => Number(right.similarity) - Number(left.similarity))
    .filter((link) => {
      if (Number(link.similarity) < 0.7) return false
      const sourceDegree = linkDegrees.get(link.source) ?? 0
      const targetDegree = linkDegrees.get(link.target) ?? 0
      if (sourceDegree >= 2 || targetDegree >= 2) return false
      linkDegrees.set(link.source, sourceDegree + 1)
      linkDegrees.set(link.target, targetDegree + 1)
      return true
    })
  for (const link of visibleLinks) {
    const source = byId.get(link.source)
    const target = byId.get(link.target)
    if (!source || !target) continue
    ctx.strokeStyle = `rgba(111,168,255,${Math.max(0.05, (Number(link.similarity) - 0.35) * 0.45)})`
    ctx.lineWidth = 1 / scale
    ctx.beginPath()
    ctx.moveTo(source.x, source.y)
    ctx.lineTo(target.x, target.y)
    ctx.stroke()
  }

  for (const cluster of clusters) {
    const hovered = cluster.id === state.graphHoveredCategory
    ctx.globalAlpha = hovered ? 1 : 0.88
    ctx.beginPath()
    ctx.arc(cluster.x, cluster.y, cluster.radius, 0, Math.PI * 2)
    ctx.fillStyle = clusterColor(cluster)
    ctx.fill()
    if (hovered) {
      ctx.strokeStyle = "#e8eef5"
      ctx.lineWidth = 2 / scale
      ctx.stroke()
    }

    ctx.globalAlpha = 1
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillStyle = "#10151d"
    let labelFontSize = Math.max(12, Math.min(20, cluster.radius / 3.5))
    ctx.font = `${labelFontSize}px ui-monospace, Consolas, monospace`
    const lines = wrappedClusterLabel(ctx, clusterDisplayLabel(cluster), cluster.radius * 1.5)
    while (labelFontSize > 9 && lines.some(line => ctx.measureText(line).width > cluster.radius * 1.5)) {
      labelFontSize -= 1
      ctx.font = `${labelFontSize}px ui-monospace, Consolas, monospace`
    }
    const labelStart = cluster.y - (lines.length === 2 ? labelFontSize * 0.7 : labelFontSize * 0.35)
    lines.forEach((line, index) => ctx.fillText(line, cluster.x, labelStart + index * labelFontSize * 1.05))
    const countFontSize = Math.max(13, Math.min(22, cluster.radius / 3.2))
    ctx.font = `600 ${countFontSize}px ui-monospace, Consolas, monospace`
    const countY = cluster.y + (lines.length === 2 ? labelFontSize * 1.8 : labelFontSize * 1.15)
    ctx.fillText(cluster.memory_count.toLocaleString(), cluster.x, countY)
  }
  ctx.textAlign = "start"
  ctx.textBaseline = "alphabetic"
}

function drawGraphCanvas() {
  const canvas = document.getElementById("memory-map")
  const ctx = canvas.getContext("2d")
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  const dpr = window.devicePixelRatio || 1
  canvas.width = width * dpr
  canvas.height = height * dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  if (state.graphMode === "semantic") {
    drawSemanticClusters(ctx, width, height)
    return
  }

  const visible = visibleGraphNodes()
  if (!visible.length) {
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted")
    ctx.fillText("No memories in this filter.", 20, 30)
    return
  }

  const selected = graphNodeById(state.graphSelectedId)
  const hovered = graphNodeById(state.graphHoveredId)
  const view = state.graphView
  ctx.translate(width / 2 + view.x, height / 2 + view.y)
  ctx.scale(view.k, view.k)
  ctx.lineWidth = 1 / view.k

  for (const edge of state.activeGraphEdges) {
    const n1 = state.graphNodes[edge.a]
    const n2 = state.graphNodes[edge.b]
    const hot = selected && (n1 === selected || n2 === selected)
    ctx.strokeStyle = hot ? "rgba(79,196,176,.85)" : `rgba(140,155,170,${Math.max(0.2, (edge.similarity - 0.6) * 0.75)})`
    ctx.beginPath()
    ctx.moveTo(n1.x, n1.y)
    ctx.lineTo(n2.x, n2.y)
    ctx.stroke()
  }

  for (const node of state.graphNodes) {
    if (!visible.includes(node)) continue
    const radius = nodeRadius(node)
    ctx.globalAlpha = selected && node !== selected && !linkedTo(selected, node) ? 0.25 : 1
    ctx.beginPath()
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = CATEGORY_COLORS[categoryOf(node.memory)] ?? CATEGORY_COLORS.context
    ctx.fill()
    if (node === selected || node === hovered) {
      ctx.strokeStyle = CATEGORY_COLORS[categoryOf(node.memory)] ?? CATEGORY_COLORS.context
      ctx.lineWidth = 2 / view.k
      ctx.beginPath()
      ctx.arc(node.x, node.y, radius + 4 / view.k, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  for (const node of [selected, hovered]) {
    if (!node || !visible.includes(node)) continue
    ctx.font = `${11 / view.k}px ui-monospace, Consolas, monospace`
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text")
    const label = contentOf(node.memory).slice(0, 46) + (contentOf(node.memory).length > 46 ? "..." : "")
    ctx.fillText(label, node.x + nodeRadius(node) + 6 / view.k, node.y + 4 / view.k)
  }
}

function pickGraphNode(clientX, clientY) {
  const canvas = document.getElementById("memory-map")
  const rect = canvas.getBoundingClientRect()
  const mx = clientX - rect.left
  const my = clientY - rect.top
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  const view = state.graphView
  const scale = state.graphMode === "semantic" ? view.k * state.graphFitScale : view.k
  const x = (mx - width / 2 - view.x) / scale
  const y = (my - height / 2 - view.y) / scale
  if (state.graphMode === "semantic") {
    return visibleGraphClusters().find((cluster) => Math.hypot(cluster.x - x, cluster.y - y) <= cluster.radius) ?? null
  }
  let best = null
  let bestDistance = Infinity
  for (const node of visibleGraphNodes()) {
    const distance = Math.hypot(node.x - x, node.y - y)
    if (distance < Math.max(10, nodeRadius(node) + 3) && distance < bestDistance) {
      best = node
      bestDistance = distance
    }
  }
  return best
}

function renderGraphDetail(node) {
  const detail = document.getElementById("detail")
  if (!node) {
    detail.innerHTML = `<button class="graph-overview">All topics</button>${state.graphError
      ? `<p class="muted">Graph edges unavailable: ${escapeHtml(state.graphError)}</p>`
      : '<p class="muted">Click a node to inspect it. Drag to reposition, scroll to zoom, drag the background to pan.<br><br>Node size = number of links at the current threshold. Color = category.</p>'}`
    detail.querySelector(".graph-overview").addEventListener("click", showGraphOverview)
    drawGraphCanvas()
    return
  }
  const memory = node.memory
  const category = categoryOf(memory)
  const neighbors = state.activeGraphEdges
    .filter((edge) => state.graphNodes[edge.a] === node || state.graphNodes[edge.b] === node)
    .map((edge) => ({
      node: state.graphNodes[edge.a] === node ? state.graphNodes[edge.b] : state.graphNodes[edge.a],
      similarity: edge.similarity,
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 8)
  detail.innerHTML = `
    <button class="graph-overview">All topics</button>
    <span class="badge category-${categoryClass(category)}">${escapeHtml(category)}</span>
    ${memory.metadata?.distilled ? '<span class="mark detail-mark">distilled</span>' : ""}
    ${isToday(memory) ? '<span class="mark today detail-mark">today</span>' : ""}
    <p class="graph-detail-content">${escapeHtml(contentOf(memory))}</p>
    <div class="meta">${escapeHtml(sourceOf(memory))} · ${escapeHtml(formatDate(effectiveDateOf(memory)))} · ${escapeHtml(idOf(memory).slice(0, 8))}${sessionOf(memory) ? ` · session ${escapeHtml(sessionOf(memory))}` : ""}${directoryOf(memory) ? ` · ${escapeHtml(directoryOf(memory))}` : ""}</div>
    ${tagsOf(memory).length ? `<div class="tags graph-detail-tags">${tagsOf(memory).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
    ${
      neighbors.length
        ? `<div class="nearby"><div class="meta nearby-title">nearest (cosine)</div>${neighbors
            .map(
              ({ node: other, similarity }) =>
                `<button data-id="${escapeHtml(idOf(other.memory))}"><span class="sim">${similarity.toFixed(2)}</span>${escapeHtml(contentOf(other.memory).slice(0, 90))}${contentOf(other.memory).length > 90 ? "..." : ""}</button>`,
            )
            .join("")}</div>`
        : ""
    }`
  detail.querySelector(".graph-overview").addEventListener("click", showGraphOverview)
  detail.querySelectorAll(".nearby button").forEach((button) => {
    button.addEventListener("click", () => {
      state.graphSelectedId = button.dataset.id
      state.selectedId = button.dataset.id
      renderGraphDetail(graphNodeById(button.dataset.id))
      drawGraphCanvas()
    })
  })
  drawGraphCanvas()
}

function renderGraphOverviewDetail(cluster) {
  const detail = document.getElementById("detail")
  if (state.graphLoading) {
    detail.innerHTML = '<p class="muted">Building semantic topics...</p>'
    return
  }
  if (!cluster) {
    detail.innerHTML = '<p class="muted">Every embedded memory is represented through categorised semantic topics.<br><br>Click or zoom into a bubble to open its deduplicated memory graph.</p>'
    return
  }
  const categories = Object.entries(cluster.category_counts ?? {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 4)
  const total = Number(cluster.total_memory_count ?? cluster.memory_count)
  const countText = state.graphFilter
    ? `${cluster.memory_count.toLocaleString()} matching memories out of ${total.toLocaleString()} in this topic.`
    : `${total.toLocaleString()} semantically related memories across categories.`
  detail.innerHTML = `
    <span class="topic-dot category-${categoryClass(cluster.dominant_category)}"></span>
    <h3>${escapeHtml(cluster.label)}</h3>
    <p>${countText}</p>
    <div class="topic-composition">${categories.map(([category, count]) => `<span>${escapeHtml(category)} ${Number(count).toLocaleString()}</span>`).join("")}</div>
    <p class="muted">Click or zoom in to reveal up to 100 individual memories.</p>`
}

function selectGraphNode(node) {
  if (state.graphMode === "semantic") {
    if (node) {
      loadSemanticCluster(node.id)
    }
    return
  }
  state.graphSelectedId = node ? idOf(node.memory) : null
  state.selectedId = state.graphSelectedId
  renderGraphDetail(node)
}

function renderGraph() {
  const threshold = document.getElementById("link-threshold")
  const today = document.getElementById("graph-today")
  const options = document.querySelector(".graph-options")
  if (state.graphMode === "semantic") {
    threshold.disabled = true
    today.disabled = true
    options.classList.add("disabled")
    const cluster = state.graphCluster
    const totalMemories = Number(cluster?.total_memory_count ?? cluster?.memory_count ?? 0)
    const memoryCount = state.graphFilter
      ? `${Number(cluster?.memory_count ?? 0).toLocaleString()} of ${totalMemories.toLocaleString()} matching memories`
      : `${totalMemories.toLocaleString()} memories`
    const topicCount = state.graphFilter
      ? `${state.graphClusters.length} of ${state.graphTotalChildren} topics`
      : `${state.graphClusters.length} topics`
    document.getElementById("graph-title").textContent = cluster
      ? `Memory Map / ${cluster.label} / ${memoryCount} / ${topicCount}`
      : "Memory Map / loading semantic topics"
    const categoryCounts = new Map()
    for (const child of state.graphClusters) {
      for (const [category, count] of Object.entries(child.category_counts ?? {})) {
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + Number(count))
      }
    }
    const categoryLegend = [...categoryCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => `<span class="graph-chip"><i class="category-${categoryClass(category)}"></i>${escapeHtml(category)} ${count.toLocaleString()}</span>`)
      .join("")
    document.getElementById("graph-legend").innerHTML = categoryLegend
    drawGraphCanvas()
    renderGraphOverviewDetail(graphClusterById(state.graphHoveredCategory))
    return
  }

  threshold.disabled = false
  today.disabled = false
  options.classList.remove("disabled")
  const list = graphMemories()
  ensureGraphNodes(list)
  rebuildGraphEdges()
  const categoryCounts = new Map()
  for (const memory of list) categoryCounts.set(categoryOf(memory), (categoryCounts.get(categoryOf(memory)) ?? 0) + 1)
  const clusterTotal = Number(state.graphCluster?.total_memory_count ?? state.graphCluster?.memory_count ?? list.length)
  document.getElementById("graph-title").textContent = `${state.graphCluster?.label ?? "Topic"} ${visibleGraphNodes().length} of ${clusterTotal.toLocaleString()} memories / ${state.activeGraphEdges.length} links`
  document.getElementById("graph-legend").innerHTML = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => `<button class="graph-chip ${state.graphCategories.has(category) ? "off" : ""}" data-category="${escapeHtml(category)}"><i class="category-${categoryClass(category)}"></i>${escapeHtml(category)} ${count}</button>`)
    .join("")
  document.querySelectorAll(".graph-chip").forEach((button) => {
    button.addEventListener("click", () => {
      const category = button.dataset.category
      if (!category) return
      if (state.graphCategories.has(category)) state.graphCategories.delete(category)
      else state.graphCategories.add(category)
      rebuildGraphEdges()
      renderGraph()
      reheatGraph()
    })
  })
  drawGraphCanvas()
  renderGraphDetail(graphNodeById(state.graphSelectedId))
  reheatGraph()
}

function showGraphOverview() {
  loadSemanticCluster()
}

async function loadAudienceGraph() {
  const request = ++state.graphRequest
  state.graphLoading = true
  const result = await call("graph", {
    operation: "generate",
    min_edge_weight: 0.68,
  })
  if (request !== state.graphRequest) return
  const graph = parsePayload(result)?.graph
  state.graphLoading = false
  if (!result.ok || !graph) {
    state.graphError = result.error ?? "Authorised graph was not returned"
    state.graphMemories = []
    state.graphEdges = []
    renderGraph()
    return
  }
  state.graphMemories = Array.isArray(graph.nodes) ? graph.nodes : []
  state.graphEdges = graphEdgesFromPayload(result, state.graphMemories)
  state.graphCluster = {
    id: "authorised",
    label: "Authorised memories",
    memory_count: state.graphMemories.length,
    total_memory_count: Number(graph.total_count ?? state.graphMemories.length),
    is_leaf: true,
  }
  state.graphBreadcrumbs = []
  state.graphMode = "memories"
  state.graphError = null
  state.graphSelectedId = null
  state.graphHoveredId = null
  state.graphCategories.clear()
  state.graphView = { x: 0, y: 0, k: 1 }
  renderGraph()
}

async function loadSemanticCluster(clusterId) {
  const request = ++state.graphRequest
  state.graphLoading = true
  if (state.graphAnimation !== null) {
    cancelAnimationFrame(state.graphAnimation)
    state.graphAnimation = null
  }
  renderGraphOverviewDetail(null)
  const cacheKey = `${clusterId ?? "root"}\u0000${state.graphFilter}`
  let hierarchy = state.graphCache.get(cacheKey)
  let result = null
  if (hierarchy) {
    state.graphCache.delete(cacheKey)
    state.graphCache.set(cacheKey, hierarchy)
  } else {
    result = await call("graph", {
      operation: "generate",
      cluster_algorithm: "semantic",
      ...(clusterId ? { cluster_id: clusterId } : {}),
      ...(state.graphFilter ? { filter_query: state.graphFilter } : {}),
      min_edge_weight: 0.68,
    })
    hierarchy = parsePayload(result)?.semantic_hierarchy
    if (hierarchy) {
      const cacheKeys = [cacheKey]
      if (hierarchy.cluster?.level === 0 && hierarchy.cluster.id) {
        cacheKeys.push(`${hierarchy.cluster.id}\u0000${state.graphFilter}`)
      }
      for (const key of cacheKeys) {
        if (state.graphCache.size >= 10 && !state.graphCache.has(key)) state.graphCache.delete(state.graphCache.keys().next().value)
        state.graphCache.set(key, hierarchy)
      }
    }
  }
  if (request !== state.graphRequest) return
  if (!hierarchy) {
    state.graphLoading = false
    state.graphError = result?.error ?? "Semantic hierarchy was not returned"
    if (clusterId) {
      await loadAudienceGraph()
      return
    }
    renderGraphOverviewDetail(null)
    return
  }

  const list = Array.isArray(hierarchy.memories) ? hierarchy.memories : []
  state.graphMemories = list
  state.graphCluster = hierarchy.cluster
  state.graphBreadcrumbs = Array.isArray(hierarchy.breadcrumbs) ? hierarchy.breadcrumbs : []
  state.graphClusterLinks = Array.isArray(hierarchy.links) ? hierarchy.links : []
  state.graphTotalChildren = Number(hierarchy.total_children ?? hierarchy.children?.length ?? 0)
  state.graphEdges = graphEdgesFromPayload({ ok: true, text: JSON.stringify({ graph: { edges: hierarchy.edges ?? [] } }) }, list)
  state.graphError = null
  state.graphMode = hierarchy.cluster?.is_leaf ? "memories" : "semantic"
  positionGraphClusters(Array.isArray(hierarchy.children) ? hierarchy.children : [], state.graphClusterLinks)
  state.graphSelectedId = null
  state.graphHoveredId = null
  state.graphHoveredCategory = null
  state.graphCategories.clear()
  state.graphView = { x: 0, y: 0, k: 1 }
  state.graphLoading = false
  state.graphHierarchyLoaded = true
  renderGraph()
}

function reheatGraph() {
  if (state.graphMode === "semantic") {
    drawGraphCanvas()
    return
  }
  state.graphFrames = 0
  const maxFrames = Math.min(900, Math.max(120, Math.floor(36_000 / Math.max(1, state.graphNodes.length))))
  if (state.graphAnimation !== null) return
  const loop = () => {
    tickGraph()
    state.graphFrames += 1
    drawGraphCanvas()
    state.graphAnimation = state.graphFrames < maxFrames ? requestAnimationFrame(loop) : null
  }
  state.graphAnimation = requestAnimationFrame(loop)
}

let graphDragNode = null
let graphPanning = false
let graphPointerStart = { x: 0, y: 0 }
let graphPointerPrev = { x: 0, y: 0 }

document.getElementById("memory-map").addEventListener("pointerdown", (event) => {
  event.currentTarget.setPointerCapture(event.pointerId)
  const node = pickGraphNode(event.clientX, event.clientY)
  if (node) {
    graphDragNode = node
    node.dragging = true
  } else {
    graphPanning = true
  }
  graphPointerStart = { x: event.clientX, y: event.clientY }
  graphPointerPrev = { x: event.clientX, y: event.clientY }
})

document.getElementById("memory-map").addEventListener("pointermove", (event) => {
  const canvas = event.currentTarget
  if (graphDragNode) {
    const rect = canvas.getBoundingClientRect()
    const view = state.graphView
    const scale = state.graphMode === "semantic" ? view.k * state.graphFitScale : view.k
    graphDragNode.x = (event.clientX - rect.left - canvas.clientWidth / 2 - view.x) / scale
    graphDragNode.y = (event.clientY - rect.top - canvas.clientHeight / 2 - view.y) / scale
    reheatGraph()
  } else if (graphPanning) {
    state.graphView.x += event.clientX - graphPointerPrev.x
    state.graphView.y += event.clientY - graphPointerPrev.y
    drawGraphCanvas()
  } else {
    const hovered = pickGraphNode(event.clientX, event.clientY)
    if (state.graphMode === "semantic") {
      const clusterId = hovered?.id ?? null
      if (clusterId !== state.graphHoveredCategory) {
        state.graphHoveredCategory = clusterId
        canvas.style.cursor = hovered ? "pointer" : "grab"
        renderGraphOverviewDetail(hovered)
        drawGraphCanvas()
      }
    } else {
      const hoveredId = hovered ? idOf(hovered.memory) : null
      if (hoveredId !== state.graphHoveredId) {
        state.graphHoveredId = hoveredId
        canvas.style.cursor = hovered ? "pointer" : "grab"
        drawGraphCanvas()
      }
    }
  }
  graphPointerPrev = { x: event.clientX, y: event.clientY }
})

document.getElementById("memory-map").addEventListener("pointerup", (event) => {
  const distance = Math.hypot(event.clientX - graphPointerStart.x, event.clientY - graphPointerStart.y)
  if (graphDragNode) {
    graphDragNode.dragging = false
    if (distance < 4) selectGraphNode(graphDragNode)
  } else if (graphPanning && distance < 4) {
    selectGraphNode(null)
  }
  graphDragNode = null
  graphPanning = false
})

document.getElementById("memory-map").addEventListener(
  "wheel",
  (event) => {
    event.preventDefault()
    state.graphView.k = Math.min(4, Math.max(0.3, state.graphView.k * (event.deltaY < 0 ? 1.12 : 0.89)))
    if (state.graphMode === "semantic" && event.deltaY < 0 && state.graphView.k >= 2.15) {
      const hovered = graphClusterById(state.graphHoveredCategory)
      if (hovered && !state.graphLoading) {
        loadSemanticCluster(hovered.id)
        return
      }
    }
    if (event.deltaY > 0 && state.graphView.k <= 0.45 && state.graphBreadcrumbs.length > 1 && !state.graphLoading) {
      loadSemanticCluster(state.graphBreadcrumbs.at(-2).id)
      return
    }
    drawGraphCanvas()
  },
  { passive: false },
)

async function loadAll() {
  const refresh = document.getElementById("refresh")
  refresh.disabled = true
  refresh.textContent = "Refreshing..."
  document.getElementById("memory-prev").disabled = true
  document.getElementById("memory-next").disabled = true
  document.querySelector(".actions").setAttribute("aria-busy", "true")
  try {
    const [memories, stats] = await Promise.all([
      call("memory", {
        operation: "list",
        limit: state.memoryPageSize,
        offset: state.memoryPage * state.memoryPageSize,
        sort_by: "source_created_at",
      }),
      call("stats", { operation: "usage" }),
    ])
    if (memories.ok) {
      state.memories = memoriesFromPayload(memories)
      state.memoryHasMore = Boolean(pageFromPayload(memories)?.has_more)
    }
    if (stats.ok) {
      const parsedStats = statsFromPayload(stats)
      state.totalMemories = parsedStats?.total_memories ?? null
    }
    if (Number.isFinite(Number(state.totalMemories))) {
      state.memoryHasMore = (state.memoryPage + 1) * state.memoryPageSize < Number(state.totalMemories)
    }
    if (!state.selectedId && state.memories[0]) state.selectedId = idOf(state.memories[0])
    setStatus(memories.ok && stats.ok, memories.ok && stats.ok ? "Signed in" : memories.error || stats.error)
    document.getElementById("last-updated").textContent = `updated ${new Date().toLocaleTimeString()}`
    renderAll()
    const currentClusterId = state.graphHierarchyLoaded ? state.graphCluster?.id : undefined
    if (state.graphMode === "memories" && currentClusterId === "authorised") await loadAudienceGraph()
    else await loadSemanticCluster(currentClusterId)
  } catch {
    setStatus(false, "Connection failed")
  } finally {
    refresh.disabled = false
    refresh.textContent = "Refresh"
    document.querySelector(".actions").setAttribute("aria-busy", "false")
    renderFeed()
  }
}

async function loadMemoryPage() {
  const feed = document.getElementById("memory-feed")
  feed.setAttribute("aria-busy", "true")
  document.getElementById("memory-prev").disabled = true
  document.getElementById("memory-next").disabled = true
  try {
    const memories = await call("memory", {
      operation: "list",
      limit: state.memoryPageSize,
      offset: state.memoryPage * state.memoryPageSize,
      sort_by: "source_created_at",
    })
    if (!memories.ok) {
      setStatus(false, memories.error)
      return
    }
    state.memories = memoriesFromPayload(memories)
    state.memoryHasMore = Number.isFinite(Number(state.totalMemories))
      ? (state.memoryPage + 1) * state.memoryPageSize < Number(state.totalMemories)
      : Boolean(pageFromPayload(memories)?.has_more)
    state.selectedId = state.memories[0] ? idOf(state.memories[0]) : null
    renderStats()
    renderFilters()
    renderFeed()
    setStatus(true, "Signed in")
    document.getElementById("last-updated").textContent = `updated ${new Date().toLocaleTimeString()}`
  } finally {
    feed.setAttribute("aria-busy", "false")
    renderFeed()
  }
}

function renderAll() {
  renderStats()
  renderFilters()
  renderFeed()
  renderDetail()
  renderGraph()
}

function activateTab(name) {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === name)
  })
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.id === `tab-${name}`)
  })
}

async function loadContexts() {
  showOutput("contexts-output", await call("context", { operation: "list" }), "No contexts found.")
}

async function loadSnapshots() {
  showOutput("snapshots-output", await call("snapshot", { operation: "list" }), "No snapshots found.")
}

async function loadStats() {
  showOutput("stats-usage", await call("stats", { operation: "usage" }))
  showOutput("stats-embeddings", await call("stats", { operation: "embeddings" }))
}

document.querySelectorAll(".tab-button").forEach((button) => {
  button.addEventListener("click", () => activateTab(button.dataset.tab))
})

document.getElementById("refresh").addEventListener("click", () => {
  state.graphCache.clear()
  loadAll()
})
document.getElementById("link-threshold").addEventListener("input", (event) => {
  state.graphThreshold = Number(event.target.value)
  document.getElementById("link-threshold-value").textContent = state.graphThreshold.toFixed(2)
  rebuildGraphEdges()
  renderGraph()
  reheatGraph()
})
let graphFilterTimer = null
document.getElementById("graph-filter").addEventListener("input", (event) => {
  state.graphFilter = event.target.value.trim()
  clearTimeout(graphFilterTimer)
  graphFilterTimer = setTimeout(() => {
    if (state.graphMode === "memories" && state.graphCluster?.id === "authorised") {
      rebuildGraphEdges()
      renderGraph()
      reheatGraph()
    } else {
      loadSemanticCluster(state.graphCluster?.id)
    }
  }, 250)
})
document.getElementById("graph-today").addEventListener("change", (event) => {
  state.graphTodayOnly = event.target.checked
  rebuildGraphEdges()
  renderGraph()
  reheatGraph()
})
document.getElementById("refresh-contexts").addEventListener("click", loadContexts)
document.getElementById("refresh-snapshots").addEventListener("click", loadSnapshots)
document.getElementById("refresh-stats").addEventListener("click", loadStats)
async function changeMemoryPage(nextPage) {
  state.memoryPage = nextPage
  const feed = document.getElementById("memory-feed")
  feed.scrollTop = 0
  feed.focus({ preventScroll: true })
  await loadMemoryPage()
  feed.scrollTop = 0
}

document.getElementById("memory-prev").addEventListener("click", () => {
  if (state.memoryPage > 0) changeMemoryPage(state.memoryPage - 1)
})
document.getElementById("memory-next").addEventListener("click", () => {
  if (state.memoryHasMore) changeMemoryPage(state.memoryPage + 1)
})
window.addEventListener("resize", drawGraphCanvas)

document.getElementById("create-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const content = document.getElementById("create-content").value.trim()
  const category = document.getElementById("create-category").value
  if (!content) return
  const result = await call("memory", { operation: "create", content, category })
  showOutput("create-output", result)
  if (result.ok) {
    document.getElementById("create-content").value = ""
    state.memoryPage = 0
    state.graphCache.clear()
    await loadAll()
  }
})

document.getElementById("delete-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const id = document.getElementById("delete-id").value.trim()
  if (!id) return
  const result = await call("memory", { operation: "delete", id })
  showOutput("delete-output", result)
  if (result.ok) {
    document.getElementById("delete-id").value = ""
    state.memoryPage = 0
    state.graphCache.clear()
    await loadAll()
  }
})

document.getElementById("search-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const query = document.getElementById("search-query").value.trim()
  const mode = document.getElementById("search-mode").value
  if (!query) return
  document.getElementById("search-output").textContent = "Searching..."
  showOutput("search-output", await call("search", { operation: "query", query, search_mode: mode, limit: 20 }), "No matching memories.")
})

function clearConsoleState(message = "Signed out", isError = false) {
  consoleToken = ""
  state.authenticated = false
  state.memories = []
  state.graphMemories = []
  state.graphEdges = []
  state.graphClusters = []
  state.graphClusterLinks = []
  state.graphBreadcrumbs = []
  state.graphCluster = null
  state.graphCache.clear()
  state.graphHierarchyLoaded = false
  state.graphMode = "semantic"
  state.memoryPage = 0
  state.memoryHasMore = false
  renderAll()
  renderAuthControls()
  if (isError) setStatus(false, message)
  else {
    document.getElementById("status").className = "status"
    document.getElementById("status-text").textContent = message
  }
}

function renderAuthControls() {
  const signedIn = state.authenticated
  document.getElementById("auth-form").hidden = signedIn
  document.getElementById("forget-console").hidden = !signedIn
  document.getElementById("refresh").hidden = !signedIn
}

async function configureAuth() {
  let config
  let unavailable = false
  try {
    const response = await fetch("/api/session", { credentials: "same-origin", redirect: "error" })
    config = await response.json()
  } catch {
    config = { authMode: "static", authenticated: false }
    unavailable = true
  }
  state.authMode = config.authMode === "session" ? "session" : "static"
  state.authenticated = Boolean(config.authenticated)
  state.writable = Boolean(config.writable)
  state.memoryPageSize = Number(config.memoryPageSize) || 50
  document.getElementById("auth-label").textContent = state.authMode === "session" ? "Rembr API key" : "Console token"
  document.getElementById("console-token").autocomplete = "off"
  document.getElementById("connect-console").textContent = state.authMode === "session" ? "Sign in" : "Connect"
  document.getElementById("forget-console").textContent = state.authMode === "session" ? "Sign out" : "Forget"
  document.querySelector('[data-tab="manage"]').hidden = !state.writable
  if (state.authMode === "session" && state.authenticated) {
    renderAuthControls()
    await Promise.all([loadAll(), loadStats()])
  } else {
    clearConsoleState(unavailable ? "Console unavailable" : "Signed out", unavailable)
  }
}

document.getElementById("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const input = document.getElementById("console-token")
  const token = input.value.trim()
  input.value = ""
  if (!token) return
  if (state.authMode === "session") {
    let result
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: token }),
        credentials: "same-origin",
        redirect: "error",
      })
      result = await response.json()
    } catch {
      result = { ok: false, error: "Console unavailable" }
    }
    if (!result.ok) {
      setStatus(false, result.error ?? "Sign in failed")
      return
    }
    state.authenticated = true
  } else {
    consoleToken = token
    state.authenticated = true
  }
  state.graphCache.clear()
  renderAuthControls()
  await Promise.all([loadAll(), loadStats()])
})
document.getElementById("forget-console").addEventListener("click", async () => {
  if (state.authMode === "session" && state.authenticated) {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin", redirect: "error" })
  }
  clearConsoleState()
})
configureAuth()
