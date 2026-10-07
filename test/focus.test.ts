import { describe, expect, test } from 'bun:test'

import { focusNamed, focusOf, focusSaid, partsFrom } from '../src/live/focus.ts'

/**
 * The parts focus, which on this page is a sentence and never a filter.
 *
 * So what is held is the counting and the words: which of the references on
 * the page are outside the picked parts, that a reference no part lists is one
 * of them, and that with nothing picked there is nothing to say at all.
 */

const part = (id: string, refs: string[], picked = false, heading = `The ${id}`) => ({ id, heading, refs, picked })
const seam = (picked: boolean) => part('seam', ['gh#10', 'gh#11'], picked)
const tests = (picked: boolean) => part('tests', ['gh#7'], picked)

describe('nothing picked out', () => {
  test('no parts, and parts with none picked, say nothing', () => {
    expect(focusOf([], ['gh#7'])).toBeNull()
    expect(focusOf([seam(false), tests(false)], ['gh#7'])).toBeNull()
  })
})

describe('which references are outside the picked parts', () => {
  test('a reference a picked part lists is inside; the rest are named, in order', () => {
    expect(focusOf([seam(true), tests(false)], ['gh#7', 'gh#10', 'gh#99'])).toEqual({
      picked: ['The seam'],
      of: 2,
      among: 3,
      outside: ['gh#7', 'gh#99'],
    })
  })

  test('several picked parts are a union, and a reference in no part is outside every focus', () => {
    const focus = focusOf([seam(true), tests(true)], ['gh#7', 'gh#10', 'gh#99'])!
    expect(focus.picked).toEqual(['The seam', 'The tests'])
    expect(focus.outside).toEqual(['gh#99'])
  })

  test('a part with no heading is named by its id', () => {
    expect(focusOf([part('seam', [], true, '')], [])?.picked).toEqual(['seam'])
  })
})

describe('the words', () => {
  const one = focusOf([seam(true), tests(false)], ['gh#7', 'gh#10', 'gh#99'])!

  test('the parts are named', () => {
    expect(focusNamed(one)).toBe('the picked part (The seam)')
    expect(focusNamed(focusOf([seam(true), tests(true)], [])!)).toBe('the 2 picked parts (The seam, The tests)')
  })

  test('how many of the references shown are outside, and that none is hidden', () => {
    expect(focusSaid(one, 'shown')).toBe(
      '2 of 3 references shown here are outside the picked part (The seam). Nothing is hidden: this page follows what is selected, not the parts.',
    )
    expect(focusSaid(focusOf([seam(true)], ['gh#7'])!, 'shown')).toBe(
      '1 of 1 reference shown here is outside the picked part (The seam). Nothing is hidden: this page follows what is selected, not the parts.',
    )
    expect(focusSaid(focusOf([seam(true)], ['gh#10'])!, 'shown')).toContain('0 of 1 reference shown here are outside')
  })

  test('with nothing selected the count is of the references the project has runs for', () => {
    expect(focusSaid(one, 'with-runs')).toContain('2 of 3 references with runs are outside the picked part (The seam).')
  })

  test('with no reference on the page at all, it still says the epic is focused', () => {
    expect(focusSaid(focusOf([seam(true)], [])!, 'shown')).toBe(
      'This epic is focused on the picked part (The seam). Nothing on this page is narrowed by that.',
    )
  })
})

describe('reading the field', () => {
  test('a host that sends none has no parts, and defaults are filled in', () => {
    expect(partsFrom(undefined)).toEqual([])
    expect(partsFrom([{ id: 'bare' }])).toEqual([{ id: 'bare', heading: '', refs: [], picked: false }])
  })

  test('anything that is not parts is no focus, never a wrong one', () => {
    expect(partsFrom('seam')).toEqual([])
    expect(partsFrom([{ id: 'Not An Id', picked: true }])).toEqual([])
  })
})
