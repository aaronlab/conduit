import { describe, expect, it } from "vitest"
import { normalizeResponsesStream, responsesError } from "../src/lib/responses-stream"
import type { ServerSentEvent } from "../src/util/sse"

function event(data: Record<string, unknown>, type: string | null = null): ServerSentEvent {
  return { data: JSON.stringify(data), event: type, id: null, retry: null }
}

async function* source(...items: ServerSentEvent[]) {
  yield* items
}

describe("Responses stream contract", () => {
  it("keeps one upstream-issued item ID across added, delta, done and final snapshots", async () => {
    const result = await Array.fromAsync(normalizeResponsesStream(source(
      event({ type: "response.output_item.added", output_index: 0, item: {
        id: "opaque-start", type: "message", role: "assistant", phase: "final_answer", content: [],
      } }),
      event({ type: "response.content_part.added", output_index: 0, content_index: 0,
        item_id: "opaque-part", part: { type: "output_text", text: "", annotations: [] } }),
      event({ type: "response.output_text.delta", output_index: 0, content_index: 0,
        item_id: "opaque-delta-1", delta: "Hello" }),
      event({ type: "response.output_text.delta", output_index: 0, content_index: 0,
        item_id: "opaque-delta-2", delta: "Hello" }),
      event({ type: "response.output_text.done", output_index: 0, content_index: 0,
        item_id: "opaque-text-done", text: "HelloHello" }),
      event({ type: "response.content_part.done", output_index: 0, content_index: 0,
        item_id: "opaque-part-done", part: { type: "output_text", text: "HelloHello", annotations: [] } }),
      event({ type: "response.output_item.done", output_index: 0, item: {
        id: "opaque-done", type: "message", role: "assistant", phase: "final_answer",
        content: [{ type: "output_text", text: "HelloHello", annotations: [] }],
      } }),
      event({ type: "response.completed", response: { id: "response-id", output: [{
        id: "opaque-final", type: "message", role: "assistant", phase: "final_answer",
        content: [{ type: "output_text", text: "HelloHello", annotations: [] }],
      }] } }),
    )))
    const payloads = result.map(item => JSON.parse(item.data))
    expect(payloads).toHaveLength(8)
    for (const item of payloads.slice(0, -1)) {
      expect(item.item?.id ?? item.item_id).toBe("opaque-start")
    }
    expect(payloads.at(-1).response.id).toBe("response-id")
    expect(payloads.at(-1).response.output[0].id).toBe("opaque-start")
    expect(payloads.filter(item => item.type === "response.output_text.delta").map(item => item.delta))
      .toEqual(["Hello", "Hello"])
    expect(payloads[6].item.content[0].text).toBe("HelloHello")
  })

  it("preserves independent items, tool call IDs, encrypted reasoning and future metadata", async () => {
    const reasoning = { id: "reasoning-done", type: "reasoning", summary: [{ type: "summary_text", text: "Summary" }], encrypted_content: "opaque-ciphertext" }
    const tool = { id: "tool-done", type: "function_call", call_id: "call_original", name: "check", arguments: "{}", future_field: { retain: true } }
    const result = await Array.fromAsync(normalizeResponsesStream(source(
      event({ type: "response.output_item.added", output_index: 0, item: { ...reasoning, id: "reasoning-start", summary: [] } }),
      event({ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, item_id: "reasoning-delta", delta: "Summary" }),
      event({ type: "response.output_item.done", output_index: 0, item: reasoning }),
      event({ type: "response.output_item.added", output_index: 1, item: { ...tool, id: "tool-start" } }),
      event({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "tool-delta", delta: "{}" }),
      event({ type: "response.output_item.done", output_index: 1, item: tool }),
      event({ type: "response.completed", response: { id: "r", output: [
        { ...reasoning, id: "reasoning-final" }, { ...tool, id: "tool-final" },
      ] } }),
    )))
    const payloads = result.map(item => JSON.parse(item.data))
    expect(payloads[1].item_id).toBe("reasoning-start")
    expect(payloads[2].item).toEqual({ ...reasoning, id: "reasoning-start" })
    expect(payloads[4].item_id).toBe("tool-start")
    expect(payloads[5].item).toEqual({ ...tool, id: "tool-start" })
    expect(payloads.at(-1).response.output).toEqual([
      { ...reasoning, id: "reasoning-start" }, { ...tool, id: "tool-start" },
    ])
  })

  it("matches synthesized completed items to preceding deltas when added/done events are absent", async () => {
    const result = await Array.fromAsync(normalizeResponsesStream(source(
      event({ type: "response.output_text.delta", output_index: 0, item_id: "first-delta", delta: "Hi" }),
      event({ type: "response.completed", response: { id: "r", output: [{
        id: "final-only", type: "message", content: [{ type: "output_text", text: "Hi" }],
      }] } }),
    )))
    expect(result.map(item => item.event)).toEqual([
      "response.output_text.delta", "response.output_item.done", "response.completed",
    ])
    expect(JSON.parse(result[1]!.data).item.id).toBe("first-delta")
    expect(JSON.parse(result[2]!.data).response.output[0].id).toBe("first-delta")
  })

  it("leaves already consistent IDs unchanged and scopes ID tracking to each response", async () => {
    for (const id of ["first-response-item", "second-response-item"]) {
      const item = { id, type: "message", content: [{ type: "output_text", text: "Identical text" }] }
      const inputs = [
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "response-id", output: [item] } },
      ]
      const result = await Array.fromAsync(normalizeResponsesStream(source(...inputs.map(data => event(data)))))
      expect(result.map(item => JSON.parse(item.data))).toEqual(inputs)
    }
  })

  it("does not merge separate messages that deliberately contain identical text", async () => {
    const message = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Repeat me" }] }
    const result = await Array.fromAsync(normalizeResponsesStream(source(
      event({ type: "response.output_item.added", output_index: 0, item: { ...message, id: "first-start" } }),
      event({ type: "response.output_item.added", output_index: 1, item: { ...message, id: "second-start" } }),
      event({ type: "response.completed", response: { id: "r", output: [
        { ...message, id: "first-final" }, { ...message, id: "second-final" },
      ] } }),
    )))
    const items = result.filter(item => item.event === "response.output_item.done").map(item => JSON.parse(item.data).item)
    expect(items).toEqual([
      { ...message, id: "first-start" }, { ...message, id: "second-start" },
    ])
  })

  it("uses the JSON type, supports unnamed SSE events and preserves opaque state", async () => {
    const item = { type: "reasoning", id: "opaque-id", summary: [], encrypted_content: "opaque-ciphertext" }
    const complete = { type: "response.completed", response: { id: "resp_1", output: [item] } }
    const result = await Array.fromAsync(normalizeResponsesStream(source(
      event({ type: "response.output_item.done", output_index: 0, item }),
      event(complete),
    )))
    expect(result.map((item) => item.event)).toEqual(["response.output_item.done", "response.completed"])
    expect(JSON.parse(result[0]!.data).item).toEqual(item)
  })

  it("supplies completed items required by Codex when upstream only embeds final output", async () => {
    const item = { type: "custom_tool_call", name: "apply_patch", call_id: "call_1", input: "*** Begin Patch\n*** End Patch" }
    const result = await Array.fromAsync(normalizeResponsesStream(source(
      event({ type: "response.completed", sequence_number: 9, response: { id: "r", output: [item] } }),
    )))
    expect(result.map((item) => item.event)).toEqual(["response.output_item.done", "response.completed"])
    expect(JSON.parse(result[0]!.data)).toMatchObject({ output_index: 0, sequence_number: 9, item })
    expect(JSON.parse(result[1]!.data).sequence_number).toBe(10)
  })

  it("adds type from a named SSE event only when JSON type is missing", async () => {
    const result = await Array.fromAsync(normalizeResponsesStream(source(
      event({ response: { id: "r", output: [] } }, "response.completed"),
    )))
    expect(JSON.parse(result[0]!.data).type).toBe("response.completed")
  })

  it("stops at completion even if the upstream connection stays open", async () => {
    let closed = false
    async function* upstream() {
      try {
        yield event({ type: "response.completed", response: { id: "r", output: [] } })
        throw new Error("Must not read past completion")
      } finally {
        closed = true
      }
    }
    expect(await Array.fromAsync(normalizeResponsesStream(upstream()))).toHaveLength(1)
    expect(closed).toBe(true)
  })

  it.each(["", "[DONE]"])("rejects truncation rather than reporting success (%s)", async (data) => {
    const last = { data, event: null, id: null, retry: null }
    await expect(Array.fromAsync(normalizeResponsesStream(source(last)))).rejects.toThrow("terminal response")
  })

  it("reports malformed JSON as an upstream error", async () => {
    await expect(Array.fromAsync(normalizeResponsesStream(source({
      data: "{", event: "response.completed", id: null, retry: null,
    })))).rejects.toThrow("Invalid JSON")
  })

  it("preserves failed events and extracts nested errors and incomplete reasons", async () => {
    const failure = { type: "response.failed", response: { id: "r", error: { message: "quota exceeded" } } }
    const result = await Array.fromAsync(normalizeResponsesStream(source(event(failure))))
    expect(JSON.parse(result[0]!.data)).toEqual(failure)
    expect(responsesError(failure)).toBe("quota exceeded")
    expect(responsesError({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }))
      .toContain("max_output_tokens")
  })
})
