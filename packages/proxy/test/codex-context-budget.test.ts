import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCodexCatalog, parseCodexCatalog, selectCodexModel, withCodexContextBudget } from "../src/lib/codex-catalog"
import { parseCodexArguments, runConduitCodex, saveCodexCatalog } from "../src/lib/codex-cli"
import { DEFAULT_CODEX_BASE_URL } from "../src/lib/codex-config"
import { parseResponsesPayload } from "../src/lib/responses-request"
import { nativeModel } from "./codex-fixtures"

function astraCatalog() {
  const model = nativeModel("gpt-6-astra")
  model.capabilities.limits = {
    max_context_window_tokens: 1_178_000, max_prompt_tokens: 1_050_000, max_output_tokens: 128_000,
  }
  model.capabilities.supports.reasoning_effort = ["low", "medium", "high", "xhigh", "max"]
  return createCodexCatalog([model, nativeModel("gpt-5.4-mini")])
}

describe("explicit usable Codex context budgets", () => {
  it("delivers exactly 872k usable tokens instead of silently reducing them by 5%", () => {
    const original = selectCodexModel(astraCatalog(), "gpt-6-astra")
    const snapshot = structuredClone(original)
    const model = withCodexContextBudget(original, 872_000)
    expect(model.context_window).toBe(872_000)
    expect(model.max_context_window).toBe(872_000)
    expect(Math.floor(model.context_window * model.effective_context_window_percent / 100)).toBe(872_000)
    expect(model.auto_compact_token_limit).toBe(784_800)
    expect(Math.min(model.auto_compact_token_limit, Math.floor(model.context_window * 0.9))).toBe(784_800)
    expect(parseCodexCatalog({ models: [model] }).models[0]).toEqual(model)
    expect(original).toEqual(snapshot)
    expect(original.context_window).toBe(1_050_000)
    expect(original.effective_context_window_percent).toBe(95)
  })

  it.each([0, 1, 4095, -1, NaN, Infinity, 872_000.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid numeric budgets: %s", (tokens) => {
    expect(() => withCodexContextBudget(selectCodexModel(astraCatalog(), "gpt-6-astra"), tokens)).toThrow("integer")
  })

  it("rejects budgets above the advertised input limit even if below total context capacity", () => {
    expect(() => withCodexContextBudget(selectCodexModel(astraCatalog(), "gpt-6-astra"), 1_050_001)).toThrow("advertised input limit")
  })

  it("parses explicit budgets without consuming Codex max/search options", () => {
    const args = ["--model", "gpt-6-astra", "--context-budget", "872000", "--", "-c", 'model_reasoning_effort="max"', "-c", 'web_search="live"']
    expect(parseCodexArguments(args)).toMatchObject({
      model: "gpt-6-astra", contextBudget: 872_000,
      codexArgs: ["-c", 'model_reasoning_effort="max"', "-c", 'web_search="live"'],
    })
    expect(parseCodexArguments(["--context-budget=872000"]).contextBudget).toBe(872_000)
    expect(parseCodexArguments([])).not.toHaveProperty("contextBudget")
  })

  it.each(["", "872k", "0", "4095", "0x10000", "1e6", "872000.5", "Infinity"])("rejects malformed budget arguments: %s", (value) => {
    expect(() => parseCodexArguments([`--context-budget=${value}`])).toThrow("--context-budget")
  })

  it("rejects conflicting window/compaction overrides rather than overriding a requested budget silently", () => {
    for (const key of ["model_context_window", "model_auto_compact_token_limit"]) {
      expect(() => parseCodexArguments(["--context-budget", "872000", "--", "-c", `${key}=999999`])).toThrow("manages")
    }
    expect(() => parseCodexArguments(["--context-budget", "872000", "--context-budget", "800000"])).toThrow("Conflicting")
    expect(() => parseCodexArguments(["--context-budget"])).toThrow("requires")
  })

  it("preserves max effort and never invents a server-side context-tier field", () => {
    const payload = parseResponsesPayload({ model: "gpt-6-astra", input: "Search", reasoning: { effort: "max" }, tools: [{ type: "web_search" }] })
    expect(payload.reasoning).toEqual({ effort: "max" })
    expect(payload).not.toHaveProperty("context_tier")
    expect(payload).not.toHaveProperty("model_context_window")
  })
})

describe("budget-specific launcher catalogs", () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "conduit-budget-test-")) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it("uses a private separate catalog and CLI overrides, without modifying user settings or the default cache", async () => {
    const catalog = astraCatalog()
    const cache = join(directory, "cache")
    const normalPath = await saveCodexCatalog(catalog, DEFAULT_CODEX_BASE_URL, cache)
    const home = join(directory, "home")
    await mkdir(home)
    const userConfig = 'model_reasoning_effort="high"\nmodel_context_window=128000\n'
    await writeFile(join(home, "config.toml"), userConfig)
    const launch = vi.fn(async (_binary: string, _args: string[], _env: Readonly<Record<string, string | undefined>>) => 0)
    const stderr = vi.fn()
    expect(await runConduitCodex([
      "--model", "gpt-6-astra", "--context-budget", "872000", "--",
      "-c", 'model_reasoning_effort="max"', "-c", 'web_search="live"', "exec", "Search",
    ], {
      repoRoot: directory,
      env: { CONDUIT_API_KEY: "test-key", CONDUIT_CODEX_CACHE_DIR: cache, CODEX_HOME: home },
      fetchImpl: async () => Response.json(catalog), launch, stderr,
    })).toBe(0)
    const args = launch.mock.calls[0]![1]
    expect(args).toContain("model_context_window=872000")
    expect(args).toContain("model_auto_compact_token_limit=784800")
    expect(args).toContain('model_reasoning_effort="max"')
    const pathSetting = args.find(arg => arg.startsWith("model_catalog_json="))
    expect(pathSetting).toBeDefined()
    const budgetPath: string = JSON.parse(pathSetting!.slice("model_catalog_json=".length))
    expect(budgetPath).not.toBe(normalPath)
    const configured = parseCodexCatalog(JSON.parse(await readFile(budgetPath, "utf8")))
    expect(selectCodexModel(configured, "gpt-6-astra").effective_context_window_percent).toBe(100)
    expect(selectCodexModel(configured, "gpt-5.4-mini")).toEqual(selectCodexModel(catalog, "gpt-5.4-mini"))
    expect(await readFile(normalPath, "utf8")).toContain('"context_window": 1050000')
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe(userConfig)
    expect(stderr).not.toHaveBeenCalled()
  })

  it("does not launch when the requested budget exceeds the current provider limit", async () => {
    const launch = vi.fn()
    const stderr = vi.fn()
    expect(await runConduitCodex(["--model", "gpt-6-astra", "--context-budget", "1050001"], {
      repoRoot: directory, env: { CONDUIT_API_KEY: "test-key" },
      fetchImpl: async () => Response.json(astraCatalog()), launch, stderr,
    })).toBe(1)
    expect(launch).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("advertised input limit"))
  })
})
