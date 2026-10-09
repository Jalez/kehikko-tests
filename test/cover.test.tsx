import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TICKET, answer } from '../doors.ts'
import { App } from '../src/app.tsx'

import { Line, greet, install, server, settle, uninstall } from './fakes.ts'

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
})
afterEach(() => {
  cleanup()
  uninstall()
  rmSync(dir, { recursive: true, force: true })
})

const cover = () => document.querySelector('[data-cover]')?.getAttribute('data-cover') ?? null
const line = () => document.querySelector('[data-stream]')
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
    expect(document.querySelector('[data-run="unit"]')).toBeTruthy()
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
    expect(document.querySelector('[hidden] [data-run="unit"]')).toBeTruthy()
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
    fireEvent.click(document.querySelector('[data-run="unit"]') as HTMLElement)
    await settle()
    expect(server.asked.at(-1)).toMatchObject({ method: 'POST', path: '/api/run', ticket: TICKET })
    expect(cover()).toBe('stale')
    expect(document.body.textContent).toContain('This page is older than its server — reloading…')
  })

  test('a run pressed on a live page starts, carrying the ticket', async () => {
    render(<App />)
    await greet(here())
    fireEvent.click(document.querySelector('[data-run="unit"]') as HTMLElement)
    await settle(120)
    const wrote = server.asked.find((one) => one.path === '/api/run')
    expect(wrote).toEqual({ method: 'POST', path: '/api/run', ticket: TICKET })
    expect(cover()).toBeNull()
    expect(document.querySelector('.text-failed')?.textContent ?? '').not.toContain('did not come from')
  })
})

describe('the line about the live stream', () => {
  test('is not drawn on an ordinary first load, while the stream is still opening', async () => {
    render(<App />)
    await greet(here())
    expect(Line.latest().url).toContain('/api/events?project=')
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
