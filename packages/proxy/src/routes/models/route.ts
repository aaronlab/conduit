import { Hono } from "hono"
import { state } from "../../lib/state"
import { createCodexCatalog } from "../../lib/codex-catalog"
import { toAnthropicModelId } from "../../lib/model-router"
import type { Model } from "../../services/copilot/get-models"

export const modelRoutes = new Hono()

// Virtual model aliases that route to /responses with a fixed reasoning effort.
// Exposed on /v1/models so OpenAI-compatible clients (ToonFlow, ai-sdk) can pick them.
const VIRTUAL_ALIASES = [
  { id: "gpt-5.5-low", display_name: "GPT-5.5 (low reasoning)", base: "gpt-5.5" },
  { id: "gpt-5.5-medium", display_name: "GPT-5.5 (medium reasoning)", base: "gpt-5.5" },
  { id: "gpt-5.5-high", display_name: "GPT-5.5 (high reasoning)", base: "gpt-5.5" },
  { id: "gpt-5.5-xhigh", display_name: "GPT-5.5 (extra high reasoning)", base: "gpt-5.5" },
]

function formatTokens(value: number | null | undefined): string | null {
  if (typeof value !== "number" || value <= 0) return null
  return value >= 1000 ? `${Math.round(value / 1000)}K` : String(value)
}

/**
 * Anthropic Models API shape, used by Claude Code's gateway model discovery
 * (CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY). Claude ids use Anthropic's
 * spelling so Claude Code applies its own capabilities for the model.
 */
export function createAnthropicModelList(models: readonly Model[]) {
  const data = models
    .filter((model) => model.model_picker_enabled && model.capabilities?.type === "chat")
    .map((model) => {
      const limits = model.capabilities.limits
      const prompt = formatTokens(limits?.max_prompt_tokens)
      const output = formatTokens(limits?.max_output_tokens)
      return {
        type: "model",
        id: toAnthropicModelId(model.id),
        display_name: model.name,
        created_at: "1970-01-01T00:00:00Z",
        description: [`GitHub Copilot ${model.id} via Conduit`, prompt && `${prompt} prompt`, output && `${output} output`]
          .filter(Boolean).join(" · "),
        ...(typeof limits?.max_prompt_tokens === "number" && { max_input_tokens: limits.max_prompt_tokens }),
        ...(typeof limits?.max_output_tokens === "number" && { max_tokens: limits.max_output_tokens }),
      }
    })
  return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null }
}

modelRoutes.get("/", (c) => {
  if (c.req.query("client_version") !== undefined) {
    if (!state.models) {
      return c.json({ error: { message: "Copilot model metadata is not available yet.", type: "model_catalog_unavailable" } }, 503)
    }
    return c.json(createCodexCatalog(state.models.data))
  }

  if (c.req.header("anthropic-version")) {
    return c.json(createAnthropicModelList(state.models?.data ?? []))
  }

  const real =
    state.models?.data.map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: model.vendor,
      display_name: model.name,
    })) ?? []

  const baseIds = new Set(real.map((m) => m.id))
  const virtual = VIRTUAL_ALIASES.filter((a) => baseIds.has(a.base)).map((a) => ({
    id: a.id,
    object: "model",
    created: 0,
    owned_by: "OpenAI",
    display_name: a.display_name,
  }))

  return c.json({ object: "list", data: [...real, ...virtual] })
})
