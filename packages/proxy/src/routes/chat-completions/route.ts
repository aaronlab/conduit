import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { createCompatibleChatCompletions, type ChatCompletionsPayload } from "../../services/copilot/create-chat-completions"
import { shouldBridgeToResponses } from "../../lib/responses-bridge"
import { extractErrorDetails, forwardError, forwardResponseHeaders, HTTPError, InvalidRequestError } from "../../lib/error"
import { isAsyncIterable, isRecord } from "../../lib/validation"
import { logEmitter } from "../../util/log-emitter"
import { generateRequestId } from "../../util/id"
import { checkRateLimit } from "../../lib/rate-limit"
import { state } from "../../lib/state"

export const completionRoutes = new Hono()

completionRoutes.post("/", async (c) => {
  const startTime = performance.now()
  const requestId = generateRequestId()
  const controller = new AbortController()
  const signal = AbortSignal.any([c.req.raw.signal, controller.signal])
  let model = "(invalid)"
  let streaming = false
  let bridge = false

  function logEnd(error: string | null, statusCode: number): void {
    const latencyMs = Math.round(performance.now() - startTime)
    logEmitter.emitLog({
      ts: Date.now(), level: error ? "error" : "info", type: "request_end", requestId,
      msg: `${statusCode} ${model} ${latencyMs}ms`,
      data: {
        path: "/v1/chat/completions", format: "openai", model, latencyMs, bridge,
        stream: streaming, status: error ? "error" : "success", statusCode,
        ...(error && { error }),
      },
    })
  }

  try {
    await checkRateLimit(state)
    let payload: ChatCompletionsPayload
    try {
      payload = await c.req.json<ChatCompletionsPayload>()
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      throw new InvalidRequestError("Invalid JSON.")
    }
    if (!isRecord(payload) || typeof payload.model !== "string" || !payload.model.trim() || !Array.isArray(payload.messages)) {
      throw new InvalidRequestError("A model string and messages array are required.")
    }
    if (payload.messages.some((message) => !isRecord(message) || typeof message.role !== "string")) {
      throw new InvalidRequestError("Each message must be an object with a role.", "messages")
    }
    if (payload.stream !== undefined && payload.stream !== null && typeof payload.stream !== "boolean") {
      throw new InvalidRequestError("stream must be a boolean.", "stream")
    }
    model = payload.model
    streaming = payload.stream === true
    bridge = shouldBridgeToResponses(model)
    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "request_start", requestId,
      msg: `POST /v1/chat/completions ${model}${bridge ? " (Responses bridge)" : ""}`,
      data: { path: "/v1/chat/completions", format: "openai", model, stream: streaming, bridge },
    })
    const response = await createCompatibleChatCompletions(payload, {
      signal, headers: c.req.raw.headers,
      onResponse: (headers) => forwardResponseHeaders(c, headers),
    })
    if (!streaming) {
      if (!isRecord(response)) throw new HTTPError("Invalid upstream chat completion.", 502)
      logEnd(null, 200)
      controller.abort()
      return c.json(response)
    }
    if (!isAsyncIterable<{ data: string }>(response)) throw new HTTPError("Expected an upstream chat stream.", 502)
    const downstream = streamSSE(c, async (stream) => {
      let failure: string | null = null
      let statusCode = 200
      let terminal = false
      const finishedChoices = new Set<number>()
      stream.onAbort(() => controller.abort(new Error("Client disconnected.")))
      const heartbeat = setInterval(() => {
        if (!stream.aborted) void stream.write(": keepalive\n\n").catch((error: unknown) => controller.abort(error))
      }, 15_000)
      try {
        for await (const event of response) {
          signal.throwIfAborted()
          if (event.data === "[DONE]") { terminal = true; break }
          if (!event.data) continue
          const chunk: unknown = JSON.parse(event.data)
          if (!isRecord(chunk)) throw new HTTPError("Invalid upstream chat event.", 502)
          if (isRecord(chunk.error)) {
            throw new HTTPError(typeof chunk.error.message === "string" ? chunk.error.message : "The chat stream failed.", 502)
          }
          if (Array.isArray(chunk.choices)) {
            for (const choice of chunk.choices) {
              if (isRecord(choice) && typeof choice.finish_reason === "string" && typeof choice.index === "number") {
                finishedChoices.add(choice.index)
              }
            }
          }
          await stream.writeSSE({ data: event.data })
          signal.throwIfAborted()
        }
        if (!terminal && finishedChoices.size < (payload.n ?? 1)) {
          throw new HTTPError("The upstream chat stream ended before completion.", 502)
        }
        await stream.writeSSE({ data: "[DONE]" })
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
        statusCode = signal.aborted ? 499 : 502
        if (!stream.aborted && !signal.aborted) {
          await stream.writeSSE({ data: JSON.stringify({
            error: { type: "api_error", code: "upstream_stream_error", message: failure },
          }) })
        }
      } finally {
        clearInterval(heartbeat)
        controller.abort()
        logEnd(failure, statusCode)
      }
    })
    downstream.headers.set("cache-control", "no-cache, no-transform")
    return downstream
  } catch (error) {
    const { errorDetail, statusCode } = extractErrorDetails(error)
    logEnd(errorDetail, signal.aborted ? 499 : statusCode)
    controller.abort()
    return forwardError(c, error)
  }
})
