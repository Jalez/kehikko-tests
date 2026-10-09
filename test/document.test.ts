import { expect, test } from 'bun:test'

import { pageDocument } from 'kehikot-module-protocol/serve'

import { BUILD_SLOT_JSON, PAGE, TICKET_SLOT, TICKET_SLOT_JSON, builtPage, fill } from '../page/document.ts'

/**
 * The built page and the dev page are one document.
 *
 * Dev serves the protocol's `pageDocument` with this process's ticket and build in it. A build
 * compiles the same document with two sentinels, and `serve.ts` swaps them per request (`fill`).
 * If those two ever stop agreeing, the substitution silently does nothing and every run is refused.
 */

const BUILD = { version: '1.2.3', commit: 'abcdef1234567', started: '2026-10-09T10:00:00.000Z', protocol: '0.35.0' }

test('the built page carries both sentinels exactly as serve.ts looks for them', () => {
  const built = builtPage()
  /* Quotes included: a bare sentinel could in principle appear inside a bundled asset. */
  expect(built).toContain(TICKET_SLOT_JSON)
  expect(built).toContain(BUILD_SLOT_JSON)
})

test('substituting the sentinels gives the same document dev would have served', () => {
  const ticket = '46324096-54d7-4087-9da0-301e991390ff'
  expect(fill(builtPage(), ticket, BUILD)).toBe(pageDocument({ ...PAGE, ticket, build: BUILD }))
})

test('a ticket containing a dollar sign survives both paths', () => {
  /* `String.replace` reads `$&` and `$1` out of a replacement STRING, so a ticket that happened
     to contain one would be served mangled. `fill` uses a function for that reason. */
  const nasty = 'aa$&bb$1cc$$dd'
  expect(JSON.parse(read(pageDocument({ ...PAGE, ticket: nasty })))).toBe(nasty)
  expect(JSON.parse(read(fill(builtPage(), nasty, BUILD)))).toBe(nasty)
})

test('nothing in a ticket or a build can close the script element it is printed into', () => {
  const filled = fill(builtPage(), '</script><script>alert(1)</script>', { ...BUILD, version: '</script>' })
  expect(filled).not.toContain('</script><script>alert(1)')
  expect(JSON.parse(read(filled))).toBe('</script><script>alert(1)</script>')
})

test('the sentinel says what went wrong if it is ever served as-is', () => {
  expect(TICKET_SLOT).toBe('ticket-not-substituted-by-the-server')
})

function read(html: string): string {
  const found = /<script id="ticket" type="application\/json">(.*?)<\/script>/s.exec(html)
  if (!found) throw new Error('the document has no ticket island')
  return found[1]!
}
