import { logger } from "./logger"

export interface SSEEvent {
  type: "data" | "event" | "done"
  value: string
}

export interface ServerSentEvent {
  data: string
  event: string | null
  id: string | null
  retry: number | null
}

export function parseSSELine(line: string): SSEEvent | null {
  const field = parseField(line.replace(/\r$/, ""))
  if (!field) return null
  if (field.field === "data") {
    return { type: field.value === "[DONE]" ? "done" : "data", value: field.value }
  }
  if (field.field === "event") return { type: "event", value: field.value }
  return null
}

export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string | null> {
  for await (const event of events(new Response(stream))) {
    if (event.data === "[DONE]") {
      yield null
      return
    }
    yield event.data
  }
}

function parseField(line: string): { field: string; value: string } | null {
  if (!line || line.startsWith(":")) return null
  const colon = line.indexOf(":")
  if (colon === -1) return { field: line, value: "" }
  let value = line.slice(colon + 1)
  if (value.startsWith(" ")) value = value.slice(1)
  return { field: line.slice(0, colon), value }
}

export async function* events(response: Response): AsyncGenerator<ServerSentEvent> {
  if (!response.body) throw new Error("Upstream SSE response has no body.")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let data: string[] = []
  let eventType: string | null = null
  let id: string | null = null
  let retry: number | null = null
  let finished = false

  function dispatch(): ServerSentEvent | null {
    const event = data.length ? { data: data.join("\n"), event: eventType, id, retry } : null
    data = []
    eventType = null
    return event
  }

  function processLine(line: string): ServerSentEvent | null {
    if (line === "") return dispatch()
    const parsed = parseField(line)
    if (!parsed) return null
    const { field, value } = parsed
    if (field === "data") data.push(value)
    else if (field === "event") eventType = value || null
    else if (field === "id" && !value.includes("\0")) id = value
    else if (field === "retry" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) {
      retry = Number(value)
    }
    return null
  }

  function* drain(flush: boolean): Generator<ServerSentEvent> {
    let start = 0
    for (let index = 0; index < buffer.length; index++) {
      const char = buffer[index]
      if (char !== "\r" && char !== "\n") continue
      // A CR at a chunk boundary may be the first half of CRLF.
      if (char === "\r" && index === buffer.length - 1 && !flush) break
      const event = processLine(buffer.slice(start, index))
      if (event) yield event
      if (char === "\r" && buffer[index + 1] === "\n") index++
      start = index + 1
    }
    buffer = buffer.slice(start)
    if (flush && buffer) {
      const event = processLine(buffer)
      if (event) yield event
      buffer = ""
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      yield* drain(done)
      if (done) {
        finished = true
        const event = dispatch()
        if (event) yield event
        return
      }
    }
  } finally {
    if (!finished) {
      try {
        await reader.cancel()
      } catch (error) {
        logger.debug("SSE reader cleanup after an interrupted stream", { error: String(error) })
      }
    }
    reader.releaseLock()
  }
}
