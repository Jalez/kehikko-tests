import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Run } from '../runs/store.ts'

/**
 * Actually running things, and the bounds refusing to run more of them.
 *
 * Everything spawned here is `/bin/sh` with a literal argument that exits, sleeps
 * or echoes, in a temporary directory. Nothing touches the network, nothing
 * writes outside `TESTS_DATA`, and the longest of them is a second — the timeout
 * test configures a one-second bound against a sleep that would otherwise take
 * sixty.
 *
 * `sh -c` appears here and is worth a word, because it looks like the thing this
 * module refuses. It is not: the argv array `['sh', '-c', 'exit 1']` was written
 * into the store by this test file, through `configure`, and could never have
 * arrived in a run request. A person configuring a suite may absolutely choose to
 * run a shell — it is their machine and their command — and the rule the module
 * enforces is that a REQUEST cannot choose it for them.
 */

const here = realpathSync(mkdtempSync(join(tmpdir(), 'tests-spawn-')))
/* Where the OLD single store is looked for: somewhere that does not exist, so no
   test can adopt this repository's real `data/` into its temporary project. */
const legacy = `${here}-legacy`

/**
 * The store this file uses, re-pointed before EVERY test rather than once.
 *
 * Bun runs the files in this directory in one process, and each of them points
 * `TESTS_DATA` at a temporary directory of its own. A `beforeAll` would set it
 * once and then lose it the moment another file's `beforeAll` ran — which is a
 * failure that appears only when the whole suite is run and never when the file
 * is run alone, so it is worth the extra line to make impossible.
 */
beforeEach(() => {
  process.env.TESTS_DATA = legacy
})
/* And once in a `beforeAll` as well, because the suites below are defined in a
   `beforeAll` of their own — which runs before any `beforeEach` does, and would
   otherwise write them into whichever file's directory happened to be pointed at
   last. */
beforeAll(() => {
  process.env.TESTS_DATA = legacy
})
afterAll(() => {
  stopAll()
  rmSync(here, { recursive: true, force: true })
})

const { configure } = await import('../suites/store.ts')
const { begin, end, stopAll, subscribe, waitFor, MAX_LIVE, runningSuite } = await import('../runs/spawn.ts')
const { standingFor } = await import('../runs/store.ts')

const define = (name: string, argv: string[], timeoutMs = 30_000) =>
  configure(here, { name, what: `a deliberate ${name} for the tests`, command: argv, dir: here, timeoutMs, by: 'the test' })

beforeAll(() => {
  define('green', ['sh', '-c', 'echo "2 pass"; echo "0 fail"; exit 0'])
  define('red', ['sh', '-c', 'echo "1 pass"; echo "1 fail" 1>&2; exit 1'])
  define('slow', ['sh', '-c', 'sleep 60'], 1_000)
  define('slow2', ['sh', '-c', 'sleep 60'], 30_000)
  define('slow3', ['sh', '-c', 'sleep 60'], 30_000)
  define('nosuch', ['this-program-does-not-exist-anywhere'])
})

async function runTo(suite: string, ref = ''): Promise<Run> {
  const started = begin({ project: here, suite, ref, by: 'the test' })
  expect(started.ok).toBe(true)
  if (!started.ok) throw new Error(started.error)
  const done = await waitFor(started.run.id, 20_000)
  expect(done).not.toBeNull()
  return done as Run
}

test('a suite that exits 0 is passed, with the counts its output printed', async () => {
  const done = await runTo('green', '!1')
  expect(done.verdict).toBe('passed')
  expect(done.exitCode).toBe(0)
  expect(done.passed).toBe(2)
  expect(done.failed).toBe(0)
})

test('a suite that exits non-zero is failed, and its stderr is kept', async () => {
  const done = await runTo('red', '!1')
  expect(done.verdict).toBe('failed')
  expect(done.exitCode).toBe(1)
  expect(done.tail.join('\n')).toContain('1 fail')
})

test('the run is recorded against the reference it was run for', () => {
  const s = standingFor(here, '!1')
  expect(s.runs.length).toBeGreaterThanOrEqual(2)
  expect(s.bySuite.map((r) => r.suite).sort()).toEqual(['green', 'red'])
})

test('a reference nothing was run against has no runs, and that is not a failure', () => {
  const s = standingFor(here, 'gh#999')
  expect(s.runs).toEqual([])
  expect(s.latest).toBeNull()
})

test('progress arrives as events while the run is going, not only at the end', async () => {
  const seen: string[] = []
  const off = subscribe((e) => seen.push(e.kind))
  await runTo('green')
  off()
  expect(seen).toContain('started')
  expect(seen).toContain('line')
  expect(seen).toContain('counts')
  expect(seen).toContain('ended')
  /* The order is the claim: a line arrived BEFORE the run ended, which is what
     "watch it happen" means as opposed to "be told afterwards". */
  expect(seen.indexOf('line')).toBeLessThan(seen.lastIndexOf('ended'))
})

/**
 * Stop a run and WAIT for it to actually be gone.
 *
 * `end` sends a signal; the slot is released when the child's `close` fires,
 * which is a later tick. A test that stopped a run and immediately started
 * another would be racing the operating system, and would fail on a loaded
 * machine and pass on an idle one — the worst kind of test in a file about
 * concurrency bounds.
 */
async function settle(id: string): Promise<void> {
  end(id, 'stopped', 'done with this test')
  await waitFor(id, 5_000)
}

test('one suite cannot be run twice at once', async () => {
  const first = begin({ project: here, suite: 'slow2', by: 'the test' })
  expect(first.ok).toBe(true)
  const second = begin({ project: here, suite: 'slow2', by: 'the test' })
  expect(second.ok).toBe(false)
  if (!second.ok) expect(second.error).toContain('already running')
  if (first.ok) await settle(first.run.id)
})

test('the concurrency cap refuses an extra run rather than queueing it', async () => {
  const started: string[] = []
  for (const name of ['slow2', 'slow3']) {
    const out = begin({ project: here, suite: name, by: 'the test' })
    expect(out.ok).toBe(true)
    if (out.ok) started.push(out.run.id)
  }
  expect(started).toHaveLength(MAX_LIVE)
  const extra = begin({ project: here, suite: 'green', by: 'the test' })
  expect(extra.ok).toBe(false)
  if (!extra.ok) expect(extra.error).toContain(`at most ${MAX_LIVE}`)
  for (const id of started) await settle(id)
})

test('a hung run is killed by its own timeout, and is "timeout" rather than "failed"', async () => {
  const started = begin({ project: here, suite: 'slow', ref: '!2', by: 'the test' })
  expect(started.ok).toBe(true)
  if (!started.ok) return
  expect(runningSuite(here, 'slow')?.id).toBe(started.run.id)
  const done = await waitFor(started.run.id, 20_000)
  expect(done?.verdict).toBe('timeout')
  /* The distinction the whole verdict vocabulary exists for: nothing was
     asserted, so this must not be reported as the tests saying no. */
  expect(done?.verdict).not.toBe('failed')
})

test('a program that is not there is "crashed", which is also not "failed"', async () => {
  const started = begin({ project: here, suite: 'nosuch', by: 'the test' })
  expect(started.ok).toBe(true)
  if (!started.ok) return
  const done = await waitFor(started.run.id, 20_000)
  expect(done?.verdict).toBe('crashed')
})

test('a run cannot name a suite that was never configured', () => {
  const out = begin({ project: here, suite: 'whatever-i-like', by: 'the test' })
  expect(out.ok).toBe(false)
  if (!out.ok) expect(out.error).toContain('no suite called')
})

test('a run with no project is refused before anything is looked up', () => {
  const out = begin({ project: null, suite: 'green', by: 'the test' })
  expect(out.ok).toBe(false)
  if (!out.ok) expect(out.error).toContain('no project is open')
})

test('runs are recorded in the project, at .kehikot/tests/runs.json', async () => {
  const done = await runTo('green', '!in-project')
  expect(done.verdict).toBe('passed')
  const kept = JSON.parse(readFileSync(join(here, '.kehikot', 'tests', 'runs.json'), 'utf8'))
  expect(kept.runs['!in-project'][0].id).toBe(done.id)
})

test('a stream is one project’s: another project’s run never reaches it', async () => {
  const { attach } = await import('../runs/stream.ts')
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'tests-spawn-other-')))
  const mine: string[] = []
  const theirs: string[] = []
  const a = attach({ write: (event) => void mine.push(event) }, here)
  const b = attach({ write: (event) => void theirs.push(event) }, elsewhere)
  await runTo('green')
  a()
  b()
  rmSync(elsewhere, { recursive: true, force: true })
  expect(mine).toContain('started')
  expect(mine).toContain('ended')
  expect(theirs).toEqual(['hello'])
})
