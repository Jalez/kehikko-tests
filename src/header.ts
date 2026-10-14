import { LIMITS, type HeaderItemInput } from 'kehikot-module-protocol'

import type { Run } from '../runs/store.ts'
import type { Listed } from '../suites/store.ts'

/**
 * What this page declares for the container's header (`kehikot.header`).
 *
 * The host draws these in its Run menu, so the cards spend no button on "run", "run again",
 * "confirm command" or "stop", and "Stop it?" has no row: the arm is the host's (`confirm`).
 * What the cards keep is what only a card can say: the verdict, the counts, the log, and the
 * command in full beside the control that confirms it.
 *
 * ## Who may press
 *
 * Nothing here says `agents: true`. A run starts a person's own command on this machine, and the
 * door already has `run_tests` and `stop_run`; naming them as `tool` sends an agent there, where
 * the confirmation rule is kept (a suite nobody has confirmed is not run). Confirming a command is
 * a person's act and has no tool.
 *
 * ## A pure function of what the page knows
 *
 * The list changes when a suite is configured or confirmed, when a reference is selected, and when
 * a run starts or ends. It does not change while a run is going (counts, log lines and "so far"
 * are not in it), nor while time passes (no "ago"), so a quiet page declares nothing.
 *
 * ## Ids
 *
 * `r<suite>_<target>` is a run of the suite at that place in the list against the target at that
 * place; `c<suite>` confirms that suite's command; `x<n>` stops the n-th live run. A press is
 * judged against the list as it stands NOW, so an id only has to mean something there.
 *
 * ## What does not fit
 *
 * A header holds 24 items. Stops come first, then confirmations, then runs in the order the cards
 * are drawn. `offered` says which of them are in the header, so a card draws its own button for
 * anything that is not: nothing becomes unreachable because a canvas selected a great many.
 */

export interface Target {
  /** The reference a run is made for; `''` is a run for none in particular. */
  ref: string
}

export interface HeaderState {
  suites: readonly Listed[]
  /** The references whose cards are drawn, in order. `[]` is the bare list, where a run is for none. */
  refs: readonly string[]
  /** Every run going, whatever it is for. */
  live: readonly Pick<Run, 'id' | 'suite' | 'ref'>[]
  /** The newest finished run of a suite for a reference, by `${ref}|${suite}`: its verdict. */
  newest: ReadonlyMap<string, Run['verdict']>
  slots: number
}

export interface Declared {
  items: HeaderItemInput[]
  /** What the header carries: `run:${ref}|${suite}`, `confirm:${suite}`, `stop:${id}`. */
  offered: ReadonlySet<string>
  /** What each item id does. */
  by: ReadonlyMap<string, { kind: 'run'; suite: string; ref: string } | { kind: 'confirm'; suite: Listed } | { kind: 'stop'; id: string }>
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

export const keyOf = {
  run: (ref: string, suite: string) => `run:${ref}|${suite}`,
  confirm: (suite: string) => `confirm:${suite}`,
  stop: (id: string) => `stop:${id}`,
}

export function headerOf(state: HeaderState): Declared {
  const items: HeaderItemInput[] = []
  const offered = new Set<string>()
  const by: Declared['by'] extends ReadonlyMap<string, infer V> ? Map<string, V> : never = new Map()
  const room = () => LIMITS.HEADER_ITEMS - items.length

  /* Stops first: ending a run is the thing a person reaches for in a hurry. */
  state.live.forEach((one, n) => {
    if (room() <= 0) return
    const id = `x${n}`
    items.push({
      kind: 'run',
      id,
      label: cut(`Stop ${one.suite}`, LIMITS.HEADER_LABEL),
      icon: 'square',
      group: 'Running',
      /* Two presses, the host's arm: "Nothing will be learned about the code" is not said again in a row. */
      confirm: true,
      /* An agent ends a run with the door's own tool, and is sent there. */
      tool: 'stop_run',
    })
    by.set(id, { kind: 'stop', id: one.id })
    offered.add(keyOf.stop(one.id))
  })

  const goingKeys = new Set(state.live.map((one) => keyOf.run(one.ref, one.suite)))
  const full = state.slots > 0 && state.live.length >= state.slots

  state.suites.forEach((suite, i) => {
    if (suite.confirmed || room() <= 0) return
    const id = `c${i}`
    items.push({
      kind: 'run',
      id,
      label: cut(`Confirm command: ${suite.name}`, LIMITS.HEADER_LABEL),
      icon: 'shield-check',
      group: 'Confirm',
      /* The command is in the page, in full, in the suite's own row. This is the second press. */
      confirm: true,
    })
    by.set(id, { kind: 'confirm', suite })
    offered.add(keyOf.confirm(suite.name))
  })

  const targets = state.refs.length ? state.refs : ['']
  targets.forEach((ref, j) => {
    state.suites.forEach((suite, i) => {
      if (!suite.confirmed || room() <= 0) return
      const id = `r${i}_${j}`
      const key = keyOf.run(ref, suite.name)
      const going = goingKeys.has(key)
      const verdict = state.newest.get(key)
      items.push({
        kind: 'run',
        id,
        label: cut(`Run ${suite.name}`, LIMITS.HEADER_LABEL),
        icon: 'play',
        ...(ref ? { group: cut(ref, LIMITS.HEADER_GROUP) } : {}),
        /* An agent runs a suite with the door's own tool, where an unconfirmed command is refused. */
        tool: 'run_tests',
        state: going ? 'busy' : 'idle',
        ...(!going && verdict && verdict !== 'running' ? { result: verdict } : {}),
        ...(!going && full ? { disabled: 'Every run slot is taken; one has to finish first.' } : {}),
      })
      by.set(id, { kind: 'run', suite: suite.name, ref })
      offered.add(key)
    })
  })

  return { items, offered, by }
}
