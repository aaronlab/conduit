import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/lib/token", () => ({
  ensureFreshCopilotToken: vi.fn(async () => undefined),
  forceCopilotTokenRefresh: vi.fn(async () => undefined),
}))
vi.mock("../src/services/copilot/get-models", () => ({ getModels: vi.fn() }))

import { state } from "../src/lib/state"
import { getModels } from "../src/services/copilot/get-models"
import { refreshModelsIfMissing, resetMissingModelRefresh } from "../src/lib/utils"
import { toAnthropicModelId, translateModelName } from "../src/lib/model-router"
import { messageRoutes } from "../src/routes/messages/route"
import { modelRoutes } from "../src/routes/models/route"
import { parseCodexCatalog } from "../src/lib/codex-catalog"
import { claudeModel, nativeModel } from "./codex-fixtures"

const app = new Hono().route("/v1/messages", messageRoutes).route("/v1/models", modelRoutes)
const published = () => ({ object: "list", data: [claudeModel(), nativeModel("gpt-5.6-sol"), nativeModel("gpt-6-sol")] })

beforeEach(() => {
  state.rateLimitSeconds = null
  state.copilotToken = "test-token"
  state.accountType = "individual"
  state.models = null
  resetMissingModelRefresh()
  vi.mocked(getModels).mockReset()
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe("Claude model ids", () => {
  it("maps Copilot Claude ids to Anthropic spellings that round-trip", () => {
    expect(toAnthropicModelId("claude-opus-5.5")).toBe("claude-opus-5-5")
    expect(toAnthropicModelId("claude-opus-4.6-1m")).toBe("claude-opus-4-6[1m]")
    expect(toAnthropicModelId("claude-opus-4.7-xhigh")).toBe("claude-opus-4-7-xhigh")
    expect(toAnthropicModelId("gpt-6-sol")).toBe("gpt-6-sol")
    for (const id of ["claude-opus-5.5", "claude-opus-4.6-1m", "claude-opus-4.7-xhigh"]) {
      expect(translateModelName(toAnthropicModelId(id))).toBe(id)
    }
    expect(translateModelName("claude-opus-5-5[1m]")).toBe("claude-opus-5.5")
  })
})

describe("model catalog refresh", () => {
  it("refreshes once, throttled, when a requested model is missing from the startup cache", async () => {
    state.models = { object: "list", data: [nativeModel("gpt-5.6-sol")] }
    vi.mocked(getModels).mockResolvedValue(published())
    await Promise.all([refreshModelsIfMissing("claude-opus-5.5"), refreshModelsIfMissing("claude-opus-5.5")])
    expect(getModels).toHaveBeenCalledTimes(1)
    expect(state.models.data.map((model) => model.id)).toContain("claude-opus-5.5")

    await refreshModelsIfMissing("claude-sonnet-9")
    expect(getModels).toHaveBeenCalledTimes(1)
  })

  it("uses a newly published Claude model instead of the unavailable-model fallback", async () => {
    state.models = { object: "list", data: [nativeModel("gpt-5.6-sol")] }
    vi.mocked(getModels).mockResolvedValue(published())
    const forwarded: Array<Record<string, unknown>> = []
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      forwarded.push(JSON.parse(String(init?.body)))
      return Response.json({ id: "msg_1", type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 1 } })
    }))
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(response.status).toBe(200)
    expect(forwarded[0]).toMatchObject({ model: "claude-opus-5.5" })
  })
})

describe("Claude Code gateway endpoints", () => {
  it("counts Claude tokens natively and declines translated models", async () => {
    state.models = published()
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ input_tokens: 7 })))
    const count = (model: string) => app.request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-beta": "claude-code-20250219" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    })
    const claude = await count("claude-opus-5-5[1m]")
    expect(claude.status).toBe(200)
    expect(await claude.json()).toEqual({ input_tokens: 7 })
    const translated = await count("gpt-6-sol")
    expect(translated.status).toBe(404)
    expect(await translated.json()).toMatchObject({ type: "error", error: { type: "not_found_error" } })
    expect((await app.request("/v1/messages/count_tokens", { method: "POST", body: "{" })).status).toBe(400)
  })

  it("lists models in Anthropic format with Anthropic Claude ids for gateway discovery", async () => {
    state.models = { object: "list", data: [
      ...published().data,
      nativeModel("text-embedding-3-small", { capabilities: { ...nativeModel().capabilities, type: "embeddings" } }),
      nativeModel("legacy", { model_picker_enabled: false }),
    ] }
    const response = await app.request("/v1/models?limit=1000", { headers: { "anthropic-version": "2023-06-01" } })
    const body = await response.json() as { data: Array<Record<string, unknown>>; has_more: boolean }
    expect(body.has_more).toBe(false)
    expect(body.data.map((model) => model.id)).toEqual(["claude-opus-5-5", "gpt-5.6-sol", "gpt-6-sol"])
    expect(body.data[0]).toMatchObject({
      type: "model",
      display_name: "Claude Opus 5.5",
      max_input_tokens: 872_000,
      max_tokens: 128_000,
      description: "GitHub Copilot claude-opus-5.5 via Conduit · 872K prompt · 128K output",
    })
  })

  it("keeps the Codex catalog and OpenAI list unchanged for their clients", async () => {
    state.models = published()
    const codex = await app.request("/v1/models?client_version=0.155.1", { headers: { "anthropic-version": "2023-06-01" } })
    expect(parseCodexCatalog(await codex.json()).models.map((model) => model.slug).sort()).toEqual(["gpt-5.6-sol", "gpt-6-sol"])
    const openai = await (await app.request("/v1/models")).json() as { object: string; data: Array<{ id: string }> }
    expect(openai.object).toBe("list")
    expect(openai.data.map((model) => model.id)).toContain("claude-opus-5.5")
  })
})
