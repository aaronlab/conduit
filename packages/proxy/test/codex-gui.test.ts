import { execFile } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildGuiConfig, ensureManagedGuiDirectory, guiLaunchArguments, prepareGuiProfile, validateGuiProfilePaths } from "../src/lib/codex-gui"
import { createCodexCatalog, DEFAULT_CODEX_REASONING_SUMMARY } from "../src/lib/codex-catalog"
import { nativeModel } from "./codex-fixtures"

const execute = promisify(execFile)
const repo = resolve(import.meta.dirname, "../../..")
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "conduit-gui-test-")) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function options() {
  return {
    repoRoot: join(root, "checkout"),
    bunPath: "/trusted/path with spaces/bun",
    home: join(root, "profile"),
    appData: join(root, "app-data"),
    baseUrl: "http://127.0.0.1:7133",
  }
}

describe("dedicated official GUI configuration", () => {
  it("uses supported provider auth without embedding credentials or lowering GUI permissions", () => {
    const config = buildGuiConfig(options(), join(root, "models.json"))
    expect(config).toContain('model_provider = "conduit"')
    expect(config).toContain('model_reasoning_effort = "max"')
    expect(config).toContain(`model_reasoning_summary = ${JSON.stringify(DEFAULT_CODEX_REASONING_SUMMARY)}`)
    expect(config).toContain('model_reasoning_summary = "detailed"')
    expect(config).toContain("model_context_window = 872000")
    expect(config).toContain('web_search = "live"')
    expect(config).toContain('approval_policy = "on-request"')
    expect(config).toContain('sandbox_mode = "workspace-write"')
    expect(config).toContain('[desktop]\nenabled-reasoning-efforts = ["low", "medium", "high", "xhigh", "max", "ultra", "persistent"]')
    expect(config).toContain("[model_providers.conduit.auth]")
    expect(config).toContain('command = "/trusted/path with spaces/bun"')
    expect(config).toContain("--stdio-token")
    expect(config).not.toMatch(/env_key|experimental_bearer_token|OPENAI_API_KEY|requires_openai_auth|danger-full-access|remote-debugging/)
  })

  it("launches only the supported app with separate homes and no debugging port or secret argv", () => {
    const args = guiLaunchArguments("/Applications/ChatGPT.app", options())
    expect(args).toEqual([
      "-n", "-a", "/Applications/ChatGPT.app",
      "--env", `CODEX_HOME=${join(root, "profile")}`,
      "--env", `CODEX_ELECTRON_USER_DATA_PATH=${join(root, "app-data")}`,
      "--args", `--user-data-dir=${join(root, "app-data")}`,
    ])
    expect(args.join(" ")).not.toMatch(/API_KEY|remote-debugging|disable-web-security|no-sandbox/)
  })

  it("refuses personal/root paths, existing unrelated data and symlinked profiles", async () => {
    expect(() => validateGuiProfilePaths(join(root, ".codex"), join(root, "gui"), root)).toThrow("personal")
    expect(() => validateGuiProfilePaths(join(root, "x"), join(root, "x"), root)).toThrow("separate")
    expect(() => validateGuiProfilePaths(join(root, "x"), root, root)).toThrow("personal")
    const existing = join(root, "existing")
    await mkdir(existing)
    await writeFile(join(existing, "preserve.txt"), "keep")
    await expect(ensureManagedGuiDirectory(existing)).rejects.toThrow("not managed")
    expect(await readFile(join(existing, "preserve.txt"), "utf8")).toBe("keep")
    const link = join(root, "link")
    await symlink(existing, link)
    await expect(ensureManagedGuiDirectory(link)).rejects.toThrow("symlinks")
  })

  it("creates a private owned directory and preserves existing managed data", async () => {
    const target = join(root, "owned")
    await ensureManagedGuiDirectory(target)
    await writeFile(join(target, "preferences.json"), '{"keep":true}')
    await ensureManagedGuiDirectory(target)
    expect((await stat(target)).mode & 0o777).toBe(0o700)
    expect((await stat(join(target, ".conduit-gui-managed.json"))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(target, "preferences.json"), "utf8")).toBe('{"keep":true}')
  })

  it("rejects stale Astra catalogs that would silently suppress the requested summary", async () => {
    const opts = options()
    await mkdir(opts.repoRoot)
    await writeFile(join(opts.repoRoot, ".conduit-key"), "gui-fixture-key\n")
    const source = nativeModel("gpt-6-astra")
    source.capabilities.supports.reasoning_effort = ["max"]
    const catalog = createCodexCatalog([source])
    catalog.models[0]!.supports_reasoning_summary_parameter = false
    catalog.models[0]!.default_reasoning_summary = "none"
    await expect(prepareGuiProfile(opts, async () => Response.json(catalog))).rejects.toThrow("does not advertise reasoning summaries")
  })

  it("uses real TOML, preserves settings and installs Study only on request", async () => {
    const opts = options()
    await mkdir(opts.repoRoot)
    await writeFile(join(opts.repoRoot, ".conduit-key"), "CONDUIT_API_KEY=gui-fixture-key\n")
    const source = nativeModel("gpt-6-astra")
    source.capabilities.limits = { max_context_window_tokens: 1178000, max_prompt_tokens: 1050000, max_output_tokens: 128000 }
    source.capabilities.supports.reasoning_effort = ["low", "medium", "high", "xhigh", "max"]
    const catalog = createCodexCatalog([source])
    const script = `
      import {prepareGuiProfile} from ${JSON.stringify(join(repo, "packages/proxy/src/lib/codex-gui.ts"))};
      import {readFile,appendFile,writeFile,mkdir} from "node:fs/promises";
      const options=JSON.parse(process.argv[1]);
      const catalog=JSON.parse(process.argv[2]);
      const fetcher=async(_url,init)=>{
        if(init.headers.Authorization!=="Bearer gui-fixture-key") throw new Error("wrong fixture auth");
        return Response.json(catalog);
      };
      const first=await prepareGuiProfile(options,fetcher);
      await appendFile(first.configPath,'\\n[mcp_servers.fixture]\\ncommand="preserve-user-command"\\n');
      const second=await prepareGuiProfile(options,fetcher);
      const config=Bun.TOML.parse(await readFile(second.configPath,"utf8"));
      const model=JSON.parse(await readFile(second.catalogPath,"utf8")).models[0];
      const custom=(await readFile(second.configPath,"utf8"))
        .replace('model_reasoning_effort = "max"','model_reasoning_effort = "high"')
        .replace(/^enabled-reasoning-efforts = .+$/m,'enabled-reasoning-efforts = ["high"]');
      await writeFile(second.configPath,custom);
      await prepareGuiProfile(options,fetcher);
      const preserved=Bun.TOML.parse(await readFile(second.configPath,"utf8"));
      const autoInstalled=await Bun.file(options.home+"/skills/conduit-study/SKILL.md").exists();
      const skillRoot=options.repoRoot+"/skills/conduit-study";
      await mkdir(skillRoot+"/agents",{recursive:true});
      await writeFile(skillRoot+"/SKILL.md","fixture Study instructions");
      await writeFile(skillRoot+"/agents/openai.yaml","fixture metadata");
      const installed=await prepareGuiProfile({...options,installStudy:true},fetcher);
      const studyContent=await readFile(installed.studySkillPath,"utf8");
      const afterStudy=Bun.TOML.parse(await readFile(installed.configPath,"utf8"));
      console.log(JSON.stringify({config,model,preserved,autoInstalled,studySkillPath:installed.studySkillPath,studyContent,afterStudy}));
    `
    const { stdout } = await execute("bun", ["-e", script, JSON.stringify(opts), JSON.stringify(catalog)], { timeout: 10_000 })
    const result = JSON.parse(stdout)
    expect(result.config.model_provider).toBe("conduit")
    expect(result.config.model_reasoning_effort).toBe("max")
    expect(result.config.model_reasoning_summary).toBe("detailed")
    expect(result.config.desktop["enabled-reasoning-efforts"]).toEqual(["low", "medium", "high", "xhigh", "max", "ultra", "persistent"])
    expect(result.config.mcp_servers.fixture.command).toBe("preserve-user-command")
    expect(result.config.model_providers.conduit.auth.command).toBe(opts.bunPath)
    expect(result.model.default_reasoning_level).toBe("max")
    expect(result.model.default_reasoning_summary).toBe("detailed")
    expect(result.model.context_window * result.model.effective_context_window_percent / 100).toBe(872000)
    expect(result.preserved.model_reasoning_effort).toBe("high")
    expect(result.preserved.desktop["enabled-reasoning-efforts"]).toEqual(["high"])
    expect(result.preserved.mcp_servers.fixture.command).toBe("preserve-user-command")
    expect(result.autoInstalled).toBe(false)
    expect(result.studySkillPath).toBe(join(opts.home, "skills", "conduit-study", "SKILL.md"))
    expect(result.studyContent).toBe("fixture Study instructions")
    expect(result.afterStudy).toEqual(result.preserved)
    expect(stdout).not.toContain("gui-fixture-key")
  })
})

describe("GUI command entry points", () => {
  it("provides setup help without opening an app or accessing a provider", async () => {
    const { stdout, stderr } = await execute("bun", [join(repo, "bin/cxg"), "--help"], {
      timeout: 10_000, env: { PATH: process.env.PATH, HOME: root, CONDUIT_CODEX_BASE_URL: "invalid" },
    })
    expect(stdout).toContain("official ChatGPT desktop GUI")
    expect(stdout).toContain("No debugging port")
    expect(stdout).toContain("--install-study")
    expect(stdout).toContain("not OpenAI's hosted Study Mode")
    expect(stderr).toBe("")
  })

  it("supplies only the fixture checkout's key through a private pipe and refuses ordinary invocation", async () => {
    const checkout = join(root, "checkout")
    await mkdir(join(checkout, "bin"), { recursive: true })
    await copyFile(join(repo, "bin/conduit-auth-token"), join(checkout, "bin/conduit-auth-token"))
    await symlink(join(repo, "packages"), join(checkout, "packages"))
    await writeFile(join(checkout, ".conduit-key"), "CONDUIT_API_KEY=fixture-private-token\n")
    const { stdout, stderr } = await execute("bun", [join(checkout, "bin/conduit-auth-token"), "--stdio-token"])
    expect(stdout).toBe("fixture-private-token\n")
    expect(stderr).toBe("")
    await expect(execute("bun", [join(checkout, "bin/conduit-auth-token")])).rejects.toMatchObject({ code: 2, stdout: "" })
  })
})
