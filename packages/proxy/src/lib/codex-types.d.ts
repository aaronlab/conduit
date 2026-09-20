export type CodexReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | "persistent"

export type CodexReasoningSummary = "auto" | "concise" | "detailed" | "none"

// ModelInfo in Codex 0.155.1, protocol/src/openai_models.rs at be2951ea.
export interface CodexModelInfo {
  slug: string
  display_name: string
  description: string | null
  default_reasoning_level: CodexReasoningEffort | null
  supported_reasoning_levels: Array<{ effort: CodexReasoningEffort; description: string }>
  shell_type: "unified_exec"
  visibility: "list"
  supported_in_api: boolean
  priority: number
  availability_nux: null
  upgrade: null
  model_messages: {
    instructions_template: string
    instructions_variables: null
  }
  include_apps_usage_instructions: false
  supports_reasoning_summary_parameter: boolean
  default_reasoning_summary: CodexReasoningSummary
  support_verbosity: false
  default_verbosity: null
  apply_patch_tool_type: "freeform" | null
  truncation_policy: { mode: "tokens"; limit: number }
  context_window: number
  max_context_window: number
  auto_compact_token_limit: number
  effective_context_window_percent: number
  experimental_supported_tools: string[]
  input_modalities: Array<"text" | "image">
  supports_search_tool: boolean
  supports_experimental_context: false
  use_responses_lite: false
}

export interface CodexCatalog {
  models: CodexModelInfo[]
}

export interface CodexProviderConfig {
  name: "Conduit"
  base_url: string
  env_key: "CONDUIT_API_KEY"
  wire_api: "responses"
  requires_openai_auth: false
  supports_websockets: false
  supports_standalone_web_search: false
}

export interface CodexConnectionModel {
  id: string
  name: string
  context_window: number
  reasoning_efforts: CodexReasoningEffort[]
  default_reasoning_summary: CodexReasoningSummary
  vision: boolean
  parallel_tool_calls: boolean
  structured_outputs: boolean
  verified_capabilities: CodexVerifiedCapabilities
}

export interface CodexVerifiedCapabilities {
  freeform_apply_patch: boolean
  tool_search: boolean
  mcp_browser: boolean
  structured_outputs: boolean
  hosted_web_search: boolean
  reasoning_summaries: boolean
}

export interface ConnectionInfo {
  base_url: string
  endpoints: {
    chat_completions: string
    responses: string
    messages: string
    models: string
    codex_models: string
  }
  models: string[]
  codex: {
    cli_version: string
    model_provider: "conduit"
    provider: CodexProviderConfig
    catalog_url: string
    default_model: string | null
    model_reasoning_summary: CodexReasoningSummary
    web_search: "disabled"
    models: CodexConnectionModel[]
    limitations: string[]
  }
}
