import { expect, test } from 'bun:test'

import { fillPage, pageDocument } from 'kehikot-module-protocol/serve'

import { PAGE, builtPage } from '../page/document.ts'

/**
 * The built page and the dev page are one document.
 *
 * Dev serves the protocol's `pageDocument` with this process's ticket and build in it. A build
 * compiles the same document with neither, and `serve.ts` puts its own in per request with the
 * protocol's `fillPage`. If the two ever stop agreeing, every run from the built page is refused.
 */

const BUILD = { version: '1.2.3', commit: 'abcdef1234567', started: '2026-10-09T10:00:00.000Z', protocol: '0.36.0' }

const island = (id: string) => new RegExp(`<script id="${id}" type="application/json">(.*?)</script>\\n`, 's')

function read(html: string, id = 'ticket'): unknown {
  const found = island(id).exec(html)
  if (!found) throw new Error(`the document has no ${id} island`)
  return JSON.parse(found[1]!)
}

test('nothing of one process is compiled into the built page', () => {
  const built = builtPage()
  expect(island('ticket').test(built)).toBe(false)
  expect(island('build').test(built)).toBe(false)
})

test('filled, it is the document dev would have served, carrying the same ticket and build', () => {
  const ticket = '46324096-54d7-4087-9da0-301e991390ff'
  const filled = fillPage(builtPage(), { ticket, build: BUILD })
  const dev = pageDocument({ ...PAGE, ticket, build: BUILD })
  expect(read(filled)).toBe(ticket)
  expect(read(filled, 'build')).toEqual(BUILD)
  const bare = (html: string) => html.replace(island('ticket'), '').replace(island('build'), '')
  expect(bare(filled)).toBe(bare(dev))
  expect(bare(filled)).toBe(builtPage())
})

test('a ticket containing a dollar sign survives both paths', () => {
  /* `String.replace` reads `$&` and `$1` out of a replacement STRING, so a ticket that happened
     to contain one would be served mangled. */
  const nasty = 'aa$&bb$1cc$$dd'
  expect(read(pageDocument({ ...PAGE, ticket: nasty }))).toBe(nasty)
  expect(read(fillPage(builtPage(), { ticket: nasty, build: BUILD }))).toBe(nasty)
})
