import {
  LIMITS,
  MESSAGE,
  PROTOCOL,
  clampHeight,
  hostMessageSchema,
  looksLikeWireMessage,
  type Goto,
  type ModuleContext,
  type ResponseFailureReason,
} from 'roadmap-module-protocol'

import { mailbox, type MessageSource } from './mailbox.ts'

/**
 * The bridge, and nothing about tests.
 *
 * One conversation with one window, in the shape the protocol package defines.
 * It knows how to be greeted, how to ask a question and match the answer to it,
 * how to answer a `goto`, and how to say how tall it would like to be. It knows
 * nothing about suites or runs, and the code that knows about those knows
 * nothing about `postMessage`.
 *
 * ## Binding to the window, not to the origin
 *
 * This file came across from a module that declares no storage, where the
 * argument ran: a host frames such a page on an opaque origin, so it has no
 * origin string of its own, every message it sends arrives at the host with an
 * origin of `"null"`, and `"null"` is a string every sandboxed frame in every tab
 * shares — so it can never be an identity.
 *
 * **This module DOES declare storage**, so half of that no longer describes us:
 * this page has a real origin, and the host can address it. The conclusion is
 * unchanged all the same, and the reason is worth writing down rather than
 * quietly keeping the code. What we gained is an origin of OURS; what we did not
 * gain is any knowledge of the HOST's. Its origin still arrives only in
 * `ev.origin`, it is still `"null"` exactly when the host is itself sandboxed,
 * and a guess that fails silently drops every message. So the identity is still
 * the window handle: the greeting arrives from exactly one `MessageEvent.source`,
 * nothing in this page or any other can forge that handle, and after the greeting
 * anything from another window is ignored. Not because a stray message would be
 * dangerous by itself, but because a second sender answering our correlation ids
 * is a page that quietly shows another host's work under this one's name — which
 * here would be a page saying another canvas's work had been tested.
 *
 * We reply with `targetOrigin: '*'` where `ev.origin` gave us nothing to aim at.
 * There is nothing secret in anything this page SENDS — the name of an epic
 * somebody is already reading — and the ticket, which is the one secret this page holds, never crosses the bridge at all: it goes to this app's own
 * `/api` over an ordinary same-origin fetch. Where `ev.origin` is a real origin
 * we use it, because then it is a fact rather than a guess.
 *
 * ## Parse what the host sends, too
 *
 * A framed page receives every message posted at its window: the host's, a dev
 * server's hot-reload socket, an extension's. `looksLikeWireMessage` is the
 * cheap filter and `hostMessageSchema` is the real one. A module that trusted
 * `data.type` alone would be one that a bundler's socket can put into an
 * unexplained state on a Tuesday.
 */

/**
 * Why a question came back without an answer.
 *
 * The protocol's three, plus one of our own. `silent` is the timeout, and it is
 * a separate word rather than folded into `failed` because the two send a
 * person to different places: `failed` is the roadmap telling us it went wrong,
 * and `silent` is the roadmap not being there — which, from inside a frame, is
 * indistinguishable from a host that is still starting up. The protocol names
 * the same condition `silent` on the other side of the wire, for a module that
 * was greeted and never answered; the symmetry is intentional.
 */
export type Refusal = { reason: ResponseFailureReason | 'silent'; error: string }

export class HostRefused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.error)
    this.name = 'HostRefused'
  }
}

/**
 * How long to wait for one answer.
 *
 * A number rather than forever, because forever is a page that shows "asking…"
 * until somebody reloads it, which is the exact shape of dishonesty this app is
 * against — a spinner is a claim that an answer is coming. Twelve seconds is
 * long enough for a roadmap reading a file off a cold disk and short enough
 * that nobody sits through it twice.
 */
const ANSWER_WITHIN_MS = 12_000

export interface HostEvents {
  /**
   * The greeting arrived, carrying the context that came with it and whatever
   * this module last asked the host to keep for it.
   *
   * The kept string rides beside the context rather than inside it because it
   * belongs to one module and the context is broadcast to all of them — the
   * protocol's own note on `state` in `helloSchema` makes that argument. It is
   * `null` when the host keeps nothing, which is a first run, a host that does
   * not answer `state.set`, or a module that has never written any; a module has
   * to be able to tell that from a field that is missing because the host is
   * older than the idea, and only one of those means it should draw its defaults
   * with confidence.
   *
   * And it arrives HERE, in the greeting, rather than being fetched — so a page
   * has it before its first render instead of drawing the wrong filter and
   * correcting it a moment later.
   */
  onHello?: (context: ModuleContext, state: string | null) => void
  /** The reader switched epics, or this tab was shown again. */
  onContext?: (context: ModuleContext) => void
  /**
   * "Go to this reference." The answer is not optional and not deferrable: the
   * host is waiting on it, and the protocol is explicit that a module which
   * never answers must not be able to hang a reference. So `answer` is handed
   * in rather than returned, and `connect` guarantees it is called — see below.
   */
  onGoto?: (goto: Goto, answer: (found: boolean, why: string) => void) => void
}

export interface Host {
  /** Ask one question. Rejects with `HostRefused` — never with a bare string. */
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  /** Say how tall we would like to be. Fire and forget, by design. */
  resize: (height: number) => void
  /** Whether anything has greeted us yet. */
  greeted: () => boolean
  /** Stop listening. Every question still waiting is refused rather than left hanging. */
  stop: () => void
}

/**
 * Start listening, and hand back the four things a page needs.
 *
 * Nothing is sent from here until a greeting arrives, and nothing needs to be:
 * the host greets on every frame load, and a module that announced itself first
 * would be shouting at a window that may not be a host at all.
 *
 * ## What it listens to, which is not the window
 *
 * The default source is the `mailbox` rather than `window`, and the difference
 * is a bug this page had for its whole life. `connect` is called from a React
 * effect, and effects run strictly after the frame's `load` event — which is
 * exactly when the host greets. Listening on the window here meant the greeting
 * had already come and gone, every time: the page rendered perfectly and the
 * pane beside it reported a module that would not speak. See the essay in
 * `mailbox.ts`.
 *
 * The source stays injectable, because everything this function decides is
 * tested without a browser and that has to keep being true.
 */
export function connect(id: string, events: HostEvents = {}, window_: MessageSource = mailbox): Host {
  let host: Window | null = null
  let origin = '*'
  let live = true

  /** Correlation id -> the promise waiting on it. A `Map`, per the protocol's note on lookups. */
  const waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: HostRefused) => void; timer: ReturnType<typeof setTimeout> }>()

  let counter = 0
  const nextId = () => `${Date.now().toString(36)}-${(counter += 1).toString(36)}`

  const send = (message: unknown) => {
    if (!host) return
    host.postMessage(message, origin)
  }

  const settle = (correlation: string, outcome: { ok: true; data: unknown } | { ok: false; refusal: Refusal }) => {
    const pending = waiting.get(correlation)
    if (!pending) return
    waiting.delete(correlation)
    clearTimeout(pending.timer)
    if (outcome.ok) pending.resolve(outcome.data)
    else pending.reject(new HostRefused(outcome.refusal))
  }

  const onMessage = (ev: MessageEvent) => {
    if (!live) return
    if (!looksLikeWireMessage(ev.data)) return
    const parsed = hostMessageSchema.safeParse(ev.data)
    if (!parsed.success) return
    const message = parsed.data

    if (message.type === MESSAGE.HELLO) {
      /* Re-greeting is normal rather than an error: the host greets on every
         frame load, and a frame that reloaded itself has forgotten everything.
         So the newest greeting wins, and the window it came from becomes the
         one we answer. */
      host = (ev.source as Window | null) ?? window_.parent ?? null
      origin = ev.origin && ev.origin !== 'null' ? ev.origin : '*'
      send({ type: MESSAGE.READY, id, protocol: message.protocol ?? PROTOCOL })
      events.onHello?.(message.context, message.state)
      return
    }

    /* Everything after the greeting has to come from the window that gave it.
       See the essay at the top: the origin cannot do this job and this can. */
    if (ev.source !== host) return

    if (message.type === MESSAGE.CONTEXT) {
      /* Rebuilt field by field rather than passed along, because a context
         message carries a `type` a `ModuleContext` does not have, and the two
         shapes are only nearly the same. `selection` is the field this whole
         module turns on: it is the host's answer to every `selection.set` anyone
         on the canvas makes, and dropping it here is the difference between a
         page that shows the runs for what somebody picked and one that shows
         the same thing however hard the canvas is clicked. */
      events.onContext?.({
        epic: message.epic,
        project: message.project,
        theme: message.theme,
        selection: message.selection,
        /* Carried and deliberately not read, exactly as `pinned` is below. This
           module declares `prompt: false` — see the essay in `manifest.ts` for
           the three reasons — so a host that offers prompts will not offer one
           for this pane and this field will be null. Passing it through anyway
           costs a line and means the day that declaration changes, the value is
           already arriving at the hook rather than being rediscovered here. */
        prompt: message.prompt,
        /* Carried, and deliberately not acted on yet. `pinned` is a host saying
           "what you were last told is what you keep" — the protocol's own essay
           argues that a pin nobody was told about is the failure, and that a
           module which ignores the field is exactly as correct as it was before,
           it simply stops receiving updates. So passing it on costs a line and
           leaves the honest sentence available to whoever writes it; what this
           page does NOT do is invent one it has never seen a host send. */
        pinned: message.pinned,
      })
      return
    }

    if (message.type === MESSAGE.RESPONSE) {
      if (message.ok) settle(message.id, { ok: true, data: message.data })
      else settle(message.id, { ok: false, refusal: { reason: message.reason, error: message.error } })
      return
    }

    if (message.type === MESSAGE.GOTO) {
      /* Answered exactly once, whatever the listener does — including nothing,
         including throwing. The host is waiting on this and will time out into
         "not found"; a module that leaves it to the timeout has turned a
         hundred milliseconds into twelve seconds of a reader waiting. */
      let answered = false
      const answer = (found: boolean, why = '') => {
        if (answered) return
        answered = true
        clearTimeout(backstop)
        send({ type: MESSAGE.WENT, id: message.id, found, why: why.slice(0, LIMITS.REASON) })
      }
      /* The backstop, and why it is a timer rather than a line after the call:
         a listener may quite reasonably want to answer after a scroll settles,
         so answering `false` the moment it returns would pre-empt the honest
         answer. Half a second is longer than any of that and far shorter than
         the host's own timeout, which means the reader gets the fallback link
         instead of a wait. */
      const backstop = setTimeout(() => answer(false, 'This app did not manage to say where that reference is.'), 500)
      try {
        if (events.onGoto) events.onGoto(message, answer)
        else answer(false, 'This app is not showing anything that can be walked to.')
      } catch {
        answer(false, 'This app failed while looking for that reference.')
      }
      return
    }
  }

  window_.addEventListener('message', onMessage)

  return {
    request(method, params = {}) {
      if (!host) {
        return Promise.reject(
          new HostRefused({ reason: 'silent', error: 'Nothing has greeted this page, so there is nobody to ask.' }),
        )
      }
      const correlation = nextId()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          settle(correlation, {
            ok: false,
            refusal: {
              reason: 'silent',
              error: `The roadmap was asked ${method} and had not answered ${Math.round(ANSWER_WITHIN_MS / 1000)} seconds later.`,
            },
          })
        }, ANSWER_WITHIN_MS)
        waiting.set(correlation, { resolve, reject, timer })
        send({ type: MESSAGE.REQUEST, id: correlation, method, params })
      })
    },

    resize(height) {
      /* Clamped on our own side with the host's own arithmetic, so that what we
         ask for is what we will get. The host runs its own copy over the raw
         number regardless — this is prediction, not enforcement. */
      send({ type: MESSAGE.RESIZE, height: clampHeight(height) })
    },

    greeted: () => host !== null,

    stop() {
      live = false
      window_.removeEventListener('message', onMessage)
      for (const correlation of [...waiting.keys()]) {
        settle(correlation, { ok: false, refusal: { reason: 'silent', error: 'This page stopped listening.' } })
      }
    },
  }
}
