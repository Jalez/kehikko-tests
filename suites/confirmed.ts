import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { moduleFolder, projectKey } from 'kehikot-module-protocol'
import { registryDir } from 'kehikot-module-protocol/serve'

import { ID } from '../manifest.ts'
import { projectIdOf, projectOf } from '../store.ts'

/**
 * Which commands a person has confirmed, on this machine.
 *
 * ## What is confirmed, and by whom
 *
 * A suite is a command this app will run. It is written down by an agent, over
 * the MCP door, and it is kept in the project — so it can also arrive with a
 * project somebody cloned. Neither is a person saying "yes, run that here". So
 * a suite does not run until a person has read its command in this app's own
 * page and pressed the control in its row, and it needs that again whenever the
 * command or the directory it runs in changes.
 *
 * What is kept is a fingerprint of exactly those two things. A suite whose
 * fingerprint is not the confirmed one is unconfirmed: a new one, a changed
 * one, or one that came with the project.
 *
 * ## Why this is not in the project
 *
 * The suites are the project's and live in it (`<project>/.kehikot/tests/`).
 * The confirmation is not the project's: it is one person's word about one
 * machine. Kept beside the suite it would travel with the project, and a
 * project file could then carry its own permission to run. So it is machine
 * state, in this machine's Kehikot folder — the folder the module registry is
 * in — under a name of this module's own:
 *
 *     <Kehikot machine folder>/module-state/tests/confirmed.json
 *
 * keyed by the project's permanent id (`.kehikot/project.json`, protocol
 * 2.1.0) when the host has given it one — `id:<id>` — and by its real path
 * while it has not. So a project that is renamed or moved keeps its
 * confirmations; a copy is unconfirmed where it now is, because a host gives a
 * copy carrying the same id a fresh one, and a `git clone` never carries the
 * file (it is gitignored always). The id is a random UUID that is never
 * committed, so a project somebody hands you cannot know another project's.
 *
 * What a fingerprint is of is the command and the directory RELATIVE to the
 * project (`''` for the folder itself), so it too survives the move.
 *
 * Confirmations kept under the path are moved to the id the first time the
 * project is seen with one, for the path it has NOW; ones kept under a path the
 * project no longer has cannot be matched and are left (a person confirms
 * again). A fingerprint of the old absolute directory is carried over to the
 * relative one when the suites file is read (`upgradeConfirmed`). `TESTS_CONFIRMED_DIR` moves it (the tests point
 * it at a temporary directory); a scratch server that sets `KEHIKOT_MODULES_DIR`
 * gets a scratch one beside its scratch registry without doing anything.
 *
 * A file that is missing or cannot be read confirms nothing. Losing it costs a
 * person one press per suite; it never lets anything run.
 */

type Kept = Record<string, Record<string, string>>

/** The directory this module's machine state is in. */
export function confirmedDir(env: Record<string, string | undefined> = process.env): string {
  return env.TESTS_CONFIRMED_DIR || join(dirname(registryDir(env)), 'module-state', moduleFolder(ID))
}

const file = () => join(confirmedDir(), 'confirmed.json')

/**
 * What is confirmed is exactly this: the argument array and the directory, in a form two spellings cannot share.
 * The directory is the one relative to the project (`rel`) when the suite has one, so a move does not change it.
 */
export function fingerprint(suite: { command: readonly string[]; dir: string; rel?: string | null }): string {
  const dir = typeof suite.rel === 'string' ? suite.rel : suite.dir
  return createHash('sha256').update(JSON.stringify({ command: suite.command, dir })).digest('hex')
}

/**
 * The key one project's confirmations are kept under, moving what was kept
 * under its current path to its id the first time it has one. Null for no project.
 */
function keyOf(projectPath: string | null | undefined, kept: Kept): { key: string; moved: boolean } | null {
  const root = projectOf(projectPath)
  if (root === null) return null
  const key = projectKey({ projectId: projectIdOf(root), projectPath: root })
  if (key === null) return null
  if (key.by === 'path') return { key: key.key, moved: false }
  const byId = `id:${key.key}`
  const byPath = kept[root]
  if (!byPath) return { key: byId, moved: false }
  kept[byId] = { ...byPath, ...(kept[byId] ?? {}) }
  delete kept[root]
  return { key: byId, moved: true }
}

/** Write what was moved to the id; a failure costs a person a press, never a run. */
function settle(kept: Kept, moved: boolean): void {
  if (!moved) return
  try {
    write(kept)
  } catch {
    /* Moved again next time. */
  }
}

/**
 * Carry a confirmation of a suite's old fingerprint over to its new one: the
 * same command in the same directory, spelled relative instead of absolute.
 * Only an exact match is carried; anything else stays unconfirmed.
 */
export function upgradeConfirmed(projectPath: string, name: string, was: string, now: string): void {
  const kept = read()
  const at = keyOf(projectPath, kept)
  if (at === null) return
  const mine = kept[at.key]
  if (!mine || mine[name] !== was || was === now) return settle(kept, at.moved)
  mine[name] = now
  settle(kept, true)
}

function read(): Kept {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    return {}
  }
  const projects = (parsed as { projects?: unknown } | null)?.projects
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return {}
  const kept: Kept = {}
  for (const [project, suites] of Object.entries(projects)) {
    if (!suites || typeof suites !== 'object' || Array.isArray(suites)) continue
    const mine: Record<string, string> = {}
    for (const [name, print] of Object.entries(suites)) if (typeof print === 'string') mine[name] = print
    kept[project] = mine
  }
  return kept
}

/** Written to a temporary file and renamed, so a crash never leaves half a file. */
function write(kept: Kept): void {
  const at = file()
  mkdirSync(dirname(at), { recursive: true })
  const temporary = `${at}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ projects: kept }, null, 2)}\n`)
  renameSync(temporary, at)
}

/** Has a person confirmed this suite, as it is now, in this project, on this machine? */
type Confirmable = { name: string; command: readonly string[]; dir: string; rel?: string | null }

export function isConfirmed(projectPath: string | null | undefined, suite: Confirmable): boolean {
  const kept = read()
  const at = keyOf(projectPath, kept)
  if (at === null) return false
  settle(kept, at.moved)
  const mine = kept[at.key]
  return mine !== undefined && Object.hasOwn(mine, suite.name) && mine[suite.name] === fingerprint(suite)
}

/** Keep a person's confirmation of one suite as it is now. Only the page's own door calls this. */
export function keepConfirmed(projectPath: string | null | undefined, suite: Confirmable): boolean {
  const kept = read()
  const at = keyOf(projectPath, kept)
  if (at === null) return false
  kept[at.key] = { ...(kept[at.key] ?? {}), [suite.name]: fingerprint(suite) }
  write(kept)
  return true
}

/** A suite that was taken off the list is no longer confirmed: one configured under its name later is a new one. */
export function dropConfirmed(projectPath: string | null | undefined, name: string): void {
  const kept = read()
  const at = keyOf(projectPath, kept)
  if (at === null) return
  const mine = kept[at.key]
  if (!mine || !Object.hasOwn(mine, name)) return settle(kept, at.moved)
  delete mine[name]
  if (!Object.keys(mine).length) delete kept[at.key]
  try {
    write(kept)
  } catch {
    /* Nothing depends on this having landed: a later suite of this name has to match the fingerprint to run. */
  }
}
