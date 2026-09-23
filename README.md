# Conduit

**Use Codex CLI and Claude Code with the models available to your GitHub Copilot account.**

[简体中文](./README_zh.md) · English

```text
Codex CLI -------- Responses API -------+
Claude Code ------ Messages API --------+--> Conduit :7133 --> GitHub Copilot
OpenAI clients --- Chat Completions ----+
                                            Dashboard :7023
```

Conduit is a local, unofficial Copilot gateway. It preserves native Responses
requests for Codex instead of converting function tools, custom `apply_patch`,
images or encrypted reasoning into a less capable chat protocol. Claude's
Messages route and its model-specific compatibility shims remain available.

**Verified with Codex CLI 0.155.1 on 2026-09-20 and Claude Code 2.1.280 (Claude
Opus 5.5) on 2026-09-23.** This does not make every OpenAI
hosted service available on Copilot. Model access, tools, limits and billing are
controlled by GitHub and your organization.

## Quick start

Requirements: Bun 1.3+, a Copilot-enabled GitHub account, and macOS/Linux/WSL.
For Codex, also install the [official CLI](https://github.com/openai/codex).

```bash
git clone https://github.com/aaronlab/conduit.git
cd conduit
bun install

# Keep the same local key across restarts; never commit it.
test -s .conduit-key || (umask 077; openssl rand -hex 32 > .conduit-key)
export CONDUIT_API_KEY="$(cat .conduit-key)"
# Local dashboard only: Vite exposes VITE_* values to its browser client.
export VITE_API_KEY="$CONDUIT_API_KEY"
bun run dev
```

The first start uses GitHub's device login. The proxy listens on `:7133`, and
the dashboard on `:7023`. Do not expose an unauthenticated development instance
to a network.

These commands create a raw key file. The Codex helper also accepts legacy
`CONDUIT_API_KEY=...` key files; for those files, export the assignment's value
when starting the proxy rather than the entire file. Keep the dashboard local:
do not publish a frontend built with a real `VITE_API_KEY`.

### Codex

In another terminal, from this repository:

```bash
./bin/conduit-codex
./bin/conduit-codex --help
```

The helper loads `CONDUIT_API_KEY` or the local `.conduit-key`, downloads a
capability-aware model catalog, and launches Codex with a custom Responses
provider. It does **not** replace your Codex configuration/login or disable its
sandbox and approval controls.

See [the Codex guide](./docs/CODEX.md) for explicit provider configuration,
model selection, web search, browser MCP setup, verified capabilities and
troubleshooting.

For a two-letter command, the optional [cx preset](./docs/CODEX.md#short-command-cx)
launches Astra with max reasoning, detailed reasoning summaries, an exact 872k
usable budget and live search.
**It also disables Codex sandboxing and standard execution approvals.**
Use it only when you explicitly want that trusted-project preset; the normal
launcher above does not weaken permissions.

For Astra with explicit max reasoning, live search and an exact **872,000-token
usable client budget**:

```bash
./bin/conduit-codex --model gpt-6-astra --context-budget 872000 -- \
  -c 'model_reasoning_effort="max"' -c 'web_search="live"'
```

This combination was verified on 2026-09-21. The budget is a Codex client
setting, not a claim about an undocumented Copilot server tier or a full-window
stress test. See the guide for the upstream limits and compaction threshold.
Astra's catalog and launcher now request visible `detailed` reasoning summaries
by default; this is separate from reasoning effort. Other models retain
conservative summary defaults. See [reasoning summaries](./docs/CODEX.md#visible-reasoning-summaries).

### Official desktop GUI

The official ChatGPT desktop app's **local Work and Codex views** have also
been verified through Conduit. On macOS, run:

```bash
./bin/cxg
```

It uses a separate private profile, preserves your existing login/settings,
and keeps GUI approvals enabled. The Work view's local `@Computer` plugin
also passed a controlled native-app screenshot/input/click test after macOS
permissions were granted. See [GUI setup and verified limitations](./docs/CODEX.md#official-desktop-gui-through-conduit-macos).
Hosted ChatGPT Chat/cloud services are not implicitly rerouted.

For optional guided learning through Copilot, run `./bin/cxg --install-study`
and select **Study (Conduit local)** from the Work composer's `@study` search.
This is a separate explicit-only local workflow, **not** OpenAI's hosted
Study Mode. See [Study setup and boundaries](./docs/CODEX.md#study-mode-and-local-guided-learning).

### Claude Code

**Claude Opus 5.5 · Max effort · 872k context** (verified on 2026-09-23 with
Claude Code 2.1.280):

```bash
unset ANTHROPIC_API_KEY
export ANTHROPIC_BASE_URL=http://127.0.0.1:7133
export ANTHROPIC_AUTH_TOKEN="$(cat .conduit-key)"
export ANTHROPIC_MODEL='claude-opus-5-5[1m]'
# Pin the Opus/Sonnet/Haiku/Fable slots (subagents, WebFetch, background calls,
# /model aliases) too; Copilot publishes no other Claude model.
export ANTHROPIC_DEFAULT_OPUS_MODEL='claude-opus-5-5[1m]'
export ANTHROPIC_DEFAULT_SONNET_MODEL='claude-opus-5-5[1m]'
export ANTHROPIC_DEFAULT_HAIKU_MODEL='claude-opus-5-5[1m]'
export ANTHROPIC_DEFAULT_FABLE_MODEL='claude-opus-5-5[1m]'
export CLAUDE_CODE_EFFORT_LEVEL=max
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=872000
claude
```

- **Version:** Claude Code **2.1.280 or newer** is required. Anthropic rejects
  older clients for this model (`claude_code_version_too_old`). npm may lag
  behind the native channel; `claude install latest` installs the native build.
- **Model:** use Anthropic's id `claude-opus-5-5` so Claude Code applies its
  Opus 5.5 capabilities; Conduit sends Copilot's `claude-opus-5.5`.
- **Effort:** `max` is session-only in `/effort`, so the environment variable
  pins it. Conduit forwards every effort level Copilot publishes for the model.
- **Context:** without `[1m]`, Claude Code assumes 200k for a custom base URL.
  Copilot allows 872,000 prompt tokens (1M window minus 128k output), so the
  auto-compact window is set to exactly that. `/context` then reports `…/872k`.
- **Search:** Copilot's Claude endpoint rejects Anthropic's server-side web
  search, so Claude Code's WebSearch runs through Copilot's native search on
  `gpt-6-sol` (else `gpt-5.6-sol`, `gpt-6-luna`, `gpt-5.6-sol-fast`; override
  with `CONDUIT_WEB_SEARCH_MODEL`). Results return as Anthropic search blocks.

Non-Claude models use the existing translation path. Newly published Claude
models are picked up without a restart; unavailable Claude aliases still fall
back to Sol. `/v1/messages/count_tokens` is supported, and Claude Code's gateway
model discovery (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`) lists Claude
models under Anthropic ids. Review [model compatibility](./docs/MODEL_COMPATIBILITY.md)
before relying on an old model name.

## Capabilities and boundaries

| Capability | Support |
|---|---|
| Codex HTTP/SSE, shell and custom `apply_patch` | Verified end to end |
| Multi-turn function/custom/MCP tool outputs | Preserved, including images |
| Opaque reasoning, instructions, schemas and future Responses fields | Native passthrough |
| Hosted `web_search` | Verified on Sol and Astra (including max effort); upstream/model dependent |
| Claude Code WebSearch on Claude models | Bridged to Copilot native search (Anthropic's server tool is rejected upstream) |
| CLI browser automation | Verified with isolated Playwright MCP |
| Desktop Work local `@Computer` plugin | Verified on a controlled macOS app with Astra / max; requires OS and per-app permissions |
| Hosted Responses `computer` / `computer_use_preview` | **Rejected by Copilot in live probes** |
| WebSocket Responses | Disabled; explicit HTTP fallback |
| OpenAI `/responses/compact` | Not emulated; use Codex local compaction |
| Chat-only models in Codex | Not advertised as native Responses models |
| Claude Messages and OpenAI Chat clients | Retained, with regression tests |

The proxy no longer deletes large historical tool outputs or writes request
content/screenshot diagnostic dumps automatically. Oversized requests fail
explicitly instead of silently losing context.

## Development and verification

```bash
bun run test
bun run typecheck

# Opt-in: makes real, billable Copilot requests through a running proxy.
bun run test:codex --model gpt-5.4-mini

# Optional browser test: Chrome + the pinned Playwright MCP are required.
bunx @playwright/mcp@0.0.82 --help
bun run test:codex --model gpt-5.4-mini --browser
```

The smoke runner uses a temporary Codex home and workspace. It checks real
shell output, the file produced by `apply_patch`, strict JSON output, and
optionally a real local browser form plus screenshot feedback. A model merely
claiming success is not sufficient.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CONDUIT_PORT` | `7133` | Proxy port |
| `CONDUIT_API_KEY` | empty | Client authentication; empty means unauthenticated development mode |
| `CONDUIT_INTERNAL_KEY` | empty | Dashboard-to-proxy authentication |
| `CONDUIT_TOKEN_PATH` | `packages/proxy/data/github_token` | GitHub token location |
| `CONDUIT_DB_PATH` | `data/conduit.db` | SQLite path, relative to the proxy process working directory |
| `CONDUIT_BASE_URL` | empty | Advertised base URL |
| `CONDUIT_WEB_SEARCH_MODEL` | first available of `gpt-6-sol`, `gpt-5.6-sol`, `gpt-6-luna`, `gpt-5.6-sol-fast` | Native-search model that runs Anthropic web searches for models without native search (e.g. Claude) |

Never use your GitHub token as the client-facing Conduit key. Keep credentials,
generated catalogs and databases out of Git.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/responses` | Native Copilot Responses, including SSE |
| GET | `/v1/models?client_version=0.155.1` | Codex `ModelInfo` catalog |
| GET | `/v1/models` | OpenAI-compatible model list (Anthropic format when `anthropic-version` is sent) |
| POST | `/v1/messages` | Anthropic Messages |
| POST | `/v1/messages/count_tokens` | Anthropic token counting (Claude models) |
| POST | `/v1/chat/completions` | Chat Completions; dynamically routes Responses-only models |
| GET | `/health` | Health check |
| GET | `/api/copilot/models?refresh=true` | Refresh current Copilot model metadata |
| GET | `/api/stats`, `/api/requests` | Request metadata, usage and error monitoring |

Further reading: [Architecture](./docs/ARCHITECTURE.md) ·
[FAQ](./docs/FAQ.md) · [Remote Claude Code access](./docs/REMOTE_ACCESS.md).

## License

MIT. Conduit is independent of GitHub, OpenAI and Anthropic. Use it only with
accounts you are authorized to use and in accordance with applicable service
terms and organization policies.
