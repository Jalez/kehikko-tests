import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The doors, exercised as a host, a page and an agent each reach them.
 *
 * `answer()` holds no socket — see the essay at the top of `doors.ts` — so this
 * calls it directly with a method, a path, a query and a body, which is exactly
 * what `vite.config.ts` does with a node request. Nothing here binds a port.
 */

const here = mkdtempSync(join(tmpdir(), 'tests-doors-'))

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

const { answer, TICKET, tellRef } = await import('../doors.ts')
const { waitFor } = await import('../runs/spawn.ts')

const q = new URLSearchParams()
const call = (name: string, args: Record<string, unknown> = {}) =>
  answer('POST', '/mcp', q, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, null)

const said = (reply: Awaited<ReturnType<typeof answer>>): string => {
  const body = reply?.body as { result?: { content?: { text?: string }[]; isError?: boolean } }
  return body.result?.content?.[0]?.text ?? ''
}
const wrong = (reply: Awaited<ReturnType<typeof answer>>): boolean => {
  const body = reply?.body as { result?: { isError?: boolean } }
  return body.result?.isError === true
}

test('the health check answers without a ticket and says what it holds', async () => {
  const reply = await answer('GET', '/healthz', q, null, null)
  expect(reply?.status).toBe(200)
  expect((reply?.body as { ok: boolean }).ok).toBe(true)
})

test('the MCP door lists its tools', async () => {
  const reply = await answer('POST', '/mcp', q, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, null)
  const names = ((reply?.body as { result: { tools: { name: string }[] } }).result.tools ?? []).map((t) => t.name)
  expect(names).toEqual(['how_tested', 'configure_suite', 'forget_suite', 'run_tests', 'test_runs', 'stop_run'])
})

test('a suite is configured over the MCP door and then appears on the read door', async () => {
  const reply = await call('configure_suite', {
    name: 'unit',
    what: 'the doors refuse a run without a ticket',
    command: ['sh', '-c', 'exit 0'],
    dir: here,
    agent: 'the test',
  })
  expect(wrong(reply)).toBe(false)
  expect(said(reply)).toContain('unit')

  const state = await answer('GET', '/api/state', q, null, null)
  expect((state?.body as { suites: { name: string }[] }).suites.map((s) => s.name)).toEqual(['unit'])
})

test('a command line over MCP is refused as a tool error, with a sentence', async () => {
  const reply = await call('configure_suite', {
    name: 'shellish',
    what: 'this should never be stored',
    command: 'sh -c "exit 0"',
    dir: here,
  })
  expect(wrong(reply)).toBe(true)
  expect(said(reply)).toContain('array')
})

test('a run without the ticket is refused, and no process is started', async () => {
  const reply = await answer('POST', '/api/run', q, { suite: 'unit' }, 'not-the-ticket')
  expect(reply?.status).toBe(403)
  const state = await answer('GET', '/api/state', q, null, null)
  expect((state?.body as { active: unknown[] }).active).toHaveLength(0)
})

test('a run with the ticket starts, and cannot name a command', async () => {
  /* The shape of the request is the argument: `suite` and `ref`, and nothing
     that could carry an executable. A field that is not read is a field that
     cannot be abused. */
  const reply = await answer('POST', '/api/run', q, { suite: 'unit', ref: '!7', command: ['rm', '-rf', '/'] }, TICKET)
  expect(reply?.status).toBe(200)
  const run = (reply?.body as { run: { id: string; command: string[]; ref: string } }).run
  expect(run.command).toEqual(['sh', '-c', 'exit 0'])
  expect(run.ref).toBe('!7')
  /* Waited out before this test returns. A child's `close` fires on a later tick
     than the `begin` that made it, so a test that simply returned would leave a
     run occupying one of this process's two slots — and the next FILE's tests
     would then be refused by a cap that was working perfectly. Bun runs these
     files in one process, so a run leaked here is a run leaked everywhere. */
  const done = await waitFor(run.id, 10_000)
  expect(done?.verdict).toBe('passed')
})

test('a run naming a suite nobody configured is refused with the names that exist', async () => {
  const reply = await answer('POST', '/api/run', q, { suite: 'invented' }, TICKET)
  expect(reply?.status).toBe(409)
  expect((reply?.body as { error: string }).error).toContain('unit')
})

test('a reference nothing has been run against comes back as a standing, not as absence', async () => {
  const reply = await answer('GET', '/api/standings', new URLSearchParams({ refs: 'gh#404' }), null, null)
  const standings = (reply?.body as { standings: { ref: string; runs: unknown[] }[] }).standings
  /* It must never be quietly left out. A missing row looks exactly like a row
     that was never meant to be there. */
  expect(standings).toHaveLength(1)
  expect(standings[0]?.ref).toBe('gh#404')
  expect(standings[0]?.runs).toEqual([])
})

test('and it is said in words, as three different things', () => {
  const words = tellRef('gh#404')
  expect(words).toContain('nothing has been run')
  expect(words).toContain('not a pass and not a failure')
})

test('an unknown path under /api is refused here rather than handed to Vite', async () => {
  const reply = await answer('GET', '/api/whatever', q, null, null)
  expect(reply?.status).toBe(404)
  /* And anything outside `/api` is not ours at all — `null` is what lets the
     page, the client modules and Vite's hot-reload socket keep working. */
  expect(await answer('GET', '/src/main.tsx', q, null, null)).toBeNull()
})

test('the MCP door is deliberately above the ticket check', async () => {
  /* An MCP client is not a browser: it has no page and was handed no ticket, so
     requiring one there would shut the door this module exists to be configured
     through. `doors.ts` says why that is acceptable — a request still cannot name
     a command. */
  const reply = await call('how_tested')
  expect(wrong(reply)).toBe(false)
  expect(said(reply)).toContain('unit')
})
