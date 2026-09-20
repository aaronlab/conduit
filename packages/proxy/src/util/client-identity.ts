/**
 * Derive client identity from request metadata.
 * Identifies Claude Code, Cursor, Windsurf, Continue, etc.
 */
export function deriveClientIdentity(
  userId: string | null,
  userAgent: string | null,
  _accountName: string,
  openaiUser: string | null,
): { sessionId: string; clientName: string; clientVersion: string | null } {
  let clientName = "unknown"
  let clientVersion: string | null = null

  if (userAgent) {
    const codex = userAgent.match(/\bcodex(?:[-_]cli(?:_rs)?)?\/([^\s]+)/i)
    if (codex) {
      clientName = "codex"
      clientVersion = codex[1] ?? null
    } else if (userAgent.includes("claude-cli") || userAgent.includes("claude-code")) {
      const match = userAgent.match(/claude-cli\/(\S+)/)
      clientName = "claude-code"
      clientVersion = match?.[1] ?? null
    } else if (userAgent.includes("cursor")) {
      clientName = "cursor"
    } else if (userAgent.includes("windsurf")) {
      clientName = "windsurf"
    } else if (userAgent.includes("continue")) {
      clientName = "continue"
    } else if (userAgent.includes("Anthropic")) {
      clientName = "anthropic-sdk"
    } else if (userAgent.includes("curl")) {
      clientName = "curl"
    }
  }

  const sessionId = openaiUser ?? userId ?? ""

  return { sessionId, clientName, clientVersion }
}
