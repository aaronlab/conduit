import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createCodexCatalog, parseCodexCatalog, selectCodexModel } from "../src/lib/codex-catalog"
import { nativeModel } from "./codex-fixtures"

const execute = promisify(execFile)
const repo = resolve(import.meta.dirname, "../../..")
let root: string
let server: Server | undefined

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "conduit-cx-test-")) })
afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done()))
    server = undefined
  }
  await rm(root, { recursive: true, force: true })
})

describe("cx shortcut", () => {
  it("shows the exact preset and permission warning without a running proxy or key", async () => {
    const { stdout, stderr } = await execute("bun", [join(repo, "bin/cx"), "--help"], {
      timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: root, CONDUIT_CODEX_BASE_URL: "invalid-url" },
    })
    expect(stdout).toContain("gpt-6-astra")
    expect(stdout).toContain("max reasoning")
    expect(stdout).toContain("detailed reasoning summaries")
    expect(stdout).toContain("872000")
    expect(stdout).toContain("live web search")
    expect(stdout).toContain("--dangerously-bypass-approvals-and-sandbox")
    expect(stdout).toContain("does not grant OS/root permissions")
    expect(stderr).toBe("")
  })

  it.each([
    { label: "default summaries", extra: [], summary: "detailed", hidden: "false" },
    { label: "explicit concise summaries", extra: ["-c", 'model_reasoning_summary="concise"'], summary: "concise", hidden: "false" },
    { label: "explicit summary opt-out", extra: ["-c", 'model_reasoning_summary="none"', "-c", "hide_agent_reasoning=true"], summary: "none", hidden: "true" },
  ])("preserves cwd, permissions, budgets and arguments with $label through a symlink", async ({ extra, summary, hidden }) => {
    const workspace = join(root, "project with spaces")
    const home = join(root, "home")
    const cache = join(root, "cache")
    const link = join(root, "cx")
    await mkdir(workspace)
    await mkdir(home)
    await symlink(join(repo, "bin/cx"), link)
    await writeFile(join(home, "config.toml"), 'model_reasoning_effort="high"\n')
    await writeFile(join(home, "auth.json"), '{"fixture":"preserve-login"}\n')
    const mock = join(root, "mock-codex")
    await writeFile(mock, '#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),keyPresent:process.env.CONDUIT_API_KEY==="cx-fixture-key"}))\n')
    await chmod(mock, 0o700)

    const source = nativeModel("gpt-6-astra")
    source.capabilities.limits = {
      max_context_window_tokens: 1178000, max_prompt_tokens: 1050000, max_output_tokens: 128000,
    }
    source.capabilities.supports.reasoning_effort = ["low", "medium", "high", "xhigh", "max"]
    let authorized = false
    server = createServer((request, response) => {
      authorized = request.headers.authorization === "Bearer cx-fixture-key"
      response.writeHead(200, { "content-type": "application/json", connection: "close" })
      response.end(JSON.stringify(createCodexCatalog([source])))
    })
    await new Promise<void>(done => server!.listen(0, "127.0.0.1", done))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Mock catalog did not start.")
    const prompt = "Keep this literal: $(not-a-shell-command)"
    const { stdout, stderr } = await execute("bun", [link, ...extra, "exec", prompt], {
      timeout: 10_000, cwd: workspace,
      env: {
        PATH: process.env.PATH, HOME: root, CODEX_HOME: home, CODEX_BIN: mock,
        CONDUIT_API_KEY: "cx-fixture-key", CONDUIT_CODEX_CACHE_DIR: cache,
        CONDUIT_CODEX_BASE_URL: `http://127.0.0.1:${address.port}`,
      },
    })
    const output = JSON.parse(stdout) as { args: string[]; cwd: string; keyPresent: boolean }
    expect(authorized).toBe(true)
    expect(output.keyPresent).toBe(true)
    expect(await realpath(output.cwd)).toBe(await realpath(workspace))
    expect(output.args).toContain('model="gpt-6-astra"')
    expect(output.args).toContain('model_reasoning_effort="max"')
    expect(output.args).toContain('model_reasoning_summary="detailed"')
    expect(output.args).toContain("hide_agent_reasoning=false")
    expect(output.args.filter(arg => arg.startsWith("model_reasoning_summary=")).at(-1))
      .toBe(`model_reasoning_summary="${summary}"`)
    expect(output.args.filter(arg => arg.startsWith("hide_agent_reasoning=")).at(-1))
      .toBe(`hide_agent_reasoning=${hidden}`)
    expect(output.args).toContain('web_search="live"')
    expect(output.args).toContain("--dangerously-bypass-approvals-and-sandbox")
    expect(output.args).toContain("model_context_window=872000")
    expect(output.args).toContain("model_auto_compact_token_limit=784800")
    expect(output.args.slice(-2)).toEqual(["exec", prompt])
    const setting = output.args.find(arg => arg.startsWith("model_catalog_json="))
    expect(setting).toBeDefined()
    const path: string = JSON.parse(setting!.slice("model_catalog_json=".length))
    const model = selectCodexModel(parseCodexCatalog(JSON.parse(await readFile(path, "utf8"))), "gpt-6-astra")
    expect(model.context_window * model.effective_context_window_percent / 100).toBe(872000)
    expect(model.supports_reasoning_summary_parameter).toBe(true)
    expect(model.default_reasoning_summary).toBe("detailed")
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe('model_reasoning_effort="high"\n')
    expect(await readFile(join(home, "auth.json"), "utf8")).toBe('{"fixture":"preserve-login"}\n')
    expect(stdout + stderr).not.toContain("cx-fixture-key")
    expect(stderr).toBe("")
  })
})
