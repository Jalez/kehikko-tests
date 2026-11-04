import { describe, expect, test } from 'bun:test'

import { footerItems } from '../src/footer.ts'

const base = { busy: 0, slots: 2, detached: false, verdicts: [], shown: 0, selected: false, trouble: null }

describe('the footer', () => {
  test('nothing running, nothing shown: one line; nothing pressable', () => {
    expect(footerItems(base)).toEqual([expect.objectContaining({ kind: 'text', id: 'live', text: 'Nothing running' })])
  })

  test('the slots, the newest verdicts and the references shown', () => {
    const items = footerItems({ ...base, busy: 2, verdicts: ['passed', 'failed', 'running', 'stopped'], shown: 1, selected: true })
    expect(items.find((i) => i.id === 'live')).toMatchObject({ text: '2 of 2 running', level: 'warn' })
    expect(items.find((i) => i.id === 'verdicts')).toMatchObject({ text: '1 passed · 1 failed · 1 stopped', level: 'warn' })
    expect(items.find((i) => i.id === 'shown')).toMatchObject({ text: '1 reference', optional: true, tooltip: 'Selected on the canvas.' })
    expect(items.every((i) => i.kind === 'text')).toBe(true)
  })

  test('a dropped stream and a trouble are critical', () => {
    const items = footerItems({ ...base, detached: true, trouble: 'The suites file does not parse.' })
    expect(items.find((i) => i.id === 'live')).toMatchObject({ text: 'Not live', level: 'critical' })
    expect(items.find((i) => i.id === 'trouble')).toMatchObject({ level: 'critical' })
  })
})
