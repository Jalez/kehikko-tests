import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The refusals that make this module safe to run.
 *
 * Every test here is a way somebody could have turned an HTTP port into a shell,
 * and the assertion is that the store said no. These are the most load-bearing
 * tests in the repository: the spawn in `runs/spawn.ts` is only defensible
 * because everything it is ever handed came through `configure`.
 */

const here = mkdtempSync(join(tmpdir(), 'tests-suites-'))

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
  process.env.TESTS_DATA = here
})
afterAll(() => {
  rmSync(here, { recursive: true, force: true })
})

const { configure, forget, suite, suites } = await import('../suites/store.ts')

const good = () => ({ name: 'unit', what: 'the store refuses a command line', command: ['bun', 'test'], dir: here })

test('a well-formed suite is kept, exactly as it was written', () => {
  const out = configure({ ...good(), by: 'the test' })
  expect(out.ok).toBe(true)
  const kept = suite('unit')
  expect(kept?.command).toEqual(['bun', 'test'])
  expect(kept?.dir).toBe(here)
  expect(kept?.by).toBe('the test')
})

test('a COMMAND LINE is refused, and the refusal says what to send instead', () => {
  /* The single most important refusal in the module. A string here would be
     looked up as the name of one program with spaces in it — and the moment
     anybody "fixed" that by passing it to a shell, this port would be a shell. */
  const out = configure({ ...good(), name: 'shellish', command: 'bun test && rm -rf /' })
  expect(out.ok).toBe(false)
  if (!out.ok) {
    expect(out.error).toContain('array')
    expect(out.error).toContain('["bun", "test"]')
  }
  expect(suite('shellish')).toBeNull()
})

test('a relative directory is refused', () => {
  const out = configure({ ...good(), name: 'relative', dir: './somewhere' })
  expect(out.ok).toBe(false)
  if (!out.ok) expect(out.error).toContain('absolute')
})

test('a directory that does not exist is refused, at configuration time', () => {
  const out = configure({ ...good(), name: 'missing', dir: join(here, 'nope', 'nothing') })
  expect(out.ok).toBe(false)
  if (!out.ok) expect(out.error).toContain('not a directory')
})

test('a name that is not a name is refused', () => {
  for (const name of ['', 'Has Spaces', 'quote"mark', '../escape', 'x'.repeat(80)]) {
    const out = configure({ ...good(), name })
    expect(out.ok).toBe(false)
  }
})

test('a suite has to say what it proves', () => {
  const out = configure({ ...good(), name: 'terse', what: 'tests' })
  expect(out.ok).toBe(false)
  if (!out.ok) expect(out.error).toContain('what it proves')
})

test('an empty program is refused, and so is a non-string argument', () => {
  expect(configure({ ...good(), name: 'empty', command: ['  '] }).ok).toBe(false)
  expect(configure({ ...good(), name: 'nonstring', command: ['bun', 42] }).ok).toBe(false)
  expect(configure({ ...good(), name: 'nul', command: ['bun', 'a\0b'] }).ok).toBe(false)
})

test('the timeout is clamped rather than trusted', () => {
  configure({ ...good(), name: 'forever', timeoutMs: 999_999_999 })
  expect(suite('forever')?.timeoutMs).toBe(900_000)
  configure({ ...good(), name: 'instant', timeoutMs: 1 })
  expect(suite('instant')?.timeoutMs).toBe(1_000)
  configure({ ...good(), name: 'unsaid' })
  expect(suite('unsaid')?.timeoutMs).toBe(120_000)
})

test('too many arguments is refused', () => {
  const out = configure({ ...good(), name: 'wordy', command: new Array(40).fill('x') })
  expect(out.ok).toBe(false)
})

test('configuring the same name again replaces it, and forgetting removes it', () => {
  configure({ ...good(), name: 'twice', command: ['echo', 'one'] })
  configure({ ...good(), name: 'twice', command: ['echo', 'two'] })
  expect(suite('twice')?.command).toEqual(['echo', 'two'])
  expect(forget('twice').ok).toBe(true)
  expect(suite('twice')).toBeNull()
  expect(forget('twice').ok).toBe(false)
})

test('every stored suite is a structure, never a string a shell could read', () => {
  for (const s of suites()) {
    expect(Array.isArray(s.command)).toBe(true)
    expect(s.dir.startsWith('/')).toBe(true)
  }
})
