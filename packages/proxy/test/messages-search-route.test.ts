import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/services/copilot/create-responses", () => ({ createResponses: vi.fn() }))
vi.mock("../src/services/copilot/create-chat-completions", () => ({ createCompatibleChatCompletions: vi.fn() }))

import { messageRoutes } from "../src/routes/messages/route"
import { createResponses } from "../src/services/copilot/create-responses"
import { createCompatibleChatCompletions } from "../src/services/copilot/create-chat-completions"
import { state } from "../src/lib/state"
import { HTTPError } from "../src/lib/error"
import { claudeModel, nativeModel } from "./codex-fixtures"

const app = new Hono().route("/v1/messages", messageRoutes)
const request = {
  model: "gpt-5.6-sol", max_tokens: 256,
  messages: [{ role: "user", content: "Perform a web search for the query: official OpenAI Codex" }],
  tools: [{ type: "web_search_20250305", name: "web_search", allowed_domains: ["github.com"], max_uses: 2 }],
}
const nativeSearch = {
  id: "resp_search", model: "gpt-5.6-sol", status: "completed",
  output: [
    { type: "web_search_call", status: "completed", action: { type: "search", query: "official OpenAI Codex" } },
    { type: "message", content: [{ type: "output_text", text: "Official repository", annotations: [
      { type: "url_citation", url: "https://github.com/openai/codex", title: "Codex" },
    ] }] },
  ], usage: { input_tokens: 10, output_tokens: 5 },
}

function post(body: unknown) {
  return app.request("/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
}

beforeEach(() => {
  state.rateLimitSeconds = null
  state.models = null
  state.stWebSearchApiKey = null
  vi.stubEnv("TAVILY_API_KEY", "")
  vi.mocked(createResponses).mockReset()
  vi.mocked(createCompatibleChatCompletions).mockReset()
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); state.stWebSearchApiKey = null })

describe("preserved Anthropic search integration", () => {
  it("bridges a dedicated search and preserves filters, limits, citations and usage", async () => {
    vi.mocked(createResponses).mockResolvedValue(nativeSearch)
    const response = await post(request)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      type: "message", content: [
        { type: "server_tool_use", name: "web_search" },
        { type: "web_search_tool_result", content: [{ url: "https://github.com/openai/codex" }] },
        { type: "text", text: "Official repository" },
      ],
      usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
    })
    expect(createResponses).toHaveBeenCalledWith(expect.objectContaining({
      tools: [{ type: "web_search", filters: { allowed_domains: ["github.com"] } }], max_tool_calls: 2,
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(createCompatibleChatCompletions).not.toHaveBeenCalled()
  })

  it("emits the Anthropic stream contract, not raw Responses events", async () => {
    vi.mocked(createResponses).mockResolvedValue(nativeSearch)
    const text = await (await post({ ...request, stream: true })).text()
    expect(text).toContain("event: message_start")
    expect(text).toContain("web_search_tool_result")
    expect(text).toContain("event: message_stop")
    expect(text).not.toContain("response.completed")
  })

  it("does not fabricate a search result when no search ran", async () => {
    vi.mocked(createResponses).mockResolvedValue({ status: "completed", output: [] })
    const response = await post(request)
    expect(response.status).toBe(502)
    expect(await response.text()).toContain("did not perform")
  })

  it("does not turn a Tavily failure into a successful empty result", async () => {
    state.stWebSearchApiKey = "test-tavily-key"
    vi.mocked(createResponses).mockRejectedValue(new HTTPError("native unavailable", 503))
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Tavily unavailable", code: "unavailable" } }, { status: 503 })))
    const response = await post(request)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "unavailable" } })
  })

  it("fails clearly if no backend can provide a translated server tool", async () => {
    state.models = { object: "list", data: [nativeModel("chat-only-model", { supported_endpoints: ["/chat/completions"] })] }
    const response = await post({ ...request, model: "chat-only-model" })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("unsupported_feature")
    expect(createResponses).not.toHaveBeenCalled()
    expect(createCompatibleChatCompletions).not.toHaveBeenCalled()
  })

  it("bridges Claude searches, which Copilot's Messages API rejects, through a native-search model", async () => {
    state.models = { object: "list", data: [claudeModel(), nativeModel("gpt-5.6-sol"), nativeModel("gpt-6-sol")] }
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    vi.mocked(createResponses).mockResolvedValue({ ...nativeSearch, model: "gpt-6-sol" })
    const response = await post({ ...request, model: "claude-opus-5-5" })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      model: "claude-opus-5-5",
      content: [
        { type: "server_tool_use", name: "web_search" },
        { type: "web_search_tool_result", content: [{ url: "https://github.com/openai/codex" }] },
        { type: "text", text: "Official repository" },
      ],
      usage: { server_tool_use: { web_search_requests: 1 } },
    })
    expect(createResponses).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-6-sol", tools: [{ type: "web_search", filters: { allowed_domains: ["github.com"] } }] }),
      expect.anything(),
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("bridges searches for an unavailable Claude alias instead of using its Sol fallback as-is", async () => {
    state.models = { object: "list", data: [nativeModel("gpt-5.6-sol"), nativeModel("gpt-6-sol")] }
    vi.stubEnv("CONDUIT_WEB_SEARCH_MODEL", "gpt-6-sol")
    vi.mocked(createResponses).mockResolvedValue({ ...nativeSearch, model: "gpt-6-sol" })
    const response = await post({ ...request, model: "claude-haiku-4-5-20251001" })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ model: "claude-haiku-4-5-20251001" })
    expect(createResponses).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-6-sol" }), expect.anything())
  })

  it("streams bridged Claude searches with the requested model and honors CONDUIT_WEB_SEARCH_MODEL", async () => {
    state.models = { object: "list", data: [claudeModel(), nativeModel("gpt-5.6-sol"), nativeModel("gpt-6-sol")] }
    vi.stubEnv("CONDUIT_WEB_SEARCH_MODEL", "gpt-5.6-sol")
    vi.mocked(createResponses).mockResolvedValue(nativeSearch)
    const text = await (await post({ ...request, model: "claude-opus-5-5[1m]", stream: true })).text()
    expect(createResponses).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.6-sol" }), expect.anything())
    expect(text).toContain('"model":"claude-opus-5-5[1m]"')
    expect(text).toContain("web_search_tool_result")
    expect(text).toContain("event: message_stop")
  })

  it.each([null, {}, { model: 42, messages: [] }, { model: "x", messages: [], tools: {} }])("validates invalid message requests: %j", async (body) => {
    expect((await post(body)).status).toBe(400)
  })
})
