import type {
  AnthropicAssistantContentBlock,
  AnthropicResponse,
} from "./anthropic-types"
import type { ResponsesPayload } from "../../services/copilot/create-responses"
import { HTTPError, InvalidRequestError } from "../../lib/error"

export const NATIVE_WEB_SEARCH_MODELS = new Set(["gpt-5.6-sol"])

export interface WebSearchRequestPayload {
  messages?: Array<{
    role?: string
    content?: string | Array<{ type?: string; text?: string }>
  }>
}

interface NativeUrlCitation {
  type?: string
  title?: string
  url?: string
}

interface NativeOutputText {
  type?: string
  text?: string
  annotations?: NativeUrlCitation[]
}

interface NativeOutputItem {
  type?: string
  status?: string
  action?: {
    type?: string
    query?: string
    queries?: string[]
  }
  content?: NativeOutputText[]
}

export interface NativeWebSearchResponse {
  id?: string
  model?: string
  status?: string
  error?: { message?: string }
  output?: NativeOutputItem[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
}

export function supportsNativeWebSearch(model: string): boolean {
  return NATIVE_WEB_SEARCH_MODELS.has(model)
}

export function extractWebSearchQuery(payload: WebSearchRequestPayload): string {
  const message =
    payload.messages?.findLast((candidate) => candidate.role === "user")
    ?? payload.messages?.at(-1)

  const rawContent =
    typeof message?.content === "string"
      ? message.content
      : Array.isArray(message?.content)
        ? message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join(" ")
        : ""

  return rawContent.replace(/^Perform a web search for the query:\s*/i, "").trim()
}

export function buildNativeWebSearchPayload(
  model: string,
  query: string,
  tool: Record<string, unknown>,
): ResponsesPayload {
  if (!query) throw new InvalidRequestError("A non-empty web search query is required.", "messages")
  if (Array.isArray(tool.blocked_domains) && tool.blocked_domains.length > 0) {
    throw new InvalidRequestError("Native web search cannot enforce blocked_domains; use a configured Tavily fallback.", "tools", "unsupported_feature")
  }
  const searchTool: Record<string, unknown> = { type: "web_search" }
  if (tool.allowed_domains !== undefined) {
    if (!Array.isArray(tool.allowed_domains) || !tool.allowed_domains.every((domain) => typeof domain === "string")) {
      throw new InvalidRequestError("allowed_domains must be an array of strings.", "tools")
    }
    searchTool.filters = { allowed_domains: tool.allowed_domains }
  }
  if (tool.user_location !== undefined) searchTool.user_location = tool.user_location
  if (tool.max_uses !== undefined && (!Number.isInteger(tool.max_uses) || typeof tool.max_uses !== "number" || tool.max_uses < 1)) {
    throw new InvalidRequestError("max_uses must be a positive integer.", "tools")
  }
  return {
    model, input: query, tools: [searchTool], tool_choice: { type: "web_search" },
    reasoning: { effort: "max" },
    ...(typeof tool.max_uses === "number" && { max_tool_calls: tool.max_uses }),
  }
}

export function buildNativeWebSearchResponse(
  native: NativeWebSearchResponse,
  options: {
    requestId: string
    requestedModel: string
    requestedQuery: string
    serverToolUseId: string
  },
): AnthropicResponse {
  const output = native.output ?? []
  const searchCalls = output.filter((item) => item.type === "web_search_call")
  if (native.status === "failed" || native.status === "incomplete" || native.error || searchCalls.some((call) => call.status === "failed")) {
    throw new HTTPError(native.error?.message ?? "The native web search did not complete.", 502)
  }
  if (searchCalls.length === 0) {
    throw new HTTPError("The upstream response did not perform the requested web search.", 502)
  }
  const actualQuery =
    searchCalls
      .map((item) => item.action?.query ?? item.action?.queries?.[0])
      .find((query): query is string => typeof query === "string" && query.length > 0)
    ?? options.requestedQuery

  const textParts: string[] = []
  const citations = new Map<string, { title: string; url: string }>()

  for (const item of output) {
    if (item.type !== "message") continue
    for (const part of item.content ?? []) {
      if (part.type !== "output_text") continue
      if (part.text) textParts.push(part.text)
      for (const annotation of part.annotations ?? []) {
        if (annotation.type !== "url_citation" || !annotation.url) continue
        citations.set(annotation.url, {
          title: annotation.title || annotation.url,
          url: annotation.url,
        })
      }
    }
  }

  const webResults = [...citations.values()].map((citation) => ({
    type: "web_search_result" as const,
    url: citation.url,
    title: citation.title,
    encrypted_content: "",
  }))
  const summaryText = textParts.join("\n\n").trim() || "No results found."
  const content: AnthropicAssistantContentBlock[] = [
    {
      type: "server_tool_use",
      id: options.serverToolUseId,
      name: "web_search",
      input: { query: actualQuery },
    },
    {
      type: "web_search_tool_result",
      tool_use_id: options.serverToolUseId,
      content: webResults,
    },
    { type: "text", text: summaryText },
  ]

  return {
    id: native.id || `msg_${options.requestId}`,
    type: "message",
    role: "assistant",
    model: native.model || options.requestedModel,
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: native.usage?.input_tokens ?? 0,
      output_tokens: native.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      service_tier: "standard",
      server_tool_use: {
        web_search_requests: searchCalls.length,
      },
    },
  }
}

export function webSearchResponseToSSE(response: AnthropicResponse): Array<{
  event: string
  data: unknown
}> {
  const events: Array<{ event: string; data: unknown }> = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          ...response,
          content: [],
          stop_reason: null,
          usage: { ...response.usage, output_tokens: 0 },
        },
      },
    },
  ]

  for (const [index, block] of response.content.entries()) {
    if (block.type === "server_tool_use") {
      events.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block: { ...block, input: {} },
        },
      })
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        },
      })
    } else if (block.type === "text") {
      events.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        },
      })
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        },
      })
    } else {
      events.push({
        event: "content_block_start",
        data: { type: "content_block_start", index, content_block: block },
      })
    }

    events.push({
      event: "content_block_stop",
      data: { type: "content_block_stop", index },
    })
  }

  events.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: response.stop_reason, stop_sequence: null },
      usage: { output_tokens: response.usage.output_tokens },
    },
  })
  events.push({ event: "message_stop", data: { type: "message_stop" } })
  return events
}