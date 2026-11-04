import { LIMITS, footerItemsSchema, type FooterItem } from 'kehikot-module-protocol'

import type { Verdict } from '../runs/store.ts'

/**
 * Tests' footer, in a host that draws one (`kehikot.footer`, protocol 2.38.0): what is going on
 * now, so a container folded to its header and footer still says it. The header keeps the acts
 * (Run, Confirm command, Stop); the lines the page drew above the cards (watching live and the run
 * slots, a dropped stream, how many references are shown, what went wrong) are here instead.
 * Nothing in the footer is pressable.
 *
 * - the run slots: how many are busy of how many, or that nothing runs; a dropped stream, critical;
 * - how the newest run of each suite shown came out, in words, warn when one did not pass;
 * - how many references are shown, and whether the canvas picked them;
 * - what went wrong reading the suites or runs.
 *
 * Pure: the page declares it only when the greeting said the host draws it.
 */
export interface FooterState {
  busy: number
  slots: number
  detached: boolean
  /** The newest verdict of each suite shown, for each reference shown. */
  verdicts: readonly Verdict[]
  /** References shown as cards, and whether the canvas selected them (else they were picked here). */
  shown: number
  selected: boolean
  trouble: string | null
}

const cut = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1)}…` : text)
const BAD: readonly Verdict[] = ['failed', 'timeout', 'crashed']

export function footerItems(state: FooterState): FooterItem[] {
  const items: unknown[] = []
  if (state.trouble) items.push({ kind: 'text', id: 'trouble', text: cut(state.trouble, LIMITS.FOOTER_TEXT), level: 'critical', tooltip: cut(state.trouble, LIMITS.FOOTER_TOOLTIP) })
  if (state.detached) {
    items.push({ kind: 'text', id: 'live', text: 'Not live', level: 'critical', tooltip: 'The live stream is not attached, so what is on screen may have stopped moving. It reconnects by itself.' })
  } else {
    const full = state.slots > 0 && state.busy >= state.slots
    items.push({
      kind: 'text',
      id: 'live',
      text: state.busy ? `${state.busy} of ${state.slots} running` : 'Nothing running',
      level: full ? 'warn' : 'normal',
      ...(full ? { tooltip: 'Every run slot is taken; starting another suite is refused until one finishes.' } : {}),
    })
  }
  const ended = state.verdicts.filter((v) => v !== 'running')
  if (ended.length) {
    const passed = ended.filter((v) => v === 'passed').length
    const bad = ended.filter((v) => BAD.includes(v)).length
    const stopped = ended.length - passed - bad
    items.push({
      kind: 'text',
      id: 'verdicts',
      text: [`${passed} passed`, ...(bad ? [`${bad} failed`] : []), ...(stopped ? [`${stopped} stopped`] : [])].join(' · '),
      level: bad ? 'warn' : 'normal',
      align: 'center',
      tooltip: 'How the newest run of each suite shown came out.',
    })
  }
  if (state.shown) {
    items.push({
      kind: 'text',
      id: 'shown',
      text: state.shown === 1 ? '1 reference' : `${state.shown} references`,
      align: 'end',
      optional: true,
      tooltip: state.selected ? 'Selected on the canvas.' : 'Picked here. Selecting on a canvas replaces this.',
    })
  }
  return footerItemsSchema.parse(items)
}
