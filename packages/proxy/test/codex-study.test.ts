import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CONDUIT_STUDY_SKILL, installConduitStudySkill } from "../src/lib/codex-study"

const repo = resolve(import.meta.dirname, "../../..")
let root: string
let checkout: string
let home: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "conduit-study-test-"))
  checkout = join(root, "checkout with spaces")
  home = join(root, "gui-home")
  await mkdir(join(checkout, "skills", CONDUIT_STUDY_SKILL, "agents"), { recursive: true })
  await writeFile(join(checkout, "skills", CONDUIT_STUDY_SKILL, "SKILL.md"), "fixture instructions\n")
  await writeFile(join(checkout, "skills", CONDUIT_STUDY_SKILL, "agents", "openai.yaml"), "fixture metadata\n")
  await mkdir(home)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe("opt-in Conduit Study installation", () => {
  it("links only into the dedicated profile and is idempotent", async () => {
    const path = await installConduitStudySkill(checkout, home)
    const target = join(home, "skills", CONDUIT_STUDY_SKILL)
    expect(path).toBe(join(target, "SKILL.md"))
    expect((await lstat(target)).isSymbolicLink()).toBe(true)
    expect(await readlink(target)).toBe(await realpath(join(checkout, "skills", CONDUIT_STUDY_SKILL)))
    expect(await readFile(path, "utf8")).toBe("fixture instructions\n")
    expect(await installConduitStudySkill(checkout, home)).toBe(path)
    expect((await lstat(join(home, "skills"))).mode & 0o777).toBe(0o700)
  })

  it("refuses to replace an existing user skill", async () => {
    const target = join(home, "skills", CONDUIT_STUDY_SKILL)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, "SKILL.md"), "keep my skill")
    await expect(installConduitStudySkill(checkout, home)).rejects.toThrow("not overwritten")
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("keep my skill")
  })

  it("refuses a link owned by another source", async () => {
    await mkdir(join(home, "skills"))
    const other = join(root, "other-skill")
    await mkdir(other)
    const target = join(home, "skills", CONDUIT_STUDY_SKILL)
    await symlink(other, target, "dir")
    await expect(installConduitStudySkill(checkout, home)).rejects.toThrow("not overwritten")
    expect(await readlink(target)).toBe(other)
  })

  it("does not follow a symlinked skills parent", async () => {
    const other = join(root, "other-skills")
    await mkdir(other)
    await symlink(other, join(home, "skills"), "dir")
    await expect(installConduitStudySkill(checkout, home)).rejects.toThrow("real directory")
    await expect(lstat(join(other, CONDUIT_STUDY_SKILL))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("reports missing checkout assets before creating the skill directory", async () => {
    await rm(join(checkout, "skills", CONDUIT_STUDY_SKILL, "SKILL.md"))
    await expect(installConduitStudySkill(checkout, home)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(join(home, "skills"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("ships an explicitly invoked local workflow rather than an official-mode impersonation", async () => {
    const skill = await readFile(join(repo, "skills", CONDUIT_STUDY_SKILL, "SKILL.md"), "utf8")
    const metadata = await readFile(join(repo, "skills", CONDUIT_STUDY_SKILL, "agents", "openai.yaml"), "utf8")
    expect(skill).toMatch(/^---\nname: conduit-study\n/)
    expect(skill).toContain("not OpenAI's")
    expect(skill).toContain("ask one focused question and wait")
    expect(metadata).toContain('display_name: "Study (Conduit local)"')
    expect(metadata).toContain("allow_implicit_invocation: false")
    expect(metadata).not.toContain("dependencies:")
  })
})
