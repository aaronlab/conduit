import type { Context } from "hono"
import { streamSSE } from "hono/streaming"

import { checkRateLimit } from "../../lib/rate-limit"
import { state } from "../../lib/state"
import { logEmitter } from "../../util/log-emitter"
import { generateRequestId } from "../../util/id"
import { extractErrorDetails, forwardError, HTTPError, InvalidRequestError } from "../../lib/error"
import { getRouteStrategy, resolveModelName } from "../../lib/model-router"
import { passthroughToMessages } from "./passthrough"
import {
  translateToOpenAI,
  translateToAnthropic,
} from "./non-stream-translation"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./stream-translation"
import { createCompatibleChatCompletions } from "../../services/copilot/create-chat-completions"
import { createResponses } from "../../services/copilot/create-responses"
import type { AnthropicStreamState } from "./anthropic-types"
import { deriveClientIdentity } from "../../util/client-identity"
import { resolveProvider } from "../../lib/upstream-router"
import { isRecord } from "../../lib/validation"
import {
  buildNativeWebSearchResponse,
  buildNativeWebSearchPayload,
  extractWebSearchQuery,
  supportsNativeWebSearch,
  webSearchResponseToSSE,
} from "./web-search"

export async function handleMessages(c: Context) {
  const startTime = performance.now()
  const requestId = generateRequestId()

  try {
    await checkRateLimit(state)
  } catch (error) {
    return forwardError(c, error)
  }

  // Extract request metadata
  const anthropicBeta = c.req.header("anthropic-beta") ?? null
  const userAgent = c.req.header("user-agent") ?? null
  const openaiUser = c.req.header("openai-user") ?? null
  const userId = c.req.header("x-user-id") ?? null
  const { sessionId, clientName, clientVersion } = deriveClientIdentity(userId, userAgent, "default", openaiUser)

  // Read raw body for passthrough, parse for routing decision
  const rawBody = await c.req.text()
  let payload: { model: string; stream?: boolean; [key: string]: unknown }
  try {
    const parsed: unknown = JSON.parse(rawBody)
    if (!isRecord(parsed) || typeof parsed.model !== "string" || !parsed.model.trim() || !Array.isArray(parsed.messages)) {
      throw new InvalidRequestError("A model string and messages array are required.")
    }
    if (parsed.stream !== undefined && typeof parsed.stream !== "boolean") {
      throw new InvalidRequestError("stream must be a boolean.", "stream")
    }
    if (parsed.tools !== undefined && (!Array.isArray(parsed.tools) || parsed.tools.some((tool) => !isRecord(tool)))) {
      throw new InvalidRequestError("tools must be an array of tool objects.", "tools")
    }
    payload = { ...parsed, model: parsed.model }
    if (typeof parsed.stream === "boolean") payload.stream = parsed.stream
  } catch (error) {
    return forwardError(c, error instanceof SyntaxError ? new InvalidRequestError("Invalid JSON.") : error)
  }
  const model = payload.model
  const stream = !!payload.stream
  const thinking = isRecord(payload.thinking) ? payload.thinking.type ?? null : null
  const effort = isRecord(payload.output_config) ? payload.output_config.effort ?? null : null
  const availableModelIds = state.models?.data.map((available) => available.id) ?? null
  const resolvedModel = resolveModelName(model, availableModelIds, anthropicBeta)

  logEmitter.emitLog({
    ts: Date.now(), level: "info", type: "request_start", requestId,
    msg: `POST /v1/messages ${model} → ${resolvedModel}`,
    data: { path: "/v1/messages", format: "anthropic", model, resolvedModel, stream, thinking, effort, anthropicBeta, sessionId, clientName, clientVersion },
  })

  // Check for custom provider routing
  const resolved = resolveProvider(model)
  if (resolved) {
    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "system", requestId,
      msg: `Custom provider matched: ${resolved.provider.name} (pattern: ${resolved.matchedPattern})`,
      data: null,
    })
  }

  const strategy = getRouteStrategy(resolvedModel)

  // ---------------------------------------------------------------------------
  // Web Search interception
  //
  // Claude Code sends a dedicated sub-request for web search with a server tool
  // ({type: "web_search_20250305"}) in the tools array. For verified models,
  // translate that request to Copilot's native Responses `web_search` tool.
  //
  // Tavily remains a fallback for older models that do not expose native search.
  // Both backends return Anthropic-native server_tool_use,
  // web_search_tool_result, and text blocks that Claude Code expects.
  // ---------------------------------------------------------------------------
  const anthropicPayload = payload as Record<string, unknown>
  const webSearchServerTool = anthropicPayload.tools
    ? (anthropicPayload.tools as Array<Record<string, unknown>>)?.find(
        (t) => typeof t.type === "string" && (t.type as string).startsWith("web_search_"),
      )
    : undefined

  const tavilyApiKey = state.stWebSearchApiKey || process.env.TAVILY_API_KEY

  try {
    if (webSearchServerTool) {
      const query = extractWebSearchQuery(anthropicPayload)
      if (!query) throw new InvalidRequestError("A non-empty web search query is required.", "messages")
      const srvId = `srvtoolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
      let responseBody: ReturnType<typeof buildNativeWebSearchResponse> | null = null
      let searchBackend: "copilot-native" | "tavily" | null = null

      if (supportsNativeWebSearch(resolvedModel)) {
        try {
          const nativeResponse = await createResponses(
            buildNativeWebSearchPayload(resolvedModel, query, webSearchServerTool),
            { signal: c.req.raw.signal },
          ) as Parameters<typeof buildNativeWebSearchResponse>[0]
          responseBody = buildNativeWebSearchResponse(nativeResponse, {
            requestId,
            requestedModel: model,
            requestedQuery: query,
            serverToolUseId: srvId,
          })
          searchBackend = "copilot-native"
        } catch (error) {
          if (error instanceof InvalidRequestError && error.code !== "unsupported_feature") throw error
          if (!tavilyApiKey) throw error
          logEmitter.emitLog({
            ts: Date.now(), level: "warn", type: "upstream_error", requestId,
            msg: "Native web search failed; trying the configured Tavily fallback",
            data: { error: extractErrorDetails(error).errorDetail },
          })
        }
      }

      if (!responseBody && tavilyApiKey) {
        // Call Tavily only when native search is unavailable or failed.
        if (webSearchServerTool.user_location) {
          throw new InvalidRequestError("The Tavily fallback cannot preserve an approximate user_location.", "tools", "unsupported_feature")
        }
        const tavilyResp = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tavilyApiKey}`,
          },
          body: JSON.stringify({
            query, max_results: 5,
            ...(webSearchServerTool.allowed_domains !== undefined && { include_domains: webSearchServerTool.allowed_domains }),
            ...(webSearchServerTool.blocked_domains !== undefined && { exclude_domains: webSearchServerTool.blocked_domains }),
          }),
          signal: c.req.raw.signal,
        })
        if (!tavilyResp.ok) throw await HTTPError.fromResponse("Tavily web search failed", tavilyResp)
        const tavilyData: unknown = await tavilyResp.json()
        if (!isRecord(tavilyData) || !Array.isArray(tavilyData.results)) {
          throw new HTTPError("Tavily returned an invalid search response.", 502)
        }
        const searchResults = tavilyData.results.map((result: unknown) => {
          if (!isRecord(result) || typeof result.url !== "string" || typeof result.title !== "string" || typeof result.content !== "string") {
            throw new HTTPError("Tavily returned an invalid search result.", 502)
          }
          return { url: result.url, title: result.title, content: result.content }
        })

        const webResults = searchResults.map((result) => ({
          type: "web_search_result" as const,
          url: result.url,
          title: result.title,
          encrypted_content: "",
        }))
        const summaryText = searchResults.length
          ? searchResults.map((result) => `${result.title}\n${result.url}\n${result.content}`).join("\n\n---\n\n")
          : "No results found."
        responseBody = {
          id: `msg_${requestId}`,
          type: "message",
          role: "assistant",
          model,
          content: [
            { type: "server_tool_use", id: srvId, name: "web_search", input: { query } },
            { type: "web_search_tool_result", tool_use_id: srvId, content: webResults },
            { type: "text", text: summaryText },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            service_tier: "standard",
            server_tool_use: { web_search_requests: 1 },
          },
        }
        searchBackend = "tavily"
      }

      if (responseBody && searchBackend) {
        const latencyMs = Math.round(performance.now() - startTime)
        logEmitter.emitLog({
          ts: Date.now(), level: "info", type: "request_end", requestId,
          msg: `200 web_search (${searchBackend}) ${latencyMs}ms`,
          data: {
            path: "/v1/messages", format: "anthropic", model, resolvedModel,
            strategy: `web_search_${searchBackend}`,
            inputTokens: responseBody.usage.input_tokens,
            outputTokens: responseBody.usage.output_tokens,
            latencyMs, stream, status: "success", statusCode: 200,
            sessionId, clientName, clientVersion,
          },
        })

        if (!stream) return c.json(responseBody)

        return streamSSE(c, async (sseStream) => {
          for (const event of webSearchResponseToSSE(responseBody)) {
            await sseStream.writeSSE({
              event: event.event,
              data: JSON.stringify(event.data),
            })
          }
        })
      }
      if (strategy === "translate") {
        throw new InvalidRequestError(
          "This model has no configured web search backend. Select a native-search model or configure Tavily.",
          "tools", "unsupported_feature",
        )
      }
    }
    // --- End Web Search interception ---

    if (strategy === "passthrough") {
      // ★ PASSTHROUGH: Claude models go directly, no translation
      const response = await passthroughToMessages(rawBody, model, stream, anthropicBeta)

      if (stream && response.body) {
        // Stream passthrough: pipe the upstream SSE response directly to the client.
        // Do NOT use Hono's streamSSE — it would double-encode the already-formatted SSE.
        const { readable, writable } = new TransformStream()
        const writer = writable.getWriter()
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        const encoder = new TextEncoder()
        let inputTokens = 0
        let outputTokens = 0

        // Keep-alive heartbeat: emit an SSE comment line every 15s while idle so that
        // upstream stalls (e.g. long reasoning with no token output) do not trigger the
        // client's fetch idle timeout (~5 min in undici/Node), which surfaces to users as
        // "socket connection was closed unexpectedly".
        const HEARTBEAT_MS = 15_000
        let lastWriteAt = performance.now()
        const heartbeatTimer = setInterval(() => {
          if (performance.now() - lastWriteAt < HEARTBEAT_MS) return
          writer.write(encoder.encode(": ka\n\n")).then(
            () => { lastWriteAt = performance.now() },
            () => { /* writer already closed/errored; main loop will clean up */ },
          )
        }, HEARTBEAT_MS)

        // Pipe in background, log when done
        ;(async () => {
          let streamError: unknown = null
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              // Extract token usage from SSE events for logging
              const chunk = decoder.decode(value, { stream: true })
              const lines = chunk.split("\n")
              for (const line of lines) {
                if (line.startsWith("data: ") && line !== "data: [DONE]") {
                  try {
                    const data = JSON.parse(line.slice(6))
                    if (data.usage) {
                      inputTokens = data.usage.input_tokens ?? inputTokens
                      outputTokens = data.usage.output_tokens ?? outputTokens
                    }
                  } catch { /* ignore parse errors */ }
                }
              }

              await writer.write(value)
              lastWriteAt = performance.now()
            }
          } catch (err) {
            streamError = err
            // Attempt to surface the error to the client as an Anthropic-style SSE error event
            // so the client sees a proper error instead of an abrupt socket close.
            try {
              const { errorDetail } = extractErrorDetails(err)
              const errorMessage =
                typeof errorDetail === "string"
                  ? errorDetail
                  : (errorDetail as { message?: string })?.message ?? String(err)
              const errorPayload = {
                type: "error",
                error: { type: "api_error", message: errorMessage },
              }
              const sseBytes = new TextEncoder().encode(
                `event: error\ndata: ${JSON.stringify(errorPayload)}\n\n`,
              )
              await writer.write(sseBytes)
            } catch { /* client may have already disconnected; ignore */ }
          } finally {
            clearInterval(heartbeatTimer)
            try { await writer.close() } catch { /* already closed or errored */ }
            try { reader.releaseLock() } catch { /* already released */ }
            const latencyMs = Math.round(performance.now() - startTime)
            if (streamError) {
              const { errorDetail, statusCode } = extractErrorDetails(streamError)
              logEmitter.emitLog({
                ts: Date.now(), level: "error", type: "request_end", requestId,
                msg: `${statusCode} ${model} ${latencyMs}ms (stream interrupted)`,
                data: {
                  path: "/v1/messages", format: "anthropic", model, resolvedModel,
                  strategy: "passthrough",
                  inputTokens, outputTokens, latencyMs,
                  stream: true, status: "error", statusCode, error: errorDetail,
                  sessionId, clientName, clientVersion,
                },
              })
            } else {
              logEmitter.emitLog({
                ts: Date.now(), level: "info", type: "request_end", requestId,
                msg: `200 ${model} ${latencyMs}ms`,
                data: {
                  path: "/v1/messages", format: "anthropic", model, resolvedModel,
                  strategy: "passthrough",
                  inputTokens, outputTokens, latencyMs,
                  stream: true, status: "success", statusCode: 200,
                  sessionId, clientName, clientVersion,
                },
              })
            }
          }
        })()

        return new Response(readable, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "connection": "keep-alive",
          },
        })
      } else {
        // Non-streaming passthrough
        const body = await response.json()
        const latencyMs = Math.round(performance.now() - startTime)
        const usage = (body as Record<string, unknown>)?.usage as Record<string, number> | undefined
        logEmitter.emitLog({
          ts: Date.now(), level: "info", type: "request_end", requestId,
          msg: `200 ${model} ${latencyMs}ms`,
          data: {
            path: "/v1/messages", format: "anthropic", model, resolvedModel,
            strategy: "passthrough",
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            latencyMs, stream: false, status: "success", statusCode: 200,
            sessionId, clientName, clientVersion,
          },
        })
        return c.json(body)
      }
    } else {
      // TRANSLATE: Non-Claude models need Anthropic → OpenAI conversion
      const anthropicPayload = JSON.parse(rawBody)
      anthropicPayload.model = resolvedModel
      const openAIPayload = translateToOpenAI(anthropicPayload)
      const response = await createCompatibleChatCompletions(openAIPayload)

      if (!stream) {
        // Non-streaming translated response
        const anthropicResponse = translateToAnthropic(response as Parameters<typeof translateToAnthropic>[0])
        const latencyMs = Math.round(performance.now() - startTime)
        logEmitter.emitLog({
          ts: Date.now(), level: "info", type: "request_end", requestId,
          msg: `200 ${model} ${latencyMs}ms`,
          data: {
            path: "/v1/messages", format: "anthropic", model, resolvedModel,
            strategy: "translate", latencyMs,
            stream: false, status: "success", statusCode: 200,
          },
        })
        return c.json(anthropicResponse)
      }

      // Streaming translated response
      return streamSSE(c, async (sseStream) => {
        const streamState: AnthropicStreamState = {
          messageStartSent: false,
          contentBlockIndex: 0,
          contentBlockOpen: false,
          toolCalls: {},
        }

        try {
          for await (const event of response as AsyncIterable<{ data: string }>) {
            const chunk = JSON.parse(event.data)
            const anthropicEvents = translateChunkToAnthropicEvents(chunk, streamState)
            for (const evt of anthropicEvents) {
              await sseStream.writeSSE({ event: evt.type, data: JSON.stringify(evt) })
            }
          }
        } catch {
          const errorEvent = translateErrorToAnthropicErrorEvent()
          await sseStream.writeSSE({ event: errorEvent.type, data: JSON.stringify(errorEvent) })
        } finally {
          const latencyMs = Math.round(performance.now() - startTime)
          logEmitter.emitLog({
            ts: Date.now(), level: "info", type: "request_end", requestId,
            msg: `200 ${model} ${latencyMs}ms`,
            data: {
              path: "/v1/messages", format: "anthropic", model, resolvedModel,
              strategy: "translate", latencyMs,
              stream: true, status: "success", statusCode: 200,
            sessionId, clientName, clientVersion,
            },
          })
        }
      })
    }
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startTime)
    const { errorDetail, statusCode } = extractErrorDetails(error)
    logEmitter.emitLog({
      ts: Date.now(), level: "error", type: "request_end", requestId,
      msg: `${statusCode} ${model} ${latencyMs}ms`,
      data: {
        path: "/v1/messages", format: "anthropic", model, resolvedModel,
        strategy, latencyMs, stream,
        status: "error", statusCode, error: errorDetail,
        sessionId, clientName, clientVersion,
      },
    })
    return forwardError(c, error)
  }
}
