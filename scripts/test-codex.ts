import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { isRecord } from "../packages/proxy/src/lib/validation"
import { fetchCodexCatalog, parseCodexArguments, resolveConduitApiKey } from "../packages/proxy/src/lib/codex-cli"
import { codexConfigOverrides, normalizeCodexBaseUrl } from "../packages/proxy/src/lib/codex-config"
import { selectCodexModel, withCodexContextBudget } from "../packages/proxy/src/lib/codex-catalog"
import { codexRuntimeContextWindow, hasMcpImage, isSuccessfulMcpCall } from "../packages/proxy/src/lib/codex-output"

const args = process.argv.slice(2)
if (args.includes("--help")) {
  console.log(`Usage: bun run test:codex [--model MODEL] [--base-url URL] [--browser]
                          [--reasoning-effort EFFORT] [--context-budget TOKENS] [--web-search]

Opt-in, billable integration tests against your running Conduit proxy.
Uses a temporary Codex home/workspace; does not edit personal configuration.
Requires Codex 0.155.1 or compatible. --browser additionally requires Chrome
and a cached Playwright MCP 0.0.82 (bunx @playwright/mcp@0.0.82 --help).
Reasoning defaults to low when advertised. Explicit context budgets are verified
against Codex runtime events; this is not a full-window capacity stress test.

Environment: CONDUIT_API_KEY (or repository .conduit-key), CODEX_BIN,
CONDUIT_BASE_URL, CONDUIT_CODEX_MODEL, CONDUIT_CHROME_PATH.`)
  process.exit(0)
}

let selectedModel = process.env.CONDUIT_CODEX_MODEL
let baseUrl = process.env.CONDUIT_BASE_URL ?? "http://127.0.0.1:7133"
let browser = false
let webSearch = false
let reasoningEffort: string | undefined
let contextBudget: number | undefined
for (let index = 0; index < args.length; index++) {
  const argument = args[index]
  if (argument === "--browser") browser = true
  else if (argument === "--web-search") webSearch = true
  else if (argument === "--model" || argument === "--base-url" || argument === "--reasoning-effort" || argument === "--context-budget") {
    const value = args[++index]
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`)
    if (argument === "--model") selectedModel = value
    else if (argument === "--base-url") baseUrl = value
    else if (argument === "--reasoning-effort") reasoningEffort = value
    else contextBudget = parseCodexArguments(["--context-budget", value]).contextBudget
  } else throw new Error(`Unknown option: ${argument}. Use --help.`)
}

const apiRoot = normalizeCodexBaseUrl(baseUrl)
const apiKey = await resolveConduitApiKey(fileURLToPath(new URL("..", import.meta.url)), process.env)

const binary = process.env.CODEX_BIN ?? "codex"
const versionProcess = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "pipe" })
const [versionCode, version, versionError] = await Promise.all([
  versionProcess.exited, new Response(versionProcess.stdout).text(), new Response(versionProcess.stderr).text(),
])
if (versionCode !== 0) throw new Error(`Codex does not run: ${versionError.trim()}`)
const clientVersion = version.match(/\d+\.\d+\.\d+/)?.[0]
if (!clientVersion) throw new Error("Could not determine the Codex CLI version.")

const catalog = await fetchCodexCatalog(apiRoot, apiKey)
let selected = selectCodexModel(catalog, selectedModel)
if (contextBudget !== undefined) {
  selected = withCodexContextBudget(selected, contextBudget)
  const configured = selected
  catalog.models = catalog.models.map(model => model.slug === configured.slug ? configured : model)
}
if (reasoningEffort !== undefined && !selected.supported_reasoning_levels.some(level => level.effort === reasoningEffort)) {
  throw new Error(`${selected.slug} does not advertise reasoning effort ${JSON.stringify(reasoningEffort)}.`)
}
const model = selected.slug

const temporary = await mkdtemp(join(tmpdir(), "conduit-codex-"))
const home = join(temporary, "home")
const workspace = join(temporary, "workspace")
let fixture: ReturnType<typeof Bun.serve> | undefined

async function run(prompt: string, extra: string[] = []): Promise<Array<Record<string, unknown>>> {
  const overrides = codexConfigOverrides(apiRoot, join(temporary, "models.json"), selected)
  overrides.push("model_providers.conduit.request_max_retries=0", "model_providers.conduit.stream_max_retries=0")
  if (reasoningEffort !== undefined) overrides.push(`model_reasoning_effort=${JSON.stringify(reasoningEffort)}`)
  else if (selected.supported_reasoning_levels.some(level => level.effort === "low")) overrides.push('model_reasoning_effort="low"')
  if (contextBudget !== undefined) {
    overrides.push(`model_context_window=${selected.context_window}`, `model_auto_compact_token_limit=${selected.auto_compact_token_limit}`)
  }
  const child = Bun.spawn([
    binary, "exec", "--strict-config", "--skip-git-repo-check",
    ...(contextBudget === undefined ? ["--ephemeral"] : []),
    "--ignore-user-config", "--ignore-rules", "--sandbox", "workspace-write",
    "--json", "--cd", workspace,
    ...overrides.flatMap(value => ["-c", value]),
    ...extra, prompt,
  ], {
    cwd: workspace,
    env: { ...process.env, CODEX_HOME: home, CONDUIT_API_KEY: apiKey },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
  let timedOut = false
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM") }, 180_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    if (timedOut) throw new Error("Codex smoke test exceeded 180 seconds.")
    if (code !== 0) throw new Error(`Codex exited ${code}: ${stderr.slice(-3000)}\n${stdout.slice(-3000)}`)
    const events = stdout.split("\n").filter(Boolean).map((line) => {
      const event: unknown = JSON.parse(line)
      if (!isRecord(event)) throw new Error("Invalid Codex JSONL event.")
      return event
    })
    const failure = events.find((event) => event.type === "error" || event.type === "turn.failed")
    if (failure) throw new Error(`Codex reported a failed turn: ${JSON.stringify(failure)}`)
    assert(events.some((event) => event.type === "turn.completed"), "Codex did not complete the turn.")
    return events
  } finally {
    clearTimeout(timeout)
  }
}

function completedItems(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return events.flatMap((event) => event.type === "item.completed" && isRecord(event.item) ? [event.item] : [])
}

try {
  await mkdir(home, { mode: 0o700 })
  await mkdir(workspace)
  await writeFile(join(temporary, "models.json"), JSON.stringify(catalog), { mode: 0o600 })
  console.log(`Testing ${version.trim()} through Conduit with ${model}. Copilot usage charges may apply.`)

  const tools = completedItems(await run(
    "In this isolated test workspace, use the shell tool to print CONDUIT_SHELL_OK. " +
    "Use apply_patch to create codex-smoke.txt containing exactly CONDUIT_PATCH_OK and a newline. " +
    "Read the file using the shell to verify it. Do not use networking. " +
    "Only after all steps succeed, reply with exactly CONDUIT_CODEX_OK.",
  ))
  assert(tools.some((item) => item.type === "command_execution" && item.exit_code === 0 && String(item.aggregated_output).includes("CONDUIT_SHELL_OK")),
    "The shell tool was not successfully exercised.")
  assert(tools.some((item) => item.type === "file_change" && item.status === "completed"), "apply_patch was not successfully exercised.")
  assert.equal(await readFile(join(workspace, "codex-smoke.txt"), "utf8"), "CONDUIT_PATCH_OK\n")
  assert(tools.some((item) => item.type === "agent_message" && String(item.text).trim() === "CONDUIT_CODEX_OK"))
  console.log("PASS: shell, custom apply_patch, multi-turn tool outputs and file verification")

  const schemaPath = join(temporary, "output-schema.json")
  await writeFile(schemaPath, JSON.stringify({
    type: "object", properties: { ok: { type: "boolean" }, value: { type: "integer" } },
    required: ["ok", "value"], additionalProperties: false,
  }))
  const structured = completedItems(await run("Without using tools, return an object with ok true and value 42.", ["--output-schema", schemaPath]))
  const answer = structured.findLast((item) => item.type === "agent_message" && typeof item.text === "string")
  assert(answer && typeof answer.text === "string", "Missing structured response.")
  assert.deepEqual(JSON.parse(answer.text), { ok: true, value: 42 })
  console.log("PASS: Codex --output-schema")

  if (webSearch) {
    const search = completedItems(await run(
      "Use native live web search to find the official OpenAI Codex GitHub repository now. " +
      "Return its official HTTPS URL with a source citation. Do not use shell tools or local files.",
      ["-c", 'web_search="live"'],
    ))
    assert(search.some(item => item.type === "web_search" && isRecord(item.action) && item.action.type === "search"),
      "Codex did not perform an actual native web search.")
    assert(search.some(item => item.type === "agent_message" && String(item.text).includes("https://github.com/openai/codex")),
      "The search answer did not include the expected official source.")
    console.log("PASS: native live web search and official source")
  }

  if (browser) {
    let verified = false
    fixture = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/verify" && request.method === "POST") {
          verified = (await request.text()) === "CONDUIT_BROWSER_TEST"
          return new Response(verified ? "BROWSER_VERIFIED" : "Wrong code", { status: verified ? 200 : 400 })
        }
        return new Response(`<!doctype html><html><head><title>Conduit browser test</title>
<style>body{font:24px system-ui;padding:60px}input,button{font:inherit;padding:12px;margin:12px}</style></head>
<body><h1>Conduit isolated browser test</h1><label for="code">Access code</label><input id="code">
<button id="verify">Verify</button><p id="result">Not verified</p>
<script>document.getElementById('verify').onclick=async()=>{const r=await fetch('/verify',{method:'POST',body:document.getElementById('code').value});document.getElementById('result').textContent=await r.text()}</script></body></html>`,
        { headers: { "content-type": "text/html" } })
      },
    })
    const origin = `http://127.0.0.1:${fixture.port}`
    const health = await fetch(origin, { signal: AbortSignal.timeout(5000) })
    assert.equal(health.status, 200, "The local browser fixture is not responsive.")
    const toolNames = ["browser_navigate", "browser_fill_form", "browser_click", "browser_take_screenshot", "browser_snapshot", "browser_close"]
    const mcpArgs = [
      "--no-install", "@playwright/mcp@0.0.82", "--headless", "--isolated",
      "--browser=chrome", `--allowed-origins=${origin}`, "--block-service-workers", "--no-webmcp",
      "--viewport-size=1024,768", "--caps=vision", "--image-responses=allow",
      ...(process.env.CONDUIT_CHROME_PATH ? [`--executable-path=${process.env.CONDUIT_CHROME_PATH}`] : []),
    ]
    // Approvals are confined to this temporary fixture server and its explicit tool allowlist.
    const approvals = toolNames.map((name) => `${name}={approval_mode="approve"}`).join(",")
    const mcp = `{command="bunx",args=${JSON.stringify(mcpArgs)},enabled_tools=${JSON.stringify(toolNames)},tools={${approvals}},required=true,startup_timeout_sec=30,tool_timeout_sec=30}`
    const results = completedItems(await run(
      `Use only the Playwright MCP tools. Navigate to ${origin}, fill Access code with CONDUIT_BROWSER_TEST ` +
      "using browser_fill_form, click Verify, confirm BROWSER_VERIFIED, then take and inspect a screenshot " +
      'using browser_take_screenshot with scale="css" and fullPage=false, without setting filename. ' +
      "The screenshot must be returned as an image, not just a file link. " +
      "Do not use shell tools, JavaScript evaluation or other websites. " +
      "Only after all steps succeed, reply with exactly CONDUIT_BROWSER_OK.",
      ["-c", `mcp_servers.playwright=${mcp}`],
    ))
    assert(verified, "The real browser did not submit the correct test form.")
    assert(!results.some((item) => item.type === "command_execution"), "The browser test used a shell instead of MCP.")
    for (const name of ["browser_navigate", "browser_fill_form", "browser_click", "browser_take_screenshot"]) {
      assert(results.some((item) => isSuccessfulMcpCall(item, name)), `${name} did not complete successfully.`)
    }
    const screenshots = results.filter((item) => item.type === "mcp_tool_call" && item.tool === "browser_take_screenshot")
    const screenshot = screenshots.find((item) => isSuccessfulMcpCall(item, "browser_take_screenshot") && hasMcpImage(item))
    const diagnostics = screenshots.map(item => ({
      status: item.status,
      result: isRecord(item.result) && Array.isArray(item.result.content)
        ? item.result.content.map((part: unknown) => isRecord(part) ? { type: part.type, text: typeof part.text === "string" ? part.text.slice(0, 400) : undefined } : null)
        : null,
    }))
    assert(screenshot, `No screenshot image was returned to Codex: ${JSON.stringify(diagnostics)}`)
    assert(results.some((item) => item.type === "agent_message" && String(item.text).trim() === "CONDUIT_BROWSER_OK"))
    console.log("PASS: isolated MCP browser navigation, typing, clicking and screenshot/image feedback")
  }
  if (contextBudget !== undefined) {
    const observed = new Set<number>()
    for await (const file of new Bun.Glob("sessions/**/*.jsonl").scan({ cwd: home })) {
      for (const line of (await readFile(join(home, file), "utf8")).split("\n").filter(Boolean)) {
        const tokens = codexRuntimeContextWindow(JSON.parse(line))
        if (tokens !== null) observed.add(tokens)
      }
    }
    assert.deepEqual([...observed], [contextBudget], "Codex did not report the requested usable runtime context budget.")
    console.log(`PASS: runtime model_context_window is exactly ${contextBudget} tokens (not a full-window load test)`)
  }
  console.log("All requested Codex smoke checks passed.")
} finally {
  if (fixture) await fixture.stop(true)
  await rm(temporary, { recursive: true, force: true })
}
