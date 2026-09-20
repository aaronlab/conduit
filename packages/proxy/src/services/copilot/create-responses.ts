import { events, type ServerSentEvent } from "../../util/sse"
import { copilotBaseUrl, copilotHeaders } from "../../lib/api-config"
import { HTTPError, InvalidRequestError } from "../../lib/error"
import { state } from "../../lib/state"
import { ensureFreshCopilotToken, forceCopilotTokenRefresh } from "../../lib/token"
import { isRecord } from "../../lib/validation"
import { copilotSessionHeaders, type CopilotRequestOptions } from "./request-options"

export interface ResponsesPayload {
  model: string
  input: unknown
  stream?: boolean
  [key: string]: unknown
}

export const createResponses = async (
  payload: ResponsesPayload,
  options: CopilotRequestOptions = {},
): Promise<Record<string, unknown> | AsyncIterable<ServerSentEvent>> => {
  const model = state.models?.data.find((candidate) => candidate.id === payload.model)
  if (model?.supported_endpoints && !model.supported_endpoints.includes("/responses")) {
    throw new InvalidRequestError(
      `${payload.model} does not expose the Responses API in Copilot. Choose a model from the Conduit Codex catalog.`,
      "model",
      "unsupported_api_for_model",
    )
  }

  options.signal?.throwIfAborted()
  await ensureFreshCopilotToken()
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const body = JSON.stringify(payload)
  const doFetch = () =>
    fetch(`${copilotBaseUrl(state)}/responses`, {
      method: "POST",
      headers: {
        ...copilotHeaders(state, hasVisionContent(payload)),
        ...copilotSessionHeaders(options.headers),
        accept: payload.stream ? "text/event-stream" : "application/json",
        "X-Initiator": hasAgentHistory(payload) ? "agent" : "user",
      },
      body,
      ...(options.signal && { signal: options.signal }),
    })

  let response = await doFetch()
  if (response.status === 401) {
    await response.body?.cancel()
    options.signal?.throwIfAborted()
    await forceCopilotTokenRefresh()
    response = await doFetch()
  }
  options.onResponse?.(response.headers)

  if (!response.ok) {
    throw await HTTPError.fromResponse("Failed to create responses", response)
  }

  if (payload.stream) {
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      await response.body?.cancel()
      throw new HTTPError("Copilot returned a non-SSE body for a streaming Responses request.", 502)
    }
    return events(response)
  }

  let result: unknown
  try {
    result = await response.json()
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new HTTPError("Copilot returned invalid JSON for a Responses request.", 502)
  }
  if (!isRecord(result)) throw new HTTPError("Copilot returned an invalid Responses body.", 502)
  return result
}

export function hasVisionContent(payload: ResponsesPayload): boolean {
  if (!Array.isArray(payload.input)) return false
  return payload.input.some((item: unknown) => {
    if (!isRecord(item)) return false
    const parts = item.content ?? item.output
    const containsImage = (part: unknown) => isRecord(part)
      && (part.type === "input_image" || part.type === "computer_screenshot")
    return Array.isArray(parts) ? parts.some(containsImage) : containsImage(parts)
  })
}

export function hasAgentHistory(payload: ResponsesPayload): boolean {
  if (typeof payload.previous_response_id === "string") return true
  if (!Array.isArray(payload.input)) return false
  return payload.input.some((item: unknown) => {
    if (!isRecord(item)) return false
    return item.role === "assistant"
      || (typeof item.type === "string" && (
        item.type.endsWith("_call")
        || item.type.endsWith("_call_output")
        || item.type === "reasoning"
        || item.type === "compaction"
      ))
  })
}
