import { expect, test } from 'bun:test'

import { emptySaid, narrowToFocus, type EpicPart } from 'kehikot-module-protocol'

import { NOUN, anchorOf, inHand, resting } from '../src/focus.ts'
import type { Live } from '../src/store/ask.ts'
import type { Listed } from '../suites/store.ts'

/* What each thing on the page says it is tied to. The rule that reads it is the protocol's. */

const part = (id: string, refs: string[], picked: boolean, more: Partial<EpicPart> = {}): EpicPart => ({ id, heading: id, refs, picked, ...more })
const suite = (name: string) => ({ name }) as unknown as Listed
const going = (id: string, ref: string) => ({ run: { id, ref }, lines: [], dropped: 0 }) as unknown as Live

test('anchorOf: a thing tied to a reference answers that reference', () => {
  expect(anchorOf({ ref: 'gh#7' })).toEqual({ ref: 'gh#7' })
})

test('anchorOf: a thing tied to none answers nothing — never the whole epic', () => {
  expect(anchorOf({ ref: '' })).toBeNull()
  expect(anchorOf({ ref: null })).toBeNull()
  expect(anchorOf({})).toBeNull()
  expect(anchorOf(resting([], [suite('unit')], [])[0]!)).toBeNull()
})

test('the resting page as items: runs going for nothing, then references, then suites', () => {
  const items = resting(['gh#7', '', 'gh#10'], [suite('unit')], [going('r1', ''), going('r2', 'gh#7')])
  /* A run going FOR a reference is drawn on that reference's card, not here. */
  expect(items.map((one) => one.kind)).toEqual(['going', 'ref', 'ref', 'suite'])
  expect(items.flatMap((one) => (one.kind === 'ref' ? [one.ref] : []))).toEqual(['gh#7', 'gh#10'])
})

const items = resting(['gh#7', 'gh#10'], [suite('unit')], [going('r1', '')])
const shown = (parts: EpicPart[]) => narrowToFocus(parts, items, anchorOf, { keep: inHand }).shown.map((one) => (one.kind === 'ref' ? one.ref : one.kind))

test('nothing picked is everything', () => {
  expect(shown([part('seam', ['gh#10'], false)])).toEqual(['going', 'gh#7', 'gh#10', 'suite'])
})

test('a picked part leaves the references it lists; the suites and a run that is going are kept', () => {
  expect(shown([part('seam', ['gh#10'], true)])).toEqual(['going', 'gh#10', 'suite'])
})

test('a part narrows by its references whichever way the host spells its documents', () => {
  expect(shown([part('seam', ['gh#10'], true, { documents: ['docs/seam.md'], files: [] })])).toEqual(['going', 'gh#10', 'suite'])
  expect(shown([part('seam', ['gh#10'], true, { files: ['chapters/seam.tex'] })])).toEqual(['going', 'gh#10', 'suite'])
})

test('keep: a run that is going and the suites are in hand on the resting page', () => {
  expect(items.map(inHand)).toEqual([true, false, false, true])
})

test('the sentence for a pick that leaves nothing is the protocol’s', () => {
  expect(emptySaid([part('seam', [], true)], NOUN)).toBe('No run is in the picked part.')
})
