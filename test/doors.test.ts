import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The doors, exercised as a host, a page and an agent each reach them.
 *
 * `answer()` holds no socket — see the essay at the top of `doors.ts` — so this
 * calls it directly with a method, a path, a query and a body, which is exactly
 * what `vite.config.ts` does with a node request. Nothing here binds a port.
 */

const here = realpathSync(mkdtempSync(join(tmpdir(), 'tests-doors-')))
/* Where the OLD single store is looked for: somewhere that does not exist, so no
   test can adopt this repository's real `data/` into its temporary project. */
const legacy = `${here}-legacy`

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
  process.env.TESTS_DATA = legacy
})
afterAll(() => {
  rmSync(here, { recursive: true, force: true })
})

const { answer, TICKET, tellRef } = await import('../doors.ts')
const { waitFor } = await import('../runs/spawn.ts')

const q = new URLSearchParams({ project: here })
const call = (name: string, args: Record<string, unknown> = {}) =>
  answer('POST', '/mcp', q, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project: here, ...args } } }, null)

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

  const state = await answer('GET', '/api/state', q, null, TICKET)
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
  const reply = await answer('POST', '/api/run', q, { project: here, suite: 'unit' }, 'not-the-ticket')
  expect(reply?.status).toBe(403)
  const state = await answer('GET', '/api/state', q, null, TICKET)
  expect((state?.body as { active: unknown[] }).active).toHaveLength(0)
})

const listedNow = async () =>
  ((await answer('GET', '/api/state', q, null, TICKET))?.body as { suites: { name: string; confirmed: boolean; fingerprint: string }[] }).suites
const unit = async () => (await listedNow()).find((one) => one.name === 'unit')!

test('a suite just configured is not confirmed, and is not run: both doors say it awaits that in the page', async () => {
  expect(await unit()).toMatchObject({ confirmed: false, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) })
  const how = said(await call('how_tested'))
  expect(how).toContain('NOT CONFIRMED')
  const agent = await call('run_tests', { suite: 'unit', waitMs: 0 })
  expect(wrong(agent)).toBe(true)
  expect(said(agent)).toContain('awaits confirmation in the Tests page')
  const page = await answer('POST', '/api/run', q, { project: here, suite: 'unit' }, TICKET)
  expect(page?.status).toBe(409)
  expect((page?.body as { error: string }).error).toContain('awaits confirmation in the Tests page')
  expect(((await answer('GET', '/api/state', q, null, TICKET))?.body as { active: unknown[] }).active).toHaveLength(0)
})

test('only this app’s own page confirms a command, and only the command it drew', async () => {
  const { fingerprint } = await unit()
  for (const ticket of [null, 'not-the-ticket']) {
    expect((await answer('POST', '/api/confirm', q, { project: here, suite: 'unit', fingerprint }, ticket))?.status).toBe(403)
  }
  /* There is no tool for it either: an agent cannot confirm what it configured. */
  expect(said(await call('confirm_suite', { suite: 'unit', fingerprint }))).toContain('no tool')
  expect((await answer('POST', '/api/confirm', q, { project: here, suite: 'unit', fingerprint: 'f'.repeat(64) }, TICKET))?.status).toBe(409)
  expect((await answer('POST', '/api/confirm', q, { project: here, suite: 'unit' }, TICKET))?.status).toBe(409)
  expect((await answer('POST', '/api/confirm', q, { project: here, suite: 'nobody', fingerprint }, TICKET))?.status).toBe(404)
  expect((await answer('POST', '/api/confirm', q, { suite: 'unit', fingerprint }, TICKET))?.status).toBe(400)
  expect((await unit()).confirmed).toBe(false)

  const reply = await answer('POST', '/api/confirm', q, { project: here, suite: 'unit', fingerprint }, TICKET)
  expect(reply?.status).toBe(200)
  expect((await unit()).confirmed).toBe(true)
  expect(said(await call('how_tested'))).not.toContain('NOT CONFIRMED')
})

test('a run with the ticket starts, and cannot name a command', async () => {
  /* The shape of the request is the argument: `suite` and `ref`, and nothing
     that could carry an executable. A field that is not read is a field that
     cannot be abused. */
  const reply = await answer('POST', '/api/run', q, { project: here, suite: 'unit', ref: '!7', command: ['rm', '-rf', '/'] }, TICKET)
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
  const reply = await answer('POST', '/api/run', q, { project: here, suite: 'invented' }, TICKET)
  expect(reply?.status).toBe(409)
  expect((reply?.body as { error: string }).error).toContain('unit')
})

test('a reference nothing has been run against comes back as a standing, not as absence', async () => {
  const reply = await answer('GET', '/api/standings', new URLSearchParams({ refs: 'gh#404' }), null, TICKET)
  const standings = (reply?.body as { standings: { ref: string; runs: unknown[] }[] }).standings
  /* It must never be quietly left out. A missing row looks exactly like a row
     that was never meant to be there. */
  expect(standings).toHaveLength(1)
  expect(standings[0]?.ref).toBe('gh#404')
  expect(standings[0]?.runs).toEqual([])
})

test('and it is said in words, as three different things', () => {
  const words = tellRef(here, 'gh#404')
  expect(words).toContain('nothing has been run')
  expect(words).toContain('not a pass and not a failure')
})

test('the page’s reads and its stream answer only this app’s own page', async () => {
  const { stream } = await import('../doors.ts')
  const reads: [string, URLSearchParams][] = [
    ['/api/state', q],
    ['/api/standings', new URLSearchParams({ project: here, refs: '!7' })],
    ['/api/run', new URLSearchParams({ project: here, id: 'x' })],
  ]
  for (const [path, query] of reads) {
    for (const carried of [null, 'not-the-ticket']) {
      const reply = await answer('GET', path, query, null, carried)
      expect([path, reply?.status]).toEqual([path, 403])
      expect((reply?.body as { refused?: string }).refused).toBe('ticket')
    }
    expect([path, (await answer('GET', path, query, null, TICKET))?.status]).not.toEqual([path, 403])
  }
  for (const query of [q, new URLSearchParams({ project: here, ticket: 'not-the-ticket' })]) {
    const refused = stream('GET', '/api/events', query, () => {})
    expect(refused && 'reply' in refused && refused.reply.status).toBe(403)
  }
  /* In the address, where an EventSource can put it, or in the header. */
  for (const opened of [stream('GET', '/api/events', new URLSearchParams({ project: here, ticket: TICKET }), () => {}), stream('GET', '/api/events', q, () => {}, TICKET)]) {
    expect(opened && 'close' in opened).toBe(true)
    if (opened && 'close' in opened) opened.close()
  }
})

test('an unknown path under /api is refused here rather than handed to Vite', async () => {
  const reply = await answer('GET', '/api/whatever', q, null, TICKET)
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

test('with no project the read door says "nowhere" rather than "nothing configured"', async () => {
  const reply = await answer('GET', '/api/state', new URLSearchParams(), null, TICKET)
  expect(reply?.body).toMatchObject({ ok: true, nowhere: true, suites: [], refs: [] })
})

test('an MCP tool with no project is refused with a sentence, not guessed', async () => {
  const reply = await answer(
    'POST',
    '/mcp',
    q,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'how_tested', arguments: {} } },
    null,
  )
  expect(wrong(reply)).toBe(true)
  expect(said(reply)).toContain('no project is open')
})

test('a run from the page with no project is refused', async () => {
  const reply = await answer('POST', '/api/run', q, { suite: 'unit' }, TICKET)
  expect(reply?.status).toBe(409)
  expect((reply?.body as { error: string }).error).toContain('no project is open')
})

test('a suite whose command changes is unconfirmed again, and is told so when it is configured', async () => {
  const changed = await call('configure_suite', {
    name: 'unit',
    what: 'the doors refuse a run without a ticket',
    command: ['sh', '-c', 'exit 3'],
    dir: here,
  })
  expect(wrong(changed)).toBe(false)
  expect(said(changed)).toContain('it will not until a person confirms it')
  expect((await unit()).confirmed).toBe(false)
  const agent = await call('run_tests', { suite: 'unit', waitMs: 0 })
  expect(wrong(agent)).toBe(true)
  expect(said(agent)).toContain('awaits confirmation')
  expect((await answer('POST', '/api/run', q, { project: here, suite: 'unit' }, TICKET))?.status).toBe(409)
  /* Written back exactly as a person confirmed it, it is the command they said yes to. */
  const back = await call('configure_suite', {
    name: 'unit',
    what: 'the doors refuse a run without a ticket',
    command: ['sh', '-c', 'exit 0'],
    dir: here,
  })
  expect(said(back)).toContain('as a person confirmed them')
  expect((await unit()).confirmed).toBe(true)
})

test('a suite taken off the list and configured again under its name is a new one', async () => {
  expect(wrong(await call('forget_suite', { name: 'unit' }))).toBe(false)
  await call('configure_suite', { name: 'unit', what: 'the doors refuse a run without a ticket', command: ['sh', '-c', 'exit 0'], dir: here })
  expect((await unit()).confirmed).toBe(false)
})

test('a directory outside the project is refused when a suite is configured', async () => {
  const reply = await call('configure_suite', { name: 'afar', what: 'this should never be stored', command: ['sh', '-c', 'exit 0'], dir: tmpdir() })
  expect(wrong(reply)).toBe(true)
  expect(said(reply)).toContain('not inside this project')
  expect((await listedNow()).map((one) => one.name)).not.toContain('afar')
})

test('every tool says honestly whether it only reads', async () => {
  const reply = await answer('POST', '/mcp', q, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, null)
  const tools = (reply?.body as { result: { tools: { name: string; annotations?: Record<string, boolean> }[] } }).result.tools
  const hint = (name: string) => tools.find((one) => one.name === name)?.annotations
  expect(hint('how_tested')).toMatchObject({ readOnlyHint: true })
  expect(hint('test_runs')).toMatchObject({ readOnlyHint: true })
  expect(hint('configure_suite')).toMatchObject({ readOnlyHint: false, destructiveHint: true })
  expect(hint('forget_suite')).toMatchObject({ readOnlyHint: false, destructiveHint: true })
  expect(hint('run_tests')).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true })
  expect(hint('stop_run')).toMatchObject({ readOnlyHint: false })
})

test('the project may still be named projectPath, as a caller from before the one spelling does', async () => {
  const named = await answer(
    'POST', '/mcp', q,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'how_tested', arguments: { projectPath: here } } },
    null,
  )
  expect(wrong(named)).toBe(false)
  expect(said(named)).toBe(said(await call('how_tested', {})))
})
