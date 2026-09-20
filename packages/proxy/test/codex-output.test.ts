import { describe, expect, it } from "vitest"
import { codexRuntimeContextWindow, hasMcpImage, isSuccessfulMcpCall } from "../src/lib/codex-output"

describe("Codex MCP smoke assertions", () => {
  it("distinguishes a completed RPC from a successful tool execution", () => {
    const call = { type: "mcp_tool_call", tool: "browser_take_screenshot", status: "completed", error: null }
    expect(isSuccessfulMcpCall({ ...call, result: { isError: true, content: [] } }, "browser_take_screenshot")).toBe(false)
    expect(isSuccessfulMcpCall({ ...call, result: { isError: false, content: [] } }, "browser_take_screenshot")).toBe(true)
    expect(isSuccessfulMcpCall({ ...call, status: "failed", result: {} }, "browser_take_screenshot")).toBe(false)
    expect(isSuccessfulMcpCall(call, "browser_take_screenshot")).toBe(false)
  })

  describe("Codex runtime context evidence", () => {
    it("reads the actual token-count event rather than a declared catalog size", () => {
      expect(codexRuntimeContextWindow({
        type: "event_msg", payload: { type: "token_count", info: { model_context_window: 872000 } },
      })).toBe(872000)
      expect(codexRuntimeContextWindow({ context_window: 872000 })).toBeNull()
      expect(codexRuntimeContextWindow({ type: "event_msg", payload: { type: "token_count", info: { model_context_window: "872000" } } })).toBeNull()
      expect(codexRuntimeContextWindow(null)).toBeNull()
    })
  })

  it("requires an image result, not a screenshot filename or a success claim", () => {
    expect(hasMcpImage({ result: { content: [{ type: "text", text: "Saved screenshot.png" }] } })).toBe(false)
    expect(hasMcpImage({ result: { content: [{ type: "image", data: "fixture" }] } })).toBe(true)
    expect(hasMcpImage({ result: null })).toBe(false)
  })
})
