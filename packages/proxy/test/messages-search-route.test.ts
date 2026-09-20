import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/services/copilot/create-responses", () => ({ createResponses: vi.fn() }))
vi.mock("../src/services/copilot/create-chat-completions", () => ({ createCompatibleChatCompletions: vi.fn() }))

import { messageRoutes } from "../src/routes/messages/route"
import { createResponses } from "../src/services/copilot/create-responses"
import { createCompatibleChatCompletions } from "../src/services/copilot/create-chat-completions"
import { state } from "../src/lib/state"
import { HTTPError } from "../src/lib/error"

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
    const response = await post({ ...request, model: "chat-only-model" })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("unsupported_feature")
    expect(createCompatibleChatCompletions).not.toHaveBeenCalled()
  })

  it.each([null, {}, { model: 42, messages: [] }, { model: "x", messages: [], tools: {} }])("validates invalid message requests: %j", async (body) => {
    expect((await post(body)).status).toBe(400)
  })
})
