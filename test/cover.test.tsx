import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TICKET, answer } from '../doors.ts'
import { App } from '../src/app.tsx'
import { keepConfirmed } from '../suites/confirmed.ts'
import { suite } from '../suites/store.ts'

import { Line, greet, install, say, server, settle, uninstall } from './fakes.ts'

/**
 * The whole page against the real doors: each not-ready moment as the one shared cover, what
 * stays underneath it, and the line about the live stream — which is drawn only when it is true.
 */

let dir = ''
let restarted = false

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tests-cover-')))
  restarted = false
  install((method, url, body, ticket) => answer(method, url.pathname, url.searchParams, body, restarted ? 'the-ticket-of-a-process-that-is-gone' : ticket), TICKET)
  await answer('POST', '/mcp', new URLSearchParams(), {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'configure_suite', arguments: { project: dir, name: 'unit', what: 'the page can start a run', command: ['sh', '-c', 'exit 0'], dir, agent: 'the test' } },
  }, null)
  /* As a person would have, in the page: a suite nobody confirmed offers that instead of Run. */
  const made = suite(dir, 'unit')
  if (made) keepConfirmed(dir, made)
})
afterEach(() => {
  cleanup()
  uninstall()
  rmSync(dir, { recursive: true, force: true })
})

const cover = () => document.querySelector('[data-cover]')?.getAttribute('data-cover') ?? null
const line = () => document.querySelector('[data-stream]')

/**
 * A control that is the container's header's, as a person finds it: the page draws its own "⋯" menu
 * where nobody frames it (or no host has pressed an item yet), with the same items behind it.
 */
const menuItem = (label: string) => {
  if (!document.querySelector('[role="menu"]')) fireEvent.click(screen.getByLabelText(/^Menu/))
  return screen.getByText(label).closest('button') as HTMLElement
}
const hasItem = (label: string) => {
  if (!document.querySelector('[role="menu"]')) fireEvent.click(screen.getByLabelText(/^Menu/))
  return screen.queryByText(label) !== null
}
const here = () => ({ project: 'p', projectPath: dir })

describe('the not-ready moments, each as the one shared cover', () => {
  test('before anything has greeted the page it is waiting — never "no project" — and then unhosted', async () => {
    render(<App />)
    await settle(10)
    expect(cover()).toBe('waiting')
    expect(document.body.textContent).not.toContain('No project')
    await settle(450)
    expect(cover()).toBe('unhosted')
    expect(document.body.textContent).toContain('Nothing is framing this page — open Tests in Kehikot.')
    expect(document.body.textContent).toContain('.kehikot/tests/')
    expect(within(document.querySelector('[data-cover]') as HTMLElement).queryAllByRole('button')).toHaveLength(0)
  })

  test('hosted with no folder: no project, and the host’s theme is on <html>', async () => {
    render(<App />)
    await greet({ project: 'p', projectPath: null, theme: 'dark' })
    expect(cover()).toBe('no-project')
    expect(document.body.textContent).toContain('nowhere to record a run')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  test('greeted with a project: no cover, and the suites the project has', async () => {
    render(<App />)
    await greet(here())
    expect(cover()).toBeNull()
    expect(document.body.textContent).toContain('How this project is tested')
    expect(hasItem('Run unit')).toBe(true)
    expect(document.querySelector('[data-run="unit"]')).toBeNull()
  })

  test('a server that is not answering: the cover, the page still mounted under it, and Try again asks again', async () => {
    render(<App />)
    await greet(here())
    act(() => Line.latest().open())
    await settle()
    expect(cover()).toBeNull()
    /* The stream dropping is what makes the page ask. */
    server.down = true
    act(() => Line.latest().drop())
    await settle()
    expect(cover()).toBe('down')
    expect(document.body.textContent).toContain('Tests’ own server is not answering.')
    expect(hasItem('Run unit')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    expect(cover()).toBe('down')
    server.down = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    expect(cover()).toBeNull()
  })

  test('a run pressed on a page older than its server is refused as stale, and the cover says it is reloading', async () => {
    render(<App />)
    await greet(here())
    restarted = true
    fireEvent.click(menuItem('Run unit'))
    await settle()
    expect(server.asked.at(-1)).toMatchObject({ method: 'POST', path: '/api/run', ticket: TICKET })
    expect(cover()).toBe('stale')
    expect(document.body.textContent).toContain('This page is older than its server — reloading…')
  })

  test('a suite nobody has confirmed: the row offers that, the press carries the ticket, and then it offers Run', async () => {
    await answer('POST', '/mcp', new URLSearchParams(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'configure_suite', arguments: { project: dir, name: 'fresh', what: 'a suite an agent just wrote down', command: ['sh', '-c', 'exit 0'], dir, agent: 'the test' } },
    }, null)
    render(<App />)
    await greet(here())
    expect(hasItem('Run fresh')).toBe(false)
    expect(hasItem('Run unit')).toBe(true)
    /* The command is read in the page; confirming it is the second of two presses, the host's arm. */
    expect(document.querySelector('[data-command="fresh"]')?.textContent).toContain('sh -c exit 0')
    fireEvent.click(menuItem('Confirm command: fresh'))
    expect(server.asked.some((one) => one.path === '/api/confirm')).toBe(false)
    fireEvent.click(screen.getByText('Press again to confirm'))
    await settle(60)
    expect(server.asked.find((one) => one.path === '/api/confirm')).toEqual({ method: 'POST', path: '/api/confirm', ticket: TICKET })
    expect(hasItem('Confirm command: fresh')).toBe(false)
    expect(hasItem('Run fresh')).toBe(true)
    /* Confirming started nothing. */
    expect(server.asked.some((one) => one.path === '/api/run')).toBe(false)
  })

  test('a run pressed on a live page starts, carrying the ticket', async () => {
    render(<App />)
    await greet(here())
    fireEvent.click(menuItem('Run unit'))
    await settle(120)
    const wrote = server.asked.find((one) => one.path === '/api/run')
    expect(wrote).toEqual({ method: 'POST', path: '/api/run', ticket: TICKET })
    expect(cover()).toBeNull()
    expect(document.querySelector('.text-failed')?.textContent ?? '').not.toContain('did not come from')
  })
})

describe('a run for no reference', () => {
  const loose = () => [...document.querySelectorAll('[data-loose]')].map((card) => card.textContent ?? '')
  const picked = { id: 'seam', heading: 'The posting seam', refs: ['gh#10'], picked: true }

  test('nothing has been run: no card, and nothing said about it', async () => {
    render(<App />)
    await greet(here())
    expect(loose()).toEqual([])
    expect(document.body.textContent).not.toContain('Not run for any particular reference')
  })

  test('pressed on the bare list, it is on the page after it ends: its result, where the going ones are drawn', async () => {
    render(<App />)
    await greet(here())
    fireEvent.click(menuItem('Run unit'))
    await settle(200)
    const state = await answer('GET', '/api/state', new URLSearchParams({ project: dir }), null, TICKET)
    const ended = (state?.body as { loose: { id: string; suite: string; verdict: string }[] }).loose
    expect(ended.map((one) => [one.suite, one.verdict])).toEqual([['unit', 'passed']])
    /* The stream is the test's to drive: the run ending is what makes the page read again. */
    act(() => Line.latest().send('ended', { run: ended[0] }))
    await settle(130)
    expect(loose()).toHaveLength(1)
    expect(loose()[0]).toContain('passed')
    expect(loose()[0]).toContain('unit')
    expect(loose()[0]).toContain('Not run for any particular reference.')

    /* A person here watched it: a pick does not take it off the page, and says nothing. */
    await say({ ...here(), epic: 'a', parts: [picked] })
    expect(loose()).toHaveLength(1)
    expect(document.querySelector('[data-none-in-focus]')).toBeNull()

    /* A page opened later draws it with nothing picked, and not under a pick: it is tied to no part. */
    cleanup()
    render(<App />)
    await say({ ...here(), epic: 'a', parts: [{ ...picked, picked: false }] })
    expect(loose()).toHaveLength(1)
    await say({ ...here(), epic: 'a', parts: [picked] })
    expect(loose()).toEqual([])
    expect(hasItem('Run unit')).toBe(true)
  })
})

describe('the line about the live stream', () => {
  test('is not drawn on an ordinary first load, while the stream is still opening', async () => {
    render(<App />)
    await greet(here())
    expect(Line.latest().url).toContain('/api/events?project=')
    /* The stream is the page's alone: its ticket rides in the address, where an EventSource can put it. */
    expect(Line.latest().url).toContain(`ticket=${TICKET}`)
    expect(line()).toBeNull()
    act(() => Line.latest().open())
    await settle()
    expect(line()).toBeNull()
  })

  test('is drawn when the stream has dropped, and goes when it is back', async () => {
    render(<App />)
    await greet(here())
    act(() => Line.latest().open())
    act(() => Line.latest().drop())
    await settle()
    expect(line()?.textContent).toContain('The live stream is not attached')
    act(() => Line.latest().open())
    await settle()
    expect(line()).toBeNull()
  })

  test('its named events reach the page: a run that starts is drawn, with what it says', async () => {
    render(<App />)
    await greet(here())
    const run = { id: 'r1', suite: 'unit', ref: '', startedAt: new Date().toISOString(), endedAt: null, verdict: 'running', exitCode: null, signal: null, passed: null, failed: null, tail: [], dropped: 0, by: 'the test', command: ['sh'], dir }
    act(() => {
      Line.latest().open()
      Line.latest().send('hello', { active: [], slots: 2 })
      Line.latest().send('started', { run })
      Line.latest().send('line', { id: 'r1', text: 'a line the suite printed' })
    })
    await settle(130)
    expect(document.body.textContent).toContain('Watching live. 1 of 2 run slots busy.')
    expect(document.body.textContent).toContain('a line the suite printed')
  })
})

describe('a host with no reading for the epic', () => {
  test('is one short sentence under the page, which still draws, and not "said no"', async () => {
    const ids: string[] = []
    const hear = (event: MessageEvent) => {
      const m = event.data as { type?: string; id?: string; method?: string } | null
      if (m?.type === 'kehikot.request' && m.method === 'live.get' && m.id) ids.push(m.id)
    }
    window.addEventListener('message', hear)
    render(<App />)
    await greet({ ...here(), epic: 'thesis' })
    expect(ids.length).toBeGreaterThan(0)
    window.postMessage(
      { type: 'kehikot.response', protocol: 2, id: ids[0], ok: false, reason: 'failed', error: 'Nothing has been read from the trackers for that epic.' },
      '*',
    )
    await settle()
    window.removeEventListener('message', hear)
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('said no')
    expect(text).toContain('The host has no reading for thesis yet')
    /* What does not need the trackers still draws: the suite is there to run. */
    expect(text).toContain('unit')
  })
})
