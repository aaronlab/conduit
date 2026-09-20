import { execFile } from "node:child_process"
import { chmod, lstat, mkdir, open, readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { fetchCodexCatalog, resolveConduitApiKey, saveCodexCatalog } from "./codex-cli"
import { DEFAULT_CODEX_REASONING_SUMMARY, selectCodexModel, withCodexContextBudget } from "./codex-catalog"
import { DEFAULT_CODEX_BASE_URL, normalizeCodexBaseUrl } from "./codex-config"
import { isRecord } from "./validation"

const execute = promisify(execFile)
const MARKER = ".conduit-gui-managed.json"
const MARKER_CONTENT = '{"owner":"conduit-gui","version":1}\n'

export interface GuiProfileOptions {
  repoRoot: string
  bunPath: string
  home: string
  appData: string
  baseUrl: string
}

export function buildGuiConfig(options: GuiProfileOptions, catalogPath: string): string {
  return `model_provider = "conduit"
model = "gpt-6-astra"
model_reasoning_effort = "max"
model_reasoning_summary = ${JSON.stringify(DEFAULT_CODEX_REASONING_SUMMARY)}
model_context_window = 872000
model_auto_compact_token_limit = 784800
model_catalog_json = ${JSON.stringify(catalogPath)}
web_search = "live"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[analytics]
enabled = false

[feedback]
enabled = false

[model_providers.conduit]
name = "Conduit"
base_url = ${JSON.stringify(normalizeCodexBaseUrl(options.baseUrl))}
wire_api = "responses"
supports_websockets = false
supports_standalone_web_search = false

[model_providers.conduit.auth]
command = ${JSON.stringify(options.bunPath)}
args = [${JSON.stringify(join(options.repoRoot, "bin", "conduit-auth-token"))}, "--stdio-token"]
timeout_ms = 5000
refresh_interval_ms = 0
`
}

export async function ensureManagedGuiDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (!(await lstat(path)).isDirectory()) throw new Error("GUI profile paths must be real directories, not symlinks.")
  const entries = await readdir(path)
  if (entries.includes(MARKER)) {
    const marker: unknown = JSON.parse(await readFile(join(path, MARKER), "utf8"))
    if (!isRecord(marker) || marker.owner !== "conduit-gui" || marker.version !== 1) {
      throw new Error("Unrecognized GUI profile marker; refusing to overwrite this directory.")
    }
  } else {
    if (entries.length) throw new Error("GUI profile directory is not empty and is not managed by Conduit.")
    const file = await open(join(path, MARKER), "wx", 0o600)
    try { await file.writeFile(MARKER_CONTENT) } finally { await file.close() }
  }
  await chmod(path, 0o700)
}

export function validateGuiProfilePaths(home: string, appData: string, userHome = homedir()): void {
  const protectedPaths = [
    userHome, join(userHome, ".codex"), join(userHome, "Library", "Application Support", "Codex"),
  ].map(path => resolve(path))
  if (protectedPaths.includes(resolve(home)) || protectedPaths.includes(resolve(appData)) || resolve(home) === resolve(appData)) {
    throw new Error("Use separate dedicated Conduit GUI directories; personal Codex/app data must not be overwritten.")
  }
}

export async function prepareGuiProfile(
  options: GuiProfileOptions,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<{ configPath: string; catalogPath: string }> {
  validateGuiProfilePaths(options.home, options.appData)
  const key = await resolveConduitApiKey(options.repoRoot, {})
  const catalog = await fetchCodexCatalog(options.baseUrl, key, fetchImpl)
  const selected = selectCodexModel(catalog, "gpt-6-astra")
  if (!selected.supported_reasoning_levels.some(level => level.effort === "max")) {
    throw new Error("The current Copilot catalog does not advertise max reasoning for Astra.")
  }
  if (!selected.supports_reasoning_summary_parameter) {
    throw new Error("The current Copilot catalog does not advertise reasoning summaries for Astra. Restart an outdated proxy before retrying.")
  }
  const model = { ...withCodexContextBudget(selected, 872000), default_reasoning_level: "max" as const }
  catalog.models = catalog.models.map(item => item.slug === model.slug ? model : item)

  await ensureManagedGuiDirectory(options.home)
  await ensureManagedGuiDirectory(options.appData)
  const catalogPath = await saveCodexCatalog(catalog, options.baseUrl, join(options.home, "catalog"))
  const configPath = join(options.home, "config.toml")
  try {
    const file = await open(configPath, "wx", 0o600)
    try { await file.writeFile(buildGuiConfig(options, catalogPath)) } finally { await file.close() }
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error
    const text = await readFile(configPath, "utf8")
    let config: unknown
    try {
      config = Bun.TOML.parse(text)
    } catch {
      throw new Error("Cannot parse the existing GUI config.toml; it was not overwritten.")
    }
    if (!isRecord(config)) throw new Error("Invalid GUI configuration; it was not overwritten.")
    const providers = config.model_providers
    const provider = isRecord(providers) ? providers.conduit : null
    const auth = isRecord(provider) ? provider.auth : null
    if (config.model_provider !== "conduit" || config.model_catalog_json !== catalogPath
      || !isRecord(provider) || provider.base_url !== normalizeCodexBaseUrl(options.baseUrl)
      || provider.wire_api !== "responses" || !isRecord(auth)
      || auth.command !== options.bunPath || !Array.isArray(auth.args)
      || auth.args[0] !== join(options.repoRoot, "bin", "conduit-auth-token") || auth.args[1] !== "--stdio-token") {
      throw new Error("Existing GUI provider configuration differs from this checkout. It was not overwritten; use a new CONDUIT_GUI_HOME/CONDUIT_GUI_DATA_DIR or review it manually.")
    }
  }
  return { configPath, catalogPath }
}

export function guiLaunchArguments(app: string, options: Pick<GuiProfileOptions, "home" | "appData">): string[] {
  return [
    "-n", "-a", app,
    "--env", `CODEX_HOME=${resolve(options.home)}`,
    "--env", `CODEX_ELECTRON_USER_DATA_PATH=${resolve(options.appData)}`,
    "--args", `--user-data-dir=${resolve(options.appData)}`,
  ]
}

export async function findOfficialGuiApp(userHome = homedir(), explicit?: string): Promise<string> {
  const candidates = explicit ? [explicit] : [
    join(userHome, "Applications", "ChatGPT.app"), "/Applications/ChatGPT.app",
  ]
  for (const candidate of candidates) {
    try {
      if (!(await lstat(join(candidate, "Contents", "Info.plist"))).isFile()) continue
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") continue
      throw error
    }
    const { stdout } = await execute("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(candidate, "Contents", "Info.plist")])
    if (stdout.trim() !== "com.openai.codex") throw new Error("Select the supported official ChatGPT desktop app, not another application.")
    await execute("codesign", ["--verify", "--deep", "--strict", candidate])
    const { stderr } = await execute("codesign", ["-dv", "--verbose=2", candidate])
    if (!stderr.includes("TeamIdentifier=2DC432GLL2")) throw new Error("The desktop app is not signed by the expected OpenAI publisher.")
    return resolve(candidate)
  }
  throw new Error("Official ChatGPT desktop app not found. Install it with brew install --cask chatgpt, or set CONDUIT_GUI_APP_PATH.")
}

export const GUI_HELP = `Usage: cxg [--help]

Open the official ChatGPT desktop GUI through Conduit (macOS).
Default model: Astra, max reasoning, ${DEFAULT_CODEX_REASONING_SUMMARY} summaries, 872000 usable context, live search.
GUI permissions remain on-request/workspace-write, not cx's unrestricted preset.

The proxy must already be running. Credentials are read from the checkout's
.conduit-key through a private auth command, never saved in the GUI config.
Uses separate ~/.codex-conduit-gui and
~/Library/Application Support/Conduit ChatGPT directories.
Personal Codex login/configuration is not replaced; existing managed GUI
settings are preserved. No debugging port is enabled by this launcher.

Environment: CONDUIT_GUI_APP_PATH, CONDUIT_GUI_HOME, CONDUIT_GUI_DATA_DIR,
CONDUIT_CODEX_BASE_URL (default ${DEFAULT_CODEX_BASE_URL}).
`

export async function runConduitGui(argv: readonly string[], repoRoot: string): Promise<number> {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) {
    process.stdout.write(GUI_HELP)
    return 0
  }
  try {
    if (argv.length) throw new Error("Unknown GUI launcher argument. Use cxg --help.")
    if (process.platform !== "darwin") throw new Error("This GUI launcher currently supports macOS only.")
    const userHome = homedir()
    const app = await findOfficialGuiApp(userHome, process.env.CONDUIT_GUI_APP_PATH)
    const options: GuiProfileOptions = {
      repoRoot: resolve(repoRoot),
      bunPath: process.execPath,
      home: resolve(process.env.CONDUIT_GUI_HOME ?? join(userHome, ".codex-conduit-gui")),
      appData: resolve(process.env.CONDUIT_GUI_DATA_DIR ?? join(userHome, "Library", "Application Support", "Conduit ChatGPT")),
      baseUrl: normalizeCodexBaseUrl(process.env.CONDUIT_CODEX_BASE_URL ?? DEFAULT_CODEX_BASE_URL),
    }
    await prepareGuiProfile(options)
    await execute("open", guiLaunchArguments(app, options))
    console.log("Opened the official ChatGPT app with the dedicated Conduit profile. Select ChatGPT Work or Codex for local tasks.")
    return 0
  } catch (error) {
    console.error(`cxg: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
