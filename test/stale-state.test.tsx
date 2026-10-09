import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'

import { App } from '../src/app.tsx'
import { useKehikot } from '../src/wire/use-kehikot.ts'

import { greet, hostQuestions, install, say, settle, uninstall } from './fakes.ts'

/*
 * The page's own hooks and the protocol's client are the real thing here. What is stood in for is
 * what is outside the page: a host (messages posted to the window), this app's own server
 * (`fetch`) and its event stream (`EventSource`). This file used to replace `connect`, `useRuns`
 * and `standings` with fakes; the hook is on the protocol's `useHost` now, which has its own
 * `connect`, so the wire is driven instead of being swapped out.
 */

let asked: ReturnType<typeof hostQuestions>['asked'] = []
let stop = () => {}

beforeEach(() => {
  install((_method, url) => {
    if (url.pathname === '/api/state') {
      return { status: 200, body: { ok: true, nowhere: false, suites: [], active: [], slots: 2, refs: ['gh#7'], trouble: null } }
    }
    if (url.pathname === '/api/standings') {
      const refs = (url.searchParams.get('refs') ?? '').split(',').filter(Boolean)
      return { status: 200, body: { ok: true, standings: refs.map((ref) => ({ ref, latest: null, runs: [], bySuite: [] })) } }
    }
    return null
  })
  const questions = hostQuestions()
  asked = questions.asked
  stop = questions.stop
})

afterEach(() => {
  cleanup()
  stop()
  uninstall()
})

const context = (epic: string | null, projectPath: string | null = '/p/x') => ({ epic, projectPath })

const focused = (selection: string[], parts?: unknown[]) => ({ epic: 'a', selection, projectPath: '/p/x', ...(parts ? { parts } : {}) })
const part = (id: string, heading: string, refs: string[], picked: boolean) => ({ id, heading, refs, picked })
const seam = (picked: boolean) => part('seam', 'The posting seam', ['gh#10'], picked)

describe('useKehikot', () => {
  test('a late reading for the epic that was closed does not replace "no epic is open"', async () => {
    const { result } = renderHook(() => useKehikot('tests', () => {}))
    await greet(context('a'))
    await say(context(null))
    expect(result.current.sight.at).toBe('no-epic')

    await asked[0]!.answer({ refs: [] })
    expect(result.current.sight.at).toBe('no-epic')
  })

  test('the same slug in another project is asked again', async () => {
    const { result } = renderHook(() => useKehikot('tests', () => {}))
    await greet(context('thesis', '/p/x'))
    await asked[0]!.answer({ from: 'x' })
    expect(asked).toHaveLength(1)

    await say(context('thesis', '/p/y'))
    expect(asked).toHaveLength(2)
    expect(result.current.sight.at).toBe('asking')

    /* The first project's slow answer must not land under the second's name. */
    await asked[0]!.answer({ from: 'x' })
    expect(result.current.sight.at).toBe('asking')
  })

  test('the same slug in the same project is not asked again', async () => {
    renderHook(() => useKehikot('tests', () => {}))
    await greet(context('thesis'))
    await say(context('thesis'))
    expect(asked).toHaveLength(1)
  })
})

/**
 * `context.parts`, from the host's message to the hook's value and on to the
 * page. The hook names the fields of a context one by one, so a new field
 * arrives nowhere until a line there carries it.
 */
describe('the parts of the epic', () => {
  test('reach the hook from the greeting, follow a later context, and keep their identity when repeated', async () => {
    const { result } = renderHook(() => useKehikot('tests', () => {}))
    await greet(focused([], [seam(false)]))
    expect(result.current.parts).toEqual([seam(false)])

    await say(focused([], [seam(true)]))
    expect(result.current.parts).toEqual([seam(true)])
    const held = result.current.parts
    await say(focused(['gh#7'], [seam(true)]))
    expect(result.current.parts).toBe(held)

    /* A host that stops sending the field, or never did: no parts, no focus. */
    await say(focused(['gh#7']))
    expect(result.current.parts).toEqual([])
  })

  const line = () => document.querySelector('[data-focus]')?.textContent ?? null
  const cards = () => [...document.querySelectorAll('[data-ref]')].map((card) => card.getAttribute('data-ref'))
  const marked = () =>
    [...document.querySelectorAll('[data-ref]')]
      .filter((card) => card.querySelector('[data-outside]'))
      .map((card) => card.getAttribute('data-ref'))

  test('with nothing picked the page says nothing about parts', async () => {
    render(<App />)
    await greet(focused(['gh#7', 'gh#10'], [seam(false)]))
    expect(cards()).toEqual(['gh#7', 'gh#10'])
    expect(line()).toBeNull()
    expect(marked()).toEqual([])
  })

  test('a selected reference outside the focus is still drawn, marked, and counted; a change of focus re-draws', async () => {
    render(<App />)
    await greet(focused(['gh#7', 'gh#10'], [seam(true)]))
    /* Both cards: a focus hides nothing here. */
    expect(cards()).toEqual(['gh#7', 'gh#10'])
    expect(marked()).toEqual(['gh#7'])
    expect(line()).toBe(
      '1 of 2 references shown here is outside the picked part (The posting seam). Nothing is hidden: this page follows what is selected, not the parts.',
    )

    await say(focused(['gh#7', 'gh#10'], [seam(false), part('tests', 'What the tests check', ['gh#7'], true)]))
    expect(cards()).toEqual(['gh#7', 'gh#10'])
    expect(marked()).toEqual(['gh#10'])
    expect(line()).toContain('(What the tests check)')

    await say(focused(['gh#7', 'gh#10'], [seam(false)]))
    expect(line()).toBeNull()
    expect(marked()).toEqual([])
  })

  test('with nothing selected, the references the project has runs for are counted and none is removed', async () => {
    render(<App />)
    await greet(focused([], [seam(true)]))
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
    await greet(context('a'))
    await act(async () => screen.getByText('gh#7').click())
    await settle()
    expect(picked()).toBeTruthy()
  }

  test('a reference picked here is dropped when the epic changes', async () => {
    await pick()
    await say(context('b'))
    expect(picked()).toBeNull()
  })

  test('a reference picked here is dropped when the project changes', async () => {
    await pick()
    await say(context('a', '/p/y'))
    expect(picked()).toBeNull()
  })

  test('a repeated context for the same epic and project keeps the pick', async () => {
    await pick()
    await say(context('a'))
    expect(picked()).toBeTruthy()
  })
})
