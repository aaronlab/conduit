import type { ServerSentEvent } from "../util/sse"
import { HTTPError } from "./error"
import { isRecord } from "./validation"

export function decodeResponsesEvent(event: ServerSentEvent): Record<string, unknown> & { type: string } {
  let data: unknown
  try {
    data = JSON.parse(event.data)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new HTTPError("Invalid JSON in the upstream Responses stream.", 502)
  }
  if (!isRecord(data)) throw new HTTPError("Invalid event in the upstream Responses stream.", 502)
  const type = typeof data.type === "string" ? data.type : event.event
  if (!type) throw new HTTPError("An upstream Responses event is missing its type.", 502)
  return { ...data, type }
}

export function responsesError(data: Record<string, unknown>): string | null {
  const response = isRecord(data.response) ? data.response : data
  if (data.type === "response.incomplete" || response.status === "incomplete") {
    const details = isRecord(response.incomplete_details) ? response.incomplete_details : {}
    return `Response incomplete: ${typeof details.reason === "string" ? details.reason : "unknown reason"}`
  }
  if (data.type !== "error" && data.type !== "response.failed" && response.status !== "failed") return null
  const error = isRecord(response.error) ? response.error : data
  return typeof error.message === "string" ? error.message : "The upstream Responses request failed."
}

export async function* normalizeResponsesStream(
  source: AsyncIterable<ServerSentEvent>,
): AsyncGenerator<ServerSentEvent> {
  const completedItems = new Set<number>()
  let sequence = 0
  for await (const event of source) {
    if (!event.data) continue
    if (event.data === "[DONE]") break
    const data = decodeResponsesEvent(event)
    if (data.type === "response.completed" && (!isRecord(data.response) || typeof data.response.id !== "string")) {
      throw new HTTPError("The completed Responses event is missing its response ID.", 502)
    }
    if (typeof data.sequence_number === "number") sequence = Math.max(sequence, data.sequence_number)
    if (data.type === "response.output_item.done" && typeof data.output_index === "number") {
      completedItems.add(data.output_index)
    }
    if ((data.type === "response.completed" || data.type === "response.incomplete") && isRecord(data.response)) {
      const output = data.response.output
      if (Array.isArray(output)) {
        for (const [index, item] of output.entries()) {
          if (completedItems.has(index) || !isRecord(item)) continue
          // Codex consumes completed items, not the output array on response.completed.
          yield {
            event: "response.output_item.done",
            data: JSON.stringify({
              type: "response.output_item.done",
              sequence_number: sequence++,
              output_index: index,
              item,
            }),
            id: null,
            retry: null,
          }
        }
      }
      if (typeof data.sequence_number === "number") data.sequence_number = sequence
    }
    yield { ...event, event: data.type, data: JSON.stringify(data) }
    if (["response.completed", "response.failed", "response.incomplete", "error"].includes(data.type)) return
  }
  throw new HTTPError("The upstream Responses stream ended before a terminal response event.", 502)
}
