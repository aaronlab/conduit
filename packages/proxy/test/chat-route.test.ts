import { Hono } from "hono"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/services/copilot/create-chat-completions", () => ({ createCompatibleChatCompletions: vi.fn() }))

import { createCompatibleChatCompletions } from "../src/services/copilot/create-chat-completions"
import { completionRoutes } from "../src/routes/chat-completions/route"
import { logEmitter } from "../src/util/log-emitter"
import { state } from "../src/lib/state"

const app = new Hono().route("/v1/chat/completions", completionRoutes)
function post(body: unknown) {
  return app.request("/v1/chat/completions", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })
}
async function* source(...items: Array<Record<string, unknown> | string>) {
  for (const item of items) yield { data: typeof item === "string" ? item : JSON.stringify(item) }
}

beforeEach(() => {
  state.rateLimitSeconds = null
  state.models = null
  vi.mocked(createCompatibleChatCompletions).mockReset()
  logEmitter.clearBuffer()
})

describe("shared Chat compatibility route", () => {
  it("uses the shared compatibility service and forwards exactly one DONE marker", async () => {
    vi.mocked(createCompatibleChatCompletions).mockResolvedValue(source(
      { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ))
    const response = await post({ model: "native", messages: [], stream: true })
    const text = await response.text()
    expect(text.match(/\[DONE\]/g)).toHaveLength(1)
    expect(createCompatibleChatCompletions).toHaveBeenCalledWith(expect.objectContaining({ model: "native" }), expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it("surfaces failures instead of logging a success or emitting DONE", async () => {
    vi.mocked(createCompatibleChatCompletions).mockResolvedValue(source({ error: { message: "upstream failure" } }))
    const text = await (await post({ model: "native", messages: [], stream: true })).text()
    expect(text).toContain("upstream failure")
    expect(text).not.toContain("[DONE]")
    expect(logEmitter.getRecent().find((event) => event.type === "request_end")?.data).toMatchObject({ status: "error" })
  })

  it("rejects premature EOF and invalid request shapes", async () => {
    vi.mocked(createCompatibleChatCompletions).mockResolvedValue(source({ choices: [{ index: 0, delta: { content: "partial" } }] }))
    const text = await (await post({ model: "native", messages: [], stream: true })).text()
    expect(text).toContain("ended before completion")
    expect((await post(null)).status).toBe(400)
    expect((await post({ model: 42, messages: [] })).status).toBe(400)
    expect((await post({ model: "native", messages: [null] })).status).toBe(400)
  })
})
