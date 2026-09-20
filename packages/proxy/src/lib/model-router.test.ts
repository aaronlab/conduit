import { describe, expect, it } from "vitest"

import {
  CLAUDE_FALLBACK_MODEL,
  resolveModelName,
} from "./model-router"

describe("resolveModelName", () => {
  it("keeps an available Claude model", () => {
    expect(resolveModelName("claude-sonnet-5", ["claude-sonnet-5", CLAUDE_FALLBACK_MODEL]))
      .toBe("claude-sonnet-5")
  })

  it("falls back retired Sonnet agents to Sol", () => {
    expect(resolveModelName("claude-sonnet-5", [CLAUDE_FALLBACK_MODEL]))
      .toBe(CLAUDE_FALLBACK_MODEL)
  })

  it("normalizes and falls back dated Haiku agents to Sol", () => {
    expect(resolveModelName("claude-haiku-4-5-20251001", [CLAUDE_FALLBACK_MODEL]))
      .toBe(CLAUDE_FALLBACK_MODEL)
  })

  it("does not invent a fallback before models are cached", () => {
    expect(resolveModelName("claude-sonnet-5", null)).toBe("claude-sonnet-5")
  })

  it("does not redirect non-Claude models", () => {
    expect(resolveModelName("gpt-5.6-sol[1m]", [CLAUDE_FALLBACK_MODEL]))
      .toBe("gpt-5.6-sol[1m]")
  })
})