import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hostThat, holdsEveryFolder, noHost } from './host.ts'

/**
 * A project folder that is renamed while this app is running (protocol 2.3.0). Nothing is written
 * under a path the host does not vouch for; a former path is followed to where the project is now;
 * and a run that is going when the folder is renamed is recorded in the renamed folder.
 * The host is a table (`test/host.ts`), the folders are scratch ones.
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), 'tests-moved-')))
beforeEach(() => {
  process.env.TESTS_DATA = join(base, 'no-legacy')
})
afterEach(() => holdsEveryFolder())
afterAll(() => {
  holdsEveryFolder()
  rmSync(base, { recursive: true, force: true })
})

const { answer, TICKET } = await import('../doors.ts')
const { active, begin, runningSuite, stopAll } = await import('../runs/spawn.ts')
const { runsFor } = await import('../runs/store.ts')
const { configure } = await import('../suites/store.ts')
const { keepConfirmed } = await import('../suites/confirmed.ts')
afterAll(() => stopAll())

const ID = 'a1b2c3d4-0000-4000-8000-0000000000aa'
let n = 0
function project(id: string | null = ID): string {
  n += 1
  const dir = join(base, `p${n}`)
  mkdirSync(join(dir, '.kehikot'), { recursive: true })
  if (id) writeFileSync(join(dir, '.kehikot', 'project.json'), JSON.stringify({ id, createdAt: null }))
  return dir
}
const kept = (dir: string) => join(dir, '.kehikot', 'tests', 'suites.json')

const call = (name: string, project: string, args: Record<string, unknown> = {}) =>
  answer('POST', '/mcp', new URLSearchParams(), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project, ...args } } }, null)
const text = (reply: Awaited<ReturnType<typeof answer>>): { said: string; isError: boolean } => {
  const body = reply?.body as { result?: { content?: { text?: string }[]; isError?: boolean } }
  return { said: body.result?.content?.[0]?.text ?? '', isError: body.result?.isError === true }
}
const configureOver = (project: string, dir: string) => call('configure_suite', project, { name: 'unit', what: 'something worth proving', command: ['bun', 'test'], dir })

describe('a former path is followed, and nothing is written under a stale one', () => {
  test('configure_suite at the old path writes in the project where it is now, and says so', async () => {
    const was = project()
    const now = join(base, `renamed-${n}`)
    renameSync(was, now)
    hostThat({ [now]: ID }, { [was]: now })

    const out = text(await configureOver(was, now))
    expect(out.isError).toBe(false)
    expect(out.said).toContain(`The project at ${was} has moved to ${now}`)
    expect(existsSync(kept(now))).toBe(true)
    expect(existsSync(was)).toBe(false)
  })

  test('an unrelated folder at the old path is refused, and nothing is written in it', async () => {
    const stranger = project(null)
    const now = project()
    /* The host says that path moved to a folder it does not hold as the same project. */
    hostThat({}, { [stranger]: now })
    const out = text(await configureOver(stranger, stranger))
    expect(out.isError).toBe(true)
    expect(out.said).toBe(`That folder was moved to ${now}; use that path.`)
    expect(existsSync(join(stranger, '.kehikot', 'tests'))).toBe(false)
  })

  test('a former path whose new folder is another project is not followed, and nothing is written in either', async () => {
    const stranger = project(null)
    const elsewhere = project('a1b2c3d4-0000-4000-8000-0000000000bb')
    /* The host says this path was a project's and it is at `elsewhere`; `elsewhere` answers as another project. */
    hostThat({ [elsewhere]: 'a1b2c3d4-0000-4000-8000-0000000000bb' }, { [stranger]: { to: elsewhere, id: ID } })
    const out = text(await configureOver(stranger, elsewhere))
    expect(out.isError).toBe(true)
    expect(out.said).toBe(`That folder was moved to ${elsewhere}; use that path.`)
    expect(existsSync(join(stranger, '.kehikot', 'tests'))).toBe(false)
    expect(existsSync(join(elsewhere, '.kehikot', 'tests'))).toBe(false)
  })

  test('a folder the host does not hold is refused in the shared sentence, and nothing is written', async () => {
    const dir = project()
    hostThat({})
    const out = text(await configureOver(dir, dir))
    expect(out).toEqual({ said: `${dir} is not a project open in Kehikot.`, isError: true })
    expect(existsSync(join(dir, '.kehikot', 'tests'))).toBe(false)
  })

  test('with no host answering, every project tool refuses and nothing is written', async () => {
    const dir = project()
    noHost()
    for (const name of ['how_tested', 'configure_suite', 'run_tests', 'test_runs']) {
      const out = text(await call(name, dir, { name: 'unit', what: 'something worth proving', command: ['bun', 'test'], dir, suite: 'unit' }))
      expect(out).toEqual({ said: `${dir} is not a project open in Kehikot.`, isError: true })
    }
    expect(existsSync(join(dir, '.kehikot', 'tests'))).toBe(false)
    const page = await answer('GET', '/api/state', new URLSearchParams({ project: dir }), null, TICKET)
    expect((page?.body as { trouble: string }).trouble).toBe(`${dir} is not a project open in Kehikot.`)
  })

  test('a call that names no project says what to send', async () => {
    const out = text(await call('how_tested', ''))
    expect(out.isError).toBe(true)
  })
})

describe('a run that is going when the folder is renamed', () => {
  const START = (dir: string) => {
    const out = configure(dir, { name: 'slowish', what: 'goes on a little', command: ['sh', '-c', 'sleep 1; echo "3 pass"'], dir, timeoutMs: 20_000, by: 'the test' })
    if (!out.ok) throw new Error(out.error)
    keepConfirmed(dir, out.suite)
  }
  const ended = (dir: string) => new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      if (runsFor(dir, 'r1').some((r) => r.verdict === 'passed')) { clearInterval(tick); resolve() }
    }, 50)
  })

  test('it is visible to the page at the new path, and is recorded there when it ends', async () => {
    const was = project()
    START(was)
    const started = begin({ project: was, suite: 'slowish', ref: 'r1', by: 'the test' })
    if (!started.ok) throw new Error(started.error)

    const now = join(base, `renamed-run-${n}`)
    renameSync(was, now)
    hostThat({ [now]: ID }, { [was]: now })

    /* The page, which has the new path, asks: the run is its own, and holds its suite's slot. */
    const state = await answer('GET', '/api/state', new URLSearchParams({ project: now }), null, TICKET)
    const live = (state?.body as { active: { run: { id: string } }[] }).active
    expect(live.map((one) => one.run.id)).toEqual([started.run.id])
    expect(runningSuite(now, 'slowish')?.id).toBe(started.run.id)
    expect(active(now)).toHaveLength(1)

    await ended(now)
    expect(runsFor(now, 'r1').map((r) => r.verdict)).toEqual(['passed'])
    expect(existsSync(was)).toBe(false)
  })

  test('with nobody asking, the run finds where its project went by asking the host, and is recorded there', async () => {
    const was = project()
    START(was)
    const started = begin({ project: was, suite: 'slowish', ref: 'r1', by: 'the test' })
    if (!started.ok) throw new Error(started.error)

    const now = join(base, `renamed-quiet-${n}`)
    renameSync(was, now)
    hostThat({ [now]: ID }, { [was]: now })

    await ended(now)
    expect(runsFor(now, 'r1').map((r) => r.verdict)).toEqual(['passed'])
    expect(existsSync(was)).toBe(false)
    expect(active()).toHaveLength(0)
  })

  test('when the host cannot say where it went, the run is released and nothing is written anywhere', async () => {
    const was = project()
    START(was)
    const started = begin({ project: was, suite: 'slowish', ref: 'r1', by: 'the test' })
    if (!started.ok) throw new Error(started.error)

    const now = join(base, `renamed-lost-${n}`)
    renameSync(was, now)
    noHost()

    const gone = Date.now() + 10_000
    while (active().length && Date.now() < gone) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(active()).toHaveLength(0)
    expect(existsSync(was)).toBe(false)
    expect(readFileSync(join(now, '.kehikot', 'project.json'), 'utf8')).toContain(ID)
    expect(existsSync(join(now, '.kehikot', 'tests', 'runs.json'))).toBe(true) /* the record written when it began, now at the new path */
    expect(runsFor(now, 'r1').map((r) => r.verdict)).toEqual(['running'])
  })
})
