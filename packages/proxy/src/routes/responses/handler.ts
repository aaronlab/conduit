import type { Context } from "hono"
import { streamSSE } from "hono/streaming"

import { createResponses } from "../../services/copilot/create-responses"
import { extractErrorDetails, forwardError, forwardResponseHeaders, HTTPError, InvalidRequestError } from "../../lib/error"
import { checkRateLimit } from "../../lib/rate-limit"
import { parseResponsesPayload } from "../../lib/responses-request"
import { decodeResponsesEvent, normalizeResponsesStream, responsesError } from "../../lib/responses-stream"
import { isAsyncIterable, isRecord } from "../../lib/validation"
import { state } from "../../lib/state"
import { logEmitter } from "../../util/log-emitter"
import { logger } from "../../util/logger"
import { generateRequestId } from "../../util/id"
import { deriveClientIdentity } from "../../util/client-identity"
import type { ServerSentEvent } from "../../util/sse"

export const handleResponses = async (c: Context) => {
  const startTime = performance.now()
  const requestId = generateRequestId()
  const controller = new AbortController()
  const signal = AbortSignal.any([c.req.raw.signal, controller.signal])
  const { sessionId, clientName, clientVersion } = deriveClientIdentity(
    c.req.header("x-user-id") ?? c.req.header("session-id") ?? null,
    c.req.header("user-agent") ?? null,
    "default",
    c.req.header("openai-user") ?? null,
  )
  let model = "(invalid)"
  let resolvedModel = model
  let streaming = false
  let inputTokens = 0
  let outputTokens = 0
  let firstChunkTime: number | null = null

  function recordResponse(response: unknown): void {
    if (!isRecord(response)) return
    if (typeof response.model === "string") resolvedModel = response.model
    if (!isRecord(response.usage)) return
    if (typeof response.usage.input_tokens === "number") inputTokens = response.usage.input_tokens
    if (typeof response.usage.output_tokens === "number") outputTokens = response.usage.output_tokens
  }

  function logEnd(error: string | null, statusCode: number): void {
    const latencyMs = Math.round(performance.now() - startTime)
    logEmitter.emitLog({
      ts: Date.now(), level: error ? "error" : "info", type: "request_end", requestId,
      msg: `${statusCode} ${resolvedModel} ${latencyMs}ms`,
      data: {
        path: "/v1/responses", format: "responses", model, resolvedModel,
        inputTokens, outputTokens, latencyMs,
        ttftMs: firstChunkTime === null ? null : Math.round(firstChunkTime - startTime),
        stream: streaming, status: error ? "error" : "success", statusCode,
        sessionId, clientName, clientVersion,
        ...(error && { error }),
      },
    })
  }

  try {
    await checkRateLimit(state)
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      throw new InvalidRequestError("Invalid JSON.")
    }
    const payload = parseResponsesPayload(raw)
    model = isRecord(raw) && typeof raw.model === "string" ? raw.model : payload.model
    resolvedModel = payload.model
    streaming = payload.stream === true
    c.header("x-request-id", requestId)
    logEmitter.emitLog({
      ts: Date.now(), level: "info", type: "request_start", requestId,
      msg: `POST /v1/responses ${model}`,
      data: { path: "/v1/responses", format: "responses", model, resolvedModel, stream: streaming, sessionId, clientName, clientVersion },
    })

    const response = await createResponses(payload, {
      signal,
      headers: c.req.raw.headers,
      onResponse: (headers) => forwardResponseHeaders(c, headers),
    })
    if (streaming && isAsyncIterable<ServerSentEvent>(response)) {
      const downstream = streamSSE(c, async (stream) => {
        let failure: string | null = null
        let statusCode = 200
        stream.onAbort(() => controller.abort(new Error("Client disconnected.")))
        const heartbeat = setInterval(() => {
          if (!stream.aborted) {
            void stream.write(": keepalive\n\n").catch((error: unknown) => controller.abort(error))
          }
        }, 15_000)
        try {
          for await (const event of normalizeResponsesStream(response)) {
            signal.throwIfAborted()
            if (firstChunkTime === null) firstChunkTime = performance.now()
            const data = decodeResponsesEvent(event)
            recordResponse(data.response)
            failure = responsesError(data) ?? failure
            if (failure) statusCode = 502
            await stream.writeSSE({
              data: event.data,
              ...(event.event !== null && { event: event.event }),
              ...(event.id !== null && { id: event.id }),
              ...(event.retry !== null && { retry: event.retry }),
            })
            signal.throwIfAborted()
          }
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
          statusCode = signal.aborted ? 499 : 502
          if (!stream.aborted && !signal.aborted) {
            try {
              await stream.writeSSE({
                event: "error",
                data: JSON.stringify({ type: "error", code: "upstream_stream_error", message: failure, param: null }),
              })
            } catch (writeError) {
              logger.warn("Could not deliver the Responses stream error", { requestId, error: String(writeError) })
            }
          }
        } finally {
          clearInterval(heartbeat)
          controller.abort()
          logEnd(failure, statusCode)
        }
      })
      downstream.headers.set("cache-control", "no-cache, no-transform")
      downstream.headers.set("x-accel-buffering", "no")
      return downstream
    }
    if (streaming || isAsyncIterable(response)) throw new HTTPError("Unexpected response transport from Copilot.", 502)
    recordResponse(response)
    const failure = responsesError(response)
    logEnd(failure, failure ? 502 : 200)
    controller.abort()
    return c.json(response)
  } catch (error) {
    const { errorDetail, statusCode } = extractErrorDetails(error)
    logEnd(errorDetail, signal.aborted ? 499 : statusCode)
    controller.abort()
    return forwardError(c, error)
  }
}
