import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { constants } from "node:os"
import { parseCodexCatalog, selectCodexModel, withCodexContextBudget } from "./codex-catalog"
import { CODEX_VERSION, DEFAULT_CODEX_BASE_URL, codexCatalogUrl, codexConfigOverrides, normalizeCodexBaseUrl } from "./codex-config"
import type { CodexCatalog } from "./codex-types"

type Environment = Readonly<Record<string, string | undefined>>
type FetchCatalog = (url: string, init: RequestInit) => Promise<Response>

export const CODEX_HELP = `Usage: bin/conduit-codex [--base-url URL] [--model MODEL] [--context-budget TOKENS] [--] [Codex arguments...]

Launch installed Codex (tested with ${CODEX_VERSION}) using Conduit's native Responses catalog.
Run from the Conduit checkout; the proxy must already be running.

  bin/conduit-codex
  bin/conduit-codex --model MODEL -- exec "Explain this project"
  bin/conduit-codex -- --help

Options:
  --base-url URL  Trusted proxy URL, with or without /v1 (default ${DEFAULT_CODEX_BASE_URL})
  --model MODEL  Exact available catalog model; unknown models fail without substitution
  --context-budget TOKENS  Exact usable client input budget (>=4096, capped by Copilot metadata)
  -h, --help     Show this help without reading keys, fetching, or launching Codex
  --            Pass the remaining arguments to Codex

Environment:
  CONDUIT_API_KEY          Proxy bearer key; otherwise read the checkout's .conduit-key locally
  CONDUIT_CODEX_BASE_URL   Default proxy URL; never send your key to an untrusted server
  CONDUIT_CODEX_MODEL      Default model (otherwise prefer the available verified baseline, then a native coding model)
  CONDUIT_CODEX_CACHE_DIR  Dedicated private catalog directory (default <checkout>/data/codex)
  CODEX_BIN               Installed Codex executable (default codex on PATH)

The catalog is refreshed with a 10-second timeout and saved atomically with mode 0600.
Only CLI -c overrides are used: ~/.codex/config.toml and auth files are not replaced.
Sandbox and approval settings are not weakened. WebSockets are disabled; hosted search
is disabled by default. With a supported model, opt in using -- -c 'web_search="live"'.
Deferred tool_search is enabled only for the verified baseline; configured MCP tools still
require their normal approvals. No MCP servers or blanket tool approvals are installed.
An explicit context budget avoids Codex's extra 5% headroom deduction and compacts at 90%.
It is a client budget, not an undocumented Copilot API context-tier switch.
`

interface CliOptions {
  help: boolean
  baseUrl: string
  model: string | undefined
  contextBudget?: number
  codexArgs: string[]
}

function argumentValue(argv: readonly string[], index: number, name: string): string {
  const value = argv[index]
  if (!value || value.startsWith("-")) throw new Error(`${name} requires a value.`)
  return value
}

function configString(value: string): string {
  const text = value.trim()
  if (text.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === "string" && parsed.length > 0) return parsed
    } catch { /* Report a model-selection error, not the raw config value. */ }
  } else if (text.startsWith("'") && text.endsWith("'") && text.length > 2) {
    return text.slice(1, -1)
  } else if (/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(text)) {
    return text
  }
  throw new Error("Could not parse the Codex model override; use --model MODEL.")
}

function passthroughModel(argv: readonly string[], contextBudget?: number): string | undefined {
  let selected: string | undefined
  const choose = (value: string) => {
    if (!value) throw new Error("--model requires a value.")
    if (selected !== undefined && selected !== value) throw new Error("Conflicting explicit Codex model selections; specify one model.")
    selected = value
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === "--") break
    if (arg === "--model" || arg === "-m") {
      choose(argumentValue(argv, ++index, arg))
    } else if (arg.startsWith("--model=")) {
      choose(arg.slice("--model=".length))
    } else if (arg.startsWith("-m") && !arg.startsWith("--") && arg.length > 2) {
      choose(arg.slice(2))
    } else if (arg === "--oss" || arg === "--local-provider" || arg.startsWith("--local-provider=")) {
      throw new Error(`${arg.split("=")[0]} conflicts with the Conduit native Responses provider.`)
    } else {
      let config: string | undefined
      if (arg === "-c" || arg === "--config") config = argumentValue(argv, ++index, arg)
      else if (arg.startsWith("--config=")) config = arg.slice("--config=".length)
      else if (arg.startsWith("-c") && !arg.startsWith("--") && arg.length > 2) config = arg.slice(2)
      if (config === undefined) continue
      const separator = config.indexOf("=")
      const key = config.slice(0, separator).replace(/["'\s]/g, "")
      const value = config.slice(separator + 1)
      if (separator < 0) continue
      if (key === "model") choose(configString(value))
      if (["model_provider", "model_catalog_json", "model_providers"].includes(key) || key.startsWith("model_providers.")) {
        throw new Error(`The helper manages ${key}; use --base-url and --model instead.`)
      }
      if (contextBudget !== undefined && ["model_context_window", "model_auto_compact_token_limit"].includes(key)) {
        throw new Error(`--context-budget manages ${key}; do not also pass a conflicting context override.`)
      }
      if (key === "model_reasoning_summary" && configString(value) !== "none") {
        throw new Error(`${key} is disabled for the Conduit Codex provider.`)
      }
      if (key === "web_search" && !["disabled", "cached", "live", "indexed"].includes(configString(value))) {
        throw new Error("web_search must be disabled, cached, live, or indexed.")
      }
    }
  }
  return selected
}

export function parseCodexArguments(argv: readonly string[], env: Environment = {}): CliOptions {
  let baseUrl = env.CONDUIT_CODEX_BASE_URL ?? DEFAULT_CODEX_BASE_URL
  let explicitModel: string | undefined
  let contextBudget: number | undefined
  const chooseModel = (value: string) => {
    if (explicitModel !== undefined && explicitModel !== value) throw new Error("Conflicting explicit helper model selections; specify one model.")
    explicitModel = value
  }
  let index = 0
  for (; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === "--help" || arg === "-h") return { help: true, baseUrl, model: undefined, codexArgs: [] }
    if (arg === "--") { index++; break }
    if (arg === "--base-url") baseUrl = argumentValue(argv, ++index, arg)
    else if (arg.startsWith("--base-url=")) baseUrl = arg.slice("--base-url=".length)
    else if (arg === "--model" || arg === "-m") chooseModel(argumentValue(argv, ++index, arg))
    else if (arg.startsWith("--model=")) chooseModel(arg.slice("--model=".length))
    else if (arg === "--context-budget" || arg.startsWith("--context-budget=")) {
      const value = arg === "--context-budget" ? argumentValue(argv, ++index, arg) : arg.slice("--context-budget=".length)
      const budget = Number(value)
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(budget) || budget < 4096) {
        throw new Error("--context-budget requires an integer of at least 4096 tokens, for example 872000.")
      }
      if (contextBudget !== undefined && contextBudget !== budget) throw new Error("Conflicting explicit context budgets; specify one budget.")
      contextBudget = budget
    }
    else break
  }
  const codexArgs = argv.slice(index)
  const passedModel = passthroughModel(codexArgs, contextBudget)
  if (explicitModel !== undefined && passedModel !== undefined && explicitModel !== passedModel) {
    throw new Error("Conflicting helper and Codex model selections; specify one model.")
  }
  const model = explicitModel ?? passedModel ?? env.CONDUIT_CODEX_MODEL
  if (model !== undefined && !model.trim()) throw new Error("--model requires a value.")
  return { help: false, baseUrl: normalizeCodexBaseUrl(baseUrl), model, codexArgs, ...(contextBudget !== undefined && { contextBudget }) }
}

export function parseConduitKeyFile(text: string): string | null {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"))
  for (const line of lines) {
    const match = /^\s*(?:export\s+)?CONDUIT_API_KEY\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    let value = match[1] ?? ""
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    return value || null
  }
  const raw = lines.length === 1 ? lines[0] : undefined
  return raw && !/\s/.test(raw) ? raw : null
}

export async function resolveConduitApiKey(repoRoot: string, env: Environment): Promise<string> {
  let key = env.CONDUIT_API_KEY?.trim() || null
  if (!key) {
    try {
      key = parseConduitKeyFile(await readFile(resolve(repoRoot, ".conduit-key"), "utf8"))
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new Error("Cannot read the checkout's .conduit-key; set CONDUIT_API_KEY explicitly.")
      }
    }
  }
  if (!key) throw new Error("Missing Conduit API key. Set CONDUIT_API_KEY or put the key (or CONDUIT_API_KEY=...) in the checkout's .conduit-key.")
  if (/[\r\n]/.test(key)) throw new Error("Invalid Conduit API key: line breaks are not allowed.")
  return key
}

const MAX_CATALOG_BYTES = 2 * 1024 * 1024

async function catalogText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Missing catalog response body.")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_CATALOG_BYTES) {
        await reader.cancel()
        throw new Error("Catalog response exceeds 2 MiB.")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(body)
}

export async function fetchCodexCatalog(
  baseUrl: string,
  apiKey: string,
  fetchImpl: FetchCatalog = fetch,
  timeoutMs = 10_000,
): Promise<CodexCatalog> {
  const signal = AbortSignal.timeout(timeoutMs)
  let response: Response
  try {
    response = await fetchImpl(codexCatalogUrl(baseUrl), {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      redirect: "error",
      signal,
    })
  } catch {
    throw new Error(signal.aborted
      ? "Conduit catalog request timed out; check that the proxy is running."
      : "Cannot reach the Conduit catalog. Check the proxy, --base-url, and that the URL does not redirect.")
  }
  if (response.status === 401 || response.status === 403) throw new Error(`Conduit authentication failed (HTTP ${response.status}); check CONDUIT_API_KEY.`)
  if (!response.ok) throw new Error(`Conduit catalog request failed (HTTP ${response.status}); check proxy model availability.`)
  let data: unknown
  try {
    data = JSON.parse(await catalogText(response))
  } catch {
    throw new Error(signal.aborted
      ? "Conduit catalog request timed out while reading the response."
      : "Malformed Conduit catalog response: expected JSON no larger than 2 MiB.")
  }
  return parseCodexCatalog(data)
}

export async function saveCodexCatalog(catalog: CodexCatalog, baseUrl: string, directory: string, variant?: string): Promise<string> {
  const hash = createHash("sha256").update(normalizeCodexBaseUrl(baseUrl))
  if (variant !== undefined) hash.update("\0").update(variant)
  const fingerprint = hash.digest("hex").slice(0, 16)
  const target = resolve(directory, `models-${fingerprint}.json`)
  const staging = `${target}.${process.pid}.${randomUUID()}.partial`
  let staged = false
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (!(await lstat(directory)).isDirectory()) throw new Error("Cache must be a real directory.")
    await chmod(directory, 0o700)
    const file = await open(staging, "wx", 0o600)
    staged = true
    try {
      await file.writeFile(`${JSON.stringify(catalog, null, 2)}\n`, "utf8")
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(staging, target)
    staged = false
    return target
  } catch {
    throw new Error("Cannot write the private Codex catalog cache; check CONDUIT_CODEX_CACHE_DIR and directory permissions.")
  } finally {
    try {
      if (staged) await rm(staging, { force: true })
    } catch {
      process.stderr.write("conduit-codex: Could not remove a temporary catalog file; check cache directory permissions.\n")
    }
  }
}

async function launchCodex(executable: string, args: string[], env: Environment): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", env: { ...env } })
    const interrupt = () => { child.kill("SIGINT") }
    const terminate = () => { child.kill("SIGTERM") }
    const cleanup = () => {
      process.off("SIGINT", interrupt)
      process.off("SIGTERM", terminate)
    }
    process.on("SIGINT", interrupt)
    process.on("SIGTERM", terminate)
    child.once("error", () => {
      cleanup()
      reject(new Error("Could not start Codex. Install Codex 0.155.1 or set CODEX_BIN to a working executable."))
    })
    child.once("exit", (code, signal) => {
      cleanup()
      resolveExit(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1))
    })
  })
}

export interface CodexLauncherOptions {
  repoRoot: string
  env?: Environment
  fetchImpl?: FetchCatalog
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  launch?: (executable: string, args: string[], env: Environment) => Promise<number>
}

export async function runConduitCodex(argv: readonly string[], options: CodexLauncherOptions): Promise<number> {
  const env = options.env ?? process.env
  try {
    const args = parseCodexArguments(argv, env)
    if (args.help) {
      (options.stdout ?? (text => { process.stdout.write(text) }))(CODEX_HELP)
      return 0
    }
    const key = await resolveConduitApiKey(options.repoRoot, env)
    let catalog = await fetchCodexCatalog(args.baseUrl, key, options.fetchImpl ?? fetch)
    let model = selectCodexModel(catalog, args.model)
    if (args.contextBudget !== undefined) {
      model = withCodexContextBudget(model, args.contextBudget)
      const selectedModel = model
      catalog = { models: catalog.models.map(candidate => candidate.slug === model.slug ? selectedModel : candidate) }
    }
    const cache = env.CONDUIT_CODEX_CACHE_DIR || resolve(options.repoRoot, "data", "codex")
    const variant = args.contextBudget === undefined ? undefined : `${model.slug}:${args.contextBudget}`
    const catalogPath = await saveCodexCatalog(catalog, args.baseUrl, cache, variant)
    const settings = codexConfigOverrides(args.baseUrl, catalogPath, model)
    if (args.contextBudget !== undefined) {
      settings.push(`model_context_window=${model.context_window}`, `model_auto_compact_token_limit=${model.auto_compact_token_limit}`)
    }
    const overrides = settings.flatMap(value => ["-c", value])
    return await (options.launch ?? launchCodex)(env.CODEX_BIN || "codex", [...overrides, ...args.codexArgs], {
      ...env,
      CONDUIT_API_KEY: key,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected Codex launcher failure."
    const report = options.stderr ?? ((text: string) => { process.stderr.write(text) })
    report(`conduit-codex: ${message}\n`)
    return 1
  }
}
