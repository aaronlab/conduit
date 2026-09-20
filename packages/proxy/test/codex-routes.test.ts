import { Hono } from "hono"
import { beforeEach, describe, expect, it } from "vitest"
import { state } from "../src/lib/state"
import { parseCodexCatalog } from "../src/lib/codex-catalog"
import type { ConnectionInfo } from "../src/lib/codex-types"
import { modelRoutes } from "../src/routes/models/route"
import { createConnectionInfoRoute } from "../src/routes/connection-info"
import { nativeModel } from "./codex-fixtures"

const app = new Hono().route("/v1/models", modelRoutes)

beforeEach(() => { state.models = null })

describe("Codex and ordinary model routes", () => {
  it("preserves OpenAI model shape and all existing GPT-5.5 effort aliases", async () => {
    state.models = { object: "list", data: [nativeModel("gpt-5.5"), nativeModel("chat-only", { supported_endpoints: ["/chat/completions"] })] }
    const response = await app.request("/v1/models")
    const result = await response.json() as { object: string; data: Array<{ id: string }> }
    expect(result.object).toBe("list")
    expect(result.data.map(model => model.id)).toEqual([
      "gpt-5.5", "chat-only", "gpt-5.5-low", "gpt-5.5-medium", "gpt-5.5-high", "gpt-5.5-xhigh",
    ])
    expect(result).not.toHaveProperty("models")
  })

  it("negotiates native ModelInfo with client_version and excludes aliases and chat-only models", async () => {
    state.models = { object: "list", data: [nativeModel(), nativeModel("gpt-5.5"), nativeModel("chat-only", { supported_endpoints: ["/chat/completions"] })] }
    const response = await app.request("/v1/models?client_version=0.155.1")
    expect(response.status).toBe(200)
    const catalog = parseCodexCatalog(await response.json())
    expect(catalog.models.map(model => model.slug)).toEqual(["gpt-5.3-codex", "gpt-5.5"])
    expect(catalog).not.toHaveProperty("data")
  })

  it("keeps ordinary startup behavior but fails clearly when Codex metadata is not loaded", async () => {
    expect(await (await app.request("/v1/models")).json()).toEqual({ object: "list", data: [] })
    expect((await app.request("/v1/models?client_version=0.155.1")).status).toBe(503)
    state.models = { object: "list", data: [nativeModel("not-ready", { model_picker_enabled: false })] }
    expect(await (await app.request("/v1/models?client_version=0.155.1")).json()).toEqual({ models: [] })
  })
})

describe("typed connection information", () => {
  it("publishes Responses, authenticated catalog URL and an available default on port 7133", async () => {
    state.models = { object: "list", data: [nativeModel()] }
    const route = new Hono().route("/api", createConnectionInfoRoute({ port: 7133, baseUrl: null }))
    const info = await (await route.request("/api/connection-info")).json() as ConnectionInfo
    expect(info.base_url).toBe("http://127.0.0.1:7133")
    expect(info.endpoints.responses).toBe("/v1/responses")
    expect(info.endpoints.codex_models).toBe("/v1/models?client_version=0.155.1")
    expect(info.codex.catalog_url).toBe(`${info.base_url}${info.endpoints.codex_models}`)
    expect(info.codex.default_model).toBe("gpt-5.3-codex")
    expect(info.codex.provider).toMatchObject({ name: "Conduit", base_url: `${info.base_url}/v1`, wire_api: "responses" })
    expect(info.codex.models[0]).toMatchObject({ context_window: 272_000, vision: true, parallel_tool_calls: true, structured_outputs: true })
    expect(info.codex.limitations.length).toBeGreaterThan(0)
  })

  it("normalizes deployment prefixes and does not fabricate an available default", async () => {
    const route = createConnectionInfoRoute({ port: 7133, baseUrl: "https://example.test/proxy/v1/" })
    const info = await (await route.request("/connection-info")).json() as ConnectionInfo
    expect(info.base_url).toBe("https://example.test/proxy")
    expect(info.codex.catalog_url).toBe("https://example.test/proxy/v1/models?client_version=0.155.1")
    expect(info.codex.default_model).toBeNull()
    expect(info.codex.models).toEqual([])
    expect(Object.values(info.endpoints).every(endpoint => endpoint.startsWith("/v1/"))).toBe(true)
  })

  it("recommends the verified baseline when it exists in the current account's native catalog", async () => {
    state.models = { object: "list", data: [nativeModel(), nativeModel("gpt-5.4-mini")] }
    const route = createConnectionInfoRoute({ port: 7133, baseUrl: null })
    const info = await (await route.request("/connection-info")).json() as ConnectionInfo
    expect(info.codex.default_model).toBe("gpt-5.4-mini")
    expect(info.codex.limitations.join(" ")).toMatch(/deferred tool_search/i)
    expect(info.codex.limitations.join(" ")).toContain("live-verified gpt-5.4-mini")
  })

  it("reports model-specific live verification without confusing browser MCP with native computer tools", async () => {
    state.models = { object: "list", data: [nativeModel("gpt-5.4-mini"), nativeModel("gpt-5.6-sol"), nativeModel("gpt-6-astra")] }
    const route = createConnectionInfoRoute({ port: 7133, baseUrl: null })
    const info = await (await route.request("/connection-info")).json() as ConnectionInfo
    expect(info.codex.models.find(model => model.id === "gpt-5.4-mini")?.verified_capabilities)
      .toMatchObject({ tool_search: true, mcp_browser: true, structured_outputs: true, hosted_web_search: false })
    expect(info.codex.models.find(model => model.id === "gpt-5.6-sol")?.verified_capabilities)
      .toMatchObject({ tool_search: false, mcp_browser: false, hosted_web_search: true })
    expect(info.codex.web_search).toBe("disabled")
    expect(info.codex.provider.supports_standalone_web_search).toBe(false)
    expect(info.codex.limitations.join(" ")).toContain("Copilot rejected both computer and computer_use_preview")
  })
})
