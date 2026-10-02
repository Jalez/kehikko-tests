import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Where the store lives, and the old single store being handed out.
 *
 * The suites and runs used to live in one `data/` beside this program. They live
 * at `<project>/.kehikot/tests/` now, and the old files are moved into the
 * project each entry's directory is in — see `claim` and `adopt` in `store.ts`.
 * `TESTS_DATA` points at a temporary legacy directory here, never at the real one.
 */

let root: string
let legacy: string
let alpha: string
let beta: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tests-legacy-')))
  legacy = join(root, 'legacy')
  alpha = join(root, 'alpha')
  beta = join(root, 'beta')
  for (const dir of [legacy, alpha, beta]) mkdirSync(dir)
  /* Repositories, so an enclosing folder opened as a project cannot claim them. */
  mkdirSync(join(alpha, '.git'))
  mkdirSync(join(beta, '.git'))
  process.env.TESTS_DATA = legacy
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const suites = () => import('../suites/store.ts')
const runs = () => import('../runs/store.ts')

const suite = (name: string, dir: string) => ({
  name,
  what: `the ${name} suite`,
  command: ['bun', 'test'],
  dir,
  timeoutMs: 1000,
  by: 'the test',
  at: '2026-01-01T00:00:00.000Z',
})
const run = (id: string, dir: string) => ({
  id,
  suite: 'unit',
  ref: 'gh#1',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:00:01.000Z',
  verdict: 'passed',
  exitCode: 0,
  signal: null,
  passed: 1,
  failed: 0,
  tail: [],
  dropped: 0,
  by: 'the test',
  command: ['bun', 'test'],
  dir,
})

const writeLegacy = () => {
  writeFileSync(
    join(legacy, 'suites.json'),
    JSON.stringify({ suites: { a: suite('a', alpha), b: suite('b', beta), gone: suite('gone', join(root, 'deleted')) } }),
  )
  writeFileSync(join(legacy, 'runs.json'), JSON.stringify({ runs: { 'gh#1': [run('r-a', alpha), run('r-b', beta), run('r-none', '')] } }))
}

const file = (project: string, name: string) => join(project, '.kehikot', 'tests', `${name}.json`)

test('suites and runs live in the project, at .kehikot/tests/', async () => {
  const { configure } = await suites()
  const out = configure(alpha, { name: 'unit', what: 'something worth proving', command: ['bun', 'test'], dir: alpha })
  expect(out.ok).toBe(true)
  expect(existsSync(file(alpha, 'suites'))).toBe(true)
})

test('two projects are two stores', async () => {
  const { configure, suites: list } = await suites()
  configure(alpha, { name: 'unit', what: 'something worth proving', command: ['bun', 'test'], dir: alpha })
  expect(list(beta)).toEqual([])
})

test('reading creates nothing', async () => {
  const { suites: list } = await suites()
  expect(list(alpha)).toEqual([])
  expect(existsSync(join(alpha, '.kehikot'))).toBe(false)
})

test('no project: reads are empty and writes are refused', async () => {
  const { configure, suites: list } = await suites()
  expect(list(null)).toEqual([])
  const out = configure(null, { name: 'unit', what: 'something worth proving', command: ['bun', 'test'], dir: alpha })
  expect(out.ok).toBe(false)
  if (!out.ok) expect(out.error).toContain('no project is open')
})

test('a .kehikot that points out of the project is refused, not followed', async () => {
  const { configure } = await suites()
  const outside = join(root, 'outside')
  mkdirSync(outside)
  symlinkSync(outside, join(alpha, '.kehikot'))
  const out = configure(alpha, { name: 'unit', what: 'something worth proving', command: ['bun', 'test'], dir: alpha })
  expect(out.ok).toBe(false)
  expect(existsSync(join(outside, 'tests'))).toBe(false)
})

test('the old store is split by directory: each project takes its own, the first also takes the unplaceable', async () => {
  writeLegacy()
  const s = await suites()
  const r = await runs()

  expect(s.suites(alpha).map((x) => x.name)).toEqual(['a', 'gone'])
  expect(r.runsFor(alpha, 'gh#1').map((x) => x.id).sort()).toEqual(['r-a', 'r-none'])

  /* What alpha did not take is still in the legacy files, waiting for beta. */
  expect(Object.keys(JSON.parse(readFileSync(join(legacy, 'suites.json'), 'utf8')).suites)).toEqual(['b'])

  expect(s.suites(beta).map((x) => x.name)).toEqual(['b'])
  expect(r.runsFor(beta, 'gh#1').map((x) => x.id)).toEqual(['r-b'])

  /* Everything placed: the legacy files and their folder are gone. */
  expect(existsSync(legacy)).toBe(false)
})

test('an enclosing folder opened as a project does not claim a repository inside it', async () => {
  writeLegacy()
  const s = await suites()
  /* `root` holds alpha and beta, both repositories. It takes only what nothing
     else could ever place. */
  expect(s.suites(root).map((x) => x.name)).toEqual(['gone'])
  expect(s.suites(alpha).map((x) => x.name)).toEqual(['a'])
})

test('never over a store the project already has', async () => {
  writeLegacy()
  mkdirSync(join(alpha, '.kehikot', 'tests'), { recursive: true })
  writeFileSync(file(alpha, 'suites'), JSON.stringify({ suites: { mine: suite('mine', alpha) } }))
  const s = await suites()
  expect(s.suites(alpha).map((x) => x.name)).toEqual(['mine'])
  /* Left in the legacy file untouched, not lost. */
  expect(Object.keys(JSON.parse(readFileSync(join(legacy, 'suites.json'), 'utf8')).suites).sort()).toEqual(['a', 'b', 'gone'])
})

test('a legacy file that will not parse is left alone', async () => {
  writeFileSync(join(legacy, 'suites.json'), 'not json {{{')
  const s = await suites()
  expect(s.suites(alpha)).toEqual([])
  expect(readFileSync(join(legacy, 'suites.json'), 'utf8')).toBe('not json {{{')
})

test('a run left "running" by a previous process is swept when its project is read, and a live one is not', async () => {
  mkdirSync(join(alpha, '.kehikot', 'tests'), { recursive: true })
  writeFileSync(
    file(alpha, 'runs'),
    JSON.stringify({ runs: { 'gh#1': [{ ...run('orphan', alpha), verdict: 'running' }, { ...run('going', alpha), verdict: 'running' }] } }),
  )
  const r = await runs()
  expect(r.sweep(alpha, (id) => id === 'going')).toBe(1)
  const verdicts = Object.fromEntries(r.runsFor(alpha, 'gh#1').map((x) => [x.id, x.verdict]))
  expect(verdicts).toEqual({ orphan: 'crashed', going: 'running' })
})
