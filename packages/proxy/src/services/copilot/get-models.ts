import { copilotBaseUrl, copilotHeaders } from "./../../lib/api-config"
import { HTTPError } from "./../../lib/error"
import { state } from "./../../lib/state"
import { ensureFreshCopilotToken } from "../../lib/token"

export const getModels = async () => {
  await ensureFreshCopilotToken()
  const response = await fetch(`${copilotBaseUrl(state)}/models`, {
    headers: copilotHeaders(state),
  })

  if (!response.ok) throw await HTTPError.fromResponse("Failed to get models", response)

  return (await response.json()) as ModelsResponse
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

export interface ModelLimits {
  max_context_window_tokens: number | null
  max_output_tokens: number | null
  max_prompt_tokens: number | null
  max_inputs?: number | null
  vision?: {
    max_prompt_image_size?: number
    max_prompt_images?: number
    supported_media_types?: string[]
  }
}

export interface ModelSupports {
  tool_calls: boolean | null
  parallel_tool_calls: boolean | null
  dimensions?: boolean | null
  streaming?: boolean
  vision?: boolean
  structured_outputs?: boolean
  reasoning_effort?: string[]
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  supported_endpoints?: string[]
  policy: {
    state: string
    terms: string
  } | null
}
