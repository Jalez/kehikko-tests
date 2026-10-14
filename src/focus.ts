import type { Anchors } from 'kehikot-module-protocol'

import type { Run } from '../runs/store.ts'
import type { Listed } from '../suites/store.ts'
import type { Live } from '@/store/ask.ts'

/**
 * This page, narrowed to the parts of the epic a person picked out.
 *
 * ## One rule, and it is not this file's
 *
 * A part of an epic lists references. What this page draws is tied to a
 * reference or to none: a run was made FOR one, a card is the standing OF one.
 * So everything here says what ties it to a part with the one `anchorOf`, and
 * the protocol's `useFocus(context).narrow` decides what is drawn.
 *
 *  - **Nothing picked is the page as it was.**
 *  - **Tied to a reference**: in front when a picked part lists that reference.
 *  - **A suite is a control, not an item.** How the project is tested, with
 *    its run buttons, is what a person presses to test anything at all, so it
 *    is drawn whatever is picked (`inHand`). It is not answered
 *    `{ whole: true }`: it is not a thing about this epic.
 *  - **What is in hand is kept.** The references a person selected, on the
 *    canvas or here, are drawn whatever is picked (`keep` in `app.tsx`). So is
 *    a run that is going with no reference: it can only be watched and stopped
 *    from this page, and a process this app started is never taken off it. And
 *    so is how that run ended, for as long as this page has been open: a run
 *    a person watched does not vanish at the moment it has an answer.
 *  - **The panel is a control too.** "How this project is tested" is drawn
 *    with no suites in it as well as with some (`how`): it is where a person
 *    reads that nothing is configured and how the first suite gets there.
 *  - **One sentence, and only where the pick left nothing to draw**: the
 *    protocol's `No run is in the picked part.` While anything is drawn nothing
 *    on this page is about the pick — and the panel is drawn wherever the
 *    project's store could be read, so there the sentence is never needed.
 *
 * ## What this does not touch
 *
 * The MCP door. An agent has no canvas and no pick: `list_suites`, `standing`
 * and the rest answer about the project whatever is picked.
 */

/** What one item is called in the protocol's sentence for an empty view. */
export const NOUN = 'run'

/** As much of anything on this page as an anchor reads: the reference it is tied to, if any. */
export interface Tied {
  ref?: string | null
}

/** What ties one item to a part: THE anchor function of this module. The reference it is about, or nothing. */
export const anchorOf = (item: Tied): Anchors => (item.ref ? { ref: item.ref } : null)

/**
 * One thing the page draws while no reference is selected: a reference
 * something has been run against, a configured suite, a run going with no
 * reference, how the newest such run of a suite ended, or the panel the
 * suites are listed in.
 */
export type Resting =
  | { kind: 'ref'; ref: string }
  | { kind: 'suite'; ref: null; suite: Listed }
  | { kind: 'going'; ref: null; live: Live }
  /** `fresh`: it ended while this page was open, so a person here saw it go. */
  | { kind: 'ended'; ref: null; run: Run; fresh: boolean }
  | { kind: 'how'; ref: null }

/**
 * The resting page as the list that is narrowed, in the order it is drawn.
 *
 * `loose` is the newest run of each suite made for no reference, as the store
 * has it; `fresh` is the ids of the runs that ended since this page loaded. A
 * suite that is going again for no reference is drawn as that run, not as how
 * the one before it ended. With no such run there is no item, and so no row.
 */
export function resting(
  refs: readonly string[],
  suites: readonly Listed[],
  live: readonly Live[],
  loose: readonly Run[] = [],
  fresh: ReadonlySet<string> = new Set(),
): Resting[] {
  const going = live.filter((one) => !one.run.ref)
  const again = new Set(going.map((one) => one.run.suite))
  return [
    ...going.map((one): Resting => ({ kind: 'going', ref: null, live: one })),
    ...loose
      .filter((run) => !run.ref && run.verdict !== 'running' && !again.has(run.suite))
      .map((run): Resting => ({ kind: 'ended', ref: null, run, fresh: fresh.has(run.id) })),
    ...refs.filter(Boolean).map((ref): Resting => ({ kind: 'ref', ref })),
    ...suites.map((suite): Resting => ({ kind: 'suite', ref: null, suite })),
    { kind: 'how', ref: null },
  ]
}

/**
 * What is drawn whatever is picked: a run that is going — it is watched, and
 * stopped, from here and nowhere else — how a run this page watched ended, and
 * the suites with the panel they are in, which are this page's controls.
 */
export const inHand = (item: Resting): boolean =>
  item.kind === 'going' || item.kind === 'suite' || item.kind === 'how' || (item.kind === 'ended' && item.fresh)
