import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A project folder that is renamed or moved keeps its suites, its runs and a
 * person's confirmations: directories are stored relative to the project, and
 * confirmations are keyed by the project's id (`.kehikot/project.json`,
 * protocol 2.1.0) when it has one. Everything here is in scratch directories.
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), 'tests-rename-')))
const machine = realpathSync(mkdtempSync(join(tmpdir(), 'tests-rename-machine-')))
const was = process.env.TESTS_CONFIRMED_DIR

beforeEach(() => {
  process.env.TESTS_DATA = join(base, 'no-legacy')
  process.env.TESTS_CONFIRMED_DIR = machine
})
afterAll(() => {
  process.env.TESTS_CONFIRMED_DIR = was
  rmSync(base, { recursive: true, force: true })
  rmSync(machine, { recursive: true, force: true })
})

const { fingerprint, isConfirmed, keepConfirmed } = await import('../suites/confirmed.ts')
const { configure, suite } = await import('../suites/store.ts')
const { begin } = await import('../runs/spawn.ts')
const { record, runsFor } = await import('../runs/store.ts')
const { storedDir } = await import('../store.ts')

let n = 0
function project(id: string | null = null): string {
  n += 1
  const dir = join(base, `p${n}`)
  mkdirSync(join(dir, '.kehikot'), { recursive: true })
  mkdirSync(join(dir, 'sub', 'deep'), { recursive: true })
  if (id) writeFileSync(join(dir, '.kehikot', 'project.json'), JSON.stringify({ id, createdAt: null }))
  return dir
}
const suitesFile = (dir: string) => join(dir, '.kehikot', 'tests', 'suites.json')
const confirmed = () => JSON.parse(readFileSync(join(machine, 'confirmed.json'), 'utf8')).projects
const make = (dir: string, name: string, at: string) => {
  const out = configure(dir, { name, what: 'something worth proving', command: ['bun', 'test'], dir: at })
  if (!out.ok) throw new Error(out.error)
  return out.suite
}

describe('a suite’s directory is stored relative to the project', () => {
  test('the project folder is kept as "", a folder in it by its relative path, and both are handed out absolute', () => {
    const dir = project()
    const root = make(dir, 'root', dir)
    const deep = make(dir, 'deep', join(dir, 'sub', 'deep'))
    const kept = JSON.parse(readFileSync(suitesFile(dir), 'utf8')).suites
    expect(kept.root.dir).toBe('')
    expect(kept.deep.dir).toBe(join('sub', 'deep'))
    expect(root).toMatchObject({ dir, rel: '' })
    expect(deep).toMatchObject({ dir: join(dir, 'sub', 'deep'), rel: join('sub', 'deep') })
  })

  test('after the folder is renamed the suite resolves under the new path', () => {
    const dir = project()
    make(dir, 'deep', join(dir, 'sub', 'deep'))
    const moved = join(base, `moved-${n}`)
    renameSync(dir, moved)
    expect(suite(moved, 'deep')).toMatchObject({ dir: join(moved, 'sub', 'deep'), rel: join('sub', 'deep') })
  })

  test('an absolute directory under the project (written before) is made relative and written back', () => {
    const dir = project()
    mkdirSync(join(dir, '.kehikot', 'tests'), { recursive: true })
    writeFileSync(suitesFile(dir), JSON.stringify({ suites: { unit: { name: 'unit', what: 'something worth proving', command: ['bun', 'test'], dir: join(dir, 'sub'), timeoutMs: 5000, by: 'x', at: 'y' } } }))
    expect(suite(dir, 'unit')).toMatchObject({ dir: join(dir, 'sub'), rel: 'sub' })
    expect(JSON.parse(readFileSync(suitesFile(dir), 'utf8')).suites.unit.dir).toBe('sub')
  })

  test('an absolute directory from before a rename is found under the project by its tail', () => {
    const dir = project()
    const gone = join(base, `gone-${n}`)
    mkdirSync(join(dir, '.kehikot', 'tests'), { recursive: true })
    const one = (name: string, at: string) => ({ name, what: 'something worth proving', command: ['bun', 'test'], dir: at, timeoutMs: 5000, by: 'x', at: 'y' })
    writeFileSync(suitesFile(dir), JSON.stringify({ suites: { top: one('top', gone), deep: one('deep', join(gone, 'sub', 'deep')), lost: one('lost', join(gone, 'nowhere')) } }))
    expect(suite(dir, 'top')).toMatchObject({ dir, rel: '' })
    expect(suite(dir, 'deep')).toMatchObject({ dir: join(dir, 'sub', 'deep'), rel: join('sub', 'deep') })
    /* Not found under the project: kept as written, and said so when it is asked to run. */
    expect(suite(dir, 'lost')).toMatchObject({ dir: join(gone, 'nowhere'), rel: null })
    const out = begin({ project: dir, suite: 'lost', by: 'the test' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error).toContain('renamed or moved')
  })

  test('the tail is never taken from a folder that is still there and is not a project', () => {
    const dir = project()
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'tests-rename-other-')))
    mkdirSync(join(other, 'sub'))
    expect(storedDir(dir, join(other, 'sub'))).toBeNull()
    /* …but a copy's original, which is a project folder, is. */
    mkdirSync(join(other, '.kehikot'))
    expect(storedDir(dir, join(other, 'sub'))).toBe('sub')
    rmSync(other, { recursive: true, force: true })
  })

  test('a relative directory that climbs out is not placed', () => {
    const dir = project()
    expect(storedDir(dir, '../elsewhere')).toBeNull()
    expect(storedDir(dir, 'sub/../sub')).toBe('sub')
    expect(storedDir(dir, '.')).toBe('')
  })
})

describe('runs keep their directory relative', () => {
  test('stored relative, handed out under the project as it is now', () => {
    const dir = project()
    const run = { id: 'r1', suite: 'unit', ref: '', startedAt: 'a', endedAt: 'b', verdict: 'passed' as const, exitCode: 0, signal: null, passed: 1, failed: 0, tail: [], dropped: 0, by: 'x', command: ['bun', 'test'], dir: join(dir, 'sub') }
    record(dir, run)
    expect(JSON.parse(readFileSync(join(dir, '.kehikot', 'tests', 'runs.json'), 'utf8')).runs[''][0].dir).toBe('sub')
    const moved = join(base, `moved-${n}`)
    renameSync(dir, moved)
    expect(runsFor(moved, '')[0]?.dir).toBe(join(moved, 'sub'))
  })
})

describe('confirmations are keyed by the project id', () => {
  test('with an id they are kept under it and survive a rename', () => {
    const id = crypto.randomUUID()
    const dir = project(id)
    const unit = make(dir, 'unit', dir)
    keepConfirmed(dir, unit)
    expect(confirmed()[`id:${id}`].unit).toBe(fingerprint(unit))
    expect(confirmed()[dir]).toBeUndefined()
    const moved = join(base, `moved-${n}`)
    renameSync(dir, moved)
    expect(isConfirmed(moved, suite(moved, 'unit')!)).toBe(true)
  })

  test('without an id they are kept under the real path, as before', () => {
    const dir = project()
    const unit = make(dir, 'unit', dir)
    keepConfirmed(dir, unit)
    expect(confirmed()[dir].unit).toBe(fingerprint(unit))
    const moved = join(base, `moved-${n}`)
    renameSync(dir, moved)
    expect(isConfirmed(moved, suite(moved, 'unit')!)).toBe(false)
  })

  test('kept under the path, they move to the id the first time the project has one', () => {
    const dir = project()
    const unit = make(dir, 'unit', dir)
    keepConfirmed(dir, unit)
    const id = crypto.randomUUID()
    writeFileSync(join(dir, '.kehikot', 'project.json'), JSON.stringify({ id, createdAt: null }))
    expect(isConfirmed(dir, unit)).toBe(true)
    expect(confirmed()[dir]).toBeUndefined()
    expect(confirmed()[`id:${id}`].unit).toBe(fingerprint(unit))
  })

  test('a confirmation of the old absolute fingerprint is carried to the relative one, and only that', () => {
    const id = crypto.randomUUID()
    const dir = project(id)
    mkdirSync(join(dir, '.kehikot', 'tests'), { recursive: true })
    const one = (name: string, command: string[]) => ({ name, what: 'something worth proving', command, dir: join(dir, 'sub'), timeoutMs: 5000, by: 'x', at: 'y' })
    writeFileSync(suitesFile(dir), JSON.stringify({ suites: { same: one('same', ['bun', 'test']), other: one('other', ['bun', 'x']) } }))
    /* As the module kept them before: under the path, of the absolute directory — one of them of a different command. */
    const old = (command: string[]) => fingerprint({ command, dir: join(dir, 'sub') })
    writeFileSync(join(machine, 'confirmed.json'), JSON.stringify({ projects: { ...confirmed(), [dir]: { same: old(['bun', 'test']), other: old(['rm', '-rf']) } } }))
    expect(isConfirmed(dir, suite(dir, 'same')!)).toBe(true)
    expect(isConfirmed(dir, suite(dir, 'other')!)).toBe(false)
    expect(confirmed()[`id:${id}`].same).toBe(fingerprint({ command: ['bun', 'test'], dir: 'sub' }))
  })
})
