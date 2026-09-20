import { describe, expect, it } from "vitest"
import { codexInputLimit, createCodexCatalog, parseCodexCatalog, selectCodexModel, verifiedCodexCapabilities } from "../src/lib/codex-catalog"
import type { Model } from "../src/services/copilot/get-models"
import { nativeModel } from "./codex-fixtures"

describe("Codex 0.155.1 model catalog", () => {
  it("supplies the stable ModelInfo contract with conservative, truthful capabilities", () => {
    const catalog = createCodexCatalog([nativeModel()])
    expect(catalog.models).toHaveLength(1)
    expect(catalog.models[0]).toMatchObject({
      slug: "gpt-5.3-codex",
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      default_reasoning_level: "medium",
      context_window: 272_000,
      max_context_window: 272_000,
      auto_compact_token_limit: 231_200,
      effective_context_window_percent: 95,
      include_apps_usage_instructions: false,
      input_modalities: ["text", "image"],
      experimental_supported_tools: [],
      supports_reasoning_summary_parameter: false,
      default_reasoning_summary: "none",
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      supports_search_tool: false,
      supports_experimental_context: false,
      use_responses_lite: false,
    })
    expect(parseCodexCatalog(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog)
  })

  const excluded: Array<[string, (model: Model) => void]> = [
    ["disabled policy", model => { model.policy = { state: "disabled", terms: "" } }],
    ["unknown policy", model => { model.policy = { state: "pending", terms: "" } }],
    ["hidden picker", model => { model.model_picker_enabled = false }],
    ["embeddings", model => { model.capabilities.type = "embeddings" }],
    ["no tools", model => { model.capabilities.supports.tool_calls = false }],
    ["unknown tools", model => { model.capabilities.supports.tool_calls = null }],
    ["no streaming", model => { model.capabilities.supports.streaming = false }],
    ["unknown streaming", model => { delete model.capabilities.supports.streaming }],
    ["chat only", model => { model.supported_endpoints = ["/chat/completions"] }],
    ["WebSockets only", model => { model.supported_endpoints = ["ws:/responses"] }],
    ["unknown endpoints", model => { delete model.supported_endpoints }],
    ["unknown limits", model => { model.capabilities.limits = { max_context_window_tokens: null, max_output_tokens: null, max_prompt_tokens: null } }],
  ]
  it.each(excluded)("excludes %s rather than promising unsupported Codex functionality", (_label, change) => {
    const model = nativeModel()
    change(model)
    expect(createCodexCatalog([model])).toEqual({ models: [] })
  })

  it("accepts visible models without a policy and never fabricates vision or reasoning support", () => {
    const model = nativeModel("other-native", { policy: null })
    delete model.capabilities.supports.vision
    delete model.capabilities.supports.reasoning_effort
    const entry = createCodexCatalog([model]).models[0]
    expect(entry?.input_modalities).toEqual(["text"])
    expect(entry?.supported_reasoning_levels).toEqual([])
    expect(entry?.default_reasoning_level).toBeNull()
  })

  it("only advertises canonical Codex efforts actually present in upstream metadata", () => {
    const model = nativeModel()
    model.capabilities.supports.reasoning_effort = ["max", "xhigh", "high", "invalid", "medium", "max", "none"]
    const entry = createCodexCatalog([model]).models[0]
    expect(entry?.supported_reasoning_levels.map(level => level.effort)).toEqual(["none", "medium", "high", "xhigh", "max"])
    expect(entry?.default_reasoning_level).toBe("medium")
  })

  it("uses real prompt limits and reserves output capacity, rather than a 272k fallback", () => {
    const model = nativeModel()
    model.capabilities.limits = { max_prompt_tokens: 32_000, max_context_window_tokens: 64_000, max_output_tokens: 48_000 }
    expect(codexInputLimit(model)).toBe(16_000)
    model.capabilities.limits.max_prompt_tokens = null
    expect(codexInputLimit(model)).toBe(16_000)
    model.capabilities.limits.max_output_tokens = null
    expect(codexInputLimit(model)).toBeNull()
    model.capabilities.limits.max_prompt_tokens = 20_000
    expect(codexInputLimit(model)).toBe(20_000)
    model.capabilities.limits.max_context_window_tokens = null
    expect(codexInputLimit(model)).toBe(20_000)
    model.capabilities.limits.max_context_window_tokens = 10_000
    model.capabilities.limits.max_output_tokens = 10_000
    expect(codexInputLimit(model)).toBeNull()
  })

  it("deterministically prefers available native coding models without assuming GPT-5.5", () => {
    const models = [nativeModel("gpt-6-astra"), nativeModel("gpt-5.9-codex"), nativeModel("gpt-5.10-codex")]
    const catalog = createCodexCatalog(models)
    expect(catalog).toEqual(createCodexCatalog([...models].reverse()))
    expect(selectCodexModel(catalog).slug).toBe("gpt-5.10-codex")
    expect(selectCodexModel(createCodexCatalog([models[0]!])).slug).toBe("gpt-6-astra")
    expect(selectCodexModel(catalog, "gpt-5.9-codex").slug).toBe("gpt-5.9-codex")
    expect(() => selectCodexModel(catalog, "gpt-5.5")).toThrow("No model was substituted")
    expect(() => selectCodexModel({ models: [] })).toThrow("No enabled native Responses models")
  })

  it("prefers the live-verified baseline only when available and preserves explicit model selection", () => {
    const models = [nativeModel(), nativeModel("gpt-6-astra"), nativeModel("gpt-5.4-mini")]
    const catalog = createCodexCatalog(models)
    expect(catalog).toEqual(createCodexCatalog([...models].reverse()))
    expect(selectCodexModel(catalog).slug).toBe("gpt-5.4-mini")
    expect(selectCodexModel(catalog, "gpt-5.3-codex").slug).toBe("gpt-5.3-codex")
    models[2]!.policy = { state: "disabled", terms: "" }
    expect(selectCodexModel(createCodexCatalog(models)).slug).toBe("gpt-5.3-codex")
  })

  it("enables verified native freeform patches without inferring support for other models", () => {
    const catalog = createCodexCatalog([nativeModel("gpt-5.4-mini"), nativeModel("gpt-6-astra"), nativeModel("gpt-5.6-sol"), nativeModel("untested-native")])
    for (const id of ["gpt-5.4-mini", "gpt-6-astra", "gpt-5.6-sol"]) {
      expect(catalog.models.find(model => model.slug === id)?.apply_patch_tool_type).toBe("freeform")
    }
    expect(catalog.models.find(model => model.slug === "untested-native")?.apply_patch_tool_type).toBeNull()
    expect(parseCodexCatalog(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog)
    const chatOnly = nativeModel("gpt-5.4-mini", { supported_endpoints: ["/chat/completions"] })
    expect(createCodexCatalog([chatOnly]).models).toEqual([])
  })

  it("enables verified deferred tool_search independently of hosted web search", () => {
    const catalog = createCodexCatalog([nativeModel("gpt-5.4-mini"), nativeModel(), nativeModel("gpt-5.6-sol")])
    expect(catalog.models.find(model => model.slug === "gpt-5.4-mini")?.supports_search_tool).toBe(true)
    expect(catalog.models.filter(model => model.slug !== "gpt-5.4-mini").every(model => model.supports_search_tool === false)).toBe(true)
    expect(parseCodexCatalog(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog)
    expect(() => parseCodexCatalog({ models: [{ ...catalog.models[0], supports_search_tool: "true" }] })).toThrow("Malformed")
  })

  it("separates live-verified MCP, structured-output and hosted-search capabilities", () => {
    expect(verifiedCodexCapabilities(nativeModel("gpt-5.4-mini"))).toEqual({
      freeform_apply_patch: true,
      tool_search: true,
      mcp_browser: true,
      structured_outputs: true,
      hosted_web_search: false,
    })
    expect(verifiedCodexCapabilities(nativeModel("gpt-5.6-sol"))).toEqual({
      freeform_apply_patch: true,
      tool_search: false,
      mcp_browser: false,
      structured_outputs: true,
      hosted_web_search: true,
    })
    expect(verifiedCodexCapabilities(nativeModel("gpt-6-astra"))).toEqual({
      freeform_apply_patch: true, structured_outputs: true,
      tool_search: false, mcp_browser: false, hosted_web_search: false,
    })
    expect(Object.values(verifiedCodexCapabilities(nativeModel("untested-native"))).every(value => !value)).toBe(true)
  })

  it("does not advertise verified capabilities when required current metadata is absent", () => {
    const model = nativeModel("gpt-5.4-mini")
    model.capabilities.supports.vision = false
    model.capabilities.supports.structured_outputs = false
    expect(verifiedCodexCapabilities(model)).toMatchObject({ mcp_browser: false, structured_outputs: false, tool_search: true })
    model.supported_endpoints = ["/chat/completions"]
    expect(Object.values(verifiedCodexCapabilities(model)).every(value => !value)).toBe(true)
    expect(Object.values(verifiedCodexCapabilities(undefined)).every(value => !value)).toBe(true)
  })

  it("never advertises rejected native computer tools or infers them from vision support", () => {
    const catalog = createCodexCatalog([nativeModel("gpt-6-astra"), nativeModel("gpt-5.6-sol"), nativeModel("gpt-5.4-mini")])
    expect(catalog.models.every(model => model.experimental_supported_tools.length === 0)).toBe(true)
    for (const tool of ["computer", "computer_use_preview"]) {
      expect(() => parseCodexCatalog({ models: [{ ...catalog.models[0], experimental_supported_tools: [tool] }] })).toThrow("Malformed")
    }
  })

  it("provides every non-optional ModelInfo field without a serde default in the pinned schema", () => {
    const model = createCodexCatalog([nativeModel("gpt-5.4-mini")]).models[0]!
    // protocol/src/openai_models.rs, ModelInfo at be2951ea:400-500.
    for (const required of [
      "slug", "display_name", "supported_reasoning_levels", "shell_type", "visibility",
      "supported_in_api", "priority", "support_verbosity", "truncation_policy", "experimental_supported_tools",
    ]) {
      expect(model).toHaveProperty(required)
    }
    expect(model.include_apps_usage_instructions).toBe(false)
    expect(model.supports_reasoning_summary_parameter).toBe(false)
    expect(model.input_modalities).toContain("text")
    expect(model.use_responses_lite).toBe(false)
  })

  it("deduplicates upstream model IDs", () => {
    expect(createCodexCatalog([nativeModel(), nativeModel()]).models).toHaveLength(1)
  })

  it.each([
    null,
    [],
    { object: "list", data: [] },
    { models: [null] },
    { models: [{ slug: "gpt-5.5" }] },
  ])("rejects malformed or OpenAI-shaped catalogs: %j", value => {
    expect(() => parseCodexCatalog(value)).toThrow("Malformed Conduit Codex catalog")
  })

  it("rejects duplicate and unsafe model metadata", () => {
    const model = createCodexCatalog([nativeModel()]).models[0]!
    expect(() => parseCodexCatalog({ models: [model, model] })).toThrow("duplicate model IDs")
    for (const patch of [
      { context_window: 0 },
      { use_responses_lite: true },
      { supported_reasoning_levels: [{ effort: "unrecognized", description: "" }] },
      { experimental_supported_tools: ["computer"] },
      { supports_reasoning_summary_parameter: true },
    ]) {
      expect(() => parseCodexCatalog({ models: [{ ...model, ...patch }] })).toThrow("Malformed")
    }
  })
})
