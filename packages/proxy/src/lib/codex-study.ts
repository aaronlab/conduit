import { lstat, mkdir, readlink, realpath, symlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { isRecord } from "./validation"

export const CONDUIT_STUDY_SKILL = "conduit-study"

export async function installConduitStudySkill(repoRoot: string, home: string): Promise<string> {
  const source = await realpath(join(repoRoot, "skills", CONDUIT_STUDY_SKILL))
  for (const file of ["SKILL.md", "agents/openai.yaml"]) {
    if (!(await lstat(join(source, file))).isFile()) {
      throw new Error(`Conduit Study requires a regular ${file} file in this checkout.`)
    }
  }
  if (!(await lstat(home)).isDirectory()) {
    throw new Error("The dedicated GUI home must be a real directory, not a symlink.")
  }
  const skillsRoot = join(resolve(home), "skills")
  await mkdir(skillsRoot, { recursive: true, mode: 0o700 })
  if (!(await lstat(skillsRoot)).isDirectory()) {
    throw new Error("The GUI skills directory must be a real directory, not a symlink.")
  }
  const target = join(skillsRoot, CONDUIT_STUDY_SKILL)
  try {
    await symlink(source, target, "dir")
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error
    if (!(await lstat(target)).isSymbolicLink() || resolve(skillsRoot, await readlink(target)) !== source) {
      throw new Error("An existing conduit-study skill belongs to another source; it was not overwritten.")
    }
  }
  return join(target, "SKILL.md")
}
