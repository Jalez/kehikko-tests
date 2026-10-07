import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'

import type { HostEvents } from 'kehikot-module-protocol/client'

/**
 * What the page does when the canvas moves faster than the host answers.
 *
 * `connect` is replaced so that the test decides when a `live.get` is answered
 * and what the host says next; a real window cannot be made to answer late on
 * cue. The run store is replaced too, so the App renders without a server.
 */
type Context = Parameters<NonNullable<HostEvents['onContext']>>[0]

let events: HostEvents
let asked: Array<{ epic: string; answer: (data: unknown) => void }> = []

const realClient = await import('kehikot-module-protocol/client')
mock.module('kehikot-module-protocol/client', () => ({
  ...realClient,
  connect: (_id: string, handlers: HostEvents) => {
    events = handlers
    return {
      listen: () => {},
      stop: () => {},
      resize: () => {},
      request: (_method: string, params: { epic: string }) =>
        new Promise((resolve) => asked.push({ epic: params.epic, answer: resolve })),
    }
  },
}))

const realRuns = await import('../src/store/use-runs.ts')
mock.module('../src/store/use-runs.ts', () => ({
  ...realRuns,
  useRuns: () => ({
    state: { nowhere: false, suites: [], active: [], slots: 2, refs: ['gh#7'], trouble: null },
    live: [],
    connected: true,
    ended: [],
    reload: () => {},
  }),
}))

const realAsk = await import('../src/store/ask.ts')
mock.module('../src/store/ask.ts', () => ({
  ...realAsk,
  standings: async (_project: string | null, refs: string[]) =>
    refs.map((ref) => ({ ref, latest: null, runs: [], bySuite: [] })),
}))

const { useKehikot } = await import('../src/wire/use-kehikot.ts')
const { App } = await import('../src/app.tsx')

afterEach(cleanup)

const context = (epic: string | null, projectPath: string | null = '/p/x'): Context =>
  ({ epic, theme: 'light', selection: [], projectPath }) as unknown as Context

describe('useKehikot', () => {
  test('a late reading for the epic that was closed does not replace "no epic is open"', async () => {
    asked = []
    const { result } = renderHook(() => useKehikot('tests', () => {}))
    act(() => events.onHello!(context('a'), null))
    act(() => events.onContext!(context(null)))
    expect(result.current.sight.at).toBe('no-epic')

    await act(async () => asked[0]!.answer({ refs: [] }))
    expect(result.current.sight.at).toBe('no-epic')
  })

  test('the same slug in another project is asked again', async () => {
    asked = []
    const { result } = renderHook(() => useKehikot('tests', () => {}))
    act(() => events.onHello!(context('thesis', '/p/x'), null))
    await act(async () => asked[0]!.answer({ from: 'x' }))
    expect(asked).toHaveLength(1)

    act(() => events.onContext!(context('thesis', '/p/y')))
    expect(asked).toHaveLength(2)
    expect(result.current.sight.at).toBe('asking')

    /* The first project's slow answer must not land under the second's name. */
    await act(async () => asked[0]!.answer({ from: 'x' }))
    expect(result.current.sight.at).toBe('asking')
  })

  test('the same slug in the same project is not asked again', () => {
    asked = []
    renderHook(() => useKehikot('tests', () => {}))
    act(() => events.onHello!(context('thesis'), null))
    act(() => events.onContext!(context('thesis')))
    expect(asked).toHaveLength(1)
  })
})

describe('App', () => {
  const picked = () => screen.queryByText(/you picked here/)

  const pick = async () => {
    render(<App />)
    act(() => events.onHello!(context('a'), null))
    await act(async () => screen.getByText('gh#7').click())
    expect(picked()).toBeTruthy()
  }

  test('a reference picked here is dropped when the epic changes', async () => {
    asked = []
    await pick()
    await act(async () => events.onContext!(context('b')))
    expect(picked()).toBeNull()
  })

  test('a reference picked here is dropped when the project changes', async () => {
    asked = []
    await pick()
    await act(async () => events.onContext!(context('a', '/p/y')))
    expect(picked()).toBeNull()
  })

  test('a repeated context for the same epic and project keeps the pick', async () => {
    asked = []
    await pick()
    await act(async () => events.onContext!(context('a')))
    expect(picked()).toBeTruthy()
  })
})
