import { expect, test } from 'bun:test'

import { fold, NOTHING, readCounts } from '../runs/counts.ts'

/**
 * Reading counts out of runner output, and — more importantly — NOT reading them
 * when there is nothing there.
 *
 * The last test is the one that matters: an unrecognised line has to leave the
 * counts null, so that the page can say "its output did not say how many" rather
 * than drawing a confident zero under a suite that ran two hundred tests.
 */

test('bun’s own summary is read', () => {
  expect(fold(NOTHING, ' 12 pass')).toEqual({ passed: 12, failed: null })
  expect(fold({ passed: 12, failed: null }, ' 3 fail')).toEqual({ passed: 12, failed: 3 })
})

test('jest and vitest spellings are read', () => {
  expect(fold(NOTHING, 'Tests:       1 failed, 2 passed, 3 total')).toEqual({ passed: 2, failed: 1 })
  expect(fold(NOTHING, 'Tests  2 passed | 1 failed (3)')).toEqual({ passed: 2, failed: 1 })
})

test('"passed" is not mistaken for "pass", and vice versa', () => {
  /* The patterns are separate because bun prints `pass` on one line and `fail`
     on another, while jest prints both on one. A boundary error here would
     double-count or miss a count silently. */
  expect(readCounts('4 passed')).toEqual({ passed: 4 })
  expect(readCounts('4 pass')).toEqual({ passed: 4 })
})

test('a partial line does not reset what another line established', () => {
  /* Bun prints the two counts on separate lines. A whole-record replacement here
     would mean this app never saw a failure count from the runner it is most
     likely to be pointed at. */
  expect(fold({ passed: null, failed: 3 }, '10 pass')).toEqual({ passed: 10, failed: 3 })
})

test('the last recognised line wins rather than accumulating', () => {
  /* Runners print a per-file line and then a summary; adding them together
     double-counts every test in the project. */
  let counts = fold(NOTHING, '2 pass')
  counts = fold(counts, '9 pass')
  expect(counts.passed).toBe(9)
})

test('output that says nothing about counts leaves them null, not zero', () => {
  for (const line of ['', 'building…', 'ok', 'FAIL src/thing.test.ts', 'exit status 1']) {
    expect(fold(NOTHING, line)).toEqual({ passed: null, failed: null })
  }
})
