import { isRecord } from "./validation"

export function isSuccessfulMcpCall(
  item: Record<string, unknown>,
  tool: string,
): item is Record<string, unknown> & { result: Record<string, unknown> } {
  return item.type === "mcp_tool_call" && item.tool === tool && item.status === "completed"
    && !item.error && isRecord(item.result) && item.result.isError !== true
}

export function hasMcpImage(item: Record<string, unknown>): boolean {
  return isRecord(item.result) && Array.isArray(item.result.content)
    && item.result.content.some((part: unknown) => isRecord(part) && part.type === "image")
}

export function codexRuntimeContextWindow(value: unknown): number | null {
  if (!isRecord(value) || value.type !== "event_msg" || !isRecord(value.payload)
    || value.payload.type !== "token_count" || !isRecord(value.payload.info)) return null
  const tokens = value.payload.info.model_context_window
  return typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null
}
