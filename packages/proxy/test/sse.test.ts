import { describe, it, expect } from "vitest"
import { events, parseSSELine, parseSSEStream } from "../src/util/sse"

describe("parseSSELine", () => {
  it("parses data lines", () => {
    expect(parseSSELine('data: {"test":true}')).toEqual({ type: "data", value: '{"test":true}' })
  })

  it("parses data without space", () => {
    expect(parseSSELine('data:{"test":true}')).toEqual({ type: "data", value: '{"test":true}' })
  })

  it("detects DONE", () => {
    expect(parseSSELine("data: [DONE]")).toEqual({ type: "done", value: "[DONE]" })
  })

  it("ignores comments", () => {
    expect(parseSSELine(": keepalive")).toBeNull()
  })

  it("ignores empty lines", () => {
    expect(parseSSELine("")).toBeNull()
  })

  it("parses event lines", () => {
    expect(parseSSELine("event: message_start")).toEqual({ type: "event", value: "message_start" })
  })

  it("only recognizes an exact DONE marker", () => {
    expect(parseSSELine("data: [DONE]extra")).toEqual({ type: "data", value: "[DONE]extra" })
  })
})

function fragmentedResponse(text: string, fragmentSize = 1, cancel?: () => void): Response {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) return controller.close()
      controller.enqueue(bytes.slice(offset, offset + fragmentSize))
      offset = Math.min(offset + fragmentSize, bytes.length)
    },
    ...(cancel && { cancel }),
  }))
}

describe("SSE event streams", () => {
  it("handles CRLF split at every byte, UTF-8, comments and multiline data", async () => {
    const source = fragmentedResponse(": heartbeat\r\nevent: delta\r\ndata: {\"text\":\r\ndata: \"你好\"}\r\n\r\n")
    const parsed = await Array.fromAsync(events(source))
    expect(parsed).toEqual([{
      event: "delta", data: '{"text":\n"你好"}', id: null, retry: null,
    }])
  })

  it("handles CR-only and unterminated final events without empty events", async () => {
    const parsed = await Array.fromAsync(events(fragmentedResponse("event: ignored\r\rdata: first\r\rdata: last")))
    expect(parsed.map((event) => event.data)).toEqual(["first", "last"])
  })

  it("retains event IDs, ignores null IDs and rejects malformed retry values", async () => {
    const source = fragmentedResponse("id: one\nretry: 123\n\ndata: a\n\nid: bad\0id\nretry: 12x\ndata: b\n\n")
    expect(await Array.fromAsync(events(source))).toEqual([
      { data: "a", event: null, id: "one", retry: 123 },
      { data: "b", event: null, id: "one", retry: 123 },
    ])
  })

  it("cancels the upstream reader when a consumer stops early", async () => {
    let cancelled = false
    const stream = events(fragmentedResponse("data: first\n\ndata: second\n\n", 1, () => { cancelled = true }))
    expect((await stream.next()).value?.data).toBe("first")
    await stream.return(undefined)
    expect(cancelled).toBe(true)
  })

  it("uses the same robust framing for the low-level parser", async () => {
    const source = fragmentedResponse("data: first\r\n\r\ndata: [DONE]\r\n\r\ndata: ignored\r\n\r\n")
    expect(await Array.fromAsync(parseSSEStream(source.body!))).toEqual(["first", null])
  })

  it("does not hide a missing body", async () => {
    await expect(Array.fromAsync(events(new Response(null)))).rejects.toThrow("no body")
  })
})
