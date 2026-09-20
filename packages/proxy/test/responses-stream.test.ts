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
