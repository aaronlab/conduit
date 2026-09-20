# Architecture

Conduit is a monorepo with two packages:

```
packages/
├── proxy/         Bun + Hono HTTP proxy on :7133
└── dashboard/     Vite + React 19 UI on :7023
```

## Request lifecycle

### Codex / Responses

```text
Codex CLI -> POST /v1/responses -> validate envelope / resolve explicit alias
         -> Copilot /responses -> normalize SSE framing and completed items
         -> Codex executes function, custom apply_patch or MCP tools locally
         -> next request replays input and opaque reasoning without truncation
```

The native path preserves input, tools, structured output, reasoning and
unknown future fields. Client disconnects cancel the upstream request.
Session/turn headers are allowlisted; the local client's credentials are
never forwarded as the Copilot credential. Upstream error status, structured
error codes and retry hints survive the return path.

`GET /v1/models` retains OpenAI's `{object, data}` shape. Requests with a
`client_version` query receive the separate Codex `{models}` catalog, whose
capabilities and limits derive from current Copilot metadata. Only eligible
native Responses models are advertised to Codex. Responses Lite and
WebSocket transport are disabled in the recommended configuration.

### Claude / Messages

```
┌──────────────┐     1. POST /v1/messages           ┌──────────────┐
│  Claude Code │ ──────────────────────────────────▶│   Conduit    │
└──────────────┘   (Anthropic Messages API)         │   :7133      │
                                                    └──────┬───────┘
                                                           │
                                2. model router            │
                                   claude-*  → passthrough │
                                   else       → translate  │
                                                           │
                              ┌────────────────────────────┤
                              │                            │
                              ▼                            ▼
                      ┌──────────────┐            ┌──────────────┐
                      │ passthrough  │            │  translate   │
                      │   (Claude)   │            │ (GPT/Gemini) │
                      └──────┬───────┘            └──────┬───────┘
                             │                           │
                             │ strip fields,             │ convert to
                             │ clamp effort,             │ OpenAI Chat
                             │ rewrite thinking          │ Completions
                             │                           │
                             ▼                           ▼
                      /v1/messages               /chat/completions
                      (Copilot native            (Copilot OpenAI
                       Anthropic endpoint)        endpoint)
```

## Key files

### `packages/proxy/src/`

| File | Role |
|---|---|
| `index.ts` | Bun.serve entry, WebSocket handling, startup orchestration |
| `app.ts` | Hono app assembly — mounts all routes with middleware |
| `middleware.ts` | API key auth (`Authorization: Bearer` / `x-api-key`) |
| `lib/model-router.ts` | Decides passthrough vs translate, normalizes model names |
| `routes/responses/handler.ts` | Native Codex Responses routing, streaming, cancellation and monitoring |
| `services/copilot/create-responses.ts` | Lossless authenticated Responses transport and image/history classification |
| `lib/responses-request.ts` | Envelope validation and explicit effort aliases |
| `lib/responses-stream.ts` | Typed events, completion recovery and premature-EOF detection |
| `lib/responses-bridge.ts` | Chat-to-Responses adaptation, selected using live supported endpoints |
| `util/sse.ts` | Shared incremental UTF-8 and CR/LF/CRLF framing |
| `routes/messages/passthrough.ts` | Anthropic → Copilot native `/v1/messages` |
| `routes/messages/translate.ts` | Anthropic → OpenAI Chat Completions fallback |
| `routes/messages/handler.ts` | Dispatches between passthrough and translate |
| `services/github/` | OAuth Device Flow + Copilot JWT refresh |
| `db/` | SQLite schema, request log sink, settings, DB-backed API keys (roadmap) |
| `util/logger.ts` | Structured logger that also writes to DB |

### `packages/dashboard/src/pages/`

- `Home` — live stats (requests, error rate, latency, tokens)
- `Logs` — request metadata, status, latency, token usage and error inspection
- `Models` — Copilot model catalog grouped by vendor
- `Connect` — copy-paste setup instructions
- `Settings` — toggles: web search, custom upstream providers, rate limiting

## Why Bun.serve instead of Node?

- Native `fetch` and `ReadableStream` semantics — streaming proxy is trivial
- ~4× faster cold start than Node + Fastify for this workload
- Built-in TypeScript, no bundler needed in dev
- `bun:sqlite` is WAL-mode out of the box

`idleTimeout` is set to 255 (Bun's max). Long-lived response streams also send
15-second SSE comments. This keeps the downstream connection alive without
inventing model tokens; it cannot prevent an upstream timeout or remove an
upstream context limit.

No request-body diagnostic dumps are written automatically. In particular,
large historical tool results and screenshots are no longer replaced with
placeholders to work around request limits. Clients must compact or reduce
oversized input explicitly.

See [Codex support and boundaries](./CODEX.md) for the native computer-tool,
remote compaction and WebSocket limitations, and the tested MCP alternative.

## Auth chain

```
User ──OAuth Device Flow──▶ github.com  ──access token──▶ Conduit
                                                          │
Conduit ──access token──▶ api.github.com/copilot_internal/v2/token
                                                          │
                                                    ──Copilot JWT──▶ Conduit
                                                          │
Conduit ──Copilot JWT──▶ api.githubcopilot.com (all API calls)
```

- Access token is persisted to `data/github_token`
- Copilot JWT is kept in memory and auto-refreshed on expiry with exponential backoff

## Database

SQLite in WAL mode at `data/conduit.db`. Main tables:

- `requests` — one row per API call (id, timestamp, path, model, resolved_model, strategy, tokens, latency, client, status)
- `settings` — key/value config edited from the dashboard
- `providers` — custom upstream providers (e.g. point `deepseek-*` at DeepSeek's OpenAI-compatible endpoint)
- `api_keys` — roadmap: DB-backed multi-tenant API keys

Indexes on `timestamp`, `model`, and `status` keep the Logs page responsive even with 100K+ rows.
