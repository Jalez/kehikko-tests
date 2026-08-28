import { afterEach, expect, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import type { Run, Standing } from '../runs/store.ts'
import { RefCard } from '../src/app.tsx'

/**
 * What the card SAYS, asserted against the real component.
 *
 * The words are the product here. This module's whole claim is that it tells
 * "nothing has been run" from "passed" from "we could not tell", and a test that
 * checked a boolean somewhere in a store would not notice the day one of those
 * three stopped reaching the screen.
 */

afterEach(cleanup)

const run = (over: Partial<Run> = {}): Run => ({
  id: 'r1',
  suite: 'unit',
  ref: 'gh#7',
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  verdict: 'passed',
  exitCode: 0,
  signal: null,
  passed: 12,
  failed: 0,
  tail: [],
  dropped: 0,
  by: 'the test',
  command: ['bun', 'test'],
  dir: '/tmp',
  ...over,
})

const standing = (runs: Run[]): Standing => ({
  ref: 'gh#7',
  latest: runs[0] ?? null,
  runs,
  bySuite: runs,
})

const draw = (s: Standing, suites: string[] = ['unit']) =>
  render(
    <RefCard
      standing={s}
      kind={null}
      suites={suites}
      live={[]}
      trouble={{}}
      onRun={() => {}}
      onStop={() => {}}
      confirming={null}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  )

test('a reference nothing has been run against says so, and does not say "failed"', () => {
  draw(standing([]), [])
  expect(screen.getByText(/Nothing has been run against this/)).toBeTruthy()
  expect(screen.getByText(/not a pass and not a failure/)).toBeTruthy()
  expect(screen.queryByText('failed')).toBeNull()
})

test('a configured suite with no run against this reference is visible as an absence', () => {
  /* The checklist half of the brief: a suite nobody has run against this change
     is a row that is THERE and empty, not a row that is missing. A missing row
     looks exactly like a row that was never meant to be there. */
  draw(standing([]), ['unit', 'e2e'])
  expect(screen.getAllByText('not run against this reference')).toHaveLength(2)
})

test('a passing run names the verdict in words, not only in colour', () => {
  draw(standing([run()]))
  expect(screen.getByText('passed')).toBeTruthy()
  expect(screen.getByText(/12 passed, 0 failed/)).toBeTruthy()
})

test('a run whose output said nothing about counts says that, rather than zero', () => {
  draw(standing([run({ passed: null, failed: null })]))
  expect(screen.getByText(/its output did not say how many/)).toBeTruthy()
})

test('a timeout is called a timeout, and is glossed so nobody reads it as a failure', () => {
  draw(standing([run({ verdict: 'timeout', exitCode: null, passed: null, failed: null })]))
  expect(screen.getByText('timeout')).toBeTruthy()
  expect(screen.getByText(/It hung/)).toBeTruthy()
  expect(screen.queryByText('failed')).toBeNull()
})

test('a crashed run is distinguished from a failing one', () => {
  draw(standing([run({ verdict: 'crashed', exitCode: null })]))
  expect(screen.getByText('crashed')).toBeTruthy()
  expect(screen.getByText(/Not a test failure/)).toBeTruthy()
})

test('a suite that has runs here but is no longer configured is kept and marked', () => {
  /* "The unit suite failed against this on Tuesday" is a fact about Tuesday, and
     it does not stop being one because somebody deleted the suite. */
  draw(standing([run({ suite: 'gone' })]), [])
  expect(screen.getByText('no longer configured')).toBeTruthy()
})

test('nothing in the card is a long unbroken string that could widen a pane', () => {
  /* The pane is 220px at its narrowest. Every element that can hold a path or a
     ref carries `overflow-wrap: anywhere` in `index.css`; this asserts the other
     half, which is that the card does not put a fixed-width element in the way.
     The measured version of this is the Playwright pass at 220/280/320/400. */
  const { container } = draw(standing([run()]))
  for (const el of container.querySelectorAll('*')) {
    expect((el as HTMLElement).style.width).toBe('')
  }
})
