/**
 * Passthrough handler for Claude models.
 * Forwards Anthropic Messages API requests directly to Copilot's
 * native /v1/messages endpoint. Patches model name and strips
 * fields that Copilot doesn't accept.
 *
 * Preserves all key Anthropic parameters:
 * - thinking (adaptive/enabled)
 * - output_config.effort
 * - cache_control
 * - top_k, service_tier
 */

import { copilotHeaders, copilotBaseUrl } from "../../lib/api-config"
import { HTTPError } from "../../lib/error"
import { state } from "../../lib/state"
import { translateModelName } from "../../lib/model-router"
import { ensureFreshCopilotToken, forceCopilotTokenRefresh } from "../../lib/token"
import { logger } from "../../util/logger"

/**
 * Fields that Copilot's /v1/messages endpoint rejects as "Extra inputs".
 * These are Anthropic API features not (yet) supported by Copilot.
 */
const FIELDS_TO_STRIP = new Set([
  "context_management",
  "cache_control",   // top-level cache_control (per-block cache_control IS supported)
  "container",
  "inference_geo",
])

export async function passthroughToMessages(
  rawBody: string,
  model: string,
  _stream: boolean,
  anthropicBeta?: string | null,
): Promise<Response> {
  // Proactive refresh if the cached JWT is stale or near expiry. Upstream
  // JWTs expire in ~25–30 min; the previous setInterval-only refresh didn't
  // always fire in time, so every request now guarantees a fresh token.
  await ensureFreshCopilotToken()
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const translatedModel = translateModelName(model, anthropicBeta)

  // Parse, patch model name, strip unsupported fields
  const parsed = JSON.parse(rawBody) as Record<string, unknown>
  parsed.model = translatedModel

  for (const field of FIELDS_TO_STRIP) {
    if (field in parsed) {
      logger.debug(`Passthrough: stripping unsupported field "${field}"`)
      delete parsed[field]
    }
  }

  // Copilot effort mapping:
  //   - Supported on most models: low, medium, high
  //   - Newer model variants like claude-opus-4.7-xhigh REQUIRE effort=xhigh
  //   - Generic xhigh on a non-xhigh model → high; max → high; none → strip
  //   - output_config.format (structured outputs) IS supported — don't strip it
  const outputConfig = parsed.output_config as Record<string, unknown> | undefined
  if (outputConfig) {
    const effort = outputConfig.effort
    const modelAcceptsXhigh = translatedModel.endsWith("-xhigh")
    if (effort === "max") {
      outputConfig.effort = modelAcceptsXhigh ? "xhigh" : "high"
      logger.debug(`Passthrough: mapped effort "max" → "${outputConfig.effort}"`)
    } else if (effort === "xhigh" && !modelAcceptsXhigh) {
      outputConfig.effort = "high"
      logger.debug(`Passthrough: mapped effort "xhigh" → "high" (model ${translatedModel} does not support xhigh)`)
    } else if (effort === "none") {
      delete outputConfig.effort
      logger.debug('Passthrough: stripped effort "none" (not supported by Copilot)')
      // If output_config is now empty, remove it
      if (Object.keys(outputConfig).length === 0) {
        delete parsed.output_config
      }
    }
  }

  // Copilot's Claude endpoint rejects `thinking.type: "enabled"` for newer
  // models (e.g. claude-opus-4.7) — it requires `adaptive` plus
  // output_config.effort to control thinking depth. Translate on the fly.
  const thinking = parsed.thinking as Record<string, unknown> | undefined
  if (thinking && thinking.type === "enabled") {
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

  const patchedBody = JSON.stringify(parsed)

  logger.debug(`Passthrough: ${model} → ${translatedModel}`)

  // Check for vision content
  const hasVision = rawBody.includes('"type":"image"') || rawBody.includes('"type":"image_url"')

  // Check for agent messages
  const isAgentCall = rawBody.includes('"role":"assistant"') || rawBody.includes('"role":"tool"')

  const doFetch = () =>
    fetch(`${copilotBaseUrl(state)}/v1/messages`, {
      method: "POST",
      headers: {
        ...copilotHeaders(state, hasVision),
        "X-Initiator": isAgentCall ? "agent" : "user",
        "anthropic-version": "2023-06-01",
      },
      body: patchedBody,
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

  if (!response.ok) {
    throw await HTTPError.fromResponse(
      `Passthrough failed (${response.status})`,
      response,
    )
  }

  return response
}
