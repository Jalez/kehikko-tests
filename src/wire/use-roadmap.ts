import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  HostRefused,
  connect,
  type Connection,
  type HostEvents,
  type Refusal,
} from 'roadmap-module-protocol/client'

/**
 * The bridge, as one React value.
 *
 * `roadmap-module-protocol/client` is the wire and knows no React; this is the
 * only file that turns messages into state, and it is deliberately the only
 * one. Two places driving "what can this page see" would eventually disagree,
 * and this module's whole honesty rests on telling `unasked` from `unknown` —
 * not having looked from having looked and found nothing.
 *
 * ## What used to be underneath this
 *
 * `wire/host.ts` and `wire/mailbox.ts` — 416 lines, near-identical to the copy
 * in eight sibling modules. They are one import now, and two things this page
 * used to do by hand went with them.
 *
 * The first is the twenty-line box below `connect` that caught an arrival which
 * came too early and replayed it once the assignment was done. It worked, and
 * it was the wrong shape: it fixed this module's copy of a hazard every module
 * had. The client splits `connect` from `listen()` so the ordering is three
 * plain lines in the order they happen.
 *
 * The second is the field-by-field rebuild of the context. What stood in
 * `host.ts` named `epic`, `project`, `theme`, `selection`, `prompt` and
 * `pinned` — and therefore dropped `projectPath` and `kehikko` on every
 * `roadmap.context` this page received, silently, with no error and no warning.
 * The client spreads the message instead, so both now arrive. Nothing here
 * reads either of them yet; what changed is that they reach the code that
 * might, rather than being discarded one line before anything could.
 *
 * This hook survives on top of the core client rather than being replaced by
 * `…/client/react`, because the six-way `Sight` below is the whole point of
 * this module and a hook handing back a nullable context would make every one
 * of those six absences a thing derived downstream.
 *
 * ## The grace, and why there is one
 *
 * A page cannot know at load whether it is framed. It has to wait to find out,
 * because the greeting arrives when the host is ready rather than when we are,
 * and a page that concluded "nobody is there" in the first frame would say so
 * and then be greeted a moment later — the reader would see the standalone
 * paragraph flash past and be replaced, which teaches them that paragraph is
 * noise. So there is a `listening` state with its own words, it lasts under a
 * second, and only then does the page say the harder thing.
 *
 * It is not a spinner. It says what it is waiting for.
 */
const GREETING_GRACE_MS = 700

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

export interface Roadmap {
  sight: Sight
  /**
   * What the canvas has picked out, as the host last said it.
   *
   * Never what this page asked for — this page never asks. It declares no
   * `selection:set`, has no control that would set one, and its entire job is to
   * answer a question about what somebody else picked. So this is a fact
   * arriving, in the same family as which epic is open, and the only place it
   * comes from is `roadmap.context`.
   */
  selection: string[]
  /** Say how tall this page would like its frame to be. Silent when nothing is framing it. */
  resize: (height: number) => void
}

/**
 * What to do when the host says "go to this reference".
 *
 * Handed in rather than handled here, because the answer depends on what is on
 * screen, and that is the view's business. The contract is the protocol's:
 * `answer` must be called, and calling it late is the same as not calling it —
 * see the backstop in `host.ts`.
 */
export type GotoHandler = NonNullable<HostEvents['onGoto']>

export function useRoadmap(id: string, onGoto: GotoHandler): Roadmap {
  const [sight, setSight] = useState<Sight>({ at: 'listening' })
  const [selection, setSelection] = useState<string[]>([])
  const host = useRef<Connection | null>(null)

  /**
   * The handler, held in a ref and read at the moment a `goto` arrives.
   *
   * The view rebuilds this function whenever the rows change, and connecting to
   * the window again on every render would mean a torn-down listener during the
   * one millisecond a host chose to greet in. So the listener is established once
   * and always calls the newest handler — which is also the only one that knows
   * what is currently on screen.
   */
  const goto = useRef(onGoto)
  goto.current = onGoto

  /**
   * Which question is the current one.
   *
   * Epics switch faster than a slow host answers, and without this the answer to
   * the previous epic arrives after the answer to this one and quietly replaces
   * it — the right refs under the right title, about the wrong work. Every answer
   * checks that it is still the one being waited for before it is allowed to
   * become the page.
   */
  const asking = useRef(0)

  /**
   * The epic the last context put this page on.
   *
   * This is the field that keeps the page still, and it is the single most
   * important line in the file for a module that reacts to a selection.
   *
   * A context is no longer a message that only ever means "the reader moved". It
   * carries the canvas's selection, so the host sends one after every selection
   * change ANYWHERE on the canvas — a click in References, a click in Journeys,
   * a click in a module written next year. Re-asking `live.get` on each of those
   * would throw the reading away and put this page back into `asking` every time
   * somebody selected a row: every run recorded against the selection would vanish, a paragraph would
   * say the question was out, and the rows would come back a moment later. The
   * click that caused it would look like a bug in whichever module was clicked.
   *
   * Worse here than in a list, because the selection is what this page draws. The
   * refetch would be triggered by exactly the event the page is supposed to be
   * responding to, so the page would blank itself precisely when it was being
   * asked to say something.
   *
   * So the fetch is keyed to the epic CHANGING rather than to a context
   * arriving. A repeated context about the same epic is a normal event, and the
   * correct response to it is to read the parts that did change — the theme and
   * the selection — and to leave the reading alone.
   *
   * The cost, stated plainly: this page no longer refetches when a host re-sends
   * the same epic to mean "you were hidden and are visible again". That was never
   * a promise the protocol made, and the fix if it is ever wanted is a context
   * field saying so, not a refetch on every selection.
   *
   * Three values and not two: a slug, `null` for "the host says no epic is
   * open", and `undefined` for "no context has been read yet". Collapsing the
   * last two would make the first context of a conversation that names no epic
   * look like a repeat of a state the page was already in.
   */
  const standingOn = useRef<string | null | undefined>(undefined)

  const look = useCallback((epic: string) => {
    const mine = (asking.current += 1)
    standingOn.current = epic
    setSight({ at: 'asking', epic })
    const current = host.current
    if (!current) return
    void current
      /**
       * Both spellings of the same name.
       *
       * `methodParams['live.get']` takes `{ epic }` in the protocol as it stands.
       * The hosts this workspace was built beside read `params.slug` and refuse
       * anything else — the package renamed this material and the hosts have not
       * all caught up. Sending only the newer key would make this app correct and
       * useless; sending only the older one would make it wrong the day a host is
       * updated. So it sends both, which no host can be confused by: each reads
       * the key it knows and neither sees a conflicting value, because there is
       * one name here spelled twice. The second key comes out when no host in the
       * field reads it.
       */
      .request('live.get', { epic, slug: epic })
      .then((data) => {
        if (asking.current !== mine) return
        /* `null` is a host's own word for "there is no reading for this epic". It
           is not an error and it is not an empty reading, and the six-way `Sight`
           exists so that it does not become either. */
        if (data === null || data === undefined) setSight({ at: 'unread', epic })
        else setSight({ at: 'read', epic, live: data })
      })
      .catch((error: unknown) => {
        if (asking.current !== mine) return
        setSight({
          at: 'refused',
          epic,
          refusal:
            error instanceof HostRefused
              ? error.refusal
              : { reason: 'failed', error: 'This app failed while reading the host’s answer.' },
        })
      })
  }, [])

  useEffect(() => {
    /**
     * What the greeting and every later context both do.
     *
     * The theme is applied here rather than in a component, because it is a fact
     * about the document rather than about any part of it: the host says light or
     * dark and the root element carries it. `light` is set explicitly as well as
     * `dark`, so that a host asking for light over a machine set to dark actually
     * gets it — see the media query in `index.css`.
     */
    const arrived = (context: { epic: string | null; theme: 'light' | 'dark'; selection: string[] }, greeting: boolean) => {
      /* A greeting always re-asks, because a greeting means the conversation is
         new: the host greets on every frame LOAD, so one arriving is a page that
         has just come into existence, or a frame that reloaded and has forgotten
         everything it knew. Answering that with "the epic has not changed, so
         there is nothing to do" would leave a page with no reading and no
         question outstanding, forever.

         `StrictMode` is the case that proves it in the smallest possible space.
         The effect below is torn down and set up again on purpose in development;
         the teardown refuses every question still in flight, and the setup
         replays the greeting out of the mailbox. If the replayed greeting were
         deduplicated against the epic the refused question had been about, the
         page would settle on the refusal and stay there — in development only,
         which is the worst place for a bug to live. */
      if (greeting) standingOn.current = undefined

      const root = document.documentElement
      root.classList.toggle('dark', context.theme === 'dark')
      root.classList.toggle('light', context.theme === 'light')

      /**
       * The selection is taken from every context, unconditionally, before
       * anything decides whether the epic moved.
       *
       * That order is the whole of "this page follows rather than showing stale
       * runs". The host clears the selection as part of moving to another epic,
       * and it says so in the same message that names the new epic — so a page
       * that read the selection only on the branch where the epic stayed put
       * would keep naming the previous epic's references beside whatever runs happen
       * to share a ref with it. Reading it first means the clear lands whether
       * the epic moved or not, and the refetch below is a separate question.
       */
      setSelection(context.selection)

      const moved = context.epic !== standingOn.current
      standingOn.current = context.epic
      if (!moved) return

      if (context.epic) look(context.epic)
      else setSight({ at: 'no-epic' })
    }

    /**
     * The connection is stored BEFORE it is told to listen, and the order is
     * the whole of a bug that made a sibling module hang forever.
     *
     * `listen()` subscribes to the mailbox, and the mailbox replays what has
     * already arrived SYNCHRONOUSLY, inside that call. The greeting almost
     * always arrives before React mounts — that is the entire reason the mailbox
     * exists — so `onHello` fires on that line. `look` reads `host.current`, and
     * if the assignment had not happened it would find null, return early, and
     * leave the page reading "Asking about …". It starts no timer either, so
     * nothing ever times out: not a slow answer, not a refusal, just a sentence
     * that never changes.
     *
     * Worse, it works often enough to look fine. When the host happens to greet
     * after this effect returns — a slow module, a reload, a busy machine — the
     * assignment has already happened and everything behaves. A race whose good
     * outcome is the common one is the kind that ships.
     *
     * What stood here was twenty lines that caught the too-early arrival in a
     * box and replayed it once the assignment was done. It worked, and it was
     * the wrong shape: it fixed this module's copy of a hazard every module had.
     * `connect` and `listen` are two calls now, so the ordering is three plain
     * lines that read in the order they happen.
     */
    const live = connect(id, {
      onHello: (context) => arrived(context, true),
      onContext: (context) => arrived(context, false),
      onGoto: (message, answer) => goto.current(message, answer),
    })
    host.current = live
    live.listen()

    const grace = setTimeout(() => {
      setSight((was) => (was.at === 'listening' ? { at: 'unhosted' } : was))
    }, GREETING_GRACE_MS)

    return () => {
      clearTimeout(grace)
      live.stop()
      /* Cleared only if it is still ours: under StrictMode the second mount has
         already assigned its own connection by the time some cleanups run. */
      if (host.current === live) host.current = null
    }
  }, [id, look])

  const resize = useCallback((height: number) => host.current?.resize(height), [])

  return useMemo(() => ({ sight, selection, resize }), [sight, selection, resize])
}
