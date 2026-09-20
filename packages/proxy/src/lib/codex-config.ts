import type { CodexModelInfo, CodexProviderConfig } from "./codex-types"
import { VERIFIED_CODEX_BASELINE_MODEL, VERIFIED_CODEX_CODING_MODELS, VERIFIED_HOSTED_SEARCH_MODEL } from "./codex-catalog"

export const CODEX_VERSION = "0.155.1"
export const DEFAULT_CODEX_BASE_URL = "http://127.0.0.1:7133/v1"

export const CODEX_LIMITATIONS = [
  "Only enabled native Responses models with streaming, tool calls, and known input limits are listed; chat-only models are not yet advertised for Codex.",
  `Freeform apply_patch is enabled for verified models: ${VERIFIED_CODEX_CODING_MODELS.join(", ")}. Deferred tool_search is enabled for the live-verified ${VERIFIED_CODEX_BASELINE_MODEL} baseline; other models retain ordinary local tools.`,
  `Native Responses hosted web search with URL citations was verified for ${VERIFIED_HOSTED_SEARCH_MODEL}; search is disabled by default and requires an explicit web_search override.`,
  "MCP browser automation is not native desktop control. Copilot rejected both computer and computer_use_preview tools; neither is advertised.",
  "WebSockets, Responses Lite, and reasoning summaries are not advertised.",
]

export function normalizeCodexBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Invalid Conduit base URL: use an absolute http:// or https:// URL.")
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid Conduit base URL: HTTP(S) is required; credentials, queries, and fragments are not allowed.")
  }
  const path = url.pathname.replace(/\/+$/, "")
  url.pathname = path.endsWith("/v1") ? path : `${path}/v1`
  return url.toString().replace(/\/$/, "")
}

export function codexCatalogUrl(baseUrl: string): string {
  return `${normalizeCodexBaseUrl(baseUrl)}/models?client_version=${CODEX_VERSION}`
}

export function createCodexProvider(baseUrl: string): CodexProviderConfig {
  return {
    name: "Conduit",
    base_url: normalizeCodexBaseUrl(baseUrl),
    env_key: "CONDUIT_API_KEY",
    wire_api: "responses",
    requires_openai_auth: false,
    supports_websockets: false,
    supports_standalone_web_search: false,
  }
}

export function codexConfigOverrides(baseUrl: string, catalogPath: string, model: CodexModelInfo): string[] {
  const provider = Object.entries(createCodexProvider(baseUrl))
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(", ")
  return [
    'model_provider="conduit"',
    `model_providers.conduit={ ${provider} }`,
    `model_catalog_json=${JSON.stringify(catalogPath)}`,
    `model=${JSON.stringify(model.slug)}`,
    'model_reasoning_summary="none"',
    'web_search="disabled"',
  ]
}
