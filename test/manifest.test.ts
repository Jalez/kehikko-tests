import { expect, test } from 'bun:test'
import { PROTOCOL, manifestSchema } from 'roadmap-module-protocol'

import { ID, MANIFEST, VERSION } from '../manifest.ts'

/**
 * The manifest is the only half of this program a host reads, so it is checked
 * against the protocol's own schema rather than against a copy of what we think
 * it says. `manifest.ts` already parses at import; this asserts the specific
 * decisions the essay there argues for, so that changing one of them has to be a
 * deliberate act with a test to update rather than a quiet edit.
 */

test('the manifest is one a host will accept', () => {
  expect(() => manifestSchema.parse(MANIFEST)).not.toThrow()
  expect(MANIFEST.id).toBe(ID)
  expect(MANIFEST.version).toBe(VERSION)
  expect(MANIFEST.protocol).toBe(PROTOCOL)
})

test('storage is declared, because this module owns data and takes writes that spawn', () => {
  /* The whole argument is in `manifest.ts`: without a real origin the page's own
     `/api` calls are cross-origin, which forces permissive CORS, which lets any
     page in any tab read `/app` and the ticket in it — and here the prize would be
     pressing Run on somebody's machine. */
  expect(MANIFEST.declares.storage).toBe(true)
})

test('prompt is refused, deliberately', () => {
  /* An agent configuring this over MCP is not the same as a person writing it a
     prompt: one goes through a door that validates an argv array and an absolute
     directory and can refuse with a sentence, and the other is free text with no
     reply channel into a program that spawns processes. */
  expect(MANIFEST.declares.prompt).toBe(false)
})

test('live:read is the only capability asked for', () => {
  expect(MANIFEST.declares.uses).toEqual(['live:read'])
})

test('there is one epic-scoped mode and an MCP door', () => {
  expect(MANIFEST.modes).toHaveLength(1)
  expect(MANIFEST.modes[0]?.scope).toBe('epic')
  expect(MANIFEST.mcp?.url).toBe('/mcp')
})
