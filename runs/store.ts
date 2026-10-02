import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'

import { adopt, claim, makeDir, place } from '../store.ts'

/**
 * What was run, against what, and how it went.
 *
 * ## The three answers this file exists to keep apart
 *
 * "not run", "passed" and "we do not know" are three different things and
 * telling them apart is the whole value of the module. So there is no boolean
 * anywhere in this file. A reference with nothing recorded against it has no
 * entry, and the page says so in a sentence of its own; it is never drawn as a
 * red cross, because nobody having run anything is not a failure and treating it
 * as one would train a reader to ignore red.
 *
 * The `Verdict` below is six words for that reason, and each of them sends a
 * person somewhere different:
 *
 * - **`running`** — a process is alive right now. Not a verdict, and the page
 *   must never round it to one.
 * - **`passed`** — the process exited 0. That is exactly what it means and no
 *   more: this app does not know whether the suite asserted anything.
 * - **`failed`** — the process exited non-zero. The test runner said no.
 * - **`timeout`** — this app killed it because it exceeded the suite's bound.
 *   Deliberately not `failed`: a hung suite and a red suite have completely
 *   different next steps, and a runner that reported the first as the second
 *   would send somebody to read assertions that never ran.
 * - **`stopped`** — a person pressed stop. Also not `failed`, for the same
 *   reason and more obviously.
 * - **`crashed`** — the process could not be started, or died on a signal that
 *   was not ours. The program is missing, or something outside killed it.
 *
 * ## Keyed by reference, and `null` is a key too
 *
 * A run belongs to the issue, merge request or pull request somebody was looking
 * at when they started it — that is what makes this module a checklist with
 * statistics rather than a log. But a run started with nothing selected is a
 * perfectly ordinary thing (somebody opened the page directly and pressed Run),
 * and losing it would be worse than filing it oddly. So those go under the empty
 * key, and the page draws them under a heading that says they belong to no
 * reference.
 *
 * ## What is kept, and what is thrown away
 *
 * The last `KEEP_PER_REF` runs per reference, and for each one a TAIL of its
 * output rather than all of it. A full transcript of every run of every suite is
 * a JSON file that grows without bound in a program nobody is watching; the tail
 * is what a person actually reads when something went red. The live stream over
 * SSE carries every line as it happens — see `runs/spawn.ts` — so nothing is
 * lost to somebody who is watching. What is lost is the middle of a run nobody
 * watched, and the record says how many lines it is not showing rather than
 * quietly presenting the tail as the whole.
 */

export type Verdict = 'running' | 'passed' | 'failed' | 'timeout' | 'stopped' | 'crashed'

const runSchema = z.object({
  id: z.string(),
  suite: z.string(),
  /** The reference this was run for; the empty string means none was selected. */
  ref: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  verdict: z.enum(['running', 'passed', 'failed', 'timeout', 'stopped', 'crashed']),
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  /**
   * Counts a runner printed, where one was recognised.
   *
   * Null and not zero. Zero passing tests is a real and alarming result; a
   * runner whose output this app could not parse is not a result at all, and the
   * page says "its output did not say" rather than drawing an empty bar.
   */
  passed: z.number().nullable(),
  failed: z.number().nullable(),
  /** The last lines of output, and how many came before them. */
  tail: z.array(z.string()).default([]),
  dropped: z.number().default(0),
  /** Who started it: the page, or an agent by name. */
  by: z.string(),
  /** What was actually executed, copied at start. */
  command: z.array(z.string()).default([]),
  dir: z.string().default(''),
})
export type Run = z.infer<typeof runSchema>

const storeSchema = z.object({
  runs: z.record(z.string(), z.array(runSchema)).default({}),
})
type Store = z.infer<typeof storeSchema>

/** How many runs are kept per reference before the oldest is dropped. */
export const KEEP_PER_REF = 20
/** How many output lines are kept with a finished run. */
export const KEEP_LINES = 200

const empty = (): Store => storeSchema.parse({})

/**
 * This project's share of the old single `runs.json`: every run whose recorded
 * directory is inside it (see `claim` in `../store.ts`), and every run whose
 * directory names nothing — the oldest records carry `dir: ''`, and nothing
 * else could ever place those.
 */
function split(legacy: unknown, root: string): { taken: Store; left: Store | null } | null {
  const parsed = storeSchema.safeParse(legacy)
  if (!parsed.success) return null
  const taken: Store = { runs: {} }
  const left: Store = { runs: {} }
  let took = 0
  let kept = 0
  for (const [ref, list] of Object.entries(parsed.data.runs)) {
    for (const one of list) {
      const into = claim(root, one.dir) === 'theirs' ? left : taken
      ;(into.runs[ref] ??= []).push(one)
      if (into === taken) took += 1
      else kept += 1
    }
  }
  if (!took) return null
  return { taken, left: kept ? left : null }
}

/** This project's file, adopting its share of the old store first. */
function where(projectPath: string | null | undefined) {
  const at = place(projectPath, 'runs')
  if ('path' in at) adopt(at, 'runs', split)
  return at
}

function read(projectPath: string | null | undefined): Store {
  const at = where(projectPath)
  if (!('path' in at)) return empty()
  const path = at.path
  if (!existsSync(path)) return empty()
  try {
    return storeSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    /* Same judgement as the suites store, for the weaker of the two reasons: a
       lost run history is a nuisance, and writing over a file that could not be
       parsed is irreversible. `trouble()` is what refuses the write. */
    return empty()
  }
}

/** A project this app will not work under, or a file that cannot be read — either blocks a write. Null for no project. */
export function trouble(projectPath: string | null | undefined): string | null {
  const at = where(projectPath)
  if ('nowhere' in at) return null
  if ('trouble' in at) return at.trouble
  const path = at.path
  if (!existsSync(path)) return null
  try {
    storeSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    return null
  } catch (e) {
    return `${path} could not be read (${
      e instanceof Error ? e.message.split('\n')[0] : String(e)
    }), so nothing has been recorded and nothing has been written over it.`
  }
}

/** Write, creating this module's folder first. Quietly nothing when there is no project to write in. */
function save(projectPath: string | null | undefined, store: Store): void {
  const at = where(projectPath)
  if (!('path' in at)) return
  if (makeDir(at.root)) return
  writeFileSync(at.path, `${JSON.stringify(storeSchema.parse(store), null, 2)}\n`)
}

/** Every run recorded against one reference in this project, newest first. */
export function runsFor(projectPath: string | null | undefined, ref: string): Run[] {
  const all = read(projectPath).runs
  return [...(Object.hasOwn(all, ref) ? (all[ref] ?? []) : [])].reverse()
}

/** Every reference anything has been run against in this project. */
export function knownRefs(projectPath: string | null | undefined): string[] {
  return Object.keys(read(projectPath).runs).sort()
}

/** One run wherever it is filed in this project, for a stream that has only an id. */
export function run(projectPath: string | null | undefined, id: string): Run | null {
  for (const list of Object.values(read(projectPath).runs)) {
    const found = list.find((r) => r.id === id)
    if (found) return found
  }
  return null
}

/**
 * Write a run down, or update the one already there.
 *
 * Called at the start of a run and again when it ends. Writing at the START is
 * what makes the reload story honest: a page that comes back mid-run finds a
 * `running` record on disk and can say "this is still going" rather than
 * discovering nothing and reporting that nothing was ever run. If this process
 * dies mid-run that record is left saying `running` forever, which is why
 * `sweep()` below exists and is called at startup.
 */
export function record(projectPath: string | null | undefined, run: Run): void {
  if (trouble(projectPath)) return
  const store = read(projectPath)
  const list = store.runs[run.ref] ?? []
  const at = list.findIndex((r) => r.id === run.id)
  if (at >= 0) list[at] = run
  else list.push(run)
  /* Oldest first out. The newest runs are the ones anybody is looking at. */
  store.runs[run.ref] = list.slice(-KEEP_PER_REF)
  save(projectPath, store)
}

/**
 * Every run left saying `running` by a process that is no longer here.
 *
 * Called whenever a project's runs are read — not once at startup, because
 * there is no list of projects at startup: the runs live inside each project,
 * and this server learns of one only when somebody opens it. `alive` is the
 * live-run table of THIS process, so a run that is genuinely going is left
 * alone and only an orphan is swept. It is not housekeeping — it is the
 * difference between an honest page and a lying one. A run only exists inside the process
 * that spawned it: kill this server and the child dies with it (see the process
 * group note in `spawn.ts`), but the record on disk still says `running`. A page
 * that then drew a spinner would be claiming a process is alive that this
 * program cannot see, cannot stream, and cannot stop.
 *
 * They become `crashed` with a sentence, rather than being deleted, because "the
 * server went away while this was running" is a real thing to have happened to a
 * run and somebody may need to know it did.
 */
export function sweep(projectPath: string | null | undefined, alive: (id: string) => boolean): number {
  if (trouble(projectPath)) return 0
  const store = read(projectPath)
  let swept = 0
  for (const [ref, list] of Object.entries(store.runs)) {
    store.runs[ref] = list.map((r) => {
      if (r.verdict !== 'running' || alive(r.id)) return r
      swept += 1
      return {
        ...r,
        verdict: 'crashed' as const,
        endedAt: r.endedAt ?? new Date().toISOString(),
        tail: [...r.tail, '— this server stopped while the run was going; whatever it had said beyond this was never written down.'],
      }
    })
  }
  if (swept) save(projectPath, store)
  return swept
}

/**
 * The one-line summary of a reference, which is what the page draws small.
 *
 * `null` for a reference nothing has ever been run against, and the caller is
 * expected to say that in words rather than to render a zero. See the essay at
 * the top: not run is not a verdict.
 */
export interface Standing {
  ref: string
  latest: Run | null
  runs: Run[]
  /** The newest run per suite, which is what "does this change pass" means. */
  bySuite: Run[]
}

export function standingFor(projectPath: string | null | undefined, ref: string): Standing {
  const all = runsFor(projectPath, ref)
  const seen = new Set<string>()
  const bySuite: Run[] = []
  for (const r of all) {
    if (seen.has(r.suite)) continue
    seen.add(r.suite)
    bySuite.push(r)
  }
  return { ref, latest: all[0] ?? null, runs: all, bySuite }
}

/* Re-exported rather than defined here, and `runs/ago.ts` says why at length:
   this file touches `node:fs`, so a page that imported a VALUE from it would pull
   the whole store into the browser bundle and die on evaluation — with no symptom
   beyond a module that never answers its host's greeting. */
export { ago } from './ago.ts'
