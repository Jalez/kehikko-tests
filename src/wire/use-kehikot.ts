import { useEffect, useMemo, useRef, useState } from 'react'

import type { EpicPart } from 'kehikot-module-protocol'
import { HostRefused, type HostEvents, type Refusal } from 'kehikot-module-protocol/client'
import { useHost, type Host } from 'kehikot-module-protocol/client/react'

import { partsFrom } from '@/live/focus.ts'

/**
 * The bridge, as one React value: the protocol's `useHost`, and this module's reading of the host
 * on top of it.
 *
 * ## What is underneath now
 *
 * The connection, the grace before deciding nobody is there, the theme on `<html>`, the flattened
 * context and a stable `request` are `kehikot-module-protocol/client/react`. This file used to do
 * all of that by hand (381 lines); see the protocol's docs/module-plumbing.md.
 *
 * ## What stays here, and why
 *
 * The six-way `Sight` below is the whole point of this module: its honesty rests on telling
 * `unasked` from `unknown` — not having looked from having looked and found nothing. `useHost`
 * hands back a context; what this page ASKS the host about that context (`live.get`), and which
 * of four different absences the answer is, is this file's. It is deliberately the only place
 * that turns the host's answers into state.
 *
 * ## The grace, and why there is one
 *
 * A page cannot know at load whether it is framed. It has to wait to find out, because the
 * greeting arrives when the host is ready rather than when we are, and a page that concluded
 * "nobody is there" in the first frame would say so and then be greeted a moment later. So there
 * is a `listening` state, it lasts under a second, and only then does the page say the harder
 * thing. The length is the protocol's.
 */

/**
 * What this page can currently see of a host's reading.
 *
 * Six states rather than a nullable reading, for the reason the whole module
 * exists: `unhosted`, `no-epic`, `refused` and `unread` are four different
 * absences with four different remedies, and collapsing them would put "the
 * tracker had nothing to say" on a screen belonging to a program that has never
 * spoken to a tracker.
 */
export type Sight =
  | { at: 'listening' }
  | { at: 'unhosted' }
  | { at: 'no-epic' }
  | { at: 'asking'; epic: string }
  | { at: 'refused'; epic: string; refusal: Refusal }
  | { at: 'unread'; epic: string }
  | { at: 'read'; epic: string; live: unknown }

export interface Kehikot {
  sight: Sight
  /** Whether anything is framing this page: `listening` for under a second, then `unhosted`, or `hosted`. */
  where: Host['where']
  /**
   * What the canvas has picked out, as the host last said it.
   *
   * Never what this page asked for — this page never asks. It declares no
   * `selection:set`, has no control that would set one, and its entire job is to
   * answer a question about what somebody else picked. So this is a fact
   * arriving, in the same family as which epic is open, and the only place it
   * comes from is `kehikot.context`.
   */
  selection: readonly string[]
  /**
   * `kehikot.context.projectPath`, or null when the host has none (or there is
   * no host). The suites and runs live inside that project, so this is the one
   * field that changes WHICH store the page reads rather than what it draws.
   */
  project: string | null
  /**
   * The epic the host says is open, or null for none. A fact about where the
   * canvas is, so a view can drop what it holds for the previous epic.
   */
  epic: string | null
  /**
   * `context.parts`: every part of the open epic, with the ones a person
   * picked out in the host's bar flagged. `[]` before any host has spoken and
   * from a host that has never heard of parts — both mean the whole epic.
   *
   * Nothing on this page is hidden by a focus; it says which of the references
   * it is showing are outside the picked parts. See `live/focus.ts`. The same
   * array is handed back while the parts say the same thing, because a context
   * arrives after every click on the canvas.
   */
  parts: readonly EpicPart[]
  /** Say how tall this page would like its frame to be. Silent when nothing is framing it. */
  resize: (height: number) => void
}

/**
 * What to do when the host says "go to this reference".
 *
 * Handed in rather than handled here, because the answer depends on what is on
 * screen, and that is the view's business. The contract is the protocol's:
 * `answer` must be called, and calling it late is the same as not calling it —
 * see the backstop in the protocol's client.
 */
export type GotoHandler = NonNullable<HostEvents['onGoto']>

export function useKehikot(id: string, onGoto: GotoHandler): Kehikot {
  /* How many greetings there have been. A greeting always re-asks, whatever the epic: see below. */
  const [greetings, setGreetings] = useState(0)
  const host = useHost(id, { onGoto, onHello: () => setGreetings((n) => n + 1) })
  const { where, epic, projectPath: project, request, resize, selection } = host

  /* The host's answer about ONE epic, or null before there is a question out. */
  const [reading, setReading] = useState<Extract<Sight, { epic: string }> | null>(null)

  /**
   * Which question is the current one.
   *
   * A reader can switch epic faster than a host can answer, and answers arrive in whatever order
   * they like. Each question takes a number; an answer is applied only if its number is still the
   * newest. The alternative is the last answer to ARRIVE winning, which draws one epic's kinds
   * under another epic's name.
   */
  const asking = useRef(0)

  /**
   * Ask the host what it last read about the open epic — when the epic or the project MOVED, and
   * on every greeting.
   *
   * A repeated context for the same epic in the same project asks nothing: a context arrives
   * after every click on the canvas. The same slug in ANOTHER project is another epic and is
   * asked again. Moving to no epic is a move like any other: whatever `live.get` is still out was
   * asked about the epic that was just closed, so its number is retired.
   *
   * A greeting always re-asks, because a greeting means the conversation is new: the host greets
   * on every frame LOAD, so one arriving is a page that has just come into existence, or a frame
   * that reloaded and has forgotten everything it knew. `StrictMode` is the case that proves it
   * in the smallest possible space — the first mount's question is refused when its connection is
   * torn down, and the second mount must not settle on that refusal.
   */
  useEffect(() => {
    if (where !== 'hosted') return
    const mine = (asking.current += 1)
    if (!epic) {
      setReading(null)
      return
    }
    setReading({ at: 'asking', epic })
    void request('live.get', { epic, slug: epic })
      .then((data) => {
        if (asking.current !== mine) return
        /* `null` is a host's own word for "there is no reading for this epic". It
           is not an error and it is not an empty reading, and the six-way `Sight`
           exists so that it does not become either. */
        if (data === null || data === undefined) setReading({ at: 'unread', epic })
        else setReading({ at: 'read', epic, live: data })
      })
      .catch((error: unknown) => {
        if (asking.current !== mine) return
        setReading({
          at: 'refused',
          epic,
          refusal:
            error instanceof HostRefused
              ? error.refusal
              : { reason: 'failed', error: 'This app failed while reading the host’s answer.' },
        })
      })
  }, [where, epic, project, greetings, request])

  const sight = useMemo<Sight>(() => {
    if (where === 'listening') return { at: 'listening' }
    if (where === 'unhosted') return { at: 'unhosted' }
    if (!epic) return { at: 'no-epic' }
    /* A reading is about the epic it was asked for. Between a move and the effect above, the old
       one is still held; it is not drawn under the new epic's name. */
    return reading && reading.epic === epic ? reading : { at: 'asking', epic }
  }, [where, epic, reading])

  /* The parts of the epic, validated (`partsFrom`). `host.parts` is the same array while the parts
     say the same thing, so this is too — a context arrives after every click on the canvas. */
  const parts = useMemo(() => partsFrom(host.parts), [host.parts])

  return useMemo(
    () => ({ sight, where, selection, project, epic, parts, resize }),
    [sight, where, selection, project, epic, parts, resize],
  )
}
