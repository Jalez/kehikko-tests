import { afterAll, beforeEach, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A person's confirmation of a command: what it is of, and where it is kept.
 *
 * The point of every test here is that a project cannot carry it. What a person
 * confirmed is kept on the machine they confirmed it on, by the project's real
 * path, and nothing a project folder holds can stand in for it.
 */

const here = realpathSync(mkdtempSync(join(tmpdir(), 'tests-confirmed-project-')))
const machine = realpathSync(mkdtempSync(join(tmpdir(), 'tests-confirmed-machine-')))
const legacy = `${here}-legacy`
const was = process.env.TESTS_CONFIRMED_DIR

beforeEach(() => {
  process.env.TESTS_DATA = legacy
  process.env.TESTS_CONFIRMED_DIR = machine
})
afterAll(() => {
  process.env.TESTS_CONFIRMED_DIR = was
  rmSync(here, { recursive: true, force: true })
  rmSync(machine, { recursive: true, force: true })
})

const { confirmedDir, dropConfirmed, fingerprint, isConfirmed, keepConfirmed } = await import('../suites/confirmed.ts')
const { configure, forget, listed, suite } = await import('../suites/store.ts')

const made = (project: string, name: string, command: string[] = ['bun', 'test']) => {
  const out = configure(project, { name, what: 'something worth proving', command, dir: project })
  if (!out.ok) throw new Error(out.error)
  return out.suite
}

test('the fingerprint is of the command and the directory, and of nothing else', () => {
  const one = { command: ['bun', 'test'], dir: '/p' }
  expect(fingerprint(one)).toMatch(/^[0-9a-f]{64}$/)
  expect(fingerprint({ ...one })).toBe(fingerprint(one))
  expect(fingerprint({ command: ['bun', 'test', '--watch'], dir: '/p' })).not.toBe(fingerprint(one))
  expect(fingerprint({ command: ['bun test'], dir: '/p' })).not.toBe(fingerprint(one))
  expect(fingerprint({ command: ['bun', 'test'], dir: '/p/sub' })).not.toBe(fingerprint(one))
  /* Two spellings that would read the same joined by spaces are two commands. */
  expect(fingerprint({ command: ['a b', 'c'], dir: '/p' })).not.toBe(fingerprint({ command: ['a', 'b c'], dir: '/p' }))
})

test('a suite is unconfirmed until a person confirms it, and the listing says which', () => {
  const unit = made(here, 'unit')
  expect(isConfirmed(here, unit)).toBe(false)
  expect(listed(here).find((one) => one.name === 'unit')).toMatchObject({ confirmed: false, fingerprint: fingerprint(unit) })
  expect(keepConfirmed(here, unit)).toBe(true)
  expect(isConfirmed(here, unit)).toBe(true)
  expect(listed(here).find((one) => one.name === 'unit')?.confirmed).toBe(true)
})

test('it is kept on the machine, by the project’s real path, and nowhere in the project', () => {
  const kept = JSON.parse(readFileSync(join(machine, 'confirmed.json'), 'utf8'))
  expect(kept.projects[here].unit).toBe(fingerprint(suite(here, 'unit')!))
  expect(readdirSync(join(here, '.kehikot', 'tests'))).toEqual(['suites.json'])
  expect(readFileSync(join(here, '.kehikot', 'tests', 'suites.json'), 'utf8')).not.toContain(fingerprint(suite(here, 'unit')!))
})

test('by default it is in this machine’s Kehikot folder, beside the module registry', () => {
  expect(confirmedDir({ KEHIKOT_MODULES_DIR: '/scratch/kehikot/modules' })).toBe('/scratch/kehikot/module-state/tests')
  expect(confirmedDir({ KEHIKOT_MODULES_DIR: '/scratch/kehikot/modules', TESTS_CONFIRMED_DIR: '/elsewhere' })).toBe('/elsewhere')
})

test('a copy of the project is unconfirmed where it is, whatever its files say', () => {
  const copy = `${here}-copy`
  cpSync(here, copy, { recursive: true })
  try {
    const arrived = suite(copy, 'unit')!
    expect(arrived.command).toEqual(['bun', 'test'])
    expect(isConfirmed(copy, arrived)).toBe(false)
    /* Not even with a file of confirmations planted in the project. */
    writeFileSync(join(copy, '.kehikot', 'tests', 'confirmed.json'), readFileSync(join(machine, 'confirmed.json')))
    mkdirSync(join(copy, 'module-state', 'tests'), { recursive: true })
    writeFileSync(join(copy, 'module-state', 'tests', 'confirmed.json'), readFileSync(join(machine, 'confirmed.json')))
    expect(isConfirmed(copy, arrived)).toBe(false)
    expect(listed(copy).every((one) => !one.confirmed)).toBe(true)
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})

test('a change to the command or the directory is a different suite to confirm', () => {
  mkdirSync(join(here, 'sub'), { recursive: true })
  const unit = suite(here, 'unit')!
  expect(isConfirmed(here, { ...unit, command: ['bun', 'test', '--bail'] })).toBe(false)
  expect(isConfirmed(here, { ...unit, dir: join(here, 'sub') })).toBe(false)
  /* What it proves, how long it may take and who wrote it down are not what runs. */
  expect(isConfirmed(here, { ...unit, what: 'said another way', timeoutMs: 1_000, by: 'somebody else' } as typeof unit)).toBe(true)
})

test('one suite’s confirmation is not another’s, and not another project’s', () => {
  const other = made(here, 'other')
  expect(isConfirmed(here, other)).toBe(false)
  expect(isConfirmed(here, { ...suite(here, 'unit')!, name: 'other' })).toBe(false)
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'tests-confirmed-other-')))
  try {
    expect(isConfirmed(elsewhere, made(elsewhere, 'unit'))).toBe(false)
  } finally {
    rmSync(elsewhere, { recursive: true, force: true })
  }
  expect(isConfirmed(null, suite(here, 'unit')!)).toBe(false)
  expect(keepConfirmed(null, suite(here, 'unit')!)).toBe(false)
})

test('taking a suite off the list forgets its confirmation', () => {
  expect(forget(here, 'unit').ok).toBe(true)
  expect(isConfirmed(here, made(here, 'unit'))).toBe(false)
  dropConfirmed(here, 'never-was')
})

test('a file that cannot be read confirms nothing, and a confirmation writes a good one over it', () => {
  const unit = suite(here, 'unit')!
  keepConfirmed(here, unit)
  for (const text of ['not json', '[]', '{"projects":[]}', `{"projects":{"${here}":"unit"}}`, `{"projects":{"${here}":{"unit":7}}}`]) {
    writeFileSync(join(machine, 'confirmed.json'), text)
    expect([text, isConfirmed(here, unit)]).toEqual([text, false])
  }
  rmSync(join(machine, 'confirmed.json'))
  expect(isConfirmed(here, unit)).toBe(false)
  keepConfirmed(here, unit)
  expect(isConfirmed(here, unit)).toBe(true)
  expect(existsSync(join(machine, 'confirmed.json'))).toBe(true)
})
