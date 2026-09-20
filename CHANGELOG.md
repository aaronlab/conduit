# Changelog

All notable changes to Conduit are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added
- Opt-in `cx` shortcut for the Astra/max/872k/live-search preset, including the
  explicitly requested sandbox/approval bypass; tested argument and working-directory
  preservation through a PATH symlink. The normal launcher remains unchanged.
- Current official ChatGPT Chat/Work versus graphical Codex/CLI comparison,
  including execution-environment and provider/usage distinctions.
- Verified Astra native web search at max effort, plus an opt-in
  `--context-budget` launcher setting with exact usable-token accounting,
  upstream-limit validation and separate per-budget catalog caches.
- Smoke-runner max reasoning, web-search and context-budget options; explicit
  budgets are verified against Codex runtime token-count events.
- Codex 0.155.1 integration, a capability-aware native Responses catalog,
  a non-destructive launcher, dashboard setup instructions and a dedicated
  Codex guide.
- Opt-in real Codex smoke tests for shell, custom `apply_patch`, multi-turn
  results, strict JSON output and isolated Playwright MCP browser/image use.
- Responses envelope, SSE, cancellation, error, model-routing, multimodal
  bridge and Anthropic search regression coverage.

### Fixed
- Responses streams now handle fragmented UTF-8/CRLF, completed output items,
  explicit terminal errors and client cancellation. EOF alone is not success.
- Image and agent-request classification now includes custom/function tool
  results, native screenshot shapes and continuation history.
- Structured upstream error codes and retry hints are preserved.
- Newly published Responses-only models are detected using Copilot metadata.
  The Chat bridge preserves image input/results, strict tools and JSON schema.
- Chat streams no longer duplicate `[DONE]` or log interrupted streams as
  successful requests.
- Claude search translation retains representable filters, location and use
  limits, and no longer reports a failed/not-performed search as success.
- Codex client identity is recognized in request logs.
- **Stream timeouts on long `thinking` responses.** Bun's default `idleTimeout` is 10s, which was killing Opus 4.7 streams whenever the model paused to think. Raised to 255s (Bun max).
- **`thinking.type: "enabled"` rejected by Opus 4.7.** The SDK sends `enabled` but Copilot's Opus 4.7 requires `adaptive`. Conduit now auto-rewrites the request and derives `output_config.effort` from `budget_tokens` if the caller didn't set one.
- **Per-model `effort` whitelist 400s.** Opus 4.7 only accepts `medium`; Haiku 4.5 doesn't support `effort` at all. Conduit now clamps or strips before forwarding instead of letting the 400 propagate to the client.
- **`ck-` prefixed API keys were unconditionally rejected** as "DB keys not yet implemented". Removed the dead branch — now any `CONDUIT_API_KEY` string works, prefix or no.

### Changed
- Removed automatic request-content diagnostic dumps and lossy truncation of
  large historical tool outputs.
- Documented tested limitations: no native Copilot computer tools, no
  fabricated remote compaction, HTTP/SSE rather than WebSockets, and no
  unsupported chat-only models in the Codex catalog.
- **README rewritten** around the "run Claude Code Opus 4.7 via your Copilot subscription" use case. Added `README_zh.md` (Chinese).
- **New docs/** — `MODEL_COMPATIBILITY.md`, `ARCHITECTURE.md`, `FAQ.md`.

## [1.0.x] — Initial releases

Highlights from the early commits that established the current architecture:

### Added
- Bun + Hono proxy on `:7133` with Vite + React 19 dashboard on `:7023`
- GitHub OAuth Device Flow + Copilot JWT auto-refresh with exponential backoff
- Native Anthropic Messages API passthrough for Claude models
- OpenAI Chat Completions translation fallback for GPT/Gemini
- Model name normalization (SDK-style → Copilot IDs)
- `anthropic-beta: context-1m-*` → `-1m` variant selection
- SQLite WAL request log with indexes; requests/stats/keys management API
- Tavily web search integration
- Custom upstream providers (route models to third-party OpenAI-compatible endpoints)
- Structured output (`output_config.format`) support preserved through passthrough
- WebSocket live log stream for the dashboard
- Rate limiting (per-second configurable)

### Fixed (pre-1.0-to-present)
- Passthrough endpoint, unsupported-field stripping, streaming plumbing
- Authentication middleware, DB logging, WebSocket reconnection, client identity detection
- `effort: "max"` / `"xhigh"` → mapped to `"high"` for Copilot
- `effort: "none"` → strip `output_config` entirely
- `output_config.format` preserved (don't strip — it's Copilot-compatible)
- `anthropic-beta` header: parsed for routing decisions but not forwarded upstream
- Load Tavily + custom upstream settings from DB on startup (previously env-only)
