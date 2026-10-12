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
 * The parts of an epic picked out in the host's bar. The page follows them by
 * the protocol's one rule (`src/focus.ts`): the references a person selected
 * are in hand and stay, the resting page is narrowed to the references a
 * picked part lists, and the only thing ever said about a pick is one sentence
 * where it left nothing.
 */
describe('the parts of the epic', () => {
  const cards = () => [...document.querySelectorAll('[data-ref]')].map((card) => card.getAttribute('data-ref'))
  const offered = () => [...document.querySelectorAll('[data-pick]')].map((button) => button.getAttribute('data-pick'))
  const none = () => document.querySelector('[data-none-in-focus]')?.textContent ?? null
  const about = () =>
    document.querySelector('[data-focus]') !== null ||
    document.querySelector('[data-outside]') !== null ||
    /picked part|outside the|host’s bar|Nothing is hidden/i.test(document.body.textContent ?? '')

  test('a pick draws no line and marks no card, and the selected references are all still there', async () => {
    render(<App />)
    await greet(focused(['gh#7', 'gh#10'], [seam(false)]))
    const before = document.body.innerHTML
    expect(cards()).toEqual(['gh#7', 'gh#10'])

    /* `gh#7` is in no picked part. It was selected, so its card is drawn as it was, with nothing said about that. */
    await say(focused(['gh#7', 'gh#10'], [seam(true)]))
    expect(cards()).toEqual(['gh#7', 'gh#10'])
    expect(about()).toBe(false)
    expect(document.body.innerHTML).toBe(before)

    await say(focused(['gh#7', 'gh#10'], [seam(false), part('tests', 'What the tests check', ['gh#7'], true)]))
    expect(document.body.innerHTML).toBe(before)
  })

  test('with nothing selected, a reference in a picked part is offered and nothing is said about the pick', async () => {
    render(<App />)
    await greet(focused([], [part('tests', 'What the tests check', ['gh#7'], true), seam(false)]))
    expect(offered()).toEqual(['gh#7'])
    expect(none()).toBeNull()
    expect(about()).toBe(false)
  })

  test('a reference in no picked part is not offered: one sentence where the page was, and it is back when nothing is picked', async () => {
    render(<App />)
    await greet(focused([], [seam(true)]))
    expect(offered()).toEqual([])
    expect(none()).toBe('No run is in the picked part.')
    /* The sentence is all there is: no card, no suite list, nothing else about the pick. */
    expect(document.body.textContent).not.toContain('Nothing has been configured')

    await say(focused([], [seam(true), part('tests', 'What the tests check', [], true)]))
    expect(none()).toBe('No run is in the picked parts.')

    await say(focused([], [seam(false)]))
    expect(none()).toBeNull()
    expect(offered()).toEqual(['gh#7'])
    expect(document.body.textContent).toContain('Nothing has been configured')
  })

  test('the same under a host that sends documents with a part and one that sends only files', async () => {
    render(<App />)
    await greet(focused([], [{ ...part('tests', 'What the tests check', ['gh#7'], true), documents: ['docs/tests.md'], files: [] }]))
    expect(offered()).toEqual(['gh#7'])
    await say(focused([], [{ ...part('tests', 'What the tests check', ['gh#7'], true), files: ['chapters/tests.tex'] }]))
    expect(offered()).toEqual(['gh#7'])
    await say(focused([], [{ ...seam(true), files: ['chapters/tests.tex'] }]))
    expect(offered()).toEqual([])
  })

  test('a reference opened here is in hand: a pick that does not list it leaves its card', async () => {
    render(<App />)
    await greet(focused([], [seam(false)]))
    await act(async () => (document.querySelector('[data-pick="gh#7"]') as HTMLElement).click())
    await settle()
    expect(cards()).toEqual(['gh#7'])

    await say(focused([], [seam(true)]))
    expect(cards()).toEqual(['gh#7'])
    expect(none()).toBeNull()
    expect(about()).toBe(false)
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
