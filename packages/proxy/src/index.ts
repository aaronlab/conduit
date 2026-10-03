import { createApp } from "./app"
import { loadConfig } from "./config"
import { initDatabase } from "./db/schema"
import { enableDatabaseSink } from "./db/log-sink"
import { getSetting } from "./db/settings"
import { getEnabledProviders } from "./db/providers"
import { ensurePaths } from "./lib/paths"
import { setupGitHubToken, setupCopilotToken } from "./lib/token"
import { cacheModels } from "./lib/utils"
import { logger } from "./util/logger"
import { state } from "./lib/state"
import { detectLocalVSCodeVersion, detectLocalCopilotVersion } from "./services/detect-local-versions"
import { handleWebSocketOpen, handleWebSocketClose } from "./ws/logs"

const config = loadConfig()

async function main() {
  logger.info("Conduit proxy starting...")

  // Ensure data directory exists
  await ensurePaths()

  // Initialize database
  const db = initDatabase(config.dbPath)

  // Enable database log sink
  enableDatabaseSink(db)

  // GitHub OAuth
  logger.info("Loading GitHub token...")
  await setupGitHubToken()

  // Copilot JWT
  logger.info("Acquiring Copilot JWT...")
  await setupCopilotToken()

  // Detect local versions
  const vsVersion = await detectLocalVSCodeVersion()
  if (vsVersion) {
    state.vsCodeVersion = vsVersion
    logger.info(`Using VSCode version: ${vsVersion} (local)`)
  } else {
    state.vsCodeVersion = "1.114.0"
    logger.info("Using VSCode version: 1.114.0 (fallback)")
  }

  const copilotVersion = await detectLocalCopilotVersion()
  if (copilotVersion) {
    state.copilotChatVersion = copilotVersion
    logger.info(`Using Copilot Chat version: ${copilotVersion} (local)`)
  } else {
    state.copilotChatVersion = "0.43.0"
    logger.info("Using Copilot Chat version: 0.43.0 (fallback)")
  }

  // Cache models
  await cacheModels()

  // Load settings from DB
  state.stWebSearchEnabled = getSetting(db, "st_web_search_enabled") === "true"
  state.stWebSearchApiKey = getSetting(db, "st_web_search_api_key") ?? process.env.TAVILY_API_KEY ?? null
  state.providers = getEnabledProviders(db)
  if (state.stWebSearchApiKey) {
    logger.info("Tavily web search: enabled")
  }

  // Create and start server
  const app = createApp(db, {
    port: config.port,
    baseUrl: config.baseUrl || null,
    apiKey: config.apiKey,
    internalKey: config.internalKey,
  })

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    // Bun's default idleTimeout is 10s, which kills long-running Claude
    // streaming responses (opus-4.7 can think silently >10s before emitting
    // the first delta). 255s is the Bun maximum and matches Anthropic's own
    // server-side timeout window.
    idleTimeout: 255,
    // Allow large request bodies (long Codex/Claude resume payloads, big tool
    // schemas, file attachments). Bun's default can be as low as ~128 MB and
    // returns 413 "failed to parse request" when exceeded. 512 MB is plenty.
    maxRequestBodySize: 1024 * 1024 * 512,
    fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === "/ws/logs") {
        const upgraded = server.upgrade(req, { data: {} })
        if (!upgraded) return new Response("Upgrade failed", { status: 400 })
        return undefined
      }
      return app.fetch(req, server)
    },
    websocket: {
      open: handleWebSocketOpen,
      close: handleWebSocketClose,
      message() {}, // No client messages expected
    },
  })

  logger.info(`Conduit proxy listening on ${config.host}:${server.port}`)
}

main().catch((err) => {
  logger.error("Failed to start Conduit", { error: String(err) })
  process.exit(1)
})
