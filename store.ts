import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import { KEHIKOT_DIR, moduleDir, moduleFile, within } from 'kehikot-module-protocol'

import { ID } from './manifest.ts'

/**
 * Where this app keeps what is its own — inside the project, never beside the
 * program.
 *
 * ## What moved
 *
 * Two files — the configured suites (`suites.json`) and what has been run
 * against a reference (`runs.json`) — used to sit in one `data/` directory
 * beside this program, for every project at once. The convention every module
 * on a kehikot host follows now is that a module keeps its data in the project
 * itself, so both live at
 *
 *     <project>/.kehikot/tests/suites.json
 *     <project>/.kehikot/tests/runs.json
 *
 * The folder name and the joins come from `kehikot-module-protocol`
 * (`moduleDir`, `moduleFile`), not from this file: four modules answering
 * "where does my data live" separately would be four answers. The path IS the
 * partition — a suite does not say which project it belongs to, because the
 * file it is in already does — and "how this project is tested" finally means
 * this project rather than this machine.
 *
 * ## Where the project comes from, and what happens without one
 *
 * The page is told by the host, in `kehikot.context.projectPath`, and sends it
 * with every read and write. An agent over MCP names it in a `project`
 * argument. When there is none this answers `nowhere`: reads are empty and say
 * so, writes are refused with `NOWHERE`. It does NOT fall back to
 * `process.cwd()`, to this program's folder or to the last project somebody
 * used. A silently wrong location is worse than a loud absent one — the essay
 * in `kehikko-checklist/store.ts` is the long form, and this file follows it
 * rather than reaching its own answer.
 *
 * ## The fence
 *
 * A project path arrives over the wire into functions that create directories
 * and write files. It is resolved with `realpathSync`, and `.kehikot` and this
 * module's folder inside it are each checked to really be inside the project
 * after resolution — a `.kehikot` that is a symlink to somewhere else is the
 * case a string comparison misses. File names are constants in this program and
 * never come from a request.
 *
 * ## The `.gitignore` is the host's business
 *
 * Whether a project commits its `.kehikot/` is a per-project checkbox in the
 * host (`shareKehikot` in its `server/projects.ts`). This module never writes a
 * project's `.gitignore`.
 */

/** The two files this module keeps. Constants; never a string from a caller. */
export type FileName = 'suites' | 'runs'

/** As long as a path may be, matching the protocol's own `LIMITS.PATH`. */
const MAX_PROJECT = 4096

/** One of this module's files in one project, or why there is not one. Creates nothing. */
export type Place = { path: string; root: string } | { nowhere: true } | { trouble: string }

export function place(projectPath: string | null | undefined, name: FileName): Place {
  const root = projectRoot(projectPath)
  if (root === null) return { nowhere: true }
  if ('trouble' in root) return { trouble: root.trouble }

  /* Both levels, outermost first, so a `.kehikot` pointing out of the project is
     refused by its own name. Only what exists can be resolved, and only what
     exists can escape — which is why `makeDir` asks again after creating. */
  for (const dir of [join(root.path, KEHIKOT_DIR), ours(root.path)]) {
    if (existsSync(dir)) {
      const escaped = escapes(root.path, dir)
      if (escaped) return { trouble: escaped }
    }
  }
  const path = moduleFile(root.path, ID, name) as string
  if (existsSync(path)) {
    const escaped = escapes(root.path, path)
    if (escaped) return { trouble: escaped }
  }
  return { path, root: root.path }
}

/** Make this module's folder under a resolved project, fenced again after it exists. A sentence back if refused. */
export function makeDir(root: string): string | null {
  const dir = ours(root)
  mkdirSync(dir, { recursive: true })
  for (const made of [join(root, KEHIKOT_DIR), dir]) {
    const escaped = escapes(root, made)
    if (escaped) return escaped
  }
  return null
}

/**
 * The project as this app names it to itself — absolute, real — or null for
 * none or a refused one. Used wherever two spellings of one project (`/p`,
 * `/p/`, a symlink) have to compare equal, e.g. which project a live run is in.
 */
export function projectOf(projectPath: string | null | undefined): string | null {
  const root = projectRoot(projectPath)
  return root !== null && 'path' in root ? root.path : null
}

/** The sentence for "no project is open", written once because every door says it. */
export const NOWHERE =
  'no project is open, so there is nowhere to keep this. How a project is tested lives in that project, at '
  + '.kehikot/tests/ inside it, and this app will not guess which project was meant — a guess writes somebody’s '
  + 'suites into a folder they will never look in. Open a project on this canvas, or pass `project` as the absolute '
  + 'path of the project folder — the same path a host puts in `kehikot.context.projectPath`.'

function ours(root: string): string {
  return moduleDir(root, ID) as string
}

function projectRoot(projectPath: string | null | undefined): { path: string } | { trouble: string } | null {
  if (typeof projectPath !== 'string') return null
  const raw = projectPath.trim()
  if (!raw) return null
  if (raw.length > MAX_PROJECT) return { trouble: 'that project path is longer than any path on this machine can be.' }
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      return { trouble: 'that project path has a control character in it, and no real path does.' }
    }
  }
  if (!isAbsolute(raw)) {
    return {
      trouble:
        `"${raw}" is not an absolute path. A project is somewhere on this machine, and a relative path would be `
        + 'resolved against whatever directory this app happens to have been started in.',
    }
  }
  try {
    const resolved = realpathSync(raw)
    if (!statSync(resolved).isDirectory()) {
      return { trouble: `"${raw}" is not a folder, so there is nowhere under it to keep anything.` }
    }
    return { path: resolved }
  } catch {
    return { trouble: `there is no folder at "${raw}" on this machine, so nothing can be read or written under it.` }
  }
}

function escapes(root: string, child: string): string | null {
  let real: string
  try {
    real = realpathSync(child)
  } catch {
    return `${child} could not be resolved, so this app will not read or write through it.`
  }
  if (within(root, real)) return null
  return (
    `${child} resolves to ${real}, which is outside the project it claims to be inside. Nothing has been read or `
    + 'written: a folder that points somewhere else is how one project’s suites end up in another’s, and it is '
    + 'refused rather than followed.'
  )
}

/* ------------------------------------------------------------------ *
 * The old store beside the program, handed out to the projects it belongs to
 * ------------------------------------------------------------------ */

/**
 * Where the OLD store was.
 *
 * `TESTS_DATA` used to move the live store, and now moves only where the legacy
 * one is looked for (`run.sh` still sets it to this program's own `data/`). The
 * tests set it to a temporary directory on every run, and that is not optional:
 * a test that left it unset would open a temporary project with this
 * repository's real `data/` in reach, adopt somebody's suites into it, and then
 * delete them with the temporary directory.
 */
export function legacyDir(): string {
  return process.env.TESTS_DATA ?? join(process.cwd(), 'data') // kehikot-storage: allow pre-.kehikot location, read only to migrate it
}

/**
 * Whose an old entry is, judged by the directory it runs in.
 *
 * Every suite records the absolute directory it runs in, and every run copies
 * it — so unlike most legacy data, this can be placed rather than guessed:
 *
 * - `'mine'` — the directory is inside this project, and no folder between the
 *   two is itself a repository (`.git`) or a kehikot project (`.kehikot`). The
 *   second half is what stops a project at `~` claiming every suite on the
 *   machine: a suite in `~/Projects/foo` belongs to `foo` when `foo` is a
 *   repository, not to the first enclosing folder somebody happened to open.
 * - `'unplaced'` — it names no directory, or one that no longer exists. Nothing
 *   says where it belongs, so it goes to the first project that opens.
 * - `'theirs'` — it is somewhere else, and waits for that project to open.
 */
export function claim(root: string, dir: string): 'mine' | 'unplaced' | 'theirs' {
  if (!dir || !isAbsolute(dir)) return 'unplaced'
  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    return 'unplaced'
  }
  if (!within(root, real)) return 'theirs'
  for (let at = real; at !== root; at = dirname(at)) {
    if (existsSync(join(at, '.git')) || existsSync(join(at, KEHIKOT_DIR))) return 'theirs'
    if (dirname(at) === at) break
  }
  return 'mine'
}

/**
 * Move this project's share of one legacy file into the project.
 *
 * `split` is the file's own: it gets the parsed legacy document and answers what
 * this project takes and what stays (null for nothing left), or null when this
 * project takes nothing.
 *
 * Never over anything. A project that already has its own file is not a
 * destination — the legacy entries that would have been its stay where they
 * are, untouched — and the new file is created with `wx`, so even one that
 * appeared between the check and the write is not overwritten. A legacy file
 * that will not parse is left alone entirely. Only after the project's file has
 * landed is the legacy file rewritten with what is left, or removed when
 * nothing is, and the legacy directory with it when that leaves it empty.
 */
export function adopt(
  at: { path: string; root: string },
  name: FileName,
  split: (legacy: unknown, root: string) => { taken: unknown; left: unknown | null } | null,
): void {
  const old = join(legacyDir(), `${name}.json`)
  if (!existsSync(old) || existsSync(at.path)) return
  let legacy: unknown
  try {
    legacy = JSON.parse(readFileSync(old, 'utf8'))
  } catch {
    return
  }
  const parts = split(legacy, at.root)
  if (!parts) return
  if (makeDir(at.root)) return
  try {
    writeFileSync(at.path, `${JSON.stringify(parts.taken, null, 2)}\n`, { flag: 'wx' })
  } catch {
    return
  }
  try {
    if (parts.left === null) {
      unlinkSync(old)
      if (readdirSync(legacyDir()).length === 0) rmdirSync(legacyDir())
    } else {
      writeFileSync(old, `${JSON.stringify(parts.left, null, 2)}\n`)
    }
  } catch {
    /* The project's copy landed. A legacy file that could not be trimmed is
       harmless: this project has its own file now and will not adopt again. */
  }
}
