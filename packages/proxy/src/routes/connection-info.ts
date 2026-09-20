import { Hono } from "hono"
import { state } from "../lib/state"
import { createCodexCatalog, verifiedCodexCapabilities } from "../lib/codex-catalog"
import { CODEX_LIMITATIONS, CODEX_VERSION, codexCatalogUrl, createCodexProvider, normalizeCodexBaseUrl } from "../lib/codex-config"
import type { ConnectionInfo } from "../lib/codex-types"

export function createConnectionInfoRoute(opts: { port: number; baseUrl: string | null }): Hono {
  const app = new Hono()
  app.get("/connection-info", (c) => {
    const apiBase = normalizeCodexBaseUrl(opts.baseUrl || `http://127.0.0.1:${opts.port}`)
    const base = apiBase.slice(0, -"/v1".length)
    const models = state.models?.data ?? []
    const catalog = createCodexCatalog(models)
    const sourceModels = new Map(models.map(model => [model.id, model]))
    const info: ConnectionInfo = {
      base_url: base,
      endpoints: {
        chat_completions: "/v1/chat/completions",
        responses: "/v1/responses",
        messages: "/v1/messages",
        models: "/v1/models",
        codex_models: `/v1/models?client_version=${CODEX_VERSION}`,
      },
      models: models.map(model => model.id),
      codex: {
        cli_version: CODEX_VERSION,
        model_provider: "conduit",
        provider: createCodexProvider(apiBase),
        catalog_url: codexCatalogUrl(apiBase),
        default_model: catalog.models[0]?.slug ?? null,
        model_reasoning_summary: catalog.models[0]?.default_reasoning_summary ?? "none",
        web_search: "disabled",
        models: catalog.models.map(model => ({
          id: model.slug,
          name: model.display_name,
          context_window: model.context_window,
          reasoning_efforts: model.supported_reasoning_levels.map(level => level.effort),
          default_reasoning_summary: model.default_reasoning_summary,
          vision: model.input_modalities.includes("image"),
          parallel_tool_calls: sourceModels.get(model.slug)?.capabilities.supports.parallel_tool_calls === true,
          structured_outputs: sourceModels.get(model.slug)?.capabilities.supports.structured_outputs === true,
          verified_capabilities: verifiedCodexCapabilities(sourceModels.get(model.slug)),
        })),
        limitations: [...CODEX_LIMITATIONS],
      },
    }
    return c.json(info)
  })
  return app
}
