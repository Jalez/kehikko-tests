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

/** A context with a selection and the epic's parts in it, as a host on protocol 0.29 sends one. */
const focused = (selection: string[], parts?: unknown[]): Context =>
  ({ epic: 'a', theme: 'light', selection, projectPath: '/p/x', ...(parts ? { parts } : {}) }) as unknown as Context
const part = (id: string, heading: string, refs: string[], picked: boolean) => ({ id, heading, refs, picked })
const seam = (picked: boolean) => part('seam', 'The posting seam', ['gh#10'], picked)

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

/**
 * `context.parts`, from the host's message to the hook's value and on to the
 * page. The hook names the fields of a context one by one, so a new field
 * arrives nowhere until a line there carries it.
 */
describe('the parts of the epic', () => {
  test('reach the hook from the greeting, follow a later context, and keep their identity when repeated', () => {
    asked = []
    const { result } = renderHook(() => useKehikot('tests', () => {}))
    act(() => events.onHello!(focused([], [seam(false)]), null))
    expect(result.current.parts).toEqual([seam(false)])

    act(() => events.onContext!(focused([], [seam(true)])))
    expect(result.current.parts).toEqual([seam(true)])
    const held = result.current.parts
    act(() => events.onContext!(focused(['gh#7'], [seam(true)])))
    expect(result.current.parts).toBe(held)

    /* A host that stops sending the field, or never did: no parts, no focus. */
    act(() => events.onContext!(focused(['gh#7'])))
    expect(result.current.parts).toEqual([])
  })

  const line = () => document.querySelector('[data-focus]')?.textContent ?? null
  const cards = () => [...document.querySelectorAll('[data-ref]')].map((card) => card.getAttribute('data-ref'))
  const marked = () =>
    [...document.querySelectorAll('[data-ref]')]
      .filter((card) => card.querySelector('[data-outside]'))
      .map((card) => card.getAttribute('data-ref'))

  test('with nothing picked the page says nothing about parts', async () => {
    asked = []
    render(<App />)
    await act(async () => events.onHello!(focused(['gh#7', 'gh#10'], [seam(false)]), null))
    expect(cards()).toEqual(['gh#7', 'gh#10'])
    expect(line()).toBeNull()
    expect(marked()).toEqual([])
  })

  test('a selected reference outside the focus is still drawn, marked, and counted; a change of focus re-draws', async () => {
    asked = []
    render(<App />)
    await act(async () => events.onHello!(focused(['gh#7', 'gh#10'], [seam(true)]), null))
    /* Both cards: a focus hides nothing here. */
    expect(cards()).toEqual(['gh#7', 'gh#10'])
    expect(marked()).toEqual(['gh#7'])
    expect(line()).toBe(
      '1 of 2 references shown here is outside the picked part (The posting seam). Nothing is hidden: this page follows what is selected, not the parts.',
    )

    await act(async () =>
      events.onContext!(focused(['gh#7', 'gh#10'], [seam(false), part('tests', 'What the tests check', ['gh#7'], true)])),
    )
    expect(cards()).toEqual(['gh#7', 'gh#10'])
    expect(marked()).toEqual(['gh#10'])
    expect(line()).toContain('(What the tests check)')

    await act(async () => events.onContext!(focused(['gh#7', 'gh#10'], [seam(false)])))
    expect(line()).toBeNull()
    expect(marked()).toEqual([])
  })

  test('with nothing selected, the references the project has runs for are counted and none is removed', async () => {
    asked = []
    render(<App />)
    await act(async () => events.onHello!(focused([], [seam(true)]), null))
    /* `gh#7` has runs in this project and is in no picked part. */
    expect(line()).toBe(
      '1 of 1 reference with runs is outside the picked part (The posting seam). Nothing is hidden: this page follows what is selected, not the parts.',
    )
    expect(document.querySelector('[data-pick="gh#7"]')).toBeTruthy()
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
