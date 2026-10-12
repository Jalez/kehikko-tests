import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { moduleFolder } from 'kehikot-module-protocol'
import { registryDir } from 'kehikot-module-protocol/serve'

import { ID } from '../manifest.ts'
import { projectOf } from '../store.ts'

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
 * keyed by the project's real path, so a project that was moved or copied is
 * unconfirmed where it now is. `TESTS_CONFIRMED_DIR` moves it (the tests point
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

/** What is confirmed is exactly this: the argument array and the directory, in a form two spellings cannot share. */
export function fingerprint(suite: { command: readonly string[]; dir: string }): string {
  return createHash('sha256').update(JSON.stringify({ command: suite.command, dir: suite.dir })).digest('hex')
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
export function isConfirmed(projectPath: string | null | undefined, suite: { name: string; command: readonly string[]; dir: string }): boolean {
  const project = projectOf(projectPath)
  if (project === null) return false
  const mine = read()[project]
  return mine !== undefined && Object.hasOwn(mine, suite.name) && mine[suite.name] === fingerprint(suite)
}

/** Keep a person's confirmation of one suite as it is now. Only the page's own door calls this. */
export function keepConfirmed(projectPath: string | null | undefined, suite: { name: string; command: readonly string[]; dir: string }): boolean {
  const project = projectOf(projectPath)
  if (project === null) return false
  const kept = read()
  kept[project] = { ...(kept[project] ?? {}), [suite.name]: fingerprint(suite) }
  write(kept)
  return true
}

/** A suite that was taken off the list is no longer confirmed: one configured under its name later is a new one. */
export function dropConfirmed(projectPath: string | null | undefined, name: string): void {
  const project = projectOf(projectPath)
  if (project === null) return
  const kept = read()
  const mine = kept[project]
  if (!mine || !Object.hasOwn(mine, name)) return
  delete mine[name]
  if (!Object.keys(mine).length) delete kept[project]
  try {
    write(kept)
  } catch {
    /* Nothing depends on this having landed: a later suite of this name has to match the fingerprint to run. */
  }
}
