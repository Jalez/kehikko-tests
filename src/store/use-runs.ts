import { useCallback, useEffect, useRef, useState } from 'react'

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
 * ## Reconnection is the browser's job, and the page has to say when it happens
 *
 * `EventSource` reconnects on its own after a drop, and each reconnection begins
 * with a fresh `hello` carrying every live run and everything it has said so far.
 * So a page that was disconnected for four seconds catches up rather than
 * missing the middle of a run. What it cannot catch up on is output older than
 * the couple of hundred lines the server holds, and `dropped` is how the server
 * says how much that is — the page prints it rather than presenting a partial log
 * as a whole one.
 *
 * `connected` is exposed for the same reason every other absence in this
 * codebase is: a page whose stream is down and which drew a still, silent run
 * would be claiming to be live while it was not. It says which.
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
  /** Everything not keyed to a selection: the suites, the slots, the trouble. */
  state: State | null
  /** Runs alive right now, with everything they have said. */
  live: Live[]
  /** Whether the stream is attached. A page with this false is not live and says so. */
  connected: boolean
  /** Runs that have ENDED since this page loaded, so a card can repaint without refetching. */
  ended: Run[]
  /** Re-read the parts that do not stream. */
  reload: () => void
}

/** How many finished runs are remembered in memory, purely to repaint cards. */
const KEEP_ENDED = 40

export function useRuns(): Runs {
  const [held, setHeld] = useState<State | null>(null)
  const [live, setLive] = useState<Live[]>([])
  const [connected, setConnected] = useState(false)
  const [ended, setEnded] = useState<Run[]>([])

  const reload = useCallback(() => {
    void state()
      .then(setHeld)
      .catch(() => setHeld(null))
  }, [])

  useEffect(reload, [reload])

  /**
   * The lines held per run, in a ref rather than in state.
   *
   * A busy suite prints hundreds of lines a second, and one `setState` per line
   * is one React render per line — which on a 220-pixel pane is a page that
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

    const source = new EventSource('/api/events')

    source.addEventListener('open', () => setConnected(true))
    source.addEventListener('error', () => {
      /* Not fatal and not reported as such: `EventSource` retries by itself, and
         this fires on every ordinary reconnection too. What the page needs to
         know is only whether it is attached RIGHT NOW. */
      setConnected(false)
    })

    const read = (e: MessageEvent): unknown => {
      try {
        return JSON.parse(e.data as string) as unknown
      } catch {
        return null
      }
    }

    source.addEventListener('hello', (e) => {
      const data = read(e as MessageEvent) as { active?: Live[] } | null
      lines.current = new Map((data?.active ?? []).map((a) => [a.run.id, { run: a.run, lines: a.lines, dropped: a.dropped }]))
      dirty.current = true
      setConnected(true)
      /* The suites and the known references may have changed while this page was
         disconnected — an agent can configure a suite over MCP at any moment —
         so a fresh greeting re-reads them. */
      reload()
    })

    source.addEventListener('started', (e) => {
      const data = read(e as MessageEvent) as { run?: Run } | null
      if (!data?.run) return
      lines.current.set(data.run.id, { run: data.run, lines: [], dropped: 0 })
      dirty.current = true
    })

    source.addEventListener('line', (e) => {
      const data = read(e as MessageEvent) as { id?: string; text?: string } | null
      if (!data?.id) return
      const held = lines.current.get(data.id)
      if (!held) return
      held.lines = [...held.lines.slice(-400), data.text ?? '']
      dirty.current = true
    })

    source.addEventListener('counts', (e) => {
      const data = read(e as MessageEvent) as { id?: string; passed?: number | null; failed?: number | null } | null
      if (!data?.id) return
      const held = lines.current.get(data.id)
      if (!held) return
      held.run = { ...held.run, passed: data.passed ?? null, failed: data.failed ?? null }
      dirty.current = true
    })

    source.addEventListener('ended', (e) => {
      const data = read(e as MessageEvent) as { run?: Run } | null
      if (!data?.run) return
      lines.current.delete(data.run.id)
      dirty.current = true
      const done = data.run
      setEnded((was) => [done, ...was.filter((r) => r.id !== done.id)].slice(0, KEEP_ENDED))
      /* A finished run changes what `/api/state` says about the known references,
         and it is the moment a reader most wants the rest of the page to agree
         with what they just watched. */
      reload()
    })

    return () => {
      clearInterval(flush)
      source.close()
    }
  }, [reload])

  return { state: held, live, connected, ended, reload }
}
