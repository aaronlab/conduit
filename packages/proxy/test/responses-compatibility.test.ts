import { afterEach, describe, expect, it } from "vitest"
import { chatToResponses, resolveAlias, responsesStreamToChat, responsesToChat, shouldBridgeToResponses } from "../src/lib/responses-bridge"
import { state } from "../src/lib/state"
import type { Model } from "../src/services/copilot/get-models"
import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"
import type { ServerSentEvent } from "../src/util/sse"

function model(id: string, endpoints: string[]): Model {
  return {
    id, name: id, object: "model", vendor: "test", version: "1", preview: false,
    model_picker_enabled: true, policy: null, supported_endpoints: endpoints,
    capabilities: {
      family: id, type: "chat", object: "model_capabilities", tokenizer: "test",
      supports: { tool_calls: true, parallel_tool_calls: true },
      limits: { max_context_window_tokens: 128000, max_prompt_tokens: 120000, max_output_tokens: 8000 },
    },
  }
}

afterEach(() => { state.models = null })

describe("capability-driven Responses bridge", () => {
  it("routes newly introduced Responses-only models using live metadata", () => {
    state.models = { object: "list", data: [
      model("new-native-model", ["/responses", "ws:/responses"]),
      model("both-apis", ["/chat/completions", "/responses"]),
      model("chat-only", ["/chat/completions"]),
    ] }
    expect(shouldBridgeToResponses("new-native-model")).toBe(true)
    expect(shouldBridgeToResponses("both-apis")).toBe(false)
    expect(shouldBridgeToResponses("chat-only")).toBe(false)
  })

  it("keeps virtual aliases authoritative without matching object prototype names", () => {
    expect(shouldBridgeToResponses("gpt-5.5-xhigh")).toBe(true)
    for (const name of ["constructor", "__proto__", "toString"]) {
      expect(shouldBridgeToResponses(name)).toBe(false)
      expect(resolveAlias(name)).toEqual({ model: name })
    }
    expect(chatToResponses({ model: "gpt-5.5-xhigh", messages: [], reasoning_effort: "low" }).reasoning)
      .toEqual({ effort: "xhigh" })
  })

  it("honors an explicit effort including none rather than forcing the Sol default", () => {
    expect(chatToResponses({ model: "gpt-5.6-sol", messages: [], reasoning_effort: "none" }).reasoning).toEqual({ effort: "none" })
    expect(chatToResponses({ model: "gpt-5.6-sol", messages: [], reasoning_effort: "low" }).reasoning).toEqual({ effort: "low" })
    expect(chatToResponses({ model: "gpt-5.6-sol", messages: [] }).reasoning).toEqual({ effort: "max" })
  })

  it("preserves images in messages and tool results, schemas and strict function tools", () => {
    const content = [
      { type: "text" as const, text: "Read the screenshot" },
      { type: "image_url" as const, image_url: { url: "data:image/png;base64,test", detail: "high" as const } },
    ]
    const payload: ChatCompletionsPayload = {
      model: "native",
      messages: [{ role: "user", content }, { role: "tool", tool_call_id: "c", content }],
      max_tokens: 5, max_completion_tokens: 12, parallel_tool_calls: false,
      tools: [{ type: "function", function: { name: "f", description: "tool", strict: false, parameters: { type: "object" } } }],
      response_format: { type: "json_schema", json_schema: {
        name: "result", strict: true, schema: { type: "object", additionalProperties: false },
      } },
    }
    const before = structuredClone(payload)
    expect(chatToResponses(payload)).toMatchObject({
      max_output_tokens: 12, parallel_tool_calls: false,
      input: [
        { role: "user", content: [{ type: "input_text", text: "Read the screenshot" }, { type: "input_image", image_url: "data:image/png;base64,test", detail: "high" }] },
        { type: "function_call_output", call_id: "c", output: [{ type: "input_text" }, { type: "input_image" }] },
      ],
      tools: [{ type: "function", name: "f", strict: false }],
      text: { format: { type: "json_schema", name: "result", strict: true } },
    })
    expect(payload).toEqual(before)
  })

  it("fails explicitly for invalid tool output pairing and failed upstream responses", () => {
    expect(() => chatToResponses({ model: "native", messages: [{ role: "tool", content: "result" }] })).toThrow("tool_call_id")
    expect(() => responsesToChat({ status: "failed", error: { message: "upstream failure" } }, "native")).toThrow("upstream failure")
  })
})

async function emitted(...items: Record<string, unknown>[]): Promise<Array<Record<string, unknown>>> {
  async function* source(): AsyncGenerator<ServerSentEvent> {
    for (const item of items) yield { data: JSON.stringify(item), event: null, id: null, retry: null }
  }
  return (await Array.fromAsync(responsesStreamToChat(source(), "native"))).map((item) => JSON.parse(item.data))
}

describe("Responses to Chat streaming fidelity", () => {
  it("recovers complete text and function calls when added/delta events are absent", async () => {
    const result = JSON.stringify(await emitted({
      type: "response.completed", response: { id: "r", output: [
        { type: "message", content: [{ type: "output_text", text: "Hello" }] },
        { type: "function_call", call_id: "call_1", name: "inspect", arguments: '{"a":1}' },
      ] },
    }))
    expect(result).toContain('"content":"Hello"')
    expect(result).toContain('"name":"inspect"')
    expect(result).toContain('"finish_reason":"tool_calls"')
    expect(result.match(/"id":"call_1"/g)).toHaveLength(1)
  })

  it("does not duplicate text on done/completed events", async () => {
    const result = await emitted(
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Hello" },
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: "Hello world" },
      { type: "response.completed", response: { id: "r", output: [
        { type: "message", content: [{ type: "output_text", text: "Hello world" }] },
      ] } },
    )
    const content = result.flatMap((item) => {
      const choices = item.choices as Array<{ delta?: { content?: string } }>
      return choices.map((choice) => choice.delta?.content ?? "")
    }).join("")
    expect(content).toBe("Hello world")
  })

  it("uses length rather than tool_calls when max_output_tokens truncates a call", async () => {
    const result = JSON.stringify(await emitted({
      type: "response.incomplete", response: {
        id: "r", incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "function_call", call_id: "call_1", name: "inspect", arguments: '{"a":' }],
      },
    }))
    expect(result).toContain('"finish_reason":"length"')
  })

  it("throws on truncated streams and inconsistent completed text", async () => {
    await expect(emitted({ type: "response.output_text.delta", delta: "partial" })).rejects.toThrow("terminal response")
    await expect(emitted(
      { type: "response.output_text.delta", delta: "a" },
      { type: "response.output_text.done", text: "b" },
    )).rejects.toThrow("disagrees")
  })
})
