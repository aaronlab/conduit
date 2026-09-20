import { useState, useEffect } from "react"
import { api } from "../lib/api"
import type { ConnectionInfo } from "../lib/api"

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`
}

export function Connect() {
  const [info, setInfo] = useState<ConnectionInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    let active = true
    api.getConnectionInfo()
      .then(data => { if (active) { setInfo(data); setLoading(false) } })
      .catch((e: unknown) => {
        if (active) {
          setError(e instanceof Error ? e.message : "Unable to load connection info.")
          setLoading(false)
        }
      })
    return () => { active = false }
  }, [])

  if (error) return <div className="error-msg">{error}</div>
  if (loading || !info) return <div className="loading"><div className="spinner" /><p>Loading connection info...</p></div>

  const baseUrl = info.base_url
  const browserModel = info.codex.models.find(model => model.verified_capabilities.mcp_browser)

  return (
    <div>
      <h1 className="page-title">Connect</h1>

      <div className="section">
        <div className="section-title">Codex CLI</div>
        <div className="card">
          <p style={{ marginBottom: 12, color: "var(--text-secondary)", fontSize: 13 }}>
            Install Codex {info.codex.cli_version} and Bun, start Conduit, then run this from your Conduit checkout.
            The helper uses your existing CONDUIT_API_KEY or reads the checkout&apos;s .conduit-key locally; it never displays the key.
          </p>
          <div className="code-block">{`./bin/conduit-codex --base-url ${shellQuote(info.codex.provider.base_url)}`}</div>
          <p style={{ marginTop: 12, color: "var(--text-secondary)", fontSize: 13 }}>
            Each launch refreshes the authenticated native model catalog and saves a private local cache.
            Provider and catalog settings are passed with CLI overrides, without replacing your Codex config or login,
            or disabling sandboxing and approvals. Use --model MODEL for an exact selection and -- before other Codex arguments.
          </p>
          {info.codex.default_model ? (
            <p style={{ marginTop: 12, fontSize: 13 }}>
              Available default: <code>{info.codex.default_model}</code>. Unknown or unavailable selections fail rather than switching models.
            </p>
          ) : (
            <p className="error-msg">No compatible Codex models are available yet. Check your Copilot connection and model access.</p>
          )}
          {info.codex.models.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <p style={{ marginBottom: 8, color: "var(--text-secondary)", fontSize: 13 }}>
                Budgets, image support, and reasoning choices reflect current Copilot metadata.
                Live-verified features are identified separately and apply only to the named models.
              </p>
              {info.codex.models.map(model => (
                <div key={model.id} className="model-item" style={{ marginBottom: 8 }}>
                  <code>{model.id}</code>
                  <span style={{ marginLeft: 8, color: "var(--text-secondary)", fontSize: 13 }}>
                    {model.context_window.toLocaleString()}-token input budget
                    {model.vision ? " · images" : " · text only"}
                    {model.reasoning_efforts.length > 0 ? ` · reasoning: ${model.reasoning_efforts.join(", ")}` : ""}
                  </span>
                  {(model.verified_capabilities.freeform_apply_patch
                    || model.verified_capabilities.hosted_web_search) && (
                    <div style={{ marginTop: 4, color: "var(--text-secondary)", fontSize: 13 }}>
                      Live-verified:
                      {model.verified_capabilities.freeform_apply_patch ? " freeform apply_patch;" : ""}
                      {model.verified_capabilities.tool_search ? " deferred tool_search;" : ""}
                      {model.verified_capabilities.structured_outputs ? " strict JSON-schema output;" : ""}
                      {model.verified_capabilities.mcp_browser ? " MCP browser tools and screenshot replay;" : ""}
                      {model.verified_capabilities.hosted_web_search ? ' native Responses hosted web search with URL citations (opt in with web_search="live");' : ""}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <ul style={{ marginTop: 12, paddingLeft: 20, color: "var(--text-secondary)", fontSize: 13 }}>
            {info.codex.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}
          </ul>
        </div>
      </div>

      {browserModel && (
        <div className="section">
          <div className="section-title">Browser automation with MCP</div>
          <div className="card">
            <p style={{ marginBottom: 12, color: "var(--text-secondary)", fontSize: 13 }}>
              Codex {info.codex.cli_version} with Playwright MCP 0.0.82 and {browserModel.id} was verified
              navigating, filling forms, clicking, checking results, and taking screenshots. The next model turn
              successfully consumed text and image tool results through deferred tool_search and namespaced MCP tools.
              This is CLI browser automation, not native computer_call or desktop control.
            </p>
            <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>
              Configure your MCP server explicitly; this helper does not install MCP or add servers to your configuration.
              Verification used an isolated localhost fixture with a headless, isolated browser and only ephemeral,
              allowlisted per-tool approvals. Codex exec defaults to approval policy never, so required MCP tool approvals
              must be configured narrowly. Do not globally bypass sandboxing or approvals.
            </p>
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-title">Claude Code</div>
        <div className="card">
          <p style={{ marginBottom: 12, color: "var(--text-secondary)", fontSize: 13 }}>
            Set these environment variables to route Claude Code through Conduit:
          </p>
          <div className="code-block">{`export ANTHROPIC_BASE_URL=${shellQuote(baseUrl)}
export ANTHROPIC_AUTH_TOKEN='your-conduit-api-key'
unset ANTHROPIC_API_KEY`}</div>
        </div>
      </div>

      <div className="section">
        <div className="section-title">OpenAI-compatible clients</div>
        <div className="card">
          <div className="code-block">{`export OPENAI_BASE_URL=${shellQuote(`${baseUrl}/v1`)}
export OPENAI_API_KEY='your-conduit-api-key'`}</div>
        </div>
      </div>

      {info.endpoints && (
        <div className="section">
          <div className="section-title">Available Endpoints</div>
          <div className="card">
            {Object.entries(info.endpoints).map(([name, ep]) => (
              <div key={name} className="model-item" style={{ marginBottom: 8 }}>
                <code>{baseUrl}{ep}</code>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
