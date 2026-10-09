import { useCallback, useEffect, useRef, useState } from 'react'

import { AskFailed, follow, type Attachment } from 'kehikot-module-protocol/client'

import type { Run } from '../../runs/store.ts'
import { state, type Live, type State } from './ask.ts'

/**
 * Watching runs happen, over Server-Sent Events.
 *
 * ## Why an `EventSource` and not a socket, from this side
 *
 * The full argument is in `vite.config.ts` beside the server half, and the short
 * version is the part that matters here: an `EventSource` is same-origin by
 * default. This module declares `storage: true`, so this page has a real origin,
 * and `new EventSource('/api/events')` is an ordinary same-origin GET that no
 * page on another origin can make. A WebSocket would not be — the same-origin
 * policy does not apply to a WebSocket handshake at all — and the same
 * protection would have to be rebuilt by hand out of an `Origin` check and a
 * ticket.
 *
 * ## Reconnection, and the page saying when it happens
 *
 * The protocol's `follow` holds the `EventSource`: the browser reconnects it after a drop,
 * `follow` reconnects it when the browser has given up for good (which is what a server that is
 * still starting looks like), and it says which of three things is true — `connecting`,
 * `attached`, `detached`. Each reconnection begins
 * with a fresh `hello` carrying every live run and everything it has said so far.
 * So a page that was disconnected for four seconds catches up rather than
 * missing the middle of a run. What it cannot catch up on is output older than
 * the couple of hundred lines the server holds, and `dropped` is how the server
 * says how much that is — the page prints it rather than presenting a partial log
 * as a whole one.
 *
 * `attachment` is exposed for the same reason every other absence in this
 * codebase is: a page whose stream is down and which drew a still, silent run
 * would be claiming to be live while it was not. It says which — and it says
 * `connecting` for a stream that has not opened YET, which is not the same
 * fact as one that dropped: the page used to draw "not attached" in red on
 * every ordinary first load, for the moment before the stream opened.
 *
 * ## The events are named, and `follow` hears only unnamed ones
 *
 * This stream sends `event: hello`, `event: line` and so on, and an
 * `EventSource` hands a named event only to a listener for that name; `follow`
 * listens with `onmessage`. So `named()` below is the `EventSource` `follow` is
 * given: the browser's own, with each of this stream's names passed on to
 * `onmessage` as `{ event, data }`. The stream's framing is untouched, which
 * matters because `serve.ts` sends the same one.
 *
 * ## What a page reload does to a run: nothing
 *
 * The run lives in the server process. This hook is a viewer. Reloading detaches
 * a listener and attaches a new one, and the `hello` puts the run back on screen
 * mid-flight. What ends a run is the run finishing, somebody stopping it, its
 * timeout, or this app's server going away — and only the last of those is
 * invisible from here, which is why the server rewrites those records as
 * `crashed` on its next start rather than leaving them saying `running`.
 */

export interface Runs {
  /** Everything not keyed to a selection: the suites, the slots, the trouble. Null until it has been read. */
  state: State | null
  /** The server's own sentence when it REFUSED that read, or null. Not set when nothing answered: that is the cover's. */
  refused: string | null
  /** Runs alive right now, with everything they have said. */
  live: Live[]
  /** Whether the stream is attached: `connecting` until it first opens, `detached` whenever it is not. A page that is detached is not live and says so. */
  attachment: Attachment
  /** Runs that have ENDED since this page loaded, so a card can repaint without refetching. */
  ended: Run[]
  /** Re-read the parts that do not stream. */
  reload: () => void
}

/** The names this stream's events carry; `beat` is the server's keep-alive and nothing here reads it. */
const NAMES = ['hello', 'started', 'line', 'counts', 'ended'] as const
type Said = { event: (typeof NAMES)[number]; data: unknown }

/** The browser's `EventSource`, passing this stream's named events to `onmessage`. See the essay above. */
function named(): typeof EventSource | undefined {
  if (typeof EventSource === 'undefined') return undefined
  return class extends EventSource {
    constructor(url: string | URL) {
      super(url)
      for (const name of NAMES) {
        this.addEventListener(name, (said) => {
          /* `data` is the JSON the server wrote, so it is spliced in rather than parsed twice. */
          this.onmessage?.({ data: `{"event":"${name}","data":${String((said as MessageEvent).data)}}` } as MessageEvent)
        })
      }
    }
  }
}

/** How many finished runs are remembered in memory, purely to repaint cards. */
const KEEP_ENDED = 40

export function useRuns(project: string | null): Runs {
  const [held, setHeld] = useState<State | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const [live, setLive] = useState<Live[]>([])
  const [attachment, setAttachment] = useState<Attachment>('connecting')
  const [ended, setEnded] = useState<Run[]>([])

  const reload = useCallback(() => {
    void state(project)
      .then((read) => {
        setHeld(read)
        setRefused(null)
      })
      .catch((caught: unknown) => {
        /* Nothing answered, or this page is older than its server: `ask` has said so to
           `useServerStanding`, which draws the cover, and what was read stays underneath it.
           A read the server REFUSED is a different fact: nothing is held, and its sentence is. */
        if (caught instanceof AskFailed && caught.kind !== 'refused') return
        setHeld(null)
        setRefused(caught instanceof Error ? caught.message : String(caught))
      })
  }, [project])

  useEffect(reload, [reload])

  /**
   * The lines held per run, in a ref rather than in state.
   *
   * A busy suite prints hundreds of lines a second, and one `setState` per line
   * is one React render per line — which on a 220-pixel container is a page that
   * stops responding to a click. So lines accumulate in a ref and the component
   * is asked to repaint on a timer. The timer is the honest trade: the screen is
   * up to a tenth of a second behind, which nobody can perceive, and it stays
   * responsive, which everybody can.
   */
  const lines = useRef(new Map<string, { run: Run; lines: string[]; dropped: number }>())
  const dirty = useRef(false)

  useEffect(() => {
    const flush = setInterval(() => {
      if (!dirty.current) return
      dirty.current = false
      setLive([...lines.current.values()])
    }, 100)

    /* One project's runs; a new project is a new stream, and what the old one
       was showing goes with it. */
    lines.current = new Map()
    dirty.current = true
    setEnded([])
    const hear = ({ event, data }: Said) => {
      if (event === 'hello') {
        const said = data as { active?: Live[] } | null
        lines.current = new Map((said?.active ?? []).map((a) => [a.run.id, { run: a.run, lines: a.lines, dropped: a.dropped }]))
        dirty.current = true
        /* The suites and the known references may have changed while this page was
           disconnected — an agent can configure a suite over MCP at any moment —
           so a fresh greeting re-reads them. It is also the first thing a server that
           has come back says, and that read is what notices it is a new process. */
        reload()
        return
      }
      if (event === 'started') {
        const said = data as { run?: Run } | null
        if (!said?.run) return
        lines.current.set(said.run.id, { run: said.run, lines: [], dropped: 0 })
        dirty.current = true
        return
      }
      if (event === 'line') {
        const said = data as { id?: string; text?: string } | null
        if (!said?.id) return
        const held = lines.current.get(said.id)
        if (!held) return
        held.lines = [...held.lines.slice(-400), said.text ?? '']
        dirty.current = true
        return
      }
      if (event === 'counts') {
        const said = data as { id?: string; passed?: number | null; failed?: number | null } | null
        if (!said?.id) return
        const held = lines.current.get(said.id)
        if (!held) return
        held.run = { ...held.run, passed: said.passed ?? null, failed: said.failed ?? null }
        dirty.current = true
        return
      }
      if (event === 'ended') {
        const said = data as { run?: Run } | null
        if (!said?.run) return
        lines.current.delete(said.run.id)
        dirty.current = true
        const done = said.run
        setEnded((was) => [done, ...was.filter((r) => r.id !== done.id)].slice(0, KEEP_ENDED))
        /* A finished run changes what `/api/state` says about the known references,
           and it is the moment a reader most wants the rest of the page to agree
           with what they just watched. */
        reload()
      }
    }

    setAttachment('connecting')
    const unfollow = follow<Said>('/api/events', hear, {
      query: { project },
      EventSource: named(),
      onAttachment: (next) => {
        setAttachment(next)
        /* The stream dropping is the first sign this app's server has gone, and nothing else
           here asks on a timer. So ask: an answer leaves things as they are, and no answer is
           what puts the "own server is not answering" cover up. */
        if (next === 'detached') reload()
      },
    })

    return () => {
      clearInterval(flush)
      unfollow()
    }
  }, [reload])

  return { state: held, refused, live, attachment, ended, reload }
}
