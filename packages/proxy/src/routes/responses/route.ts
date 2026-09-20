import { Hono } from "hono"
import { handleResponses } from "./handler"

export const responsesRoutes = new Hono()

responsesRoutes.post("/", handleResponses)

responsesRoutes.get("/", (c) => {
  const websocket = c.req.header("upgrade")?.toLowerCase() === "websocket"
  return c.json({
    error: {
      type: "invalid_request_error",
      code: websocket ? "websocket_not_supported" : "method_not_allowed",
      message: websocket
        ? "Use HTTP/SSE Responses with supports_websockets = false. WebSocket transport is not enabled."
        : "Use POST to create a response.",
    },
  }, websocket ? 426 : 405)
})

responsesRoutes.post("/compact", (c) => c.json({
  error: {
    type: "invalid_request_error",
    code: "unsupported_feature",
    message: "Copilot does not expose OpenAI's remote compaction contract. Use the Conduit provider configuration so Codex compacts locally.",
  },
}, 501))
