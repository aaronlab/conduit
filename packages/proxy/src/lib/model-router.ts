/**
 * Model Router — determines whether a request should be passed through
 * directly (for Claude models) or translated (for non-Claude models).
 */

export type RouteStrategy = "passthrough" | "translate"

export const CLAUDE_FALLBACK_MODEL = "gpt-5.6-sol"

/**
 * Determine routing strategy based on model name.
 * Claude models -> passthrough (Copilot natively supports Anthropic Messages API)
 * Non-Claude models -> translate (Anthropic -> OpenAI format conversion)
 */
export function getRouteStrategy(model: string): RouteStrategy {
  // Claude models: passthrough directly to Copilot's native Messages API support
  if (model.startsWith("claude-")) {
    return "passthrough"
  }
  // All other models need Anthropic -> OpenAI translation
  return "translate"
}

/**
 * Resolve Claude aliases, then fall back when Copilot has removed that Claude
 * model from the current model list. Claude Code can hard-code Sonnet/Haiku for
 * internal agents even when the main model is a non-Claude model.
 */
export function resolveModelName(
  model: string,
  availableModelIds: readonly string[] | null,
  anthropicBeta?: string | null,
): string {
  const translated = translateModelName(model, anthropicBeta)
  if (!translated.startsWith("claude-") || availableModelIds === null) {
    return translated
  }

  const isAvailable = availableModelIds.includes(translated)
  const fallbackIsAvailable = availableModelIds.includes(CLAUDE_FALLBACK_MODEL)
  return !isAvailable && fallbackIsAvailable ? CLAUDE_FALLBACK_MODEL : translated
}

/**
 * Translate Anthropic SDK model names to Copilot model IDs.
 * Only modifies the model name string, nothing else.
 *
 * Examples:
 *   claude-opus-4-6          → claude-opus-4.6-1m
 *   claude-opus-4-6-20250820 → claude-opus-4.6-1m
 *   claude-sonnet-4-6        → claude-sonnet-4.6
 *   claude-haiku-4-5         → claude-haiku-4.5
 */
export function translateModelName(model: string, anthropicBeta?: string | null): string {
  // Parse beta flags from anthropic-beta header
  const betas = anthropicBeta?.split(",").map((b) => b.trim()) ?? []
  const wants1m = betas.some((b) => b.startsWith("context-1m-"))
  const wantsFast = betas.some((b) => b.startsWith("fast-mode-"))

  const match = model.match(
    /^(claude-(?:opus|sonnet|haiku))-(\d+)-(\d{1,2})(?:(?:-|\[)(1m|fast|high|xhigh)\]?)?(?:-\d{8})?$/
  )
  if (match) {
    const [, family, major, minor, suffix] = match
    const base = `${family}-${major}.${minor}`
    const effectiveSuffix = suffix ?? (wants1m ? "1m" : wantsFast ? "fast" : null)

    // Copilot upstream's /v1/messages path allows ~1M prompt regardless of the
    // `-1m` model id suffix — the suffix only exists for claude-opus-4.6 and
    // does not exist for other Claude models (opus-4.7-1m → 400 not_supported).
    // So strip the suffix for any model that doesn't publish a -1m variant,
    // but keep the 1M intent because the upstream honors it anyway.
    if (effectiveSuffix === "1m" && base !== "claude-opus-4.6") {
      return base
    }

    if (effectiveSuffix) return `${base}-${effectiveSuffix}`
    return base
  }

  const matchNoMinor = model.match(
    /^(claude-(?:opus|sonnet|haiku))-(\d+)(?:-\d{8})?$/
  )
  if (matchNoMinor) {
    const [, family, major] = matchNoMinor
    return `${family}-${major}`
  }

  return model
}
