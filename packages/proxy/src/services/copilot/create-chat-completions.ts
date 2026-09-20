import { events } from "./../../util/sse"

import { copilotHeaders, copilotBaseUrl } from "./../../lib/api-config"
import { HTTPError } from "./../../lib/error"
import {
  chatToResponses,
  responsesStreamToChat,
  responsesToChat,
  shouldBridgeToResponses,
} from "./../../lib/responses-bridge"
import { state } from "./../../lib/state"
import { ensureFreshCopilotToken, forceCopilotTokenRefresh } from "./../../lib/token"
import { createResponses } from "./create-responses"
import type { ServerSentEvent } from "../../util/sse"
import { copilotSessionHeaders, type CopilotRequestOptions } from "./request-options"

export const createCompatibleChatCompletions = async (
  payload: ChatCompletionsPayload,
  options: CopilotRequestOptions = {},
) => {
  if (!shouldBridgeToResponses(payload.model)) {
    return createChatCompletions(payload, options)
  }

  const upstream = await createResponses(chatToResponses(payload), options)
  if (payload.stream) {
    return responsesStreamToChat(
      upstream as AsyncIterable<ServerSentEvent>,
      payload.model,
    )
  }

  return responsesToChat(upstream as Record<string, unknown>, payload.model)
}

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  options: CopilotRequestOptions = {},
) => {
  options.signal?.throwIfAborted()
  await ensureFreshCopilotToken()
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Agent/user check for X-Initiator header
  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  const doFetch = () =>
    fetch(`${copilotBaseUrl(state)}/chat/completions`, {
      method: "POST",
      headers: {
        ...copilotHeaders(state, enableVision),
        ...copilotSessionHeaders(options.headers),
        accept: payload.stream ? "text/event-stream" : "application/json",
        "X-Initiator": isAgentCall ? "agent" : "user",
      },
      body: JSON.stringify(payload),
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
    throw await HTTPError.fromResponse("Failed to create chat completions", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint: string | null
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details: {
      cached_tokens: number
    } | null
    completion_tokens_details: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    } | null
  } | null
}

interface Delta {
  content: string | null
  role: "user" | "assistant" | "system" | "tool" | null
  tool_calls: Array<{
    index: number
    id: string | null
    type: "function" | null
    function: {
      name: string | null
      arguments: string | null
    } | null
  } | null>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint: string | null
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details: {
      cached_tokens: number
    } | null
  } | null
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls: Array<ToolCall> | null
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  max_completion_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: {
    type: "json_schema"
    json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean; description?: string }
  } | { type: "json_object" } | null
  parallel_tool_calls?: boolean
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null

  /**
   * Controls reasoning effort for o1/o3 style models.
   */
  reasoning_effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description: string | null
    parameters: Record<string, unknown>
    strict?: boolean
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string | null
  tool_calls?: Array<ToolCall> | null
  tool_call_id?: string | null
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
