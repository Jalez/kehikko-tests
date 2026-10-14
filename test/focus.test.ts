import { expect, test } from 'bun:test'

import { emptySaid, narrowToFocus, type EpicPart } from 'kehikot-module-protocol'

import { NOUN, anchorOf, inHand, resting } from '../src/focus.ts'
import type { Run } from '../runs/store.ts'
import type { Live } from '../src/store/ask.ts'
import type { Listed } from '../suites/store.ts'

/* What each thing on the page says it is tied to. The rule that reads it is the protocol's. */

const part = (id: string, refs: string[], picked: boolean, more: Partial<EpicPart> = {}): EpicPart => ({ id, heading: id, refs, picked, ...more })
const suite = (name: string) => ({ name }) as unknown as Listed
const going = (id: string, ref: string, suite = 'unit') => ({ run: { id, ref, suite }, lines: [], dropped: 0 }) as unknown as Live
const done = (id: string, suite: string, verdict = 'passed') => ({ id, ref: '', suite, verdict }) as unknown as Run

test('anchorOf: a thing tied to a reference answers that reference', () => {
  expect(anchorOf({ ref: 'gh#7' })).toEqual({ ref: 'gh#7' })
})

test('anchorOf: a thing tied to none answers nothing — never the whole epic', () => {
  expect(anchorOf({ ref: '' })).toBeNull()
  expect(anchorOf({ ref: null })).toBeNull()
  expect(anchorOf({})).toBeNull()
  expect(anchorOf(resting([], [suite('unit')], [])[0]!)).toBeNull()
})

test('the resting page as items: runs going for nothing, then references, then suites, then their panel', () => {
  const items = resting(['gh#7', '', 'gh#10'], [suite('unit')], [going('r1', ''), going('r2', 'gh#7')])
  /* A run going FOR a reference is drawn on that reference's card, not here. */
  expect(items.map((one) => one.kind)).toEqual(['going', 'ref', 'ref', 'suite', 'how'])
  expect(items.flatMap((one) => (one.kind === 'ref' ? [one.ref] : []))).toEqual(['gh#7', 'gh#10'])
})

const items = resting(['gh#7', 'gh#10'], [suite('unit')], [going('r1', '')])
const shown = (parts: EpicPart[]) => narrowToFocus(parts, items, anchorOf, { keep: inHand }).shown.map((one) => (one.kind === 'ref' ? one.ref : one.kind))

test('nothing picked is everything', () => {
  expect(shown([part('seam', ['gh#10'], false)])).toEqual(['going', 'gh#7', 'gh#10', 'suite', 'how'])
})

test('a picked part leaves the references it lists; the suites and a run that is going are kept', () => {
  expect(shown([part('seam', ['gh#10'], true)])).toEqual(['going', 'gh#10', 'suite', 'how'])
})

test('a part narrows by its references whichever way the host spells its documents', () => {
  expect(shown([part('seam', ['gh#10'], true, { documents: ['docs/seam.md'], files: [] })])).toEqual(['going', 'gh#10', 'suite', 'how'])
  expect(shown([part('seam', ['gh#10'], true, { files: ['chapters/seam.tex'] })])).toEqual(['going', 'gh#10', 'suite', 'how'])
})

test('keep: a run that is going, the suites and their panel are in hand on the resting page', () => {
  expect(items.map(inHand)).toEqual([true, false, false, true, true])
})

test('the panel is an item with no suites at all, and is kept under a pick', () => {
  const bare = resting([], [], [])
  expect(bare.map((one) => one.kind)).toEqual(['how'])
  expect(narrowToFocus([part('seam', ['gh#10'], true)], bare, anchorOf, { keep: inHand }).shown.map((one) => one.kind)).toEqual(['how'])
})

test('a run for no reference that ended is an item where the going ones are; none is no item', () => {
  expect(resting([], [suite('unit')], []).map((one) => one.kind)).toEqual(['suite', 'how'])
  const ended = resting(['gh#7'], [suite('unit')], [], [done('r1', 'unit'), done('r2', 'lint', 'failed')])
  expect(ended.map((one) => one.kind)).toEqual(['ended', 'ended', 'ref', 'suite', 'how'])
  /* Never a run that is still going, and never one filed under a reference. */
  expect(resting([], [], [], [done('r3', 'unit', 'running'), { ...done('r4', 'unit'), ref: 'gh#7' }]).map((one) => one.kind)).toEqual(['how'])
})

test('a suite going again for no reference is drawn as that run, not as how the last one ended', () => {
  const now = resting([], [], [going('r9', '', 'unit')], [done('r1', 'unit'), done('r2', 'lint')])
  expect(now.flatMap((one) => (one.kind === 'ended' ? [one.run.suite] : one.kind === 'going' ? ['going'] : []))).toEqual(['going', 'lint'])
})

test('how a run ended is in hand only when it ended while this page was open', () => {
  const [seen, old] = resting([], [], [], [done('r1', 'unit'), done('r2', 'lint')], new Set(['r1']))
  expect([inHand(seen!), inHand(old!)]).toEqual([true, false])
})

test('the sentence for a pick that leaves nothing is the protocol’s', () => {
  expect(emptySaid([part('seam', [], true)], NOUN)).toBe('No run is in the picked part.')
})
