import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { Server } from "node:http"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCodexCatalog } from "../src/lib/codex-catalog"
import {
  fetchCodexCatalog, parseCodexArguments, parseConduitKeyFile, resolveConduitApiKey,
  runConduitCodex, saveCodexCatalog,
} from "../src/lib/codex-cli"
import { DEFAULT_CODEX_BASE_URL } from "../src/lib/codex-config"
import { nativeModel } from "./codex-fixtures"

const repoRoot = resolve(import.meta.dirname, "../../..")
const execute = promisify(execFile)
const catalog = createCodexCatalog([nativeModel(), nativeModel("gpt-5.5"), nativeModel("gpt-5.4-mini"), nativeModel("gpt-6-astra")])
let directory: string
let server: Server | undefined

beforeEach(async () => {
  directory = resolve(repoRoot, "data", `codex-test-${randomUUID()}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
})

afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolveClose, reject) => server!.close(error => error ? reject(error) : resolveClose()))
    server = undefined
  }
  await rm(directory, { recursive: true, force: true })
})

describe("Codex launcher arguments and local key parsing", () => {
  it("defaults to loopback, an available model, and passes CLI arguments without shell expansion", () => {
    expect(parseCodexArguments([])).toEqual({ help: false, baseUrl: DEFAULT_CODEX_BASE_URL, model: undefined, codexArgs: [] })
    expect(parseCodexArguments(["--base-url", "http://localhost:7133", "--model", "gpt-5.5", "--", "exec", "literal $(not-a-command)"]))
      .toEqual({ help: false, baseUrl: "http://localhost:7133/v1", model: "gpt-5.5", codexArgs: ["exec", "literal $(not-a-command)"] })
  })

  it.each([
    ["--", "exec", "--model", "gpt-5.5"],
    ["exec", "-m", "gpt-5.5"],
    ["exec", "-mgpt-5.5"],
    ["exec", "--model=gpt-5.5"],
    ["--", "-c", 'model="gpt-5.5"', "exec"],
    ["--", "--config", "model='gpt-5.5'", "exec"],
    ["--", "--config=model=gpt-5.5", "exec"],
  ])("recognizes explicit model selection in pass-through arguments %j", (...args) => {
    expect(parseCodexArguments(args).model).toBe("gpt-5.5")
  })

  it("honors explicit arguments over environment defaults and never silently resolves conflicts", () => {
    const env = { CONDUIT_CODEX_MODEL: "gpt-5.3-codex", CONDUIT_CODEX_BASE_URL: "https://proxy.example" }
    expect(parseCodexArguments([], env).model).toBe("gpt-5.3-codex")
    expect(parseCodexArguments(["--", "exec", "-m", "gpt-5.5"], env).model).toBe("gpt-5.5")
    expect(parseCodexArguments([], env).baseUrl).toBe("https://proxy.example/v1")
    expect(() => parseCodexArguments(["--model", "first", "--", "exec", "-m", "second"])).toThrow("Conflicting")
    expect(() => parseCodexArguments(["--model", "first", "--model", "second"])).toThrow("Conflicting")
    expect(() => parseCodexArguments(["exec", "-m", "first", "-c", "model=second"])).toThrow("Conflicting")
  })

  it.each([
    ["--base-url"],
    ["--model", "--help"],
    ["--model="],
    ["--", "--oss"],
    ["--", "-c", "model_provider=openai"],
    ["--", "-c", "model_providers.conduit.wire_api=chat"],
    ["--", "-c", '"model_providers" . "conduit".wire_api=chat'],
    ["--", "-c", "model_catalog_json=other.json"],
    ["--", "-c", "model_reasoning_summary=invalid"],
    ["--", "-c", 'model_reasoning_summary=""'],
    ["--", "-c", "web_search=unknown-mode"],
  ])("fails on missing values or conflicting transport overrides %j", (...args) => {
    expect(() => parseCodexArguments(args)).toThrow()
  })

  it("does not interpret positional text after Codex's own separator as a model flag", () => {
    expect(parseCodexArguments(["--", "exec", "--", "--model", "literal"]).model).toBeUndefined()
    expect(parseCodexArguments(["--", "--help"]).codexArgs).toEqual(["--help"])
  })

  it("allows explicit hosted search without changing the safe default", () => {
    expect(parseCodexArguments(["--", "--search", "exec", "Search"]).codexArgs).toEqual(["--search", "exec", "Search"])
    expect(parseCodexArguments(["--", "-c", 'web_search="live"', "exec", "Search"]).codexArgs)
      .toEqual(["-c", 'web_search="live"', "exec", "Search"])
  })

  it.each(["auto", "concise", "detailed", "none"])("allows the explicit reasoning summary mode %s", summary => {
    const args = ["--model", "gpt-6-astra", "--", "-c", `model_reasoning_summary="${summary}"`, "exec", "Test"]
    expect(parseCodexArguments(args)).toMatchObject({
      model: "gpt-6-astra",
      reasoningSummary: summary,
      codexArgs: args.slice(3),
    })
  })

  it("respects the last summary override and ignores positional prompt text", () => {
    expect(parseCodexArguments(["--", "-cmodel_reasoning_summary=concise", "--config=model_reasoning_summary=none"]).reasoningSummary)
      .toBe("none")
    expect(parseCodexArguments(["--", "exec", "--", "-c", "model_reasoning_summary=invalid"]).reasoningSummary)
      .toBeUndefined()
  })

  it("parses repository key assignments as data without evaluating shell syntax", () => {
    expect(parseConduitKeyFile("# ignored\nCONDUIT_API_KEY=fake-key\nOTHER=value\n")).toBe("fake-key")
    expect(parseConduitKeyFile("export CONDUIT_API_KEY='fake-key'\r\n")).toBe("fake-key")
    expect(parseConduitKeyFile('CONDUIT_API_KEY="fake-key"')).toBe("fake-key")
    expect(parseConduitKeyFile("CONDUIT_API_KEY=$(never-execute)")).toBe("$(never-execute)")
    expect(parseConduitKeyFile("# CONDUIT_API_KEY=fake-key")).toBeNull()
    expect(parseConduitKeyFile("raw-test-key\n")).toBe("raw-test-key")
    expect(parseConduitKeyFile("# local key\nraw-test-key\n")).toBe("raw-test-key")
    expect(parseConduitKeyFile("first\nsecond\n")).toBeNull()
  })

  it("prefers an existing environment key and falls back only to the provided fixture checkout", async () => {
    await writeFile(resolve(directory, ".conduit-key"), "CONDUIT_API_KEY=file-test-key\n")
    expect(await resolveConduitApiKey(directory, { CONDUIT_API_KEY: "environment-test-key" })).toBe("environment-test-key")
    expect(await resolveConduitApiKey(directory, {})).toBe("file-test-key")
    await rm(resolve(directory, ".conduit-key"))
    await expect(resolveConduitApiKey(directory, {})).rejects.toThrow("Missing Conduit API key")
  })
})

describe("authenticated and bounded catalog fetching", () => {
  it("uses bearer authentication, native catalog negotiation and a redirect-blocking timeout", async () => {
    const fetcher = vi.fn(async () => Response.json(catalog))
    expect(await fetchCodexCatalog(DEFAULT_CODEX_BASE_URL, "test-key", fetcher)).toEqual(catalog)
    expect(fetcher).toHaveBeenCalledWith(`${DEFAULT_CODEX_BASE_URL}/models?client_version=0.155.1`, {
      headers: { Authorization: "Bearer test-key", Accept: "application/json" },
      redirect: "error",
      signal: expect.any(AbortSignal),
    })
  })

  it.each([401, 403])("fails clearly on HTTP %i without echoing response bodies or credentials", async status => {
    const fetcher = vi.fn(async () => new Response("do-not-print-test-key", { status }))
    await expect(fetchCodexCatalog(DEFAULT_CODEX_BASE_URL, "do-not-print-test-key", fetcher)).rejects.toThrow(`authentication failed (HTTP ${status})`)
  })

  it("reports upstream availability errors, malformed JSON and invalid catalogs", async () => {
    await expect(fetchCodexCatalog(DEFAULT_CODEX_BASE_URL, "test-key", async () => new Response("", { status: 503 }))).rejects.toThrow("HTTP 503")
    await expect(fetchCodexCatalog(DEFAULT_CODEX_BASE_URL, "test-key", async () => new Response("invalid"))).rejects.toThrow("Malformed")
    await expect(fetchCodexCatalog(DEFAULT_CODEX_BASE_URL, "test-key", async () => Response.json({ object: "list", data: [] }))).rejects.toThrow("ModelInfo")
    await expect(fetchCodexCatalog(DEFAULT_CODEX_BASE_URL, "test-key", async () => new Response("x".repeat(2 * 1024 * 1024 + 1)))).rejects.toThrow("2 MiB")
  })

  it("reports unreachable servers and bounded timeouts without exposing the underlying error", async () => {
    await expect(fetchCodexCatalog(DEFAULT_CODEX_BASE_URL, "secret-fixture", async () => { throw new Error("secret-fixture") })).rejects.toThrow("Cannot reach")
    const pending = fetchCodexCatalog(DEFAULT_CODEX_BASE_URL, "test-key", (_url, init) =>
      new Promise((_resolveResponse, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      }), 10)
    await expect(pending).rejects.toThrow("timed out")
  })

  it("keeps the deadline active while receiving a stalled response body", async () => {
    const fetcher = async (_url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"models":'))
        init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true })
      },
    }))
    await expect(fetchCodexCatalog(DEFAULT_CODEX_BASE_URL, "test-key", fetcher, 10)).rejects.toThrow("timed out while reading")
  })
})

describe("private atomic catalog cache and launcher", () => {
  it("writes a 0600 catalog in a 0700 directory, atomically replaces it and leaves no staging files", async () => {
    const cache = resolve(directory, "cache")
    const target = await saveCodexCatalog(catalog, DEFAULT_CODEX_BASE_URL, cache)
    expect((await stat(target)).mode & 0o777).toBe(0o600)
    expect((await stat(cache)).mode & 0o777).toBe(0o700)
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(catalog)
    const next = createCodexCatalog([nativeModel("gpt-6-astra")])
    expect(await saveCodexCatalog(next, DEFAULT_CODEX_BASE_URL, cache)).toBe(target)
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(next)
    expect(await readdir(cache)).toHaveLength(1)
    expect(await readFile(target, "utf8")).not.toContain("CONDUIT_API_KEY")
  })

  it("rejects symlinked or unwritable cache locations without replacing unrelated files", async () => {
    const link = resolve(directory, "cache-link")
    await symlink(directory, link)
    await expect(saveCodexCatalog(catalog, DEFAULT_CODEX_BASE_URL, link)).rejects.toThrow("Cannot write")
    const file = resolve(directory, "not-directory")
    await writeFile(file, "preserve")
    await expect(saveCodexCatalog(catalog, DEFAULT_CODEX_BASE_URL, file)).rejects.toThrow("Cannot write")
    expect(await readFile(file, "utf8")).toBe("preserve")
  })

  it("provides help without fetching, reading keys or launching Codex", async () => {
    const fetcher = vi.fn()
    const launch = vi.fn()
    const stdout = vi.fn()
    const code = await runConduitCodex(["--help"], { repoRoot: resolve(directory, "missing-checkout"), env: {}, fetchImpl: fetcher, launch, stdout })
    expect(code).toBe(0)
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Usage: bin/conduit-codex"))
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("configured MCP tools still\nrequire their normal approvals"))
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("No MCP servers or blanket tool approvals are installed"))
    expect(fetcher).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
  })

  it("uses only CLI overrides, preserves Codex arguments and propagates the child exit code", async () => {
    const launch = vi.fn(async (_executable: string, _args: string[], _env: Readonly<Record<string, string | undefined>>) => 7)
    const stderr = vi.fn()
    const env = { CONDUIT_API_KEY: "only-in-environment", CODEX_BIN: "custom-codex", CONDUIT_CODEX_CACHE_DIR: resolve(directory, "cache") }
    expect(await runConduitCodex(["--", "exec", "-m", "gpt-5.5", "--sandbox", "read-only", "hello"], {
      repoRoot: directory, env, fetchImpl: async () => Response.json(catalog), launch, stderr,
    })).toBe(7)
    expect(launch).toHaveBeenCalledWith("custom-codex", expect.arrayContaining([
      "-c", 'model_provider="conduit"', 'model="gpt-5.5"', 'model_reasoning_summary="none"', 'web_search="disabled"',
    ]), expect.objectContaining({ CONDUIT_API_KEY: "only-in-environment" }))
    const args = launch.mock.calls[0]?.[1]
    expect(args?.slice(-6)).toEqual(["exec", "-m", "gpt-5.5", "--sandbox", "read-only", "hello"])
    expect(args?.join(" ")).not.toContain("only-in-environment")
    expect(args?.join(" ")).not.toMatch(/dangerously-bypass|approval_policy|sandbox_mode/)
    expect(stderr).not.toHaveBeenCalled()
  })

  it("does not launch or reuse a stale cache after unknown models, missing keys or authentication failure", async () => {
    const launch = vi.fn()
    const stderr = vi.fn()
    const cache = resolve(directory, "cache")
    await saveCodexCatalog(catalog, DEFAULT_CODEX_BASE_URL, cache)
    const env = { CONDUIT_API_KEY: "never-print-test-key", CONDUIT_CODEX_CACHE_DIR: cache }
    expect(await runConduitCodex(["--model", "unavailable"], { repoRoot: directory, env, fetchImpl: async () => Response.json(catalog), launch, stderr })).toBe(1)
    expect(stderr).toHaveBeenLastCalledWith(expect.stringContaining("No model was substituted"))
    expect(await runConduitCodex([], { repoRoot: directory, env: {}, launch, stderr })).toBe(1)
    expect(stderr).toHaveBeenLastCalledWith(expect.stringContaining("Missing Conduit API key"))
    expect(await runConduitCodex([], { repoRoot: directory, env, fetchImpl: async () => new Response("never-print-test-key", { status: 401 }), launch, stderr })).toBe(1)
    expect(stderr).toHaveBeenLastCalledWith(expect.stringContaining("authentication failed"))
    expect(stderr.mock.calls.flat().join("")).not.toContain("never-print-test-key")
    expect(launch).not.toHaveBeenCalled()
    expect(await readdir(cache)).toHaveLength(1)
  })

  it("launches Astra with detailed summaries and preserves an explicit opt-out", async () => {
    const launch = vi.fn(async (_executable: string, _args: string[], _env: Readonly<Record<string, string | undefined>>) => 0)
    const options = {
      repoRoot: directory,
      env: { CONDUIT_API_KEY: "test-key", CONDUIT_CODEX_CACHE_DIR: resolve(directory, "cache") },
      fetchImpl: async () => Response.json(catalog), launch,
    }
    expect(await runConduitCodex(["--model", "gpt-6-astra"], options)).toBe(0)
    expect(launch.mock.calls[0]?.[1]).toContain('model_reasoning_summary="detailed"')
    expect(await runConduitCodex(["--model", "gpt-6-astra", "--", "-c", 'model_reasoning_summary="none"'], options)).toBe(0)
    expect(launch.mock.calls[1]?.[1].filter(arg => arg.startsWith("model_reasoning_summary=")))
      .toEqual(['model_reasoning_summary="detailed"', 'model_reasoning_summary="none"'])
  })

  it("fails explicitly instead of silently omitting requested summaries for an unsupported or stale catalog", async () => {
    const launch = vi.fn()
    const stderr = vi.fn()
    const options = {
      repoRoot: directory, env: { CONDUIT_API_KEY: "test-key" },
      fetchImpl: async () => Response.json(catalog), launch, stderr,
    }
    expect(await runConduitCodex(["--model", "gpt-5.5", "--", "-c", 'model_reasoning_summary="concise"'], options)).toBe(1)
    expect(stderr).toHaveBeenLastCalledWith(expect.stringContaining("does not advertise reasoning summaries"))
    const stale = createCodexCatalog([nativeModel("gpt-6-astra")])
    stale.models[0]!.supports_reasoning_summary_parameter = false
    stale.models[0]!.default_reasoning_summary = "none"
    expect(await runConduitCodex(["--model", "gpt-6-astra", "--", "-c", 'model_reasoning_summary="concise"'], {
      ...options, fetchImpl: async () => Response.json(stale),
    })).toBe(1)
    expect(stderr).toHaveBeenLastCalledWith(expect.stringContaining("restart an outdated proxy"))
    expect(launch).not.toHaveBeenCalled()
  })

  it("reports a missing Codex executable clearly after validating the fetched catalog", async () => {
    const stderr = vi.fn()
    expect(await runConduitCodex([], {
      repoRoot: directory,
      env: { CONDUIT_API_KEY: "test-key", CODEX_BIN: resolve(directory, "does-not-exist") },
      fetchImpl: async () => Response.json(catalog),
      stderr,
    })).toBe(1)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Could not start Codex"))
  })

  it("launches the actual Bun entry point against a mock proxy and mock Codex without changing user state", async () => {
    const home = resolve(directory, "home")
    const codexHome = resolve(home, ".codex")
    await mkdir(codexHome, { recursive: true })
    await writeFile(resolve(codexHome, "config.toml"), 'model="preserve-user-setting"\n')
    await writeFile(resolve(codexHome, "auth.json"), '{"fixture":"preserve"}\n')
    const mock = resolve(directory, "mock-codex")
    await writeFile(mock, '#!/usr/bin/env node\nconsole.log(JSON.stringify({args: process.argv.slice(2), keyPresent: process.env.CONDUIT_API_KEY === "subprocess-test-key"}))\n')
    await chmod(mock, 0o700)
    let requestUrl: string | undefined
    let requestAuthorization: string | undefined
    server = createServer((request, response) => {
      requestUrl = request.url
      requestAuthorization = request.headers.authorization
      response.writeHead(200, { "content-type": "application/json", connection: "close" })
      response.end(JSON.stringify(catalog))
    })
    await new Promise<void>(resolveListen => server!.listen(0, "127.0.0.1", resolveListen))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Mock server did not bind.")
    const baseUrl = `http://127.0.0.1:${address.port}`
    const { stdout, stderr } = await execute("bun", [
      resolve(repoRoot, "bin/conduit-codex"), "--base-url", baseUrl, "--", "exec", "--sandbox", "read-only", "Inspect only",
    ], {
      timeout: 10_000,
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: codexHome,
        CODEX_BIN: mock,
        CONDUIT_API_KEY: "subprocess-test-key",
        CONDUIT_CODEX_CACHE_DIR: resolve(directory, "cache"),
      },
    })
    const output = JSON.parse(stdout) as { args: string[]; keyPresent: boolean }
    expect(output.keyPresent).toBe(true)
    expect(output.args.slice(-4)).toEqual(["exec", "--sandbox", "read-only", "Inspect only"])
    expect(output.args).toContain('model="gpt-5.4-mini"')
    expect(output.args.find(arg => arg.startsWith("model_providers.conduit="))).toContain(`${baseUrl}/v1`)
    expect(requestUrl).toBe("/v1/models?client_version=0.155.1")
    expect(requestAuthorization).toBe("Bearer subprocess-test-key")
    expect(stdout + stderr).not.toContain("subprocess-test-key")
    expect(stderr).toBe("")
    expect(await readFile(resolve(codexHome, "config.toml"), "utf8")).toBe('model="preserve-user-setting"\n')
    expect(await readFile(resolve(codexHome, "auth.json"), "utf8")).toBe('{"fixture":"preserve"}\n')
  })
})
