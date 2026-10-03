import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { chmod, lstat, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { findOfficialGuiApp, prepareGuiProfile } from "./codex-gui"
import { isRecord } from "./validation"

const execute = promisify(execFile)
export const PASEO_VERSION = "0.10.3"
export const MOBILE_PORT = 6799
export const OFFICIAL_RELAY_ORIGIN = "https://paseo-relay-next.fly.dev"
const PROXY_LABEL = "lab.aaronlab.conduit.proxy"
const MOBILE_LABEL = "lab.aaronlab.conduit.mobile"

export interface MobileOptions {
  repoRoot: string
  bunPath: string
  userHome: string
  home: string
  codexHome: string
  appData: string
  paseoApp: string
}

export async function findBundledCodex(app: string): Promise<string> {
  for (const relative of ["Contents/Resources/codex-cli/bin/codex", "Contents/Resources/codex"]) {
    const path = join(app, relative)
    try {
      const entry = await lstat(path)
      if (entry.isFile() && (entry.mode & 0o111) !== 0) return path
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error
    }
  }
  throw new Error("The official ChatGPT app has no supported bundled Codex executable. Update the mobile integration before retrying.")
}

export function buildMobileConfig(options: MobileOptions, passwordHash: string) {
  if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(passwordHash)) {
    throw new Error("A bcrypt password hash is required; plaintext credentials must not enter the config.")
  }
  return {
    version: 1,
    daemon: {
      listen: `127.0.0.1:${MOBILE_PORT}`,
      auth: { password: passwordHash },
      relay: { enabled: true },
      mcp: { enabled: false, injectIntoAgents: false },
      enableTerminalAgentHooks: false,
    },
    features: {
      webUi: { enabled: true, distDir: join(options.paseoApp, "Contents/Resources/app-dist") },
      dictation: { enabled: false },
      voiceMode: { enabled: false },
    },
    agents: {
      providers: {
        codex: {
          enabled: true,
          label: "Conduit Codex",
          command: [options.bunPath, join(options.repoRoot, "bin/conduit-mobile-codex")],
          env: { CODEX_HOME: options.codexHome },
          paseoTools: { enabled: false },
          models: [{
            id: "gpt-6-astra", label: "Astra via Conduit", isDefault: true,
            thinkingOptions: [{ id: "max", label: "Max", isDefault: true }],
          }],
        },
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
      },
    },
    log: { console: { level: "warn", format: "json" }, file: { level: "warn" } },
  }
}

async function writeExclusive(path: string, text: string): Promise<void> {
  const file = await open(path, "wx", 0o600)
  try { await file.writeFile(text) } finally { await file.close() }
}

export async function prepareMobileHome(options: MobileOptions): Promise<void> {
  const home = resolve(options.home)
  if ([options.userHome, options.codexHome, join(options.userHome, ".paseo")].some(path => resolve(path) === home)) {
    throw new Error("Use a dedicated Conduit mobile home, not an existing personal profile.")
  }
  await mkdir(home, { recursive: true, mode: 0o700 })
  if (!(await lstat(home)).isDirectory()) throw new Error("The mobile home must not be a symlink.")
  const markerPath = join(home, ".conduit-managed.json")
  const expected = { owner: "conduit-mobile", version: 1, repoRoot: options.repoRoot, codexHome: options.codexHome }
  const entries = await readdir(home)
  if (entries.includes(".conduit-managed.json")) {
    const marker: unknown = JSON.parse(await readFile(markerPath, "utf8"))
    if (!isRecord(marker) || Object.entries(expected).some(([key, value]) => marker[key] !== value)) {
      throw new Error("This mobile profile belongs to another configuration; it was not overwritten.")
    }
  } else {
    if (entries.length) throw new Error("The mobile directory is not empty and is not managed by Conduit.")
    await writeExclusive(markerPath, `${JSON.stringify(expected)}\n`)
  }
  await chmod(home, 0o700)
  const passwordPath = join(home, "connection-password")
  let password: string
  try {
    password = (await readFile(passwordPath, "utf8")).trim()
    if (!(await lstat(passwordPath)).isFile() || !/^[a-f0-9]{64}$/.test(password)) throw new Error("Invalid managed connection password.")
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error
    password = randomBytes(32).toString("hex")
    await writeExclusive(passwordPath, `${password}\n`)
  }
  await chmod(passwordPath, 0o600)
  const configPath = join(home, "config.json")
  try {
    await lstat(configPath)
    const config: unknown = JSON.parse(await readFile(configPath, "utf8"))
    const daemon = isRecord(config) && isRecord(config.daemon) ? config.daemon : null
    const auth = daemon && isRecord(daemon.auth) ? daemon.auth : null
    const agents = isRecord(config) && isRecord(config.agents) ? config.agents : null
    const providers = agents && isRecord(agents.providers) ? agents.providers : null
    const codex = providers && isRecord(providers.codex) ? providers.codex : null
    const env = codex && isRecord(codex.env) ? codex.env : null
    const command = [options.bunPath, join(options.repoRoot, "bin/conduit-mobile-codex")]
    if (!(await lstat(configPath)).isFile() || daemon?.listen !== `127.0.0.1:${MOBILE_PORT}`
      || typeof auth?.password !== "string" || !await Bun.password.verify(password, auth.password)
      || env?.CODEX_HOME !== options.codexHome || JSON.stringify(codex?.command) !== JSON.stringify(command)) {
      throw new Error("Existing mobile listener/auth/provider settings differ; review them manually. No config was overwritten.")
    }
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error
    const hash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 12 })
    await writeExclusive(configPath, `${JSON.stringify(buildMobileConfig(options, hash), null, 2)}\n`)
  }
  await chmod(configPath, 0o600)
  await mkdir(join(home, "logs"), { recursive: true, mode: 0o700 })
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

export function mobileServicePlist(options: MobileOptions, kind: "proxy" | "mobile"): string {
  const label = kind === "proxy" ? PROXY_LABEL : MOBILE_LABEL
  const args = kind === "proxy"
    ? [options.bunPath, join(options.repoRoot, "bin/conduit-proxy")]
    : [join(options.paseoApp, "Contents/Resources/bin/paseo"), "daemon", "run", "--home", options.home]
  const path = [join(options.userHome, ".local/bin"), join(options.userHome, ".bun/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(options.repoRoot)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string><key>CONDUIT_HOST</key><string>127.0.0.1</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(join(options.home, "logs", `${kind}.log`))}</string>
<key>StandardErrorPath</key><string>${xml(join(options.home, "logs", `${kind}.log`))}</string>
</dict></plist>
`
}

async function serviceLoaded(label: string): Promise<boolean> {
  try { await execute("launchctl", ["list", label]); return true } catch (error) {
    if (isRecord(error) && error.code === 113) return false
    throw error
  }
}

async function installService(options: MobileOptions, kind: "proxy" | "mobile"): Promise<string> {
  const label = kind === "proxy" ? PROXY_LABEL : MOBILE_LABEL
  const directory = join(options.userHome, "Library/LaunchAgents")
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${label}.plist`)
  const text = mobileServicePlist(options, kind)
  try { await writeExclusive(path, text) } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error
    if (!(await lstat(path)).isFile() || await readFile(path, "utf8") !== text) {
      throw new Error(`Existing ${label} service differs and was not overwritten.`)
    }
  }
  await execute("plutil", ["-lint", path])
  return path
}

export async function repairMobileRelay(
  home: string,
  run: (args: string[]) => Promise<string>,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  const agents: unknown = JSON.parse(await run(["ls"]))
  if (!Array.isArray(agents) || !agents.every(agent => isRecord(agent) && typeof agent.status === "string")) {
    throw new Error("Could not establish whether mobile tasks are idle; the relay was not changed.")
  }
  if (agents.some(agent => !["idle", "closed", "stopped", "completed", "error", "failed"].includes(agent.status))) {
    throw new Error("Finish active mobile tasks before repairing the relay. No settings were changed.")
  }
  const response = await fetchImpl(`${OFFICIAL_RELAY_ORIGIN}/ready`, {
    redirect: "error", signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`The official alternate relay is not ready (HTTP ${response.status}); no settings were changed.`)
  const readiness: unknown = await response.json()
  if (!isRecord(readiness) || readiness.status !== "ready") {
    throw new Error("The official alternate relay did not confirm readiness; no settings were changed.")
  }
  const configPath = join(home, "config.json")
  if (!(await lstat(configPath)).isFile()) throw new Error("The mobile config must be a regular file.")
  const original = await readFile(configPath, "utf8")
  const config: unknown = JSON.parse(original)
  if (!isRecord(config) || !isRecord(config.daemon)) throw new Error("Invalid mobile daemon configuration.")
  const relay = {
    enabled: true,
    endpoint: "paseo-relay-next.fly.dev:443",
    publicEndpoint: "paseo-relay-next.fly.dev:443",
    useTls: true,
    publicUseTls: true,
  }
  await writeExclusive(join(home, `config.before-relay-repair-${Date.now()}.json`), original)
  await run(["daemon", "config", "set", "daemon.relay", JSON.stringify(relay)])
  await run(["daemon", "restart"])
}

export const MOBILE_HELP = `Usage: cxm [setup|start|stop|status|pair|repair-relay|open|import THREAD_UUID]

Paseo ${PASEO_VERSION}: an open-source phone companion for local Codex through Conduit.
setup  Configure private mobile state and per-user startup services.
start  Start the proxy if needed and the mobile daemon.
stop   Stop the mobile daemon only; keep Conduit running.
status Show the real daemon state.
pair   Display the official pairing QR and URL; keep them private.
repair-relay  Check idle tasks, select the documented official relay origin,
              reconnect, and print a new verified pairing QR (for relay 503s).
open   Open the password-protected local Paseo web interface.
import Import an idle Astra desktop thread, explicitly selecting Max and
       default permissions. Quit the official GUI first.

The official ChatGPT app and Paseo do not share a live engine. Finish and quit
the official GUI before importing a saved thread; stop Paseo before reopening
that thread in ChatGPT. Use Paseo on both devices for simultaneous viewing.
Relay is enabled, with upstream application-layer E2EE; both local HTTP
listeners stay on 127.0.0.1. The relay still sees connection metadata.
This is not hosted ChatGPT Chat or an OpenAI subscription connection.

Environment: CONDUIT_MOBILE_HOME, CONDUIT_GUI_HOME, CONDUIT_GUI_DATA_DIR,
CONDUIT_PASEO_APP_PATH. Existing personal profiles and credentials are preserved.
`

export async function runConduitMobile(argv: readonly string[], repoRoot: string): Promise<number> {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) { console.log(MOBILE_HELP); return 0 }
  try {
    const action = argv[0] ?? "status"
    if (!["setup", "start", "stop", "status", "pair", "repair-relay", "open", "import"].includes(action)
      || (action === "import" ? argv.length !== 2 || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(argv[1]!) : argv.length > 1)) {
      throw new Error("Use cxm --help for supported commands and a full native thread UUID.")
    }
    if (process.platform !== "darwin" || !process.getuid) throw new Error("Managed mobile setup currently supports macOS only.")
    const userHome = homedir()
    const options: MobileOptions = {
      repoRoot: resolve(repoRoot), bunPath: process.execPath, userHome,
      home: resolve(process.env.CONDUIT_MOBILE_HOME ?? join(userHome, ".paseo-conduit")),
      codexHome: resolve(process.env.CONDUIT_GUI_HOME ?? join(userHome, ".codex-conduit-gui")),
      appData: resolve(process.env.CONDUIT_GUI_DATA_DIR ?? join(userHome, "Library/Application Support/Conduit ChatGPT")),
      paseoApp: resolve(process.env.CONDUIT_PASEO_APP_PATH ?? join(userHome, "Applications/Paseo.app")),
    }
    const paseo = join(options.paseoApp, "Contents/Resources/bin/paseo")
    if (action === "setup") {
      await execute("codesign", ["--verify", "--deep", "--strict", options.paseoApp])
      const signature = await execute("codesign", ["-dv", "--verbose=2", options.paseoApp])
      if (!signature.stderr.includes("TeamIdentifier=99ZMJMKU9Y")) throw new Error("Unexpected Paseo signing publisher.")
    }
    if (!["stop", "status"].includes(action)) {
      const { stdout: version } = await execute(paseo, ["--version"], { timeout: 10000 })
      if (version.trim() !== PASEO_VERSION) throw new Error(`This integration was tested with Paseo ${PASEO_VERSION}, not ${version.trim()}. Review compatibility before upgrading.`)
    }
    if (action === "setup") {
      await findBundledCodex(await findOfficialGuiApp(userHome, process.env.CONDUIT_GUI_APP_PATH))
      await prepareGuiProfile({ repoRoot: options.repoRoot, bunPath: options.bunPath, home: options.codexHome, appData: options.appData, baseUrl: "http://127.0.0.1:7133/v1" })
      await prepareMobileHome(options)
      await installService(options, "proxy")
      await installService(options, "mobile")
      console.log("Configured Paseo for Conduit. Run cxm start, then cxm pair. No API key was copied to the phone configuration.")
      return 0
    }
    let marker: unknown
    try { marker = JSON.parse(await readFile(join(options.home, ".conduit-managed.json"), "utf8")) } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") throw new Error("Mobile access is not configured. Run cxm setup first.")
      throw error
    }
    if (!isRecord(marker) || marker.owner !== "conduit-mobile" || marker.version !== 1
      || marker.repoRoot !== options.repoRoot || marker.codexHome !== options.codexHome) {
      throw new Error("The selected mobile home does not belong to this Conduit configuration.")
    }
    const domain = `gui/${process.getuid()}`
    if (action === "start") {
      await prepareMobileHome(options)
      for (const [kind, label] of [["proxy", PROXY_LABEL], ["mobile", MOBILE_LABEL]] as const) {
        if (!await serviceLoaded(label)) {
          if (kind === "proxy") {
            let response: Response | undefined
            try { response = await fetch("http://127.0.0.1:7133/health", { signal: AbortSignal.timeout(3000) }) } catch (error) {
              if (!(error instanceof TypeError) && !(isRecord(error) && ["ConnectionRefused", "ECONNREFUSED"].includes(String(error.code)))) throw error
            }
            if (response) {
              if (!response.ok) throw new Error("The existing port 7133 service is unhealthy; it was not replaced.")
              const health: unknown = await response.json()
              if (!isRecord(health) || health.status !== "ok") throw new Error("Port 7133 is occupied by an unexpected service; it was not replaced.")
              console.log("Using the already running proxy; no duplicate proxy service was started.")
              continue
            }
          }
          const path = await installService(options, kind)
          await execute("launchctl", ["bootstrap", domain, path])
        }
      }
      console.log("Startup services loaded. Run cxm status to verify readiness, then cxm pair.")
      return 0
    }
    const password = (await readFile(join(options.home, "connection-password"), "utf8")).trim()
    const env = { ...process.env, PASEO_PASSWORD: password }
    if (action === "stop") {
      if (await serviceLoaded(MOBILE_LABEL)) await execute("launchctl", ["bootout", `${domain}/${MOBILE_LABEL}`])
      else await execute(paseo, ["daemon", "stop", "--home", options.home], { env, timeout: 30000 })
      console.log("Stopped the mobile service; the Conduit proxy was left running.")
    } else if (action === "open") {
      await execute("open", [`http://127.0.0.1:${MOBILE_PORT}`])
      console.log(`Use the separate password in ${join(options.home, "connection-password")}; never use the Conduit API key here.`)
    } else if (action === "import") {
      const app = await findOfficialGuiApp(undefined, process.env.CONDUIT_GUI_APP_PATH)
      const processes = await execute("ps", ["-ax", "-o", "comm="])
      if (processes.stdout.split("\n").some(line => line.trim() === join(app, "Contents/MacOS/ChatGPT"))) {
        throw new Error("Quit the official ChatGPT app before handing a native thread to Paseo. No thread was imported.")
      }
      const imported = await execute(paseo, ["import", argv[1]!, "--provider", "codex", "--home", options.home, "--json"], { env, timeout: 60000 })
      const result: unknown = JSON.parse(imported.stdout)
      if (!isRecord(result) || typeof result.agentId !== "string") throw new Error("Unexpected native thread import result.")
      const details = await execute(paseo, ["inspect", result.agentId, "--home", options.home, "--json"], { env, timeout: 30000 })
      const agent: unknown = JSON.parse(details.stdout)
      if (!isRecord(agent) || agent.Model !== "gpt-6-astra") {
        throw new Error("This imported thread is not Astra. It has not been started; choose its supported model/thinking settings in Paseo.")
      }
      if (!["idle", "created", "stopped"].includes(String(agent.Status))) {
        throw new Error("The imported agent is active. Wait for its turn to finish before changing handoff settings.")
      }
      await execute(paseo, ["agent", "update", result.agentId, "--thinking", "max", "--home", options.home, "--json"], { env, timeout: 30000 })
      await execute(paseo, ["agent", "mode", result.agentId, "auto", "--home", options.home, "--json"], { env, timeout: 30000 })
      console.log(`Imported native thread ${argv[1]} as Paseo agent ${result.agentId}; Max and default permissions explicitly selected.`)
    } else if (action === "pair" || action === "repair-relay") {
      if (action === "repair-relay") {
        await repairMobileRelay(options.home, async args =>
          (await execute(paseo, [...args, "--home", options.home, "--json"], { env, timeout: 90000 })).stdout,
        )
      }
      const result = await execute(paseo, ["daemon", "pair", "--relay", "--home", options.home, "--json"], { env, timeout: 30000, maxBuffer: 1024 * 1024 })
      const pairing: unknown = JSON.parse(result.stdout)
      if (!isRecord(pairing) || typeof pairing.qr !== "string" || typeof pairing.url !== "string") throw new Error("Unexpected Paseo pairing output.")
      try {
        await execute(paseo, ["ls", "--json"], {
          env: { ...process.env, PASEO_HOST: pairing.url, PASEO_HOME: undefined, PASEO_PASSWORD: undefined },
          timeout: 30000,
        })
      } catch (error) {
        await writeFile(join(options.home, "logs", "pairing-probe-error.log"), String(error), { mode: 0o600 })
        throw new Error("The encrypted relay connection failed. No QR was printed; details are in the private pairing-probe-error.log.")
      }
      await writeFile(join(options.home, "pairing.json"), result.stdout, { mode: 0o600 })
      await chmod(join(options.home, "pairing.json"), 0o600)
      console.log(pairing.qr)
      console.log(pairing.url)
      console.log("Mac-to-relay connection verified. Scan this QR in the Paseo phone app; the phone's network still needs to connect successfully. Keep the code/link private.")
    } else {
      const result = await execute(paseo, ["daemon", "status", "--home", options.home, "--json"], { env, timeout: 30000 })
      console.log(result.stdout.trim())
    }
    return 0
  } catch (error) {
    const detail = isRecord(error) && typeof error.code === "string" ? ` (${error.code})` : ""
    console.error(`cxm: ${error instanceof Error ? error.message : String(error)}${detail}`)
    return 1
  }
}
