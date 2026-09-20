import type { Model } from "../services/copilot/get-models"
import type { CodexCatalog, CodexModelInfo, CodexReasoningEffort, CodexVerifiedCapabilities } from "./codex-types"
import { isRecord as record } from "./validation"

export const CODEX_REASONING_EFFORTS: readonly CodexReasoningEffort[] = [
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent",
]

export const VERIFIED_CODEX_BASELINE_MODEL = "gpt-5.4-mini"
export const VERIFIED_HOSTED_SEARCH_MODEL = "gpt-5.6-sol"
export const VERIFIED_CODEX_CODING_MODELS: readonly string[] = [
  VERIFIED_CODEX_BASELINE_MODEL, "gpt-6-astra", VERIFIED_HOSTED_SEARCH_MODEL,
]

const INSTRUCTIONS = "You are a coding assistant. Follow the user's instructions, inspect relevant project guidance and code before changing it, make focused changes, and verify your work with appropriate checks. Use the available tools and respect the configured sandbox and approval requirements."

export function verifiedCodexCapabilities(model: Model | undefined): CodexVerifiedCapabilities {
  const nativeTools = model?.supported_endpoints?.includes("/responses") === true
    && model.capabilities.supports.tool_calls === true
  const baseline = nativeTools && model?.id === VERIFIED_CODEX_BASELINE_MODEL
  const coding = nativeTools && model !== undefined && VERIFIED_CODEX_CODING_MODELS.includes(model.id)
  return {
    freeform_apply_patch: coding,
    tool_search: baseline,
    mcp_browser: baseline && model?.capabilities.supports.vision === true,
    structured_outputs: coding && model?.capabilities.supports.structured_outputs === true,
    hosted_web_search: nativeTools && model?.id === VERIFIED_HOSTED_SEARCH_MODEL,
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

export function codexInputLimit(model: Model): number | null {
  const limits = model.capabilities.limits
  const bounds: number[] = []
  if (positiveInteger(limits.max_prompt_tokens)) bounds.push(limits.max_prompt_tokens)
  if (positiveInteger(limits.max_context_window_tokens)) {
    if (positiveInteger(limits.max_output_tokens)) {
      const input = limits.max_context_window_tokens - limits.max_output_tokens
      if (input <= 0) return null
      bounds.push(input)
    } else if (bounds.length > 0) {
      bounds.push(limits.max_context_window_tokens)
    }
  }
  return bounds.length > 0 ? Math.min(...bounds) : null
}

function preference(model: Model): number {
  if (model.id === VERIFIED_CODEX_BASELINE_MODEL) return -1
  if (/^gpt-\d.*-codex(?:-|$)/i.test(model.id)) return 0
  if (/(?:^|-)cod(?:e|ex)(?:-|$)/i.test(model.id)) return 1
  if (/^gpt-\d/i.test(model.id)) return 2
  return 3
}

export function createCodexCatalog(models: readonly Model[]): CodexCatalog {
  const eligible = models.filter(model =>
    model.model_picker_enabled === true
    && (!model.policy || model.policy.state === "enabled")
    && model.capabilities.type === "chat"
    && model.capabilities.supports.tool_calls === true
    && model.capabilities.supports.streaming === true
    && model.supported_endpoints?.includes("/responses")
    && codexInputLimit(model) !== null,
  ).sort((a, b) =>
    preference(a) - preference(b)
    || Number(a.preview) - Number(b.preview)
    || b.id.localeCompare(a.id, "en", { numeric: true })
    || a.name.localeCompare(b.name, "en"),
  )
  const seen = new Set<string>()
  const catalog: CodexCatalog = { models: [] }
  for (const model of eligible) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    const contextWindow = codexInputLimit(model)!
    const verified = verifiedCodexCapabilities(model)
    const efforts = CODEX_REASONING_EFFORTS.filter(effort =>
      model.capabilities.supports.reasoning_effort?.includes(effort),
    )
    catalog.models.push({
      slug: model.id,
      display_name: model.name,
      description: `${model.vendor} via Conduit · native Responses`,
      default_reasoning_level: efforts.includes("medium") ? "medium" : efforts[0] ?? null,
      supported_reasoning_levels: efforts.map(effort => ({ effort, description: `${effort} reasoning effort` })),
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: catalog.models.length,
      availability_nux: null,
      upgrade: null,
      model_messages: { instructions_template: INSTRUCTIONS, instructions_variables: null },
      include_apps_usage_instructions: false,
      supports_reasoning_summary_parameter: false,
      default_reasoning_summary: "none",
      support_verbosity: false,
      default_verbosity: null,
      // Generic tool metadata is insufficient; this native model passed live Codex custom-tool replay.
      apply_patch_tool_type: verified.freeform_apply_patch ? "freeform" : null,
      truncation_policy: { mode: "tokens", limit: Math.min(10_000, contextWindow) },
      context_window: contextWindow,
      max_context_window: contextWindow,
      auto_compact_token_limit: Math.max(1, Math.floor(contextWindow * 0.85)),
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: model.capabilities.supports.vision === true ? ["text", "image"] : ["text"],
      // Codex's deferred tool_search gate, independent of the hosted web_search setting.
      supports_search_tool: verified.tool_search,
      supports_experimental_context: false,
      use_responses_lite: false,
    })
  }
  return catalog
}

export function selectCodexModel(catalog: CodexCatalog, requested?: string): CodexModelInfo {
  if (requested !== undefined) {
    const model = catalog.models.find(candidate => candidate.slug === requested)
    if (!model) throw new Error(`Selected model ${JSON.stringify(requested)} is not in the available Conduit Codex catalog. No model was substituted.`)
    return model
  }
  const model = [...catalog.models].sort((a, b) => a.priority - b.priority || a.slug.localeCompare(b.slug, "en"))[0]
  if (!model) throw new Error("No enabled native Responses models with streaming, tool calls, and known input limits are available.")
  return model
}

function reasoningEffort(value: unknown): value is CodexReasoningEffort {
  return typeof value === "string" && CODEX_REASONING_EFFORTS.some(effort => effort === value)
}

function validModel(value: unknown): value is CodexModelInfo {
  if (!record(value)) return false
  const efforts = value.supported_reasoning_levels
  const modalities = value.input_modalities
  const policy = value.truncation_policy
  const messages = value.model_messages
  return typeof value.slug === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value.slug)
    && typeof value.display_name === "string" && value.display_name.length > 0
    && (value.description === null || typeof value.description === "string")
    && Array.isArray(efforts)
    && efforts.every(effort => record(effort) && reasoningEffort(effort.effort) && typeof effort.description === "string")
    && (value.default_reasoning_level === null || (reasoningEffort(value.default_reasoning_level)
      && efforts.some(effort => effort.effort === value.default_reasoning_level)))
    && value.shell_type === "unified_exec" && value.visibility === "list" && value.supported_in_api === true
    && typeof value.priority === "number" && Number.isSafeInteger(value.priority) && value.priority >= 0
    && value.availability_nux === null && value.upgrade === null
    && record(messages) && typeof messages.instructions_template === "string" && messages.instructions_variables === null
    && value.include_apps_usage_instructions === false
    && value.supports_reasoning_summary_parameter === false && value.default_reasoning_summary === "none"
    && value.support_verbosity === false && value.default_verbosity === null
    && (value.apply_patch_tool_type === null || value.apply_patch_tool_type === "freeform")
    && record(policy) && policy.mode === "tokens" && positiveInteger(policy.limit)
    && positiveInteger(value.context_window) && positiveInteger(value.max_context_window)
    && value.context_window <= value.max_context_window
    && positiveInteger(value.auto_compact_token_limit) && value.auto_compact_token_limit <= value.context_window
    && positiveInteger(value.effective_context_window_percent) && value.effective_context_window_percent <= 100
    && Array.isArray(value.experimental_supported_tools) && value.experimental_supported_tools.length === 0
    && Array.isArray(modalities) && modalities.includes("text")
    && modalities.every(modality => modality === "text" || modality === "image")
    && typeof value.supports_search_tool === "boolean" && value.supports_experimental_context === false
    && value.use_responses_lite === false
}

export function parseCodexCatalog(value: unknown): CodexCatalog {
  if (!record(value) || !Array.isArray(value.models) || !value.models.every(validModel)) {
    throw new Error("Malformed Conduit Codex catalog: expected { models: [ModelInfo, ...] } for Codex 0.155.1.")
  }
  const models: CodexModelInfo[] = value.models
  if (new Set(models.map(model => model.slug)).size !== models.length) {
    throw new Error("Malformed Conduit Codex catalog: duplicate model IDs.")
  }
  return { models }
}
