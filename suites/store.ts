import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import { z } from 'zod'

import { dataDir } from '../store.ts'

/**
 * How this project is tested, as this app holds it.
 *
 * ## This file is the security boundary of the whole module, so read it first
 *
 * Everything else here is bookkeeping. This is the file that decides what a
 * `spawn` will eventually be handed, and the rule it exists to enforce is one
 * sentence long:
 *
 *   **A suite names a directory and a command, both of which are CONFIGURED,
 *   and the run door takes a NAME and looks it up.**
 *
 * The alternative — a run endpoint that accepts a command line — is not a
 * smaller version of this. It is a shell on an HTTP port. Loopback does not save
 * it: loopback is a fence around the machine and not around the programs on it,
 * and everything on this machine can reach 7900. Nor does the ticket save it,
 * because the ticket separates "this app's own page" from "something else that
 * found the port" and was never an authorization check. The only thing that
 * actually holds is that there is no path from a request to an executable name,
 * and this file is where that is true.
 *
 * `runs/spawn.ts` says the second half of the argument: an argv ARRAY handed to
 * `spawn` with `shell: false`, so that nothing anywhere near this program ever
 * interpolates a string into a command line.
 *
 * ## What a suite is, field by field, and why each is bounded here
 *
 * - **`name`** — how a run asks for it. Lowercase letters, digits, dash and
 *   underscore, and that is not tidiness: the name goes into a filename-free
 *   store but it also goes into an MCP tool result, a page, and a `data-suite`
 *   attribute, and a name allowed to be arbitrary text is a name that eventually
 *   contains a quote mark in one of those places.
 * - **`what`** — a sentence saying what this suite proves. Required, and the
 *   requirement is the one piece of paternalism in the file. A list of suites
 *   called `unit`, `unit2` and `fast` is a list nobody can act on six weeks
 *   later, and this is the only moment anybody has the answer to hand.
 * - **`command`** — an ARRAY. `['bun', 'test']`, never `'bun test'`. The array
 *   is the whole point: it is impossible to express "and also `rm -rf /`" in an
 *   argv array, because the shell that would have parsed the `&&` is not there.
 *   The first element is the program and is not allowed to be empty or to be a
 *   path traversal.
 * - **`dir`** — absolute, normalised, and checked to be an existing directory
 *   AT CONFIGURATION TIME. It is checked again at run time in `spawn.ts`,
 *   because a directory that existed when somebody configured a suite in March
 *   is not a directory that exists now, and the refusal a person wants is "that
 *   directory is gone" rather than a spawn error about ENOENT on a binary.
 * - **`timeoutMs`** — clamped rather than trusted. A suite with no timeout is a
 *   suite that can hold one of this app's two run slots forever, which is the
 *   fork-bomb-with-a-button failure approached from the other side: not too many
 *   processes, but a process nothing will ever reap.
 *
 * ## What is deliberately NOT here
 *
 * No environment. A suite cannot set variables for its child, and the child gets
 * this process's environment plus nothing. It was tempting — half the test
 * runners in the world want `CI=1` — and it is a door into the child's behaviour
 * that would have to be bounded on its own terms (`PATH`, `LD_PRELOAD`,
 * `NODE_OPTIONS`), so it stays shut until somebody needs it enough to write
 * those bounds down. A suite that needs a variable can be `['sh', '-lc', …]` in
 * somebody's own repository under their own eyes, which is a decision they make
 * visibly rather than one this app makes quietly for everybody.
 *
 * No shell. See above, and `spawn.ts`.
 */

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/

/** Bounds on the strings, applied before any of them is looked at as a meaning. */
export const BOUNDS = {
  NAME: 40,
  WHAT: 300,
  /** One argv element. Long enough for a real path, short enough to be a bound. */
  ARG: 400,
  /** How many argv elements one command may have. */
  ARGC: 32,
  DIR: 1024,
  BY: 80,
  /** The floor, the default and the ceiling on how long a run may take. */
  TIMEOUT_MIN_MS: 1_000,
  TIMEOUT_DEFAULT_MS: 120_000,
  TIMEOUT_MAX_MS: 900_000,
} as const

const suiteSchema = z.object({
  name: z.string(),
  what: z.string(),
  command: z.array(z.string()).min(1),
  dir: z.string(),
  timeoutMs: z.number(),
  /** Who configured it. An agent's own name over MCP; nobody else can write here. */
  by: z.string(),
  at: z.string(),
})
export type Suite = z.infer<typeof suiteSchema>

const storeSchema = z.object({
  suites: z.record(z.string(), suiteSchema).default({}),
})
type Store = z.infer<typeof storeSchema>

function file(): string {
  return join(dataDir(), 'suites.json')
}

const empty = (): Store => storeSchema.parse({})

/**
 * The store, freshly read.
 *
 * An unreadable file reads as an empty one, and `trouble()` below is what stops
 * a write landing on top of it. The asymmetry is deliberate and it is the same
 * one every sibling module makes: a lost configuration is a thing somebody can
 * state again, and a write over a file that could not be parsed is not
 * recoverable at all.
 *
 * Read on every call rather than cached. This program is one process serving one
 * page and a handful of MCP calls; a cache would buy nothing measurable and
 * would mean an agent configuring a suite and the page listing them could
 * disagree for as long as the cache lived.
 */
function read(): Store {
  const path = file()
  if (!existsSync(path)) return empty()
  try {
    return storeSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return empty()
  }
}

/** Whether the file exists and cannot be read — the one state that blocks a write. */
export function trouble(): string | null {
  const path = file()
  if (!existsSync(path)) return null
  try {
    storeSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    return null
  } catch (e) {
    return `${path} could not be read (${
      e instanceof Error ? e.message.split('\n')[0] : String(e)
    }), so nothing has been configured and nothing has been written over it. Every suite already in that file is recoverable: fix or move it.`
  }
}

function save(store: Store): void {
  writeFileSync(file(), `${JSON.stringify(storeSchema.parse(store), null, 2)}\n`)
}

/** Every configured suite, by name. */
export function suites(): Suite[] {
  return Object.values(read().suites).sort((a, b) => a.name.localeCompare(b.name))
}

/** One suite, or null. This is the lookup the run door uses and the only one. */
export function suite(name: string): Suite | null {
  return read().suites[name] ?? null
}

export type Configured = { ok: true; suite: Suite } | { ok: false; error: string }

/**
 * Write down how something is tested.
 *
 * Every refusal is a sentence naming what was wrong and what a correct value
 * looks like, because the caller is an agent with no other way to find out — a
 * `400` with no words sends it round a loop of guesses, which is the failure
 * mode an MCP door has that an HTTP API does not.
 *
 * The checks run in the order somebody would fix them: the name, the sentence,
 * the command, the directory, the bound. That order matters only for which
 * refusal comes back first, and coming back with the most fundamental one first
 * is what stops an agent fixing a timeout on a suite whose name was never going
 * to be accepted.
 */
export function configure(input: {
  name: unknown
  what: unknown
  command: unknown
  dir: unknown
  timeoutMs?: unknown
  by?: unknown
}): Configured {
  const blocked = trouble()
  if (blocked) return { ok: false, error: `nothing was configured. ${blocked}` }

  /* Not truncated to the bound — TESTED against it. A name silently cut to forty
     characters is a suite stored under a name nobody asked for, and the caller
     would then be told "there is no suite called …" when it tried to run the
     thing it had just configured. The regex carries the length, so an over-long
     name is refused with the same sentence as an invalid one. */
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      error: `"${name.slice(0, 40)}" is not a usable suite name. Use lowercase letters, digits, dash and underscore, up to ${BOUNDS.NAME} characters — "unit", "e2e-smoke". The name is how a run asks for this suite, and it is printed on a page and into a tool result, so it is kept to characters that mean the same thing in all three.`,
    }
  }

  const what = typeof input.what === 'string' ? input.what.trim().slice(0, BOUNDS.WHAT) : ''
  if (what.length < 10) {
    return {
      ok: false,
      error: `a suite needs a sentence saying what it proves, and "${what}" is too short. Somebody reading a red "${name}" in six weeks has nothing else to go on — say what passing it would mean, e.g. "the store refuses a suite whose directory does not exist".`,
    }
  }

  /* An ARRAY, and the refusal for a string is long because a string is the
     mistake this module is built to refuse. An agent that has just been told
     "command must be an array" and nothing else will try `["bun test"]` next,
     which spawns a program with a space in its name; so the sentence has to name
     that too. */
  if (!Array.isArray(input.command)) {
    return {
      ok: false,
      error: `command has to be an array of arguments, not a command line: ["bun", "test"] rather than "bun test". This server never hands anything to a shell, so a string here would be looked up as the name of one program with a space in it. Split it yourself — that is the point, not a formality.`,
    }
  }
  if (input.command.length < 1 || input.command.length > BOUNDS.ARGC) {
    return { ok: false, error: `command needs between 1 and ${BOUNDS.ARGC} arguments; this one has ${input.command.length}.` }
  }
  const command: string[] = []
  for (const raw of input.command) {
    if (typeof raw !== 'string') return { ok: false, error: 'every argument in command has to be a string.' }
    if (raw.length > BOUNDS.ARG) return { ok: false, error: `one argument is longer than ${BOUNDS.ARG} characters.` }
    command.push(raw)
  }
  const program = command[0] ?? ''
  if (!program.trim()) return { ok: false, error: 'the first argument is the program to run, and it is empty.' }
  /* A NUL in an argv element is refused rather than truncated. Node throws on
     one, and a truncation here would silently run a shorter command than the one
     that was written down — which is the single worst thing this file could do,
     because what is stored is what a person will later read to find out what
     runs. */
  if (command.some((a) => a.includes('\0'))) return { ok: false, error: 'an argument contains a NUL byte.' }

  const dir = typeof input.dir === 'string' ? input.dir.trim().slice(0, BOUNDS.DIR) : ''
  if (!dir) {
    return {
      ok: false,
      error: 'a suite has to say which directory to run in, as an absolute path. There is no default: inheriting this server’s own working directory would mean a suite ran somewhere nobody wrote down.',
    }
  }
  if (!isAbsolute(dir)) {
    return { ok: false, error: `"${dir}" is not an absolute path. A relative directory would be resolved against wherever this server happens to have been started, which is not a thing the person configuring the suite can see.` }
  }
  const at = normalize(dir)
  if (!existsSync(at) || !statSync(at).isDirectory()) {
    /* Checked now AND again at run time. Checking now is what makes the refusal
       land on the agent that made the mistake, while it still has the context to
       fix it; checking again later is what covers the directory being deleted
       afterwards. Neither check makes the other redundant. */
    return { ok: false, error: `${at} is not a directory on this machine, so nothing could ever be run there.` }
  }

  const asked = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) ? input.timeoutMs : BOUNDS.TIMEOUT_DEFAULT_MS
  const timeoutMs = Math.min(BOUNDS.TIMEOUT_MAX_MS, Math.max(BOUNDS.TIMEOUT_MIN_MS, Math.round(asked)))

  const store = read()
  const suite: Suite = {
    name,
    what,
    command,
    dir: at,
    timeoutMs,
    by: (typeof input.by === 'string' ? input.by.trim().slice(0, BOUNDS.BY) : '') || 'an agent',
    at: new Date().toISOString(),
  }
  store.suites[name] = suite
  save(store)
  return { ok: true, suite }
}

/** Take a suite off the list. Runs already recorded against it are left alone. */
export function forget(name: string): { ok: boolean; error?: string } {
  const blocked = trouble()
  if (blocked) return { ok: false, error: `nothing was changed. ${blocked}` }
  const store = read()
  if (!store.suites[name]) return { ok: false, error: `there is no suite called "${name.slice(0, BOUNDS.NAME)}".` }
  delete store.suites[name]
  save(store)
  /* The runs are deliberately kept. A record saying "the unit suite failed
     against !1848 on Tuesday" is a fact about Tuesday, and it does not stop being
     one because somebody has since deleted the suite. The page prints such a run
     with its suite marked as no longer configured, which is the honest reading. */
  return { ok: true }
}

/** How a suite is written out anywhere a person reads it — the page, a tool result. */
export function spell(s: Suite): string {
  return `${s.name} — ${s.what}\n      ${s.command.join(' ')}\n      in ${s.dir}, killed after ${Math.round(s.timeoutMs / 1000)}s`
}
