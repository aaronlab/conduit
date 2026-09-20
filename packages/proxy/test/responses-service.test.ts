import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/lib/token", () => ({
  ensureFreshCopilotToken: vi.fn(async () => undefined),
  forceCopilotTokenRefresh: vi.fn(async () => undefined),
}))

import { state } from "../src/lib/state"
import { forceCopilotTokenRefresh } from "../src/lib/token"
import { createResponses, hasAgentHistory, hasVisionContent } from "../src/services/copilot/create-responses"
import type { Model } from "../src/services/copilot/get-models"

describe("Copilot Responses transport", () => {
  beforeEach(() => {
    state.models = null
    state.copilotToken = "test-copilot-token"
    state.accountType = "individual"
    vi.mocked(forceCopilotTokenRefresh).mockClear()
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it("preserves all input, custom tools, encrypted reasoning and large tool outputs without mutation", async () => {
    const payload = {
      model: "native-model",
      input: [
        { type: "reasoning", id: "opaque", encrypted_content: "ciphertext", summary: [] },
        ...Array.from({ length: 4 }, (_, index) => ({
          type: "function_call_output", call_id: `call_${index}`,
          output: [{ type: "input_text", text: "x".repeat(270_000) }, { type: "input_image", image_url: "data:image/png;base64,test" }],
        })),
        { type: "custom_tool_call_output", call_id: "patch", output: "applied" },
      ],
      tools: [{ type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: TEXT" } }],
      reasoning: { effort: "high", summary: "concise" },
      include: ["reasoning.encrypted_content"],
      store: false,
      client_metadata: { client: "codex" },
    }
    const original = JSON.stringify(payload)
    const fetcher = vi.fn(async () => Response.json({ id: "r", output: [] }))
    vi.stubGlobal("fetch", fetcher)
    await createResponses(payload)
    expect(JSON.stringify(payload)).toBe(original)
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/responses"), expect.objectContaining({
      body: original,
      headers: expect.objectContaining({ "copilot-vision-request": "true", "X-Initiator": "agent" }),
    }))
  })

  it("forwards only allowlisted session headers and the caller's cancellation signal", async () => {
    const controller = new AbortController()
    const received: Headers[] = []
    const fetcher = vi.fn(async () => Response.json({ id: "r" }, { headers: { "x-codex-turn-state": "sticky" } }))
    vi.stubGlobal("fetch", fetcher)
    await createResponses({ model: "native", input: "hello" }, {
      signal: controller.signal,
      headers: new Headers({ "session-id": "session", authorization: "Bearer client-key", cookie: "private" }),
      onResponse: (headers) => received.push(headers),
    })
    expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      signal: controller.signal,
      headers: expect.objectContaining({ "session-id": "session", Authorization: "Bearer test-copilot-token" }),
    }))
    const options = vi.mocked(fetcher).mock.calls[0]
    expect(JSON.stringify(options)).not.toContain("client-key")
    expect(JSON.stringify(options)).not.toContain("private")
    expect(received[0]?.get("x-codex-turn-state")).toBe("sticky")
  })

  it("refreshes once on 401 and preserves structured upstream failures", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ error: { type: "rate_limit_error", code: "quota", message: "busy" } }, {
        status: 429, headers: { "retry-after": "3" },
      }))
    vi.stubGlobal("fetch", fetcher)
    await expect(createResponses({ model: "native", input: "hello" })).rejects.toMatchObject({
      status: 429, responseBody: expect.stringContaining('"code":"quota"'),
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(forceCopilotTokenRefresh).toHaveBeenCalledTimes(1)
  })

  it("fails before fetching when the caller is already cancelled", async () => {
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    const controller = new AbortController()
    controller.abort()
    await expect(createResponses({ model: "native", input: "hello" }, { signal: controller.signal })).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("rejects chat-only models explicitly rather than silently changing their protocol", async () => {
    const model: Model = {
      id: "gemini-test", name: "Gemini", vendor: "Google", object: "model", version: "1",
      model_picker_enabled: true, preview: false, policy: null, supported_endpoints: ["/chat/completions"],
      capabilities: {
        family: "gemini", object: "model_capabilities", type: "chat", tokenizer: "test",
        limits: { max_context_window_tokens: 128000, max_output_tokens: 4096, max_prompt_tokens: 123904 },
        supports: { tool_calls: true, parallel_tool_calls: true },
      },
    }
    state.models = { object: "list", data: [model] }
    await expect(createResponses({ model: model.id, input: "hello" })).rejects.toMatchObject({
      status: 400, responseBody: expect.stringContaining("unsupported_api_for_model"),
    })
  })

  it("rejects a non-SSE streaming response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "r", output: [] })))
    await expect(createResponses({ model: "native", input: "hello", stream: true })).rejects.toThrow("non-SSE")
  })
})

describe("Responses request classification", () => {
  it.each(["function_call_output", "custom_tool_call_output", "computer_call_output"])("recognizes %s vision", (type) => {
    const image = { type: "input_image", image_url: "data:image/png;base64,test" }
    expect(hasVisionContent({ model: "test", input: [{ type, output: [image] }] })).toBe(true)
  })
  it("recognizes native computer screenshots and ordinary message images", () => {
    expect(hasVisionContent({ model: "test", input: [{ type: "computer_call_output", output: { type: "computer_screenshot" } }] })).toBe(true)
    expect(hasVisionContent({ model: "test", input: [{ role: "user", content: [{ type: "input_image" }] }] })).toBe(true)
    expect(hasVisionContent({ model: "test", input: "hello" })).toBe(false)
  })
  it.each(["custom_tool_call", "custom_tool_call_output", "computer_call", "computer_call_output", "tool_search_call", "reasoning"])("recognizes agent history: %s", (type) => {
    expect(hasAgentHistory({ model: "test", input: [{ type }] })).toBe(true)
  })
  it("distinguishes an initial user request from a continuation", () => {
    expect(hasAgentHistory({ model: "test", input: [{ role: "user", content: "hello" }] })).toBe(false)
    expect(hasAgentHistory({ model: "test", input: [], previous_response_id: "resp_previous" })).toBe(true)
  })
})
