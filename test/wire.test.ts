import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AskFailed, serverStanding } from 'kehikot-module-protocol/client'

import { TICKET, answer, stream } from '../doors.ts'
import { run, state, stop } from '../src/store/ask.ts'

import { install, server, uninstall } from './fakes.ts'

/* The page's store against the real doors, with `fetch` as the only thing faked. */

let dir = ''
/** The ticket the doors are told a request carried, when a test wants another than the page's. */
let forged: string | undefined

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tests-wire-')))
  forged = undefined
  install((method, url, body, ticket) => answer(method, url.pathname, url.searchParams, body, forged ?? ticket), TICKET)
})
afterEach(() => {
  uninstall()
  rmSync(dir, { recursive: true, force: true })
})

describe('a write from the page', () => {
  test('carries the page’s ticket in the shared header, which the doors accept', async () => {
    /* No such suite: the doors refuse in their own words, and it is not the ticket they refuse. */
    const out = await run(dir, 'unit', 'gh#7')
    expect(server.asked).toEqual([{ method: 'POST', path: '/api/run', ticket: TICKET }])
    expect(out.ok).toBe(false)
    expect(out.ok ? '' : out.error).toContain('unit')
    expect(serverStanding()).toBe('up')
  })

  test('a stop the server refuses is its own sentence, not a stale page', async () => {
    const out = await stop('no-such-run')
    expect(out.ok).toBe(false)
    expect((out.error ?? '').length).toBeGreaterThan(5)
    expect(serverStanding()).toBe('up')
  })

  test('from a page older than its server is refused, marked, and said as such', async () => {
    forged = 'a-ticket-from-before-the-restart'
    const out = await run(dir, 'unit', '')
    expect(out).toEqual({ ok: false, error: 'This page is older than its server.' })
    expect(serverStanding()).toBe('stale')
  })
})

describe('a read', () => {
  test('carries no ticket, and names the project', async () => {
    const read = await state(dir)
    expect(read.nowhere).toBe(false)
    expect(server.asked).toEqual([{ method: 'GET', path: '/api/state', ticket: null }])
  })

  test('with no project is "nowhere", not a failure', async () => {
    expect((await state(null)).nowhere).toBe(true)
  })

  test('with nothing answering is thrown as one sentence, and the standing says down', async () => {
    server.down = true
    const failed = await state(dir).catch((caught: unknown) => caught)
    expect(failed).toBeInstanceOf(AskFailed)
    expect((failed as AskFailed).kind).toBe('down')
    expect((failed as Error).message).toBe('This app’s own server is not answering.')
    expect(serverStanding()).toBe('down')
  })
})

describe('the stream door', () => {
  test('is /api/events by GET, and its events are NAMED, the hello first', () => {
    const seen: [string | undefined, unknown][] = []
    const open = stream('GET', '/api/events', new URLSearchParams({ project: dir }), (data, name) => seen.push([name, data]))
    expect(open && 'close' in open).toBe(true)
    expect(seen[0]?.[0]).toBe('hello')
    expect(seen[0]?.[1]).toMatchObject({ active: [], slots: expect.any(Number) })
    open?.close()
    expect(() => open?.close()).not.toThrow()
    expect(stream('GET', '/api/state', new URLSearchParams(), () => {})).toBeNull()
    expect(stream('POST', '/api/events', new URLSearchParams(), () => {})).toBeNull()
  })
})
