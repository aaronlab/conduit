import type { ResponsesPayload } from "../services/copilot/create-responses"
import { InvalidRequestError } from "./error"
import { resolveAlias } from "./responses-bridge"
import { isRecord } from "./validation"

export function parseResponsesPayload(value: unknown): ResponsesPayload {
  if (!isRecord(value)) throw new InvalidRequestError("Request body must be a JSON object.")
  if (typeof value.model !== "string" || !value.model.trim()) {
    throw new InvalidRequestError("model must be a non-empty string.", "model")
  }
  if (value.input !== undefined && typeof value.input !== "string" && !Array.isArray(value.input)) {
    throw new InvalidRequestError("input must be a string or an array of Responses input items.", "input")
  }
  if (value.stream !== undefined && typeof value.stream !== "boolean") {
    throw new InvalidRequestError("stream must be a boolean.", "stream")
  }
  if (value.reasoning !== undefined && value.reasoning !== null && !isRecord(value.reasoning)) {
    throw new InvalidRequestError("reasoning must be an object or null.", "reasoning")
  }
  if (value.tools !== undefined && !Array.isArray(value.tools)) {
    throw new InvalidRequestError("tools must be an array.", "tools")
  }
  if (Array.isArray(value.tools) && value.tools.some((tool) => !isRecord(tool) || typeof tool.type !== "string")) {
    throw new InvalidRequestError("Each tool must be an object with a type.", "tools")
  }

  const alias = resolveAlias(value.model)
  const payload: ResponsesPayload = { ...value, model: alias.model, input: value.input }
  if (typeof value.stream === "boolean") payload.stream = value.stream
  if (alias.defaultEffort) {
    payload.reasoning = {
      ...(isRecord(value.reasoning) ? value.reasoning : {}),
      effort: alias.defaultEffort,
    }
  }
  return payload
}
