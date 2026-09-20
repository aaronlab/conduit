import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/services/copilot/create-responses", () => ({ createResponses: vi.fn() }))

import { responsesRoutes } from "../src/routes/responses/route"
import { createResponses } from "../src/services/copilot/create-responses"
import { HTTPError } from "../src/lib/error"
import { state } from "../src/lib/state"
import { logEmitter } from "../src/util/log-emitter"
import type { ServerSentEvent } from "../src/util/sse"

const app = new Hono().route("/v1/responses", responsesRoutes)
const completion = { type: "response.completed", response: {
  id: "resp_test", model: "native", status: "completed", output: [],
  usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
} }

function event(data: Record<string, unknown>): ServerSentEvent {
  return { data: JSON.stringify(data), event: null, id: null, retry: null }
}
async function* stream(...data: Record<string, unknown>[]) { for (const item of data) yield event(item) }

function post(body: unknown) {
  return app.request("/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.mocked(createResponses).mockReset()
  state.rateLimitSeconds = null
  logEmitter.clearBuffer()
})
afterEach(() => vi.restoreAllMocks())

describe("Responses HTTP route", () => {
  it.each([null, [], {}, { model: 1 }, { model: "" }, { model: "a", input: 123 }, { model: "a", stream: "yes" }, { model: "a", reasoning: [] }])(
    "rejects invalid request bodies with an actionable 400: %j", async (body) => {
      const response = await post(body)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } })
      expect(createResponses).not.toHaveBeenCalled()
    },
  )

  it("rejects malformed JSON", async () => {
    const response = await app.request("/v1/responses", { method: "POST", body: "{" })
    expect(response.status).toBe(400)
  })

  it("resolves explicit effort aliases without dropping future request fields", async () => {
    vi.mocked(createResponses).mockResolvedValue({ id: "r", model: "gpt-5.5", output: [] })
    const response = await post({ model: "gpt-5.5-xhigh", input: "hi", reasoning: { effort: "low", summary: "auto" }, future_field: { value: true } })
    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5.5", reasoning: { effort: "xhigh", summary: "auto" }, future_field: { value: true },
    }), expect.any(Object))
  })

  it("preserves upstream error codes and Retry-After instead of double-encoding JSON", async () => {
    vi.mocked(createResponses).mockRejectedValue(new HTTPError("busy", 429,
      JSON.stringify({ error: { type: "rate_limit_error", code: "quota_exceeded", message: "busy" } }),
      new Headers({ "retry-after": "4" }),
    ))
    const response = await post({ model: "native", input: "hi" })
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("4")
    expect(await response.json()).toEqual({ error: { type: "rate_limit_error", code: "quota_exceeded", message: "busy" } })
  })

  it("forwards unnamed SSE events, usage and terminal completion", async () => {
    vi.mocked(createResponses).mockResolvedValue(stream(
      { type: "response.output_text.delta", delta: "hello" }, completion,
    ))
    const response = await post({ model: "native", input: "hi", stream: true })
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(response.headers.get("cache-control")).toContain("no-transform")
    const text = await response.text()
    expect(text).toContain("event: response.completed")
    expect(text).toContain('"delta":"hello"')
    expect(logEmitter.getRecent().find((log) => log.type === "request_end")?.data)
      .toMatchObject({ status: "success", inputTokens: 4, outputTokens: 2 })
  })

  it("preserves Astra's requested summary mode and forwards readable summary deltas", async () => {
    vi.mocked(createResponses).mockResolvedValue(stream(
      { type: "response.reasoning_summary_text.delta", delta: "Checking constraints." }, completion,
    ))
    const response = await post({
      model: "gpt-6-astra", input: "Test", stream: true, reasoning: { effort: "max", summary: "concise" },
    })
    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-6-astra", reasoning: { effort: "max", summary: "concise" },
    }), expect.any(Object))
    const text = await response.text()
    expect(text).toContain("event: response.reasoning_summary_text.delta")
    expect(text).toContain('"delta":"Checking constraints."')
    expect(text).toContain("event: response.completed")
  })

  it.each(["auto", "concise", "detailed", "none"])("preserves an explicit %s summary setting for every native Responses client", async summary => {
    for (const model of ["gpt-6-astra", "gpt-5.6-sol", "other-native"]) {
      vi.mocked(createResponses).mockResolvedValue({ id: "r", model, output: [] })
      const reasoning = { effort: "high", summary }
      const response = await post({ model, input: "Test", reasoning })
      expect(response.status).toBe(200)
      expect(createResponses).toHaveBeenLastCalledWith(expect.objectContaining({ model, reasoning }), expect.any(Object))
    }
  })

  it("does not inject reasoning parameters into direct Responses requests", async () => {
    for (const reasoning of [undefined, null, { effort: "max" }]) {
      vi.mocked(createResponses).mockResolvedValue({ id: "r", model: "gpt-6-astra", output: [] })
      const body = { model: "gpt-6-astra", input: "Test", ...(reasoning !== undefined && { reasoning }) }
      expect((await post(body)).status).toBe(200)
      expect(vi.mocked(createResponses).mock.lastCall?.[0]).toEqual(body)
    }
  })

  it("surfaces truncated streams as typed errors and never logs success", async () => {
    vi.mocked(createResponses).mockResolvedValue(stream({ type: "response.output_text.delta", delta: "partial" }))
    const text = await (await post({ model: "native", input: "hi", stream: true })).text()
    expect(text).toContain('"type":"error"')
    expect(text).toContain('"code":"upstream_stream_error"')
    expect(logEmitter.getRecent().find((log) => log.type === "request_end")?.data).toMatchObject({ status: "error" })
  })

  it("records nested response.failed errors instead of a successful 200", async () => {
    vi.mocked(createResponses).mockResolvedValue(stream({
      type: "response.failed", response: { id: "r", status: "failed", error: { message: "tool unavailable" } },
    }))
    const text = await (await post({ model: "native", input: "hi", stream: true })).text()
    expect(text).toContain("tool unavailable")
    expect(logEmitter.getRecent().find((log) => log.type === "request_end")?.data)
      .toMatchObject({ status: "error", error: "tool unavailable" })
  })

  it("aborts the upstream request when the client disconnects", async () => {
    let upstreamSignal: AbortSignal | undefined
    let closed = false
    vi.mocked(createResponses).mockImplementation(async (_payload, options) => {
      upstreamSignal = options?.signal
      async function* upstream() {
        try {
          yield event({ type: "response.created", response: { id: "r" } })
          if (!upstreamSignal?.aborted) {
            await new Promise<void>((resolve) => upstreamSignal?.addEventListener("abort", () => resolve(), { once: true }))
          }
          upstreamSignal?.throwIfAborted()
        } finally { closed = true }
      }
      return upstream()
    })
    const response = await post({ model: "native", input: "hi", stream: true })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    await vi.waitFor(() => {
      expect(upstreamSignal?.aborted).toBe(true)
      expect(closed).toBe(true)
    })
  })

  it("returns 426 for WebSocket fallback and explicitly rejects remote compaction", async () => {
    const upgrade = await app.request("/v1/responses", { headers: { upgrade: "websocket" } })
    expect(upgrade.status).toBe(426)
    expect((await app.request("/v1/responses/compact", { method: "POST" })).status).toBe(501)
    expect((await app.request("/v1/responses")).status).toBe(405)
  })
})
