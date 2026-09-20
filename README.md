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

**Verified with Codex CLI 0.155.1 on 2026-09-20.** This does not make every OpenAI
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
and keeps GUI approvals enabled. See [GUI setup and verified limitations](./docs/CODEX.md#official-desktop-gui-through-conduit-macos).
Hosted ChatGPT Chat/cloud services are not implicitly rerouted.

### Claude Code

Choose models actually available in your account's catalog:

```bash
unset ANTHROPIC_API_KEY
export ANTHROPIC_BASE_URL=http://127.0.0.1:7133
export ANTHROPIC_AUTH_TOKEN="$(cat .conduit-key)"
export ANTHROPIC_MODEL=<available-model-id>
claude
```

Available Claude models use the native Messages endpoint. Non-Claude models
use the existing translation path. The existing fallback for unavailable
Claude aliases and the Anthropic `web_search_*` to Sol native-search bridge
are preserved. Review [model compatibility](./docs/MODEL_COMPATIBILITY.md)
before relying on an old model name.

## Capabilities and boundaries

| Capability | Support |
|---|---|
| Codex HTTP/SSE, shell and custom `apply_patch` | Verified end to end |
| Multi-turn function/custom/MCP tool outputs | Preserved, including images |
| Opaque reasoning, instructions, schemas and future Responses fields | Native passthrough |
| Hosted `web_search` | Verified on Sol and Astra (including max effort); upstream/model dependent |
| CLI browser automation | Verified with isolated Playwright MCP |
| Native `computer` / `computer_use_preview` | **Rejected by Copilot in live probes** |
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

Never use your GitHub token as the client-facing Conduit key. Keep credentials,
generated catalogs and databases out of Git.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/responses` | Native Copilot Responses, including SSE |
| GET | `/v1/models?client_version=0.155.1` | Codex `ModelInfo` catalog |
| GET | `/v1/models` | OpenAI-compatible model list |
| POST | `/v1/messages` | Anthropic Messages |
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
