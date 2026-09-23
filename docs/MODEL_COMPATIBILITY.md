# Model Compatibility

Copilot's model catalog is account- and policy-dependent. Refresh
`/api/copilot/models?refresh=true` for the current list; a historical model
name below does not guarantee current availability.

## Codex / Responses (2026-09-21)

See [CODEX.md](./CODEX.md) for the live test matrix and reproducible CLI checks.
Codex requires native Responses, not the older Chat wire protocol.

- The Codex catalog includes eligible models with `/responses` in their
  supported endpoints; chat-only models are excluded instead of presented as
  fully compatible.
- Context/prompt limits, vision, parallel tools and reasoning choices come
  from current Copilot metadata. Declared limits are not stress-test results.
- HTTP/SSE preserves custom tools, tool-output images and opaque reasoning.
- Sol/Astra native web search and CLI browser automation via Playwright MCP were
  tested. Native computer tools returned explicit upstream 400 errors.
- Astra search at `reasoning.effort=max` was confirmed by the upstream response.
  `--context-budget 872000` was confirmed by Codex's actual runtime token-count
  event, not just the catalog. This is a client budget, not an undocumented
  Responses tier or a full-window load test; see the Codex guide.
- Chat clients automatically bridge newly published Responses-only models,
  rather than relying only on a fixed `gpt-5.5`/Sol name list.
- Virtual `gpt-5.5-*` effort aliases remain authoritative. For a real model
  name, an explicit Chat `reasoning_effort`, including `none`, is respected.
  Sol's historical Chat default remains `max` only when no effort is supplied.

## Claude Code / Claude Opus 5.5 (2026-09-23)

Verified with Claude Code 2.1.280 through a Conduit instance and direct
Copilot probes. Copilot currently publishes one Claude model, `claude-opus-5.5`.

| Property | Copilot metadata / live result |
|---|---|
| Endpoint | `/v1/messages` passthrough (Claude Code sends Anthropic's `claude-opus-5-5`) |
| Window / prompt / output | 1,000,000 / **872,000** / 128,000 tokens |
| `effort` | `low`, `medium`, `high`, `xhigh`, `max` — all forwarded as requested |
| `thinking` | `adaptive`; `disabled` is **rejected** upstream. Thinking text is returned only for `display: summarized` (`omitted` or no `display` returns empty thinking blocks) |
| Over-limit prompt | `400 prompt is too long: N tokens > 1000000 maximum` (Anthropic format) |
| Client version | Claude Code **≥ 2.1.280**, else `claude_code_version_too_old` |
| Anthropic `web_search_*` server tool | **Rejected** (`The use of the web search tool is not supported.`) |
| `context_management` | Accepted only with its `context-management-*` beta header |
| Per-message `output_config` (per-turn effort) | Rejected, even with its beta |
| `safeguards` (server-side auto-mode classifier) | Rejected; Claude Code falls back to its local classifier |
| `/v1/messages/count_tokens` | Supported (except server tools) |
| Images per request | Several accepted (3 screenshots in tool results passed), although metadata lists `max_prompt_images: 1` |
| Claude Code's Claude in Chrome (`--chrome`) | Not available: Claude Code requires a claude.ai OAuth login and disables it with `ANTHROPIC_AUTH_TOKEN` or a custom base URL |
| Safeguard refusal (`stop_reason: refusal`) | Claude Code retries on `claude-opus-4-8`, which Copilot lacks, so Conduit's fallback serves it with `gpt-5.6-sol` (seen in a real subagent). `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` keeps the session on Opus 5.5 |

With `claude-opus-5-5[1m]`, `CLAUDE_CODE_EFFORT_LEVEL=max` and
`CLAUDE_CODE_AUTO_COMPACT_WINDOW=872000`, the captured requests carried
`max_tokens: 128000`, adaptive thinking and `effort: max`; Claude Code reported
a 1M model window and `/context` showed an 872k budget. WebSearch returned
results and citations through the native-search bridge below.

## Historical Claude results

The table below records earlier `/v1/messages` testing and existing shims.
These model-specific maximum-input measurements were **not rerun** during the
Codex update. Do not configure Codex's context window from this table.

| Model | Passthrough | `effort` | `thinking` | Tools | Streaming | Tested max input |
|---|---|---|---|---|---|---|
| `claude-opus-4.7` | ✅ | only `medium` | only `adaptive` | ✅ | ✅ | 630K tokens |
| `claude-opus-4.6` | ✅ | low / medium / high | enabled or adaptive | ✅ | ✅ | ~1M tokens (hard cap) |
| `claude-opus-4.5` | ✅ | low / medium / high | enabled or adaptive | ✅ | ✅ | 168K (declared) |
| `claude-sonnet-4.6` | ✅ | low / medium / high | enabled or adaptive | ✅ | ✅ | 168K (declared) |
| `claude-sonnet-4.5` | ✅ | low / medium / high | enabled or adaptive | ✅ | ✅ | 168K (declared) |
| `claude-haiku-4.5` | ✅ | **not supported** | _none_ | ✅ | ✅ | 136K (declared) |

"Declared" numbers come from Copilot's `/models` catalog. Actual upstream limits can be more lenient — for instance `claude-opus-4.6` advertises `max_prompt_tokens: 168000` but the real hard cap is 1,000,000 tokens, with no beta header needed.

## How Conduit handles the quirks

Conduit transparently reshapes requests so you don't have to special-case per model in your client:

### `thinking.type: "enabled"` → `adaptive` for Opus 4.7

Anthropic SDKs send `{"thinking": {"type": "enabled", "budget_tokens": 8000}}`, but Copilot's Opus 4.7 rejects `enabled` with:

```
"thinking.type.enabled" is not supported for this model.
Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
```

Conduit rewrites the payload on the fly: `type` becomes `adaptive`, and the budget is translated into an `effort` level (`<=4000` → `low`, `4000–16000` → `medium`, `>=16000` → `high`) unless the caller already picked one explicitly.

### `effort` validated against Copilot metadata

When Copilot publishes a model's `reasoning_effort` list (for example
`claude-opus-5.5`: `low … max`), the requested effort is kept if listed and
otherwise clamped to the nearest listed level below it. Without metadata the
legacy mapping applies: `max` → `high` (`xhigh` on `-xhigh` variants) and
`xhigh` → `high`.

### Per-model effort overrides

- **`claude-opus-4.7`** — upstream whitelist is `["medium"]`. Anything else (low / high / max) gets clamped to `medium`.
- **`claude-opus-4.8`, `claude-opus-5`** — forced to `max`.
- **`claude-haiku-4.5`** — does not support `reasoning_effort` at all. Conduit strips the field.

`claude-opus-5.5` has no override: Claude Code's `/effort` or
`CLAUDE_CODE_EFFORT_LEVEL` decides.

### `thinking.type: "disabled"` on Opus 5.5

Opus 5.5 rejects disabled thinking. Conduit drops `thinking` (the default is
adaptive) and uses the model's lowest effort instead. Another model returning
the same 400 is remembered and the request is retried once.

### Per-turn effort

Claude Code 2.1.280 can place `output_config` on a mid-conversation system
message. Copilot rejects that shape, so Conduit removes it and lifts the most
recent per-turn effort to the request-level `output_config`.

### `context_management` and betas

`anthropic-beta` is not forwarded in general. The exception is
`context-management-*`, sent only with a `context_management` body, which
Copilot then accepts. Without that beta — or after an upstream rejection, which
is retried once — `context_management` is stripped.

### Unsupported top-level fields

The following fields are silently stripped on their way out because Copilot's `/v1/messages` returns "Extra inputs" errors for them. Per-block `cache_control` is preserved — only the _top-level_ shortcut is dropped.

- top-level `cache_control`
- `container`
- `inference_geo`

`safeguards` is deliberately **not** stripped: removing it would make Claude
Code believe a server-side safety classifier had run. Its upstream 400 lets
Claude Code fall back to its local auto-mode classifier.

### Web search for Claude models

Copilot rejects Anthropic's `web_search_*` server tool on Claude models.
Conduit runs the search with Copilot's native Responses `web_search` on a
bridge model — `CONDUIT_WEB_SEARCH_MODEL`, or the first available of
`gpt-6-sol`, `gpt-5.6-sol`, `gpt-6-luna`, `gpt-5.6-sol-fast` — and returns
Anthropic `server_tool_use`, `web_search_tool_result` and text blocks under the
requested model. `allowed_domains`, location and `max_uses` are forwarded;
`blocked_domains` cannot be enforced natively and fails explicitly unless a
Tavily fallback is configured. The request log records the search model.

### Model name normalization

SDK-style model names (`claude-opus-4-6-20250820`, `claude-opus-5-5[1m]`) are mapped to Copilot IDs (`claude-opus-4.6`, `claude-opus-5.5`). A Claude model missing from the startup model cache triggers a throttled refresh before the unavailable-model fallback is used. When the client sends `anthropic-beta: context-1m-*`, Conduit picks the `-1m` variant (`claude-opus-4.6-1m`). In our tests `claude-opus-4.6` already accepts up to 1,000,000 input tokens without the `-1m` suffix, so the beta header isn't strictly required.

## How to test yourself

Conduit's dashboard records request metadata and usage, not full private
conversation/screenshot dumps:

1. Send a request through Conduit
2. Open `http://localhost:7023/logs`
3. Inspect the requested/resolved model, status, error and token usage

For programmatic access, query the SQLite DB directly:

```bash
sqlite3 data/conduit.db \
  "SELECT timestamp, model, resolved_model, strategy, status_code
   FROM requests ORDER BY timestamp DESC LIMIT 10;"
```
