/**
 * Passthrough handler for Claude models.
 * Forwards Anthropic Messages API requests directly to Copilot's
 * native /v1/messages endpoint. Patches model name and strips
 * fields that Copilot doesn't accept.
 *
 * Preserves all key Anthropic parameters:
 * - thinking (adaptive/enabled)
 * - output_config.effort (validated against Copilot's published efforts)
 * - context_management, together with its anthropic-beta
 * - cache_control
 * - top_k, service_tier
 */

import { copilotHeaders, copilotBaseUrl } from "../../lib/api-config"
import { HTTPError } from "../../lib/error"
import { state } from "../../lib/state"
import { translateModelName } from "../../lib/model-router"
import { ensureFreshCopilotToken, forceCopilotTokenRefresh } from "../../lib/token"
import { isRecord } from "../../lib/validation"
import { logger } from "../../util/logger"

/**
 * Fields that Copilot's /v1/messages endpoint rejects as "Extra inputs".
 * These are Anthropic API features not (yet) supported by Copilot.
 */
const FIELDS_TO_STRIP = new Set([
  "cache_control",   // top-level cache_control (per-block cache_control IS supported)
  "container",
  "inference_geo",
])

/** count_tokens has no server-tool support on Copilot either. */
const COUNT_TOKENS_REJECTED_TOOL_PREFIXES = ["web_search_"]

/**
 * Only betas that unlock a body field Conduit forwards are sent upstream.
 * `context_management` is accepted by Copilot only with its beta header.
 */
const FORWARDED_BETA_PREFIXES = ["context-management-"]

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const

// Models whose upstream rejects `thinking.type: "disabled"` (verified for
// claude-opus-5.5); further models are learned from the upstream's 400.
const REJECTS_DISABLED_THINKING = new Set(["claude-opus-5.5"])
// Learned per endpoint and model, only from the exact "unsupported" errors
// (matched in the raw JSON body, where quotes are escaped), so an ordinary
// validation error never disables a feature.
const DISABLED_THINKING_REJECTION = /thinking\.type\.disabled\\?"? is not supported/
const CONTEXT_MANAGEMENT_REJECTION = /(^|[^.\w])context_management: Extra inputs are not permitted/
const learnedRejectsDisabledThinking = new Set<string>()
const learnedRejectsContextManagement = new Set<string>()
type ClaudeEndpoint = "messages" | "count_tokens"
const compatibilityKey = (endpoint: ClaudeEndpoint, model: string) => `${endpoint}:${model}`

/** Test hook: forget compatibility downgrades learned from upstream errors. */
export function resetPassthroughCompatibility(): void {
  learnedRejectsDisabledThinking.clear()
  learnedRejectsContextManagement.clear()
}

/** Effort values Copilot publishes for a model, or null when unknown. */
export function publishedEfforts(model: string): string[] | null {
  const efforts = state.models?.data.find((candidate) => candidate.id === model)
    ?.capabilities?.supports?.reasoning_effort
  return Array.isArray(efforts) && efforts.length > 0 ? efforts : null
}

/**
 * Nearest published effort that does not exceed the request; if none is
 * lower, the lowest published effort above it. Unknown values are left alone.
 */
export function clampEffort(requested: string, published: readonly string[]): string | undefined {
  if (published.includes(requested)) return requested
  const rank = EFFORT_LEVELS.indexOf(requested as (typeof EFFORT_LEVELS)[number])
  if (rank < 0) return undefined
  for (let index = rank - 1; index >= 0; index--) {
    if (published.includes(EFFORT_LEVELS[index]!)) return EFFORT_LEVELS[index]
  }
  return EFFORT_LEVELS.slice(rank + 1).find((level) => published.includes(level))
}

function lowestEffort(model: string): string {
  const published = publishedEfforts(model)
  return (published && EFFORT_LEVELS.find((level) => published.includes(level))) ?? "low"
}

function parseBetas(anthropicBeta?: string | null): string[] {
  return anthropicBeta?.split(",").map((beta) => beta.trim()).filter(Boolean) ?? []
}

export interface PreparedClaudeRequest {
  body: Record<string, unknown>
  model: string
  betas: string[]
  endpoint: ClaudeEndpoint
}

/**
 * Normalize an Anthropic Messages (or count_tokens) body for Copilot's Claude
 * endpoint. Pure apart from reading the cached model metadata.
 */
export function prepareClaudeRequest(
  rawBody: string,
  model: string,
  anthropicBeta?: string | null,
  endpoint: ClaudeEndpoint = "messages",
): PreparedClaudeRequest {
  const translatedModel = translateModelName(model, anthropicBeta)
  const key = compatibilityKey(endpoint, translatedModel)

  // Parse, patch model name, strip unsupported fields
  const parsed = JSON.parse(rawBody) as Record<string, unknown>
  parsed.model = translatedModel

  for (const field of FIELDS_TO_STRIP) {
    if (field in parsed) {
      logger.debug(`Passthrough: stripping unsupported field "${field}"`)
      delete parsed[field]
    }
  }

  // Claude Code's per-turn control puts output_config on individual messages
  // (a mid-conversation system message). Copilot rejects that shape
  // ("messages.N.output_config: Extra inputs are not permitted"), so the most
  // recent per-turn effort — the one in force for this turn — is lifted to
  // the request-level output_config.
  if (Array.isArray(parsed.messages)) {
    let turnEffort: unknown
    parsed.messages = parsed.messages.map((message: unknown) => {
      if (!isRecord(message) || !("output_config" in message)) return message
      const { output_config: turnConfig, ...rest } = message
      if (isRecord(turnConfig) && turnConfig.effort !== undefined) turnEffort = turnConfig.effort
      return rest
    })
    if (turnEffort !== undefined) {
      const outputConfig = isRecord(parsed.output_config) ? parsed.output_config : {}
      outputConfig.effort = turnEffort
      parsed.output_config = outputConfig
      logger.debug(`Passthrough: lifted per-turn effort "${String(turnEffort)}" to output_config`)
    }
  }

  // context_management is accepted upstream only together with its beta.
  const contextBetas = parseBetas(anthropicBeta)
    .filter((beta) => FORWARDED_BETA_PREFIXES.some((prefix) => beta.startsWith(prefix)))
  if ("context_management" in parsed
    && (contextBetas.length === 0 || learnedRejectsContextManagement.has(key))) {
    logger.debug('Passthrough: stripping unsupported field "context_management"')
    delete parsed.context_management
  }
  const betas = "context_management" in parsed ? contextBetas : []

  if (endpoint === "count_tokens" && Array.isArray(parsed.tools)) {
    parsed.tools = parsed.tools.filter((tool: unknown) => !(isRecord(tool) && typeof tool.type === "string"
      && COUNT_TOKENS_REJECTED_TOOL_PREFIXES.some((prefix) => (tool.type as string).startsWith(prefix))))
  }

  const outputConfig = isRecord(parsed.output_config) ? parsed.output_config : undefined
  if (outputConfig?.effort === "none") {
    delete outputConfig.effort
    logger.debug('Passthrough: stripped effort "none" (not supported by Copilot)')
    // If output_config is now empty, remove it
    if (Object.keys(outputConfig).length === 0) {
      delete parsed.output_config
    }
  }

  // Newer Claude models reject `thinking.type: "disabled"` and require
  // adaptive thinking. The closest equivalent keeps the default (adaptive)
  // thinking at the model's lowest effort.
  if (isRecord(parsed.thinking) && parsed.thinking.type === "disabled"
    && (REJECTS_DISABLED_THINKING.has(translatedModel) || learnedRejectsDisabledThinking.has(key))) {
    delete parsed.thinking
    const oc = isRecord(parsed.output_config) ? parsed.output_config : {}
    oc.effort = lowestEffort(translatedModel)
    parsed.output_config = oc
    logger.debug(`Passthrough: mapped thinking.disabled → default thinking at effort "${String(oc.effort)}" for ${translatedModel}`)
  }

  // Copilot's Claude endpoint rejects `thinking.type: "enabled"` for newer
  // models (e.g. claude-opus-4.7) — it requires `adaptive` plus
  // output_config.effort to control thinking depth. Translate on the fly.
  const thinking = isRecord(parsed.thinking) ? parsed.thinking : undefined
  if (thinking && thinking.type === "enabled" && endpoint === "messages") {
    const budget = thinking.budget_tokens
    thinking.type = "adaptive"
    delete thinking.budget_tokens
    // Carry budget → effort if the caller didn't pick one explicitly.
    const oc = (parsed.output_config as Record<string, unknown> | undefined) ?? {}
    if (!oc.effort) {
      let effort: "low" | "medium" | "high" = "medium"
      if (typeof budget === "number") {
        if (budget <= 4000) effort = "low"
        else if (budget >= 16000) effort = "high"
      }
      oc.effort = effort
      parsed.output_config = oc
    }
    logger.debug(
      `Passthrough: mapped thinking.enabled → adaptive (budget=${String(budget)}, effort=${String((parsed.output_config as Record<string, unknown>).effort)})`,
    )
  }

  // Copilot effort mapping. When Copilot publishes the model's effort list
  // (e.g. claude-opus-5.5: low, medium, high, xhigh, max), the request is
  // clamped to it, so `max` reaches models that support it. Otherwise the
  // legacy mapping applies:
  //   - Supported on most models: low, medium, high
  //   - Newer model variants like claude-opus-4.7-xhigh REQUIRE effort=xhigh
  //   - Generic xhigh on a non-xhigh model → high; max → high
  //   - output_config.format (structured outputs) IS supported — don't strip it
  const effortConfig = isRecord(parsed.output_config) ? parsed.output_config : undefined
  if (typeof effortConfig?.effort === "string") {
    const effort = effortConfig.effort
    const published = publishedEfforts(translatedModel)
    if (published) {
      const clamped = clampEffort(effort, published)
      if (clamped !== undefined && clamped !== effort) {
        effortConfig.effort = clamped
        logger.debug(`Passthrough: clamped effort "${effort}" → "${clamped}" (published for ${translatedModel}: ${published.join(", ")})`)
      }
    } else {
      const modelAcceptsXhigh = translatedModel.endsWith("-xhigh")
      if (effort === "max") {
        effortConfig.effort = modelAcceptsXhigh ? "xhigh" : "high"
        logger.debug(`Passthrough: mapped effort "max" → "${effortConfig.effort}"`)
      } else if (effort === "xhigh" && !modelAcceptsXhigh) {
        effortConfig.effort = "high"
        logger.debug(`Passthrough: mapped effort "xhigh" → "high" (model ${translatedModel} does not support xhigh)`)
      }
    }
  }

  // Per-model effort constraints. Copilot enforces different reasoning_effort
  // whitelists per model; clamp unsupported values instead of getting 400'd.
  //   claude-opus-4.7         → only "medium"
  //   claude-opus-4.7-high    → only "high"
  //   claude-opus-4.7-xhigh   → only "xhigh"
  //   claude-opus-4.8         → supports [low medium high xhigh max]; we force
  //                             "max" (the strongest tier — matches Claude Code's
  //                             "Max" effort). Adaptive thinking keeps trivial
  //                             calls fast and only thinks deeply when needed.
  //   claude-opus-5           → same whitelist as 4.8, verified by probe:
  //                             "supported values: [low medium high xhigh max]".
  //                             Force "max".
  //   claude-haiku-4.5        → does not support effort at all (strip)
  // claude-opus-5.5 is intentionally absent: its published efforts are honored
  // as requested, so Claude Code's /effort (or CLAUDE_CODE_EFFORT_LEVEL) decides.
  const MODEL_EFFORT_OVERRIDES: Record<string, "medium" | "high" | "xhigh" | "max" | "strip"> = {
    "claude-opus-4.7": "medium",
    "claude-opus-4-7": "medium",
    "claude-opus-4.7-high": "high",
    "claude-opus-4.7-xhigh": "xhigh",
    "claude-opus-4.8": "max",
    "claude-opus-4-8": "max",
    "claude-opus-5": "max",
    "claude-haiku-4.5": "strip",
    "claude-haiku-4-5": "strip",
  }
  const override = MODEL_EFFORT_OVERRIDES[translatedModel]
  if (override) {
    let oc = parsed.output_config as Record<string, unknown> | undefined
    if (override === "strip") {
      if ("thinking" in parsed) {
        delete parsed.thinking
        logger.debug(`Passthrough: stripped thinking for ${translatedModel} (not supported)`)
      }
      if (oc && "effort" in oc) {
        delete oc.effort
        if (Object.keys(oc).length === 0) delete parsed.output_config
        logger.debug(`Passthrough: stripped effort for ${translatedModel} (not supported)`)
      }
    } else {
      // Force the locked effort, even if the client sent nothing or something else
      if (!oc) {
        oc = {}
        parsed.output_config = oc
      }
      if (oc.effort !== override) {
        logger.debug(
          `Passthrough: clamped effort "${String(oc.effort ?? "<unset>")}" → "${override}" for ${translatedModel}`,
        )
        oc.effort = override
      }
    }
  }

  return { body: parsed, model: translatedModel, betas, endpoint }
}

/**
 * Record a compatibility downgrade from a 400 body. Returns true when the
 * request should be rebuilt and retried once.
 */
function learnFromRejection(prepared: PreparedClaudeRequest, errorText: string): boolean {
  const key = compatibilityKey(prepared.endpoint, prepared.model)
  const thinking = prepared.body.thinking
  if (isRecord(thinking) && thinking.type === "disabled" && DISABLED_THINKING_REJECTION.test(errorText)) {
    learnedRejectsDisabledThinking.add(key)
    logger.warn(`Upstream rejects thinking.type "disabled" for ${prepared.model}; retrying with adaptive thinking`)
    return true
  }
  if ("context_management" in prepared.body && CONTEXT_MANAGEMENT_REJECTION.test(errorText)) {
    learnedRejectsContextManagement.add(key)
    logger.warn(`Upstream rejects context_management for ${prepared.model}; retrying without it`)
    return true
  }
  return false
}

async function forwardClaudeRequest(
  rawBody: string,
  model: string,
  anthropicBeta: string | null | undefined,
  endpoint: ClaudeEndpoint,
): Promise<Response> {
  // Proactive refresh if the cached JWT is stale or near expiry. Upstream
  // JWTs expire in ~25–30 min; the previous setInterval-only refresh didn't
  // always fire in time, so every request now guarantees a fresh token.
  await ensureFreshCopilotToken()
  if (!state.copilotToken) throw new Error("Copilot token not found")

  let prepared = prepareClaudeRequest(rawBody, model, anthropicBeta, endpoint)
  logger.debug(`Passthrough: ${model} → ${prepared.model}`)

  // Check for vision content
  const hasVision = rawBody.includes('"type":"image"') || rawBody.includes('"type":"image_url"')

  // Check for agent messages
  const isAgentCall = rawBody.includes('"role":"assistant"') || rawBody.includes('"role":"tool"')

  const path = endpoint === "count_tokens" ? "/v1/messages/count_tokens" : "/v1/messages"
  const doFetch = () =>
    fetch(`${copilotBaseUrl(state)}${path}`, {
      method: "POST",
      headers: {
        ...copilotHeaders(state, hasVision),
        "X-Initiator": isAgentCall ? "agent" : "user",
        "anthropic-version": "2023-06-01",
        ...(prepared.betas.length > 0 && { "anthropic-beta": prepared.betas.join(",") }),
      },
      body: JSON.stringify(prepared.body),
      // Bun-specific: disable the default ~5min fetch timeout. Reasoning
      // models (e.g. claude-opus-4.7-xhigh) can stall mid-stream for >5min
      // while thinking, which otherwise triggers "The operation timed out."
      // from the upstream fetch. We rely on the SSE heartbeat in the handler
      // to keep the downstream client connection alive.
      ...({ timeout: false } as object),
    } as RequestInit)

  let response = await doFetch()

  // Belt-and-suspenders: even with proactive refresh, the upstream can
  // occasionally return 401 "IDE token expired" (e.g. clock skew or a token
  // that just rotated). Force-refresh once and retry the request.
  if (response.status === 401) {
    logger.warn("Upstream 401 — forcing Copilot JWT refresh and retrying once")
    try {
      await forceCopilotTokenRefresh()
      response = await doFetch()
    } catch (refreshError) {
      logger.error("Failed to refresh Copilot JWT after 401", {
        error: String(refreshError),
      })
    }
  }

  if (response.status === 400) {
    const errorText = await response.clone().text()
    if (learnFromRejection(prepared, errorText)) {
      prepared = prepareClaudeRequest(rawBody, model, anthropicBeta, endpoint)
      response = await doFetch()
    }
  }

  if (!response.ok) {
    throw await HTTPError.fromResponse(
      `Passthrough failed (${response.status})`,
      response,
    )
  }

  return response
}

export async function passthroughToMessages(
  rawBody: string,
  model: string,
  _stream: boolean,
  anthropicBeta?: string | null,
): Promise<Response> {
  return forwardClaudeRequest(rawBody, model, anthropicBeta, "messages")
}

export async function passthroughToCountTokens(
  rawBody: string,
  model: string,
  anthropicBeta?: string | null,
): Promise<Response> {
  return forwardClaudeRequest(rawBody, model, anthropicBeta, "count_tokens")
}
