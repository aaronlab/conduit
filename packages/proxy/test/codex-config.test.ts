import { describe, expect, it } from "vitest"
import { createCodexCatalog } from "../src/lib/codex-catalog"
import { CODEX_VERSION, codexCatalogUrl, codexConfigOverrides, createCodexProvider, normalizeCodexBaseUrl } from "../src/lib/codex-config"
import { nativeModel } from "./codex-fixtures"

describe("Codex provider configuration", () => {
  it.each([
    ["http://127.0.0.1:7133", "http://127.0.0.1:7133/v1"],
    ["http://localhost:7133/v1/", "http://localhost:7133/v1"],
    ["https://proxy.example/conduit/", "https://proxy.example/conduit/v1"],
    ["https://proxy.example/conduit/v1", "https://proxy.example/conduit/v1"],
  ])("normalizes %s without duplicating /v1", (input, expected) => {
    expect(normalizeCodexBaseUrl(input)).toBe(expected)
    expect(codexCatalogUrl(input)).toBe(`${expected}/models?client_version=${CODEX_VERSION}`)
  })

  it.each(["not a URL", "file:///catalog", "ftp://proxy.example", "https://user:secret@proxy.example", "http://proxy.example?key=secret", "http://proxy.example#fragment"])("rejects unsafe base URL %s", value => {
    expect(() => normalizeCodexBaseUrl(value)).toThrow("Invalid Conduit base URL")
  })

  it("uses a custom non-OpenAI Responses provider and no unverified transports", () => {
    expect(createCodexProvider("http://127.0.0.1:7133")).toEqual({
      name: "Conduit",
      base_url: "http://127.0.0.1:7133/v1",
      env_key: "CONDUIT_API_KEY",
      wire_api: "responses",
      requires_openai_auth: false,
      supports_websockets: false,
      supports_standalone_web_search: false,
    })
  })

  it("quotes config values and leaves approvals, sandbox, and auth files alone", () => {
    const model = createCodexCatalog([nativeModel()]).models[0]!
    const overrides = codexConfigOverrides("http://127.0.0.1:7133", '/checkout/private "catalog"/models.json', model)
    expect(overrides).toContain('model_provider="conduit"')
    expect(overrides).toContain('model="gpt-5.3-codex"')
    expect(overrides).toContain('model_catalog_json="/checkout/private \\"catalog\\"/models.json"')
    expect(overrides).toContain('model_reasoning_summary="none"')
    expect(overrides).toContain('web_search="disabled"')
    expect(overrides.join("\n")).not.toMatch(/sandbox|approval|dangerously|auth\.json|config\.toml/)
  })
})
