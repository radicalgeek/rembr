# MCP 2026-07-28 Migration — Implementation Status

Status of the "Rembr MCP 2026-07-28 Migration Evaluation" plan as of 2026-06-10.

**Key constraint discovered during implementation:** the latest published
`@modelcontextprotocol/sdk` (1.29.0, installed) still targets protocol
**2025-11-25**. No SDK release implements the 2026-07-28 wire changes
(`server/discover`, handshake removal, `_meta`-mandated client info). This
answers the plan's Open Question 1. Everything implementable without SDK
support has been implemented; the remainder is tracked under "Blocked on SDK".

## Implemented

| Plan item | What was done |
|---|---|
| 1.1 SDK upgrade | `@modelcontextprotocol/sdk` 1.29.0 (latest published) |
| 1.2 server/discover | Custom request handler in `createMCPServer()` returning protocol version, serverInfo, and capabilities. Legacy `initialize` still answered by the SDK for 2025-xx clients. |
| 1.3 Remove session management | `/mcp` POST now builds a fresh `Server` + stateless `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`) per request and tears it down on response close. In-memory `sessions` Map, `RedisSessionStore` (`session-store.ts`), session sweep interval, and all `mcp_sessions` reads/writes are gone. GET/DELETE `/mcp` return 405 per the stateless Streamable HTTP spec. |
| 1.4 `_meta` extraction | `src/middleware/mcp-meta.ts` extracts `io.modelcontextprotocol/protocolVersion`, `clientInfo`, `clientCapabilities` per request (logged in dev; never throws on legacy clients). |
| 1.5 Mcp-Method/Mcp-Name validation (SEP-2243) | Already implemented (`middleware/mcp-header-validation.ts`, wired before the POST handler). |
| 1.6 Remove session auth | Tier-4 session fallback removed from `unified-auth-middleware.ts`; precedence is now API key → OAuth Bearer → JWT. `/mcp/start-auth/:sessionId` (rembr-mcp) and `/api/mcp-auth` (rembr-ui) return **410 Gone** with migration guidance. Migration 026 drops `mcp_sessions`. |
| 1.7 Stateless API key / OAuth auth | Verified — every request authenticates independently; tenant scoping rides on the credential. |
| 1.8 Tool handlers without session transport | All tools work against the per-request server (verified by smoke test: `tools/list` succeeds with no prior `initialize`). |
| 1.9 Deployment configs | `sessionAffinity: ClientIP` removed from prod + test MCP Services — pods can round-robin. |
| 2.1 / 2.3 OAuth issuer binding (SEP-837, RFC 9207) | `issuer` column added (`oauth_tokens`; Prisma model + migration in rembr-ui, SQL migration 026 in rembr-mcp, bootstrap schema). rembr-ui stamps `OAUTH_ISSUER`/`NEXTAUTH_URL` at issuance; `verifyOAuthToken()` validates against `OAUTH_EXPECTED_ISSUER`/`PUBLIC_URL` — **advisory by default**, rejecting when `OAUTH_ENFORCE_ISSUER=true` (per the plan's risk mitigation). |
| 3.1 Cacheable results (SEP-2549) | `tools/list` returns `ttlMs: 300000`, `cacheScope: "private"` (tool availability varies by tenant plan). |
| 3.7 Trace context (SEP-414) | `traceparent`/`tracestate`/`baggage` extracted from `_meta` and logged with request diagnostics. Full OpenTelemetry propagation deferred (plan marks it optional/Phase 2). |
| 3.8 Deterministic tool order | Already compliant — tool lists are static literal arrays (consolidated first, then legacy), identical on every request. |

## Not applicable (verified against the codebase)

| Plan item | Why |
|---|---|
| 2.2 DCR `application_type` | rembr has no Dynamic Client Registration endpoint (OAuth clients are provisioned via rembr-ui). |
| 2.4–2.7, 2.9 Tasks extension (SEP-2663) | Rembr's task tooling (`task-mcp-tools.ts`, RLM) is **application-level tools invoked via `tools/call`**, not the experimental protocol Tasks API. No `tasks/*` methods exist, so there is no lifecycle to migrate and no `io.modelcontextprotocol/tasks` extension to advertise. |
| 2.8 Multi Round-Trip / InputRequired (SEP-2322) | No tool handler issues server-initiated requests (no elicitation/sampling); task iteration state is returned in tool results and persisted in the DB. |
| 3.2 Error code -32002 → -32602 | No occurrence of `-32002` in the codebase. |
| 3.5 `subscriptions/listen` | No resource subscriptions implemented (capabilities advertise `tools` only). |
| 3.6 / 3.9 / SEP-2577 deprecations | No roots/sampling/logging/`ping` implementations of our own; those live inside the SDK. |

## Blocked on SDK (revisit when a 2026-07-28 SDK ships)

- Removing the legacy `initialize` handshake path (SDK still requires it for
  pre-2026 clients; our stateless mode makes it a no-op rather than a session).
- Rejecting requests lacking `_meta` protocol fields (would break every
  2025-11-25 client, including current Claude clients).
- SDK-native `server/discover` (our custom handler should be replaced).
- `tasks` extension support, `subscriptions/listen`, `logging/setLevel`
  removal — all SDK-internal.

## Client migration notes

- **Session-cookie clients**: authentication via `mcp-session-id` is gone.
  Create an API key (sent via `X-API-Key`) or connect via OAuth
  (`Authorization: Bearer mcp_oauth_…`).
- **`Mcp-Session-Id` clients**: the header is ignored; the server no longer
  issues one. Initialize still works but creates no state.
- **SSE notifications**: GET `/mcp` returns 405 — there is no standalone
  notification stream in stateless mode.

## Rollout/env flags

| Variable | Effect |
|---|---|
| `OAUTH_EXPECTED_ISSUER` | Issuer that tokens must carry (defaults to `PUBLIC_URL`). |
| `OAUTH_ENFORCE_ISSUER=true` | Turn the advisory issuer check into a hard 401. Enable once all live tokens carry `issuer` (tokens rotate within 7 days). |

Run migration `src/migrations/026-mcp-stateless-protocol.sql` (adds
`oauth_tokens.issuer`, drops `mcp_sessions`) and the rembr-ui Prisma migration
`20260610000000_add_oauth_token_issuer` before deploying.
