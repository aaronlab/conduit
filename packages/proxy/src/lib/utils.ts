import { logger } from "./../util/logger"
import { getModels } from "./../services/copilot/get-models"

import { state } from "./state"

export const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const isNullish = (value: unknown): value is null | undefined =>
  value === null || value === undefined

export async function cacheModels(): Promise<void> {
  const models = await getModels()
  state.models = models
  logger.info(`Cached ${models.data.length} models from Copilot API`)
}

export const MISSING_MODEL_REFRESH_INTERVAL_MS = 60_000
let lastMissingModelRefresh = 0
let pendingMissingModelRefresh: Promise<void> | null = null

/**
 * The model list is cached at startup. When a request names a model that the
 * cache lacks (e.g. Copilot published it later), refresh once — throttled —
 * so it is used instead of the unavailable-Claude fallback.
 */
export async function refreshModelsIfMissing(modelId: string): Promise<void> {
  if (!state.models || state.models.data.some((model) => model.id === modelId)) return
  if (pendingMissingModelRefresh) return pendingMissingModelRefresh
  const now = Date.now()
  if (now - lastMissingModelRefresh < MISSING_MODEL_REFRESH_INTERVAL_MS) return
  lastMissingModelRefresh = now
  pendingMissingModelRefresh = cacheModels()
    .catch((error: unknown) => {
      logger.warn("Could not refresh the Copilot model list", { error: String(error) })
    })
    .finally(() => {
      pendingMissingModelRefresh = null
    })
  return pendingMissingModelRefresh
}

/** Test hook: forget refresh throttling state. */
export function resetMissingModelRefresh(): void {
  lastMissingModelRefresh = 0
  pendingMissingModelRefresh = null
}
