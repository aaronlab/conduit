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

### `effort` clamping per model

- **`claude-opus-4.7`** — upstream whitelist is `["medium"]`. Anything else (low / high / max) gets clamped to `medium`.
- **`claude-haiku-4.5`** — does not support `reasoning_effort` at all. Conduit strips the field.

### `max` / `xhigh` → `high`

Anthropic's SDK sometimes sends `effort: "max"` or `"xhigh"`. Copilot only accepts `low / medium / high`, so Conduit maps those to `high` before forwarding.

### Unsupported top-level fields

The following fields are silently stripped on their way out because Copilot's `/v1/messages` returns "Extra inputs" errors for them. Per-block `cache_control` is preserved — only the _top-level_ shortcut is dropped.

- `context_management`
- top-level `cache_control`
- `container`
- `inference_geo`

### Model name normalization

SDK-style model names (`claude-opus-4-6-20250820`) are mapped to Copilot IDs (`claude-opus-4.6`). When the client sends `anthropic-beta: context-1m-*`, Conduit picks the `-1m` variant (`claude-opus-4.6-1m`). In our tests `claude-opus-4.6` already accepts up to 1,000,000 input tokens without the `-1m` suffix, so the beta header isn't strictly required.

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
