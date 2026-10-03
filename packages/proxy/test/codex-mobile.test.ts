import { execFile } from "node:child_process"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildMobileConfig, findBundledCodex, mobileServicePlist, privateAuthorizationUrl, repairMobileRelay, MOBILE_HELP, MOBILE_PORT, OFFICIAL_RELAY_ORIGIN } from "../src/lib/codex-mobile"
import type { MobileOptions } from "../src/lib/codex-mobile"

const execute = promisify(execFile)
const repo = resolve(import.meta.dirname, "../../..")
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "conduit-mobile-test-")) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function options(): MobileOptions {
  return {
    repoRoot: join(root, "checkout with spaces"), bunPath: "/trusted/bun", userHome: root,
    home: join(root, "mobile"), codexHome: join(root, "gui"), appData: join(root, "app-data"),
    paseoApp: join(root, "Paseo.app"),
  }
}

describe("mobile provider and startup configuration", () => {
  it("provides help and rejects malformed imports before accessing apps or credentials", async () => {
    const env = { PATH: process.env.PATH, HOME: root }
    const { stdout } = await execute("bun", [join(repo, "bin/cxm"), "--help"], { env, timeout: 10000 })
    expect(stdout).toContain("Paseo 0.10.3")
    expect(stdout).toContain("import THREAD_UUID")
    await expect(execute("bun", [join(repo, "bin/cxm"), "import", "not-a-uuid"], { env, timeout: 10000 }))
      .rejects.toMatchObject({ code: 1 })
    await expect(lstat(join(root, ".paseo-conduit"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("keeps the native provider, execution profile, loopback binding and independent password", () => {
    const opts = options()
    const config = buildMobileConfig(opts, `$2b$12$${"a".repeat(53)}`)
    expect(config.daemon.listen).toBe(`127.0.0.1:${MOBILE_PORT}`)
    expect(config.daemon.relay.enabled).toBe(true)
    expect(config.agents.providers.codex.env.CODEX_HOME).toBe(opts.codexHome)
    expect(config.agents.providers.codex.command).toEqual([opts.bunPath, join(opts.repoRoot, "bin/conduit-mobile-codex")])
    expect(config.agents.providers.codex.models[0]).toMatchObject({ id: "gpt-6-astra", thinkingOptions: [{ id: "max" }] })
    expect(config.features.voiceMode.enabled).toBe(false)
    expect(config.daemon.mcp.injectIntoAgents).toBe(false)
    expect(JSON.stringify(config)).not.toMatch(/OPENAI_API_KEY|CONDUIT_API_KEY|OPENAI_BASE_URL|danger-full-access/)
    expect(() => buildMobileConfig(opts, "plaintext-password")).toThrow("bcrypt")
  })

  it("writes foreground launchd jobs without placing credentials in argv or plist", () => {
    const opts = { ...options(), repoRoot: `${root}/code & tools` }
    const mobile = mobileServicePlist(opts, "mobile")
    const proxy = mobileServicePlist(opts, "proxy")
    expect(mobile).toContain("<string>daemon</string><string>run</string>")
    expect(mobile).toContain("code &amp; tools")
    expect(proxy).toContain("<string>127.0.0.1</string>")
    expect(proxy).toContain("bin/conduit-proxy")
    expect(mobile).toContain("<key>RunAtLoad</key><true/>")
    expect(mobile + proxy).not.toMatch(/CONDUIT_API_KEY|PASEO_PASSWORD|connection-password|remote-debugging/)
  })

  it("explains that phone handoff is not simultaneous official-desktop control", () => {
    expect(MOBILE_HELP).toContain("do not share a live engine")
    expect(MOBILE_HELP).toContain("stop Paseo before reopening")
    expect(MOBILE_HELP).toContain("Relay is enabled")
  })

  it("limits the private network to the existing Paseo port without a system VPN or inherited auth key", () => {
    const plist = mobileServicePlist(options(), "private")
    expect(plist).toContain("bin/tsnet-proxy")
    expect(plist).toContain("<string>conduit-mobile</string><string>6799</string><string>6799</string>")
    expect(plist).toContain("<key>TS_AUTHKEY</key><string></string>")
    expect(plist).toContain("<key>TS_NO_LOGS_NO_SUPPORT</key><string>true</string>")
    expect(plist).not.toMatch(/tailscaled|userspace-networking|funnel|socks5|7133|CONDUIT_API_KEY|PASEO_PASSWORD/)
  })

  it("opens only the latest official HTTPS authorization link, not an arbitrary log URL", () => {
    expect(privateAuthorizationUrl("https://login.tailscale.com/a/old\nhttps://login.tailscale.com/a/new-token"))
      .toBe("https://login.tailscale.com/a/new-token")
    expect(privateAuthorizationUrl("https://example.test/a/token")).toBeNull()
    expect(privateAuthorizationUrl("http://login.tailscale.com/a/token")).toBeNull()
  })
})

describe("official bundled Codex discovery", () => {
  it("supports the relocated bundle and prefers it over the legacy executable", async () => {
    const app = join(root, "ChatGPT.app")
    const modern = join(app, "Contents/Resources/codex-cli/bin/codex")
    const legacy = join(app, "Contents/Resources/codex")
    await mkdir(join(app, "Contents/Resources/codex-cli/bin"), { recursive: true })
    await writeFile(modern, "modern")
    await writeFile(legacy, "legacy")
    await chmod(modern, 0o700)
    await chmod(legacy, 0o700)
    expect(await findBundledCodex(app)).toBe(modern)
    await rm(modern)
    expect(await findBundledCodex(app)).toBe(legacy)
  })

  describe("relay 503 repair", () => {
    it("backs up configuration and changes only the relay through the supported CLI", async () => {
      const configPath = join(root, "config.json")
      const original = '{"daemon":{"auth":{"password":"keep-hash"},"relay":{"enabled":true}},"agents":{"keep":true}}\n'
      await writeFile(configPath, original)
      const calls: string[][] = []
      const run = async (args: string[]) => {
        calls.push(args)
        return args[0] === "ls" ? '[{"status":"closed"}]' : "{}"
      }
      const fetcher = vi.fn(async () => Response.json({ status: "ready" }))
      await repairMobileRelay(root, run, fetcher)
      expect(fetcher).toHaveBeenCalledWith(`${OFFICIAL_RELAY_ORIGIN}/ready`, {
        redirect: "error", signal: expect.any(AbortSignal),
      })
      expect(calls[1]!.slice(0, 4)).toEqual(["daemon", "config", "set", "daemon.relay"])
      expect(JSON.parse(calls[1]![4]!)).toEqual({
        enabled: true, endpoint: "paseo-relay-next.fly.dev:443",
        publicEndpoint: "paseo-relay-next.fly.dev:443", useTls: true, publicUseTls: true,
      })
      expect(calls[2]).toEqual(["daemon", "restart"])
      expect(JSON.stringify(calls)).not.toContain("keep-hash")
      expect(await readFile(configPath, "utf8")).toBe(original)
      const backups = (await readdir(root)).filter(name => name.startsWith("config.before-relay-repair-"))
      expect(backups).toHaveLength(1)
      expect(await readFile(join(root, backups[0]!), "utf8")).toBe(original)
      expect((await lstat(join(root, backups[0]!))).mode & 0o777).toBe(0o600)
    })

    it("does not interrupt active work to repair networking", async () => {
      const run = vi.fn(async () => '[{"status":"running"}]')
      const fetcher = vi.fn(async () => Response.json({ status: "ready" }))
      await expect(repairMobileRelay(root, run, fetcher)).rejects.toThrow("Finish active")
      expect(run).toHaveBeenCalledTimes(1)
      expect(fetcher).not.toHaveBeenCalled()
    })

    it("refuses an unavailable alternate relay rather than silently printing a bad QR", async () => {
      const run = vi.fn(async () => "[]")
      await expect(repairMobileRelay(root, run, async () => new Response("", { status: 503 }))).rejects.toThrow("HTTP 503")
      expect(run).toHaveBeenCalledTimes(1)
    })

    it("does not print or save a pairing QR when its encrypted connection probe fails", async () => {
      const opts = options()
      const directory = join(opts.paseoApp, "Contents/Resources/bin")
      await mkdir(directory, { recursive: true })
      const paseo = join(directory, "paseo")
      await writeFile(paseo, `#!/usr/bin/env node
  if(process.argv.includes("--version")) console.log("0.10.3");
  else if(process.argv[2]==="daemon"&&process.argv[3]==="pair") console.log(JSON.stringify({qr:"PRIVATE_QR_FIXTURE",url:"https://app.paseo.sh/#offer=private-fixture"}));
  else { console.error("fixture relay unavailable"); process.exitCode=1; }
  `, { mode: 0o700 })
      await mkdir(join(opts.home, "logs"), { recursive: true })
      await writeFile(join(opts.home, ".conduit-managed.json"), JSON.stringify({
        owner: "conduit-mobile", version: 1, repoRoot: repo, codexHome: opts.codexHome,
      }))
      await writeFile(join(opts.home, "connection-password"), "fixture-password")
      const env = {
        PATH: process.env.PATH, HOME: root, CONDUIT_MOBILE_HOME: opts.home,
        CONDUIT_GUI_HOME: opts.codexHome, CONDUIT_PASEO_APP_PATH: opts.paseoApp,
      }
      await expect(execute("bun", [join(repo, "bin/cxm"), "pair"], { env, timeout: 10000 }))
        .rejects.toMatchObject({ code: 1, stdout: "" })
      await expect(lstat(join(opts.home, "pairing.json"))).rejects.toMatchObject({ code: "ENOENT" })
      const errorLog = join(opts.home, "logs/pairing-probe-error.log")
      expect(await readFile(errorLog, "utf8")).toContain("fixture relay unavailable")
      expect((await lstat(errorLog)).mode & 0o777).toBe(0o600)
    })
  })

  it("does not silently substitute an unrelated PATH executable", async () => {
    await expect(findBundledCodex(root)).rejects.toThrow("no supported bundled Codex")
  })
})

describe("private managed mobile home", () => {
  it("generates and verifies bcrypt using Bun, preserves existing settings and rejects conflicts", async () => {
    const opts = options()
    const script = `
      import {prepareMobileHome} from ${JSON.stringify(join(repo, "packages/proxy/src/lib/codex-mobile.ts"))};
      import {readFile,writeFile,stat} from "node:fs/promises";
      const options=JSON.parse(process.argv[1]);
      await prepareMobileHome(options);
      const path=options.home+"/config.json";
      const key=(await readFile(options.home+"/connection-password","utf8")).trim();
      const config=JSON.parse(await readFile(path,"utf8"));
      const verified=await Bun.password.verify(key,config.daemon.auth.password);
      config.features.dictation.enabled=true;
      await writeFile(path,JSON.stringify(config));
      await prepareMobileHome(options);
      const preserved=JSON.parse(await readFile(path,"utf8")).features.dictation.enabled;
      const keyUnchanged=key===(await readFile(options.home+"/connection-password","utf8")).trim();
      config.daemon.listen="0.0.0.0:6799";
      await writeFile(path,JSON.stringify(config));
      let rejected=false;
      try { await prepareMobileHome(options) } catch(error) { rejected=error.message.includes("differ"); }
      const unchanged=JSON.parse(await readFile(path,"utf8")).daemon.listen==="0.0.0.0:6799";
      console.log(JSON.stringify({verified,preserved,keyUnchanged,rejected,unchanged,plaintextLeaked:JSON.stringify(config).includes(key),
        homeMode:(await stat(options.home)).mode&511,keyMode:(await stat(options.home+"/connection-password")).mode&511}));
    `
    const { stdout } = await execute("bun", ["-e", script, JSON.stringify(opts)], { timeout: 15000 })
    expect(JSON.parse(stdout)).toEqual({
      verified: true, preserved: true, keyUnchanged: true, rejected: true, unchanged: true,
      plaintextLeaked: false, homeMode: 0o700, keyMode: 0o600,
    })
    expect((await lstat(join(opts.home, "config.json"))).mode & 0o777).toBe(0o600)
  })

  it("refuses unrelated existing directories before writing configuration", async () => {
    const opts = options()
    await mkdir(opts.home)
    await writeFile(join(opts.home, "keep.txt"), "keep")
    const script = `import{prepareMobileHome}from${JSON.stringify(join(repo, "packages/proxy/src/lib/codex-mobile.ts"))};await prepareMobileHome(JSON.parse(process.argv[1]));`
    await expect(execute("bun", ["-e", script, JSON.stringify(opts)])).rejects.toMatchObject({ code: 1 })
    expect(await readFile(join(opts.home, "keep.txt"), "utf8")).toBe("keep")
    await expect(lstat(join(opts.home, "connection-password"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
