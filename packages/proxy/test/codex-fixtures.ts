import type { Model } from "../src/services/copilot/get-models"

export function nativeModel(id = "gpt-5.3-codex", overrides: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    object: "model",
    vendor: "OpenAI",
    version: id,
    model_picker_enabled: true,
    preview: false,
    policy: { state: "enabled", terms: "" },
    supported_endpoints: ["/responses", "ws:/responses"],
    capabilities: {
      family: id,
      object: "model_capabilities",
      type: "chat",
      tokenizer: "o200k_base",
      limits: { max_prompt_tokens: 272_000, max_context_window_tokens: 400_000, max_output_tokens: 128_000 },
      supports: {
        tool_calls: true,
        parallel_tool_calls: true,
        streaming: true,
        vision: true,
        structured_outputs: true,
        reasoning_effort: ["low", "medium", "high", "xhigh"],
      },
    },
    ...overrides,
  }
}
