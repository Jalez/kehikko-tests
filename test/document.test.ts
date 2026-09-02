import { expect, test } from 'bun:test'

import { page, TICKET_SLOT, TICKET_SLOT_JSON } from '../page/document.ts'

/**
 * The one document, and the two ways a ticket gets into it.
 *
 * Dev mints a ticket per process and calls `page(ticket)` per request. A build
 * calls `page(TICKET_SLOT)` once and `serve.ts` swaps the sentinel out per
 * request. Both have to end up with the same document and a working ticket, and
 * the failure if they do not is silent in the same way on both paths: every
 * write refused, with a page that looks entirely fine.
 */

test('the built page carries the sentinel exactly as serve.ts looks for it', () => {
  const built = page(TICKET_SLOT)

  /* Quotes included. `serve.ts` replaces the QUOTED form, because a bare
     sentinel could in principle appear inside a bundled asset's contents and a
     replacement that hit one would corrupt a script rather than a ticket. If
     these two ever stop agreeing, the substitution silently does nothing. */
  expect(built).toContain(TICKET_SLOT_JSON)
  expect(built).not.toContain('__TICKET__')
})

test('substituting the sentinel gives the same document dev would have served', () => {
  const ticket = '46324096-54d7-4087-9da0-301e991390ff'

  expect(page(TICKET_SLOT).replace(TICKET_SLOT_JSON, () => JSON.stringify(ticket))).toBe(page(ticket))
})

test('a ticket containing a dollar sign survives both paths', () => {
  /* The reason `page` uses a function replacement, asserted rather than trusted.
     `String.replace` reads `$&` and `$1` out of a replacement STRING, so a
     ticket that happened to contain one would be served mangled — and only
     sometimes, which is the worst frequency for a bug that refuses every write.
     `serve.ts` uses a function for the same reason and this covers it too. */
  const nasty = 'aa$&bb$1cc$$dd'

  expect(JSON.parse(read(page(nasty)))).toBe(nasty)
  expect(JSON.parse(read(page(TICKET_SLOT).replace(TICKET_SLOT_JSON, () => JSON.stringify(nasty))))).toBe(nasty)
})

test('the sentinel says what went wrong if it is ever served as-is', () => {
  /* It is a sentence rather than a plausible UUID on purpose: when the
     substitution fails, this is what lands in the page, and a reader looking at
     a refused write should be able to see the cause in the document instead of
     an id indistinguishable from a real one that has gone stale. */
  expect(TICKET_SLOT).toBe('ticket-not-substituted-by-the-server')
})

/** The ticket island's text, which is where both paths put their value. */
function read(html: string): string {
  const found = /<script id="ticket" type="application\/json">(.*?)<\/script>/s.exec(html)
  if (!found) throw new Error('the document has no ticket island')
  return found[1]!
}
