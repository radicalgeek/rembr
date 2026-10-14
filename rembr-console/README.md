# rembr-console

A self-hosted web console for [Rembr](https://github.com/radicalgeek/rembr). Static mode
supports a single server-configured identity. Hosted session mode preserves the same
console while letting each user sign in with their own API key.

## Design: a pure MCP client, by construction

The console talks to the Rembr engine **only through its MCP tool surface** — the same
`memory` / `search` / `context` / `snapshot` / `stats` tools agents use. There is no
private API, no feature flags, and no enterprise code in this package at all: tenant
management, RBAC, SSO, and billing live in a separate closed codebase that is never
shipped here. The OSS/enterprise boundary is *what code exists in the artifact*, not a
flag someone could flip.

Two consequences:

- **Nothing to bypass.** Unlocking "more" in this UI is impossible — the code isn't here,
  and server-side plan limits are enforced by the engine regardless of client.
- **Zero runtime dependencies.** One Node process: static files + a `/api/call` proxy that
  forwards an allowlisted set of MCP tools to Rembr, holding the API key server-side so it
  never reaches the browser.

## Run

### Static mode

```bash
REMBR_URL=http://localhost:3000/mcp \
REMBR_API_KEY=your-scoped-upstream-key \
REMBR_CONSOLE_AUTH_TOKEN="$(openssl rand -hex 32)" \
node server.mjs
# → http://localhost:8080
```

Or via Docker / the repo's `docker-compose.yml` (see [SELF-HOSTING.md](../SELF-HOSTING.md)).

| Env var | Default | Meaning |
|---|---|---|
| `REMBR_URL` | `http://localhost:3000/mcp` | Rembr engine MCP endpoint |
| `REMBR_API_KEY` | — | API key (see the bootstrap script in SELF-HOSTING.md) |
| `REMBR_CONSOLE_AUTH_TOKEN` | — | Required, distinct browser-to-console bearer token (32+ bytes) |
| `REMBR_CONSOLE_MODE` | `read-only` | Set to `read-write` to permit memory create/delete |
| `HOST` | `127.0.0.1` | Listen address; retain loopback unless a protected proxy is in front |
| `PORT` | `8080` | Console listen port |
| `REMBR_TIMEOUT_MS` | `30000` | Upstream request timeout |
| `REMBR_CONSOLE_ALLOWED_ORIGINS` | same origin | Comma-separated origins for a trusted reverse proxy |

The console binds loopback, requires a dedicated bearer token, validates browser origins,
caps requests and exposes only the operations used by this UI. It defaults to read-only.
If it is placed behind a reverse proxy, keep the bearer check enabled, terminate TLS there
and set an explicit origin allowlist. Use an upstream key scoped to this tenant and console;
never reuse an administrative or autonomous-bootstrap credential.

### Hosted session mode

```bash
REMBR_URL=http://localhost:3000/mcp \
REMBR_CONSOLE_AUTH_MODE=session \
node server.mjs
```

Hosted mode does not use `REMBR_API_KEY` or `REMBR_CONSOLE_AUTH_TOKEN`. A user submits
their user-bound API key once over TLS. The console validates it with
`memory.list_personal`, retains it only in a bounded in-memory server session, and gives
the browser an opaque `Secure`, `HttpOnly`, `SameSite=Strict` cookie. Process restart
invalidates every session.

Every console operation is forwarded with the API key held by that session, so Rembr
enforces personal, project, and tenant-shared visibility for that identity. The memory
feed, search, audience-scoped graph, stats, contexts, snapshots, and 50-record Memory Store
pages remain available. Memory Store is ordered by capture time from authorised memories, not
the process-wide client capture log.

Hosted mode remains read-only by default. Set `REMBR_CONSOLE_MODE=read-write` to expose
Store and Delete; those operations use the signed-in user's API key and Rembr's normal
write authorization.

| Env var | Default | Meaning |
|---|---|---|
| `REMBR_CONSOLE_AUTH_MODE` | `static` | Set to `session` for per-user API-key login |
| `REMBR_CONSOLE_SESSION_IDLE_MS` | `1800000` | Session idle expiry (30 minutes) |
| `REMBR_CONSOLE_SESSION_ABSOLUTE_MS` | `28800000` | Absolute session expiry (8 hours) |
| `REMBR_CONSOLE_SESSION_MAXIMUM` | `100` | Maximum concurrent in-memory sessions |
| `REMBR_CONSOLE_LOGIN_WINDOW_MS` | `60000` | Login-throttle window |
| `REMBR_CONSOLE_LOGIN_MAXIMUM` | `5` | Login attempts per client and window |
| `REMBR_CONSOLE_LOGIN_GLOBAL_MAXIMUM` | `100` | Global login-attempt ceiling per window |
| `REMBR_CONSOLE_TRUST_PROXY` | `false` | Trust an ingress-overwritten `X-Real-IP` for per-client login throttling |

Put hosted mode behind TLS and a trusted network boundary. Set
`REMBR_CONSOLE_ALLOWED_ORIGINS` to its exact public origin. Enable proxy trust only when
the console is a `ClusterIP` Service behind an ingress that overwrites `X-Real-IP`. Do not expose the internal
Rembr Service or console Service directly; use `ClusterIP` services and an allowlisted
ingress.

## Development

```bash
npm install   # vitest only
npm test
```

Logic lives in [lib.mjs](./lib.mjs) (config, MCP proxy, allowlist); [server.mjs](./server.mjs)
is a thin zero-dependency HTTP wrapper; the UI is vanilla JS in [public/](./public).
