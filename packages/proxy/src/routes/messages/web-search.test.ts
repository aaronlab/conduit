import { describe, expect, it } from "vitest"

import {
  buildNativeWebSearchResponse,
  buildNativeWebSearchPayload,
  extractWebSearchQuery,
  supportsNativeWebSearch,
  webSearchResponseToSSE,
} from "./web-search"

describe("native web search bridge", () => {
  it("enables only verified native-search models", () => {
    expect(supportsNativeWebSearch("gpt-5.6-sol")).toBe(true)
    expect(supportsNativeWebSearch("claude-opus-5")).toBe(false)
  })

  it("extracts the Claude Code dedicated search query", () => {
    expect(extractWebSearchQuery({
      messages: [{
        role: "user",
        content: [{ type: "text", text: "Perform a web search for the query: Bun runtime" }],
      }],
    })).toBe("Bun runtime")
  })

  it("converts Sol search calls, citations, text, and usage", () => {
    const response = buildNativeWebSearchResponse({
      id: "resp-1",
      model: "gpt-5.6-sol",
      output: [
        {
          type: "web_search_call",
          action: { type: "search" },
        },
        {
          type: "web_search_call",
          action: { query: "official Bun runtime" },
        },
        {
          type: "message",
          content: [{
            type: "output_text",
            text: "Bun is a JavaScript runtime.",
            annotations: [
              { type: "url_citation", title: "Bun", url: "https://bun.sh/" },
              { type: "url_citation", title: "Bun duplicate", url: "https://bun.sh/" },
            ],
          }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    }, {
      requestId: "request-1",
      requestedModel: "gpt-5.6-sol",
      requestedQuery: "Bun runtime",
      serverToolUseId: "srvtoolu_1",
    })

    expect(response.content[0]).toEqual({
      type: "server_tool_use",
      id: "srvtoolu_1",
      name: "web_search",
      input: { query: "official Bun runtime" },
    })
    expect(response.content[1]).toMatchObject({
      type: "web_search_tool_result",
      content: [{ title: "Bun duplicate", url: "https://bun.sh/" }],
    })
    expect(response.content[2]).toEqual({ type: "text", text: "Bun is a JavaScript runtime." })
    expect(response.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      server_tool_use: { web_search_requests: 2 },
    })
  })

  it("emits valid incremental server-tool and text blocks", () => {
    const response = buildNativeWebSearchResponse({
      output: [{ type: "web_search_call", action: { query: "question" } }, {
        type: "message",
        content: [{ type: "output_text", text: "Answer" }],
      }],
    }, {
      requestId: "request-2",
      requestedModel: "gpt-5.6-sol",
      requestedQuery: "question",
      serverToolUseId: "srvtoolu_2",
    })
    const events = webSearchResponseToSSE(response)

    expect(events.map((entry) => entry.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(events[2]?.data).toMatchObject({
      delta: { type: "input_json_delta", partial_json: '{"query":"question"}' },
    })
    expect(events[7]?.data).toMatchObject({
      delta: { type: "text_delta", text: "Answer" },
    })
  })

  it("uses the latest user query and forwards allowed domains, location and search limits", () => {
    expect(extractWebSearchQuery({ messages: [
      { role: "user", content: "old query" },
      { role: "user", content: "Perform a web search for the query: current query" },
    ] })).toBe("current query")
    expect(buildNativeWebSearchPayload("gpt-5.6-sol", "query", {
      allowed_domains: ["github.com"], max_uses: 2,
      user_location: { type: "approximate", country: "US" },
    })).toMatchObject({
      max_tool_calls: 2,
      tools: [{ type: "web_search", filters: { allowed_domains: ["github.com"] }, user_location: { country: "US" } }],
    })
  })

  it("never reports a successful search when no search ran or the upstream failed", () => {
    const options = { requestId: "r", requestedModel: "gpt-5.6-sol", requestedQuery: "query", serverToolUseId: "s" }
    expect(() => buildNativeWebSearchResponse({ output: [] }, options)).toThrow("did not perform")
    expect(() => buildNativeWebSearchResponse({ status: "failed", error: { message: "unavailable" } }, options)).toThrow("unavailable")
    expect(() => buildNativeWebSearchPayload("gpt-5.6-sol", "", {})).toThrow("non-empty")
    expect(() => buildNativeWebSearchPayload("gpt-5.6-sol", "query", { blocked_domains: ["example.com"] })).toThrow("cannot enforce")
  })
})