import { expect, test } from 'bun:test'

import { attach, frame } from '../runs/stream.ts'

/**
 * The event stream's policy, which is now one file because two servers serve it.
 *
 * These are not tests of SSE framing for its own sake. They exist because
 * `vite.config.ts` and `serve.ts` are two adapters over `attach`, and the whole
 * argument for pulling this out was that a page connecting to one and a page
 * connecting to the other must not be able to disagree. What is asserted here is
 * therefore the part an adapter cannot get wrong on its own and cannot check
 * either: what the FIRST frame is, and whether letting go twice is safe.
 */

test('the first frame on any connection is the hello, before anything else', () => {
  const seen: string[] = []
  const detach = attach({ write: (event) => void seen.push(event) })
  detach()

  /* The order is the assertion. A page that connected mid-run and was told about
     the live runs SECOND would have already drawn an empty box, and an empty box
     is how this app says "nothing is running" — so a late hello is not a
     cosmetic delay, it is the page saying something false. */
  expect(seen[0]).toBe('hello')
})

test('the hello names how many run slots there are, so the page can say 1 of 2', () => {
  let payload: unknown = null
  const detach = attach({ write: (event, data) => { if (event === 'hello') payload = data } })
  detach()

  expect(payload).toMatchObject({ active: [], slots: expect.any(Number) })
})

test('detaching twice is not an error', () => {
  const detach = attach({ write: () => {} })
  detach()

  /* node fires both `close` and `error` on some broken connections and the
     adapter listens for both, so this happens in ordinary use rather than only
     in a test. If it ever threw, it would throw inside a request handler, on a
     connection that had already gone — which is the least visible place in this
     program for an exception to land. */
  expect(() => detach()).not.toThrow()
})

test('a frame ends with the blank line that terminates it', () => {
  const text = frame('line', { id: 'r1', stream: 'out', text: 'ok' })

  /* Missing this is a frame the browser holds forever waiting for the rest of
     it, which presents as a stream that connects and then says nothing — the
     symptom here hardest to tell apart from "no runs are happening". */
  expect(text.endsWith('\n\n')).toBe(true)
  expect(text.startsWith('event: line\ndata: {')).toBe(true)
})

test('a sink that throws is the adapter’s problem, not the run’s', () => {
  /* `Sink` states that an adapter must not throw, and the adapters honour it
     with a try. This asserts the other half — that `attach` does not defend
     against it — so that anybody writing a third adapter finds out here rather
     than by killing a test suite mid-run from a socket that closed. */
  expect(() => attach({ write: () => { throw new Error('socket gone') } })).toThrow('socket gone')
})
