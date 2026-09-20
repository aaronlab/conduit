import { describe, expect, it } from "vitest"

import type { ServerSentEvent } from "../util/sse"
import { responsesStreamToChat } from "./responses-bridge"

function event(event: string, data: Record<string, unknown>): ServerSentEvent {
  return { event, data: JSON.stringify(data), id: null, retry: null }
}

async function emittedArguments(events: ServerSentEvent[]): Promise<string> {
  async function* source() {
    yield* events
  }

  let result = ""
  for await (const chunk of responsesStreamToChat(source(), "gpt-5.6-sol")) {
    const parsed = JSON.parse(chunk.data)
    const calls = parsed.choices?.[0]?.delta?.tool_calls ?? []
    for (const call of calls) result += call.function?.arguments ?? ""
  }
  return result
}

const added = event("response.output_item.added", {
  output_index: 1,
  item: {
    id: "added-encrypted-id",
    call_id: "call-1",
    type: "function_call",
    name: "Agent",
    arguments: "",
  },
})

const completed = event("response.completed", {
  response: { id: "resp_test", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
})

describe("responsesStreamToChat function arguments", () => {
  it("uses function_call_arguments.done when delta events are absent", async () => {
    const args = '{"description":"Inspect","prompt":"Read only"}'
    expect(await emittedArguments([
      added,
      event("response.function_call_arguments.done", {
        output_index: 1,
        item_id: "done-different-encrypted-id",
        arguments: args,
      }),
      completed,
    ])).toBe(args)
  })

  it("does not duplicate arguments when done repeats streamed deltas", async () => {
    const first = '{"description":"Inspect",'
    const second = '"prompt":"Read only"}'
    expect(await emittedArguments([
      added,
      event("response.function_call_arguments.delta", {
        output_index: 1,
        item_id: "delta-encrypted-id-1",
        delta: first,
      }),
      event("response.function_call_arguments.delta", {
        output_index: 1,
        item_id: "delta-encrypted-id-2",
        delta: second,
      }),
      event("response.function_call_arguments.done", {
        output_index: 1,
        item_id: "done-encrypted-id",
        arguments: first + second,
      }),
      completed,
    ])).toBe(first + second)
  })

  it("recovers arguments from output_item.done", async () => {
    const args = '{"subject":"Plan","description":"Make plan"}'
    expect(await emittedArguments([
      added,
      event("response.output_item.done", {
        output_index: 1,
        item: { id: "output-different-encrypted-id", type: "function_call", arguments: args },
      }),
      completed,
    ])).toBe(args)
  })

  it("uses response.completed as the final recovery source", async () => {
    const args = '{"command":"pwd"}'
    expect(await emittedArguments([
      added,
      event("response.completed", {
        response: {
          id: "resp_test",
          output: [
            { id: "reasoning-1", type: "reasoning" },
            { id: "completed-different-encrypted-id", type: "function_call", arguments: args },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      }),
    ])).toBe(args)
  })
})