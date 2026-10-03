import { afterEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "../src/config"

afterEach(() => vi.unstubAllEnvs())

describe("proxy listener configuration", () => {
  it("preserves the existing default listener", () => {
    vi.stubEnv("CONDUIT_HOST", undefined)
    vi.stubEnv("CONDUIT_PORT", undefined)
    expect(loadConfig()).toMatchObject({ host: "0.0.0.0", port: 7133 })
  })

  it("allows the managed mobile setup to keep the proxy on loopback", () => {
    vi.stubEnv("CONDUIT_HOST", "127.0.0.1")
    vi.stubEnv("CONDUIT_PORT", "17133")
    expect(loadConfig()).toMatchObject({ host: "127.0.0.1", port: 17133 })
  })
})
