export interface CopilotRequestOptions {
  signal?: AbortSignal
  headers?: Headers
  onResponse?: (headers: Headers) => void
}

export function copilotSessionHeaders(headers?: Headers): Record<string, string> {
  const forwarded: Record<string, string> = {}
  for (const name of [
    "session-id",
    "thread-id",
    "x-client-request-id",
    "x-openai-subagent",
    "x-codex-turn-state",
    "x-codex-turn-metadata",
    "openai-beta",
  ]) {
    const value = headers?.get(name)
    if (value) forwarded[name] = value
  }
  return forwarded
}
