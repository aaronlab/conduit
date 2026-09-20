/**
 * chat/completions ↔ /responses bridge.
 *
 * Some Copilot models (notably gpt-5.5) are only available on the upstream
 * `/responses` endpoint — calling them via `/chat/completions` returns
 * `unsupported_api_for_model`. This module lets us accept OpenAI-style
 * `/v1/chat/completions` requests for those models and silently bridge to
 * `/responses` upstream, then translate the answer back.
 *
 * Preserves text, images, function tools, reasoning effort and structured output.
 * Unsupported content is rejected instead of silently dropping it.
 */
import type { ChatCompletionsPayload, Message, Tool } from "../services/copilot/create-chat-completions"
import type { ResponsesPayload } from "../services/copilot/create-responses"
import type { ServerSentEvent } from "../util/sse"
import { HTTPError, InvalidRequestError } from "./error"
import { state } from "./state"
import { decodeResponsesEvent, normalizeResponsesStream, responsesError } from "./responses-stream"
import { isRecord } from "./validation"

type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

/** Models that must be routed through /responses instead of /chat/completions. */
const RESPONSES_ONLY_MODELS = new Set<string>([
  "gpt-5.5",
  "gpt-5.6-sol",
])

const DEFAULT_MODEL_EFFORTS: Record<string, ReasoningEffort> = {
  "gpt-5.6-sol": "max",
}

/** Optional aliases: virtual model id → {real model, default reasoning effort}. */
const MODEL_ALIASES: Record<string, { model: string; effort: ReasoningEffort }> = {
  "gpt-5.5-low": { model: "gpt-5.5", effort: "low" },
  "gpt-5.5-medium": { model: "gpt-5.5", effort: "medium" },
  "gpt-5.5-high": { model: "gpt-5.5", effort: "high" },
  "gpt-5.5-xhigh": { model: "gpt-5.5", effort: "xhigh" },
}

export function shouldBridgeToResponses(model: string): boolean {
  if (Object.hasOwn(MODEL_ALIASES, model)) return true
  const { model: realModel } = resolveAlias(model)
  const available = state.models?.data.find((candidate) => candidate.id === realModel)
  if (available?.supported_endpoints) {
    return available.supported_endpoints.includes("/responses")
      && !available.supported_endpoints.includes("/chat/completions")
  }
  if (RESPONSES_ONLY_MODELS.has(model)) return true
  return false
}

export function resolveAlias(model: string): { model: string; defaultEffort?: ReasoningEffort } {
  const a = Object.hasOwn(MODEL_ALIASES, model) ? MODEL_ALIASES[model] : undefined
  if (a) return { model: a.model, defaultEffort: a.effort }
  return { model }
}

/**
 * Convert a chat/completions payload into a /responses payload.
 */
export function chatToResponses(chat: ChatCompletionsPayload): ResponsesPayload {
  const { model: realModel, defaultEffort } = resolveAlias(chat.model)

  // Build /responses `input` array.
  // /responses accepts message items {role, content} AND tool items
  // {type:"function_call", call_id, name, arguments} and
  // {type:"function_call_output", call_id, output}.
  const input: Array<Record<string, unknown>> = []
  for (const m of chat.messages) {
    const role = m.role

    // tool result message → function_call_output item
    if (role === "tool") {
      if (!m.tool_call_id) throw new InvalidRequestError("A tool message requires tool_call_id.", "messages")
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id,
        output: toResponseContent(m.content),
      })
      continue
    }

    // assistant message that contains tool_calls → emit text first (if any), then function_call items
    if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const content = toResponseContent(m.content)
      if (content.length > 0) {
        input.push({ role: "assistant", content })
      }
      for (const tc of m.tool_calls) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments ?? "",
        })
      }
      continue
    }

    // plain message
    input.push({
      role,
      content: toResponseContent(m.content),
    })
  }

  const payload: ResponsesPayload = {
    model: realModel,
    input,
  }

  if (chat.stream) payload.stream = true

  // reasoning_effort → reasoning.effort
  const effort = defaultEffort ?? chat.reasoning_effort ?? DEFAULT_MODEL_EFFORTS[realModel]
  if (effort) {
    payload.reasoning = { effort }
  }

  // temperature / top_p
  if (typeof chat.temperature === "number") payload.temperature = chat.temperature
  if (typeof chat.top_p === "number") payload.top_p = chat.top_p

  // max_tokens → max_output_tokens
  const maxTokens = chat.max_completion_tokens ?? chat.max_tokens
  if (typeof maxTokens === "number") payload.max_output_tokens = maxTokens
  if (typeof chat.parallel_tool_calls === "boolean") payload.parallel_tool_calls = chat.parallel_tool_calls
  if (chat.response_format?.type === "json_schema") {
    payload.text = { format: { type: "json_schema", ...chat.response_format.json_schema } }
  } else if (chat.response_format?.type === "json_object") {
    payload.text = { format: { type: "json_object" } }
  }

  // tools: chat shape {type:"function", function:{name,description,parameters}}
  //        → responses shape {type:"function", name, description, parameters}
  if (Array.isArray(chat.tools) && chat.tools.length) {
    payload.tools = chat.tools.map((t: Tool) => ({
      type: "function" as const,
      name: t.function.name,
      description: t.function.description ?? undefined,
      parameters: t.function.parameters,
      ...(typeof t.function.strict === "boolean" && { strict: t.function.strict }),
    }))
  }

  // tool_choice: leave as-is when string, or convert object form
  if (chat.tool_choice) {
    if (typeof chat.tool_choice === "string") {
      payload.tool_choice = chat.tool_choice
    } else if (typeof chat.tool_choice === "object" && chat.tool_choice.type === "function") {
      payload.tool_choice = { type: "function", name: chat.tool_choice.function.name }
    }
  }

  return payload
}

function toResponseContent(content: Message["content"]): string | Array<Record<string, unknown>> {
  if (content === null) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) throw new InvalidRequestError("Invalid message content.", "messages")
  return content.map((part) => {
    if (part?.type === "text" && typeof part.text === "string") {
      return { type: "input_text", text: part.text }
    }
    if (part?.type === "image_url" && typeof part.image_url?.url === "string") {
      return {
        type: "input_image",
        image_url: part.image_url.url,
        ...(part.image_url.detail && { detail: part.image_url.detail }),
      }
    }
    throw new InvalidRequestError("Only text and image_url content can be bridged to Responses.", "messages", "unsupported_content")
  })
}

/**
 * Convert a non-streaming /responses JSON body into a /chat/completions response.
 */
export function responsesToChat(
  resp: Record<string, unknown>,
  requestedModel: string,
): unknown {
  if (resp.status === "failed" || resp.error) {
    throw new HTTPError(responsesError(resp) ?? "The upstream Responses request failed.", 502)
  }
  const id = (resp.id as string) ?? `chatcmpl-bridge-${Date.now()}`
  const created = Math.floor(((resp.created_at as number) ?? Date.now() / 1000))
  const model = (resp.model as string) ?? requestedModel

  const output = (resp.output as Array<Record<string, unknown>>) ?? []
  let text = ""
  const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = []
  let finishReason: "stop" | "length" | "tool_calls" | "content_filter" = "stop"

  for (const item of output) {
    const itype = item.type as string | undefined
    if (itype === "message") {
      const content = (item.content as Array<Record<string, unknown>>) ?? []
      for (const c of content) {
        if (c.type === "output_text" && typeof c.text === "string") text += c.text
      }
    } else if (itype === "function_call") {
      toolCalls.push({
        id: (item.call_id as string) ?? (item.id as string) ?? `call_${Date.now()}`,
        type: "function",
        function: {
          name: (item.name as string) ?? "",
          arguments: (item.arguments as string) ?? "{}",
        },
      })
    }
    // reasoning items are dropped — chat/completions has no analog
  }

  if (toolCalls.length) finishReason = "tool_calls"
  // map incomplete_details
  const incomplete = resp.incomplete_details as Record<string, unknown> | null
  if (incomplete && incomplete.reason === "max_output_tokens") finishReason = "length"
  if (incomplete && incomplete.reason === "content_filter") finishReason = "content_filter"

  const usage = resp.usage as Record<string, unknown> | undefined
  const promptTokens = usage ? (usage.input_tokens as number) ?? 0 : 0
  const completionTokens = usage ? (usage.output_tokens as number) ?? 0 : 0
  const totalTokens = usage ? (usage.total_tokens as number) ?? promptTokens + completionTokens : promptTokens + completionTokens
  const cachedTokens =
    usage && (usage.input_tokens_details as Record<string, unknown> | undefined)
      ? ((usage.input_tokens_details as Record<string, unknown>).cached_tokens as number) ?? 0
      : 0

  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      prompt_tokens_details: { cached_tokens: cachedTokens },
    },
  }
}

/**
 * Convert a streaming /responses event iterator into chat/completion chunks
 * (objects ready to JSON.stringify into the SSE `data:` field).
 *
 * Emits in order:
 *   1. role chunk (delta.role="assistant")
 *   2. one delta per response.output_text.delta event
 *   3. tool_calls deltas if function_call items show up
 *   4. final stop chunk (or tool_calls stop) with finish_reason
 *   5. usage chunk (if include_usage-like info available)
 */
export async function* responsesStreamToChat(
  events: AsyncIterable<ServerSentEvent>,
  requestedModel: string,
): AsyncGenerator<{ data: string }> {
  const id = `chatcmpl-bridge-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  let model = requestedModel
  let roleSent = false
  let finishReason: "stop" | "length" | "tool_calls" | "content_filter" = "stop"
  // Copilot rewrites/encrypts item_id independently in each SSE event, so it
  // is not stable across added/delta/done. output_index is stable.
  const toolIndex = new Map<number, number>()
  const emittedToolArguments = new Map<number, string>()
  const emittedText = new Map<string, string>()
  let nextToolIdx = 0
  let usageChunk: Record<string, unknown> | null = null

  function chunk(delta: Record<string, unknown>, finish: string | null = null): { data: string } {
    return {
      data: JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      }),
    }
  }

  function completedArgumentsChunk(
    outputIndex: number,
    fullArguments: string,
  ): { data: string } | null {
    const idx = toolIndex.get(outputIndex)
    if (idx === undefined || !fullArguments) return null

    const emitted = emittedToolArguments.get(outputIndex) ?? ""
    if (!fullArguments.startsWith(emitted)) {
      throw new HTTPError("Upstream tool arguments disagree with previously streamed arguments.", 502)
    }

    const remainder = fullArguments.slice(emitted.length)
    if (!remainder) return null

    emittedToolArguments.set(outputIndex, fullArguments)
    return chunk({
      tool_calls: [{ index: idx, function: { arguments: remainder } }],
    })
  }

  function* startTool(outputIndex: number, item: Record<string, unknown>): Generator<{ data: string }> {
    if (toolIndex.has(outputIndex)) return
    if (typeof item.name !== "string" || typeof item.call_id !== "string") {
      throw new HTTPError("Upstream function call is missing its name or call_id.", 502)
    }
    const idx = nextToolIdx++
    const args = typeof item.arguments === "string" ? item.arguments : ""
    toolIndex.set(outputIndex, idx)
    emittedToolArguments.set(outputIndex, args)
    if (!roleSent) {
      yield chunk({ role: "assistant", content: "" })
      roleSent = true
    }
    yield chunk({ tool_calls: [{
      index: idx, id: item.call_id, type: "function",
      function: { name: item.name, arguments: args },
    }] })
  }

  function* emitText(outputIndex: number, contentIndex: number, text: string, complete: boolean): Generator<{ data: string }> {
    const key = `${outputIndex}:${contentIndex}`
    const emitted = emittedText.get(key) ?? ""
    if (complete && !text.startsWith(emitted)) {
      throw new HTTPError("Upstream text disagrees with previously streamed text.", 502)
    }
    const delta = complete ? text.slice(emitted.length) : text
    if (!delta) return
    emittedText.set(key, emitted + delta)
    if (!roleSent) {
      yield chunk({ role: "assistant", content: "" })
      roleSent = true
    }
    yield chunk({ content: delta })
  }

  for await (const ev of normalizeResponsesStream(events)) {
    const parsed = decodeResponsesEvent(ev)
    const evType = parsed.type

    if (evType === "response.created" || evType === "response.in_progress") {
      const r = parsed.response as Record<string, unknown> | undefined
      if (r && typeof r.model === "string") model = r.model
      continue
    }

    if (evType === "response.output_text.delta" || evType === "response.output_text.done") {
      const complete = evType.endsWith(".done")
      const text = complete ? parsed.text : parsed.delta
      if (typeof text !== "string") throw new HTTPError("Invalid upstream output text.", 502)
      yield* emitText(
        typeof parsed.output_index === "number" ? parsed.output_index : 0,
        typeof parsed.content_index === "number" ? parsed.content_index : 0,
        text, complete,
      )
      continue
    }

    if (evType === "response.output_item.added") {
      const item = parsed.item as Record<string, unknown> | undefined
      if (item && item.type === "function_call") {
        const outputIndex = parsed.output_index as number
        yield* startTool(outputIndex, item)
      }
      continue
    }

    if (evType === "response.function_call_arguments.delta") {
      const outputIndex = parsed.output_index as number
      const idx = toolIndex.get(outputIndex)
      const delta = (parsed.delta as string) ?? ""
      if (idx === undefined || !delta) continue
      emittedToolArguments.set(
        outputIndex,
        (emittedToolArguments.get(outputIndex) ?? "") + delta,
      )
      yield chunk({
        tool_calls: [
          {
            index: idx,
            function: { arguments: delta },
          },
        ],
      })
      continue
    }

    if (evType === "response.function_call_arguments.done") {
      const completed = completedArgumentsChunk(
        parsed.output_index as number,
        (parsed.arguments as string) ?? "",
      )
      if (completed) yield completed
      continue
    }

    if (evType === "response.output_item.done") {
      const item = parsed.item as Record<string, unknown> | undefined
      if (item?.type === "function_call") {
        yield* startTool(parsed.output_index as number, item)
        const completed = completedArgumentsChunk(
          parsed.output_index as number,
          (item.arguments as string) ?? "",
        )
        if (completed) yield completed
      } else if (item?.type === "message" && Array.isArray(item.content)) {
        for (const [index, part] of item.content.entries()) {
          if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
            yield* emitText(parsed.output_index as number, index, part.text, true)
          }
        }
      }
      continue
    }

    if (evType === "response.completed" || evType === "response.incomplete") {
      const r = parsed.response as Record<string, unknown> | undefined
      if (r) {
        const output = (r.output as Array<Record<string, unknown>> | undefined) ?? []
        for (const [outputIndex, item] of output.entries()) {
          if (item.type !== "function_call") continue
          yield* startTool(outputIndex, item)
          const completed = completedArgumentsChunk(
            outputIndex,
            (item.arguments as string) ?? "",
          )
          if (completed) yield completed
        }
        const incomplete = r.incomplete_details as Record<string, unknown> | null
        if (toolIndex.size > 0) finishReason = "tool_calls"
        if (incomplete?.reason === "max_output_tokens") finishReason = "length"
        else if (incomplete?.reason === "content_filter") finishReason = "content_filter"
        else if (evType === "response.incomplete") throw new HTTPError(responsesError(parsed) ?? "Incomplete response.", 502)
        const usage = r.usage as Record<string, unknown> | undefined
        if (usage) {
          usageChunk = {
            prompt_tokens: (usage.input_tokens as number) ?? 0,
            completion_tokens: (usage.output_tokens as number) ?? 0,
            total_tokens: (usage.total_tokens as number) ?? 0,
            prompt_tokens_details: {
              cached_tokens:
                ((usage.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens as number) ?? 0,
            },
            completion_tokens_details: {
              accepted_prediction_tokens: 0,
              rejected_prediction_tokens: 0,
            },
          }
        }
      }
      // emit final stop chunk
      yield chunk({}, finishReason)
      // emit usage chunk (OpenAI compat: separate chunk with usage and empty choices)
      if (usageChunk) {
        yield {
          data: JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [],
            usage: usageChunk,
          }),
        }
      }
      return
    }

    if (evType === "response.failed" || evType === "error") {
      throw new HTTPError(responsesError(parsed) ?? "The upstream Responses stream failed.", 502)
    }
  }
}
