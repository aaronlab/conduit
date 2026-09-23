import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/lib/token", () => ({
  ensureFreshCopilotToken: vi.fn(async () => undefined),
  forceCopilotTokenRefresh: vi.fn(async () => undefined),
}))

import { state } from "../src/lib/state"
import {
  clampEffort,
  passthroughToCountTokens,
  passthroughToMessages,
  resetPassthroughCompatibility,
} from "../src/routes/messages/passthrough"
import { claudeModel } from "./codex-fixtures"

interface Forwarded { url: string; headers: Record<string, string>; body: Record<string, unknown> }

function captureUpstream(...responses: Array<() => Response>) {
  const forwarded: Forwarded[] = []
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    forwarded.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    })
    const next = responses[Math.min(forwarded.length - 1, responses.length - 1)]
    return next ? next() : Response.json({ id: "msg_test", content: [] })
  }))
  return forwarded
}

const ok = () => Response.json({ id: "msg_test", content: [] })
const rejected = (message: string) => () => Response.json(
  { type: "error", error: { type: "invalid_request_error", message } },
  { status: 400 },
)
const request = (body: Record<string, unknown>) => JSON.stringify({
  max_tokens: 64,
  messages: [{ role: "user", content: "hello" }],
  ...body,
})

describe("passthroughToMessages", () => {
  beforeEach(() => {
    state.copilotToken = "test-token"
    state.copilotTokenExpiresAt = Math.floor(Date.now() / 1000) + 3600
    state.accountType = "individual"
    state.vsCodeVersion = "1.114.0"
    state.copilotChatVersion = "0.43.0"
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    state.models = null
    resetPassthroughCompatibility()
  })

  it("strips thinking and effort for haiku 4.5 before forwarding", async () => {
    let forwardedBody: Record<string, unknown> | null = null
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        forwardedBody = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({ id: "msg_test", content: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }),
    )

    await passthroughToMessages(
      JSON.stringify({
        model: "claude-haiku-4.5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
      }),
      "claude-haiku-4.5",
      false,
    )

    expect(forwardedBody).toMatchObject({
      model: "claude-haiku-4.5",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
    })
    expect(forwardedBody).not.toHaveProperty("thinking")
    expect(forwardedBody).not.toHaveProperty("output_config")
  })

  it("forwards max effort to Claude models whose Copilot metadata publishes it", async () => {
    state.models = { object: "list", data: [claudeModel()] }
    const forwarded = captureUpstream(ok)
    await passthroughToMessages(request({
      model: "claude-opus-5-5[1m]", thinking: { type: "adaptive", display: "omitted" }, output_config: { effort: "max" },
    }), "claude-opus-5-5[1m]", true)
    expect(forwarded[0]!.body).toMatchObject({
      model: "claude-opus-5.5", thinking: { type: "adaptive", display: "omitted" }, output_config: { effort: "max" },
    })
  })

  it("clamps effort to the published list and keeps the legacy mapping without metadata", async () => {
    expect(clampEffort("max", ["low", "medium", "high"])).toBe("high")
    expect(clampEffort("xhigh", ["low", "medium", "high", "max"])).toBe("high")
    expect(clampEffort("low", ["medium", "high"])).toBe("medium")
    expect(clampEffort("custom", ["low"])).toBeUndefined()

    state.models = { object: "list", data: [claudeModel("claude-sonnet-5.1", {
      capabilities: { ...claudeModel().capabilities, supports: { ...claudeModel().capabilities.supports, reasoning_effort: ["low", "medium", "high"] } },
    })] }
    const forwarded = captureUpstream(ok)
    await passthroughToMessages(request({ model: "claude-sonnet-5-1", output_config: { effort: "max" } }), "claude-sonnet-5-1", false)
    state.models = null
    await passthroughToMessages(request({ model: "claude-sonnet-4-6", output_config: { effort: "max" } }), "claude-sonnet-4-6", false)
    expect(forwarded.map((entry) => (entry.body.output_config as Record<string, unknown>).effort)).toEqual(["high", "high"])
  })

  it("lifts Claude Code's per-turn output_config to the request level", async () => {
    state.models = { object: "list", data: [claudeModel()] }
    const forwarded = captureUpstream(ok)
    await passthroughToMessages(request({
      model: "claude-opus-5-5",
      output_config: { effort: "medium", format: { type: "json_schema", schema: { type: "object" } } },
      messages: [
        { role: "user", content: "hello" },
        { role: "system", content: "turn 1", output_config: { effort: "high" } },
        { role: "assistant", content: "hi" },
        { role: "system", content: "turn 2", output_config: { effort: "max" } },
        { role: "user", content: "again" },
      ],
    }), "claude-opus-5-5", true)
    const body = forwarded[0]!.body
    expect((body.messages as Array<Record<string, unknown>>).some((message) => "output_config" in message)).toBe(false)
    expect(body.output_config).toEqual({ effort: "max", format: { type: "json_schema", schema: { type: "object" } } })
  })

  it("forwards context_management only with its beta header", async () => {
    const forwarded = captureUpstream(ok)
    const contextManagement = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] }
    await passthroughToMessages(
      request({ model: "claude-opus-5-5", context_management: contextManagement }),
      "claude-opus-5-5", true, "claude-code-20250219,context-management-2025-06-27,effort-2025-11-24",
    )
    await passthroughToMessages(
      request({ model: "claude-opus-5-5", context_management: contextManagement }),
      "claude-opus-5-5", true, "claude-code-20250219",
    )
    expect(forwarded[0]!.body.context_management).toEqual(contextManagement)
    expect(forwarded[0]!.headers["anthropic-beta"]).toBe("context-management-2025-06-27")
    expect(forwarded[1]!.body).not.toHaveProperty("context_management")
    expect(forwarded[1]!.headers).not.toHaveProperty("anthropic-beta")
  })

  it("retries once without context_management when the upstream rejects it", async () => {
    const forwarded = captureUpstream(rejected("context_management: Extra inputs are not permitted"), ok)
    const response = await passthroughToMessages(
      request({ model: "claude-opus-5-5", context_management: { edits: [] } }),
      "claude-opus-5-5", false, "context-management-2025-06-27",
    )
    expect(response.status).toBe(200)
    expect(forwarded).toHaveLength(2)
    expect(forwarded[1]!.body).not.toHaveProperty("context_management")
    expect(forwarded[1]!.headers).not.toHaveProperty("anthropic-beta")
  })

  it("replaces disabled thinking, which Opus 5.5 rejects, with its lowest effort", async () => {
    state.models = { object: "list", data: [claudeModel()] }
    const forwarded = captureUpstream(ok)
    await passthroughToMessages(request({
      model: "claude-opus-5.5", thinking: { type: "disabled" }, output_config: { effort: "high", format: { type: "json_schema" } },
    }), "claude-opus-5.5", true)
    expect(forwarded[0]!.body).not.toHaveProperty("thinking")
    expect(forwarded[0]!.body.output_config).toEqual({ effort: "low", format: { type: "json_schema" } })
  })

  it("learns a disabled-thinking rejection for other models and retries once", async () => {
    const forwarded = captureUpstream(
      rejected('"thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.'),
      ok,
    )
    await passthroughToMessages(request({ model: "claude-opus-6", thinking: { type: "disabled" } }), "claude-opus-6", false)
    await passthroughToMessages(request({ model: "claude-opus-6", thinking: { type: "disabled" } }), "claude-opus-6", false)
    expect(forwarded.map((entry) => entry.body.thinking ?? null)).toEqual([{ type: "disabled" }, null, null])
    expect(forwarded[1]!.body.output_config).toEqual({ effort: "low" })
  })

  it("does not learn from an ordinary context_management validation error", async () => {
    const contextManagement = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] }
    const forwarded = captureUpstream(
      rejected("context_management.edits.0.type: Input should be 'clear_tool_uses_20250919'"),
      ok,
    )
    await expect(passthroughToMessages(
      request({ model: "claude-opus-5-5", context_management: { edits: [{ type: "bogus" }] } }),
      "claude-opus-5-5", false, "context-management-2025-06-27",
    )).rejects.toMatchObject({ status: 400 })
    await passthroughToMessages(
      request({ model: "claude-opus-5-5", context_management: contextManagement }),
      "claude-opus-5-5", false, "context-management-2025-06-27",
    )
    expect(forwarded).toHaveLength(2)
    expect(forwarded[1]!.body.context_management).toEqual(contextManagement)
  })

  it("does not retry unrelated upstream errors", async () => {
    const forwarded = captureUpstream(rejected("messages: roles must alternate"))
    await expect(passthroughToMessages(request({ model: "claude-opus-5-5", thinking: { type: "disabled" } }), "claude-opus-6", false))
      .rejects.toMatchObject({ status: 400 })
    expect(forwarded).toHaveLength(1)
  })

  it("counts tokens natively without the server tools Copilot rejects", async () => {
    const forwarded = captureUpstream(() => Response.json({ input_tokens: 42 }))
    const response = await passthroughToCountTokens(request({
      model: "claude-opus-5-5[1m]",
      tools: [{ name: "Read", input_schema: { type: "object" } }, { type: "web_search_20250305", name: "web_search" }],
      thinking: { type: "enabled", budget_tokens: 1024 },
    }), "claude-opus-5-5[1m]")
    expect(await response.json()).toEqual({ input_tokens: 42 })
    expect(forwarded[0]!.url).toBe("https://api.githubcopilot.com/v1/messages/count_tokens")
    expect(forwarded[0]!.body).toMatchObject({
      model: "claude-opus-5.5",
      tools: [{ name: "Read", input_schema: { type: "object" } }],
      thinking: { type: "enabled", budget_tokens: 1024 },
    })
  })
})

