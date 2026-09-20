# Codex with Conduit

Verified on **2026-09-20**, using **Codex CLI 0.155.1** and the current Copilot
model API. This guide distinguishes native protocol support from hosted
services that Copilot does not provide.

## Recommended setup

Start Conduit with a non-empty `CONDUIT_API_KEY`, then run from the repository:

```bash
./bin/conduit-codex
./bin/conduit-codex --help
```

The helper reads the environment key or repository `.conduit-key`, obtains
model metadata, writes a local catalog, and applies provider overrides for
this invocation. Your existing Codex configuration and login remain intact.
Normal Codex sandbox and approval controls remain in force.

The ordinary `/v1/models` response is still an OpenAI model list. Codex needs
the different `ModelInfo` shape returned by
`/v1/models?client_version=0.155.1`. The catalog uses Copilot's declared prompt
and context limits rather than Codex's generic unknown-model fallback. It
disables Responses Lite and does not advertise unverified hosted tools.

Explicitly choosing a model unavailable in the catalog is an error, not
permission to silently select another model. Chat-only models remain usable
through `/v1/chat/completions`, but are not advertised as native Codex models.

## Manual provider configuration

For a manually managed setup, use a user-level Codex configuration like:

```toml
model = "gpt-5.4-mini" # Choose an available native Responses model.
model_provider = "conduit"
model_reasoning_summary = "none"
web_search = "disabled"
model_catalog_json = "/absolute/path/to/conduit-models.json"

[model_providers.conduit]
name = "Conduit"
base_url = "http://127.0.0.1:7133/v1"
wire_api = "responses"
env_key = "CONDUIT_API_KEY"
requires_openai_auth = false
supports_websockets = false
supports_standalone_web_search = false
```

Export `CONDUIT_API_KEY` before starting Codex. The catalog file must contain
the authenticated Codex catalog response, not the normal OpenAI model list.
The helper is preferred because it generates the catalog and configuration
together.

Select a model explicitly, or forward normal Codex arguments after `--`:

```bash
./bin/conduit-codex --model gpt-6-astra
./bin/conduit-codex --model gpt-5.4-mini -- exec "Explain this project"
```

`CONDUIT_CODEX_BASE_URL`, `CONDUIT_CODEX_MODEL`, `CONDUIT_CODEX_CACHE_DIR` and
`CODEX_BIN` configure the launcher. The default cache is the checkout's ignored
`data/codex` directory, with private directory/file permissions. The key file
may contain either a raw key or a `CONDUIT_API_KEY=...` assignment; it is parsed
as data, never sourced as a shell script.

Important:

- `wire_api = "chat"` is no longer supported by this Codex release.
- Use the API root ending in `/v1`, not a URL already ending in `/responses`.
- Do not name this provider `OpenAI`: Codex uses first-party provider identity
  for behavior such as remote compaction.
- Do not copy prerelease-only settings into a stable Codex configuration.
- An API key for OpenAI is not required. A Copilot-enabled account and the
  separate local Conduit key are required.

## What was actually tested

| Path | Live result |
|---|---|
| Codex + `gpt-5.4-mini` | Text, shell, custom grammar `apply_patch`, file verification and multi-turn tool results passed |
| Codex + `gpt-6-astra` / `gpt-5.6-sol` | Shell, custom `apply_patch`, file verification, history replay and strict JSON-schema output passed |
| Responses reasoning history | Opaque reasoning items survived the CLI tool loop |
| `text.format` JSON schema | Strict object `{"ok":true,"value":42}` returned |
| Sol native `web_search` | Real `web_search_call` plus URL citation returned |
| Codex + Playwright MCP 0.0.82 | Navigation, form fill, click, verified page state and screenshot/image feedback passed |
| `computer` with `gpt-6-astra` | HTTP 400, `unsupported_value`, tool not supported |
| `computer_use_preview` with Sol | HTTP 400, `unsupported_value`, tool not supported |

These are point-in-time results, not guarantees about every model or account.
No personal browser profile or desktop was used for the browser test.
The catalog enables verified freeform patches on these three models. Deferred
tool search and browser/image replay are marked verified only for the mini
baseline; other native models keep ordinary local tools rather than being
promised untested capabilities.

### Web search

Native Responses `web_search` definitions, options, search-call output items
and URL citations are passed through, not translated into a fake function.
Use a model that actually supports search and explicitly enable it in Codex:

```toml
web_search = "live"
```

Through the helper (this path was also tested with actual Codex search events):

```bash
./bin/conduit-codex --model gpt-5.6-sol -- \
  -c 'web_search="live"' exec "Search for the official OpenAI Codex repository"
```

The default is disabled because availability is model-dependent. Cached/live
search options are upstream capabilities; Conduit does not manufacture a
search cache or implement the experimental `/alpha/search` service.

Claude Code's dedicated Anthropic search requests retain their existing
Sol-backed conversion. Allowed domains, approximate location and search-use
limits are forwarded where representable. Unsupported constraints and failed
searches are explicit errors; a failed backend is not reported as "no results."
A configured Tavily fallback remains a separate service.

## Computer use: the important distinction

**Native OpenAI computer tools are not available through the tested Copilot
API.** Both modern `computer` and legacy `computer_use_preview` were rejected.
Also, Codex CLI 0.155.1 does not provide a native `computer_call` executor just
because a proxy forwards that item.

**CLI browser automation through MCP does work.** This is a client-executed
tool workflow: Codex calls a local MCP server, the server operates an isolated
browser, and text/images return through Responses function-tool outputs.
It is not native hosted computer use, and it does not grant control of your
macOS desktop.

An example interactive browser MCP configuration:

```toml
[mcp_servers.playwright]
command = "bunx"
args = ["@playwright/mcp@0.0.82", "--headless", "--isolated", "--browser=chrome"]
required = true
startup_timeout_sec = 30
tool_timeout_sec = 60
default_tools_approval_mode = "prompt"
```

Install Chrome and review the MCP server before enabling it. Use an isolated
profile, restrict destinations appropriate to your task, and retain approvals
for real accounts or consequential actions. Origin allowlists alone are not
a complete browser security boundary. Do not connect to an existing personal
browser profile merely to run the smoke test.

In noninteractive `codex exec`, a tool requiring approval can be refused under
the `never` approval policy; a zero CLI exit code alone does not mean the tool
ran. The opt-in browser smoke runner grants only an explicit tool allowlist
for its temporary localhost fixture and independently verifies the submitted
form and returned screenshot. It does not change your personal MCP settings.

## Reproduce the checks

```bash
# Proxy must already be running with the same key.
bun run test:codex --model gpt-5.4-mini

# Optional, actual browser automation:
bunx @playwright/mcp@0.0.82 --help
bun run test:codex --model gpt-5.4-mini --browser

# Alternative executable, proxy or Chrome location:
CODEX_BIN=/absolute/path/to/codex \
  bun run test:codex --base-url http://127.0.0.1:7133 --model gpt-5.4-mini
```

The script is opt-in and consumes Copilot usage. It uses a temporary
`CODEX_HOME` and workspace, cleans them up, and fails if actual tool/file/image
evidence is missing. `CONDUIT_CHROME_PATH` optionally selects a Chrome binary.
Ordinary `bun run test` uses mocked upstreams and makes no inference requests.

## Reliability and unsupported surfaces

- **Streaming:** fragmented UTF-8 and CR/LF/CRLF framing are handled. Completed
  output items are preserved/recovered before terminal completion. EOF or
  `[DONE]` alone is not a successful Responses completion.
- **Errors:** upstream status/code/parameter and retry hints are preserved.
  Failed/incomplete streams are recorded as failures rather than successful
  requests. Disconnecting the client cancels the upstream request.
- **Context:** images, large text/tool results and encrypted reasoning are not
  automatically discarded. Compact in Codex or reduce attachments if Copilot
  rejects an oversized request.
- **Compaction:** OpenAI's `/responses/compact` is not emulated. That endpoint
  returns an explicit 501; use a custom Conduit provider so Codex selects its
  local summarization workflow.
- **WebSockets:** use HTTP/SSE. A WebSocket upgrade receives 426 for Codex's
  fallback path; no connection-local continuation state is fabricated.
- **Other hosted products:** forwarding JSON is not an implementation of
  OpenAI file storage, remote MCP hosting, image generation, audio, hosted
  containers or desktop control. Any such feature must be supported by the
  actual upstream and tested separately.
- **Privacy:** normal logging records request metadata/usage/errors, not
  automatic conversation or screenshot dumps. Generated catalogs and keys
  are local files and should not be committed.

## Upstream references

- [Codex 0.155.1 release](https://github.com/openai/codex/releases/tag/rust-v0.155.1)
- [Pinned provider contract](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/model-provider-info/src/lib.rs)
- [Pinned Responses SSE decoder](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/codex-api/src/sse/responses.rs)
- [Pinned model metadata schema](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/protocol/src/openai_models.rs)
- [Codex MCP documentation](https://developers.openai.com/codex/mcp/)
- [Codex browser availability](https://developers.openai.com/codex/browser/?surface=cli)
- [OpenAI computer-use API](https://developers.openai.com/api/docs/guides/tools-computer-use)
