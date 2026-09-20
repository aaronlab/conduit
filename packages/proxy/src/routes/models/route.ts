import { Hono } from "hono"
import { state } from "../../lib/state"
import { createCodexCatalog } from "../../lib/codex-catalog"

export const modelRoutes = new Hono()

// Virtual model aliases that route to /responses with a fixed reasoning effort.
// Exposed on /v1/models so OpenAI-compatible clients (ToonFlow, ai-sdk) can pick them.
const VIRTUAL_ALIASES = [
  { id: "gpt-5.5-low", display_name: "GPT-5.5 (low reasoning)", base: "gpt-5.5" },
  { id: "gpt-5.5-medium", display_name: "GPT-5.5 (medium reasoning)", base: "gpt-5.5" },
  { id: "gpt-5.5-high", display_name: "GPT-5.5 (high reasoning)", base: "gpt-5.5" },
  { id: "gpt-5.5-xhigh", display_name: "GPT-5.5 (extra high reasoning)", base: "gpt-5.5" },
]

modelRoutes.get("/", (c) => {
  if (c.req.query("client_version") !== undefined) {
    if (!state.models) {
      return c.json({ error: { message: "Copilot model metadata is not available yet.", type: "model_catalog_unavailable" } }, 503)
    }
    return c.json(createCodexCatalog(state.models.data))
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
