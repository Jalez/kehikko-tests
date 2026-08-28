/**
 * The one message listener this page has, installed the moment this file is
 * imported and never removed.
 *
 * ## The bug it exists to fix
 *
 * The host greets a frame on the frame's `load` event, and that is correct: a
 * module greeted before its own script has run never hears the greeting, so the
 * host waits for the browser to say the document is there.
 *
 * But `load` fires when the document and its subresources are ready, and a
 * React application is not ready then. `createRoot().render()` schedules work;
 * effects run after that work commits, in a task of their own. So a listener
 * added inside `useEffect` — which is where `connect` was being called from —
 * is added STRICTLY AFTER `load`. The greeting had already been posted into a
 * page that was not yet listening, and was gone. Nothing retries: the host says
 * its one word, the module never answers, and the pane reads "loaded its page
 * and did not answer the host's greeting". Which is true, and gives no hint
 * that the greeting arrived a few hundred milliseconds before anybody was there
 * to hear it.
 *
 * `StrictMode` makes it worse rather than revealing it: the deliberate
 * double-mount attaches, detaches and re-attaches, so there is a window with no
 * listener at all in the middle of startup.
 *
 * So the listener is installed here, at module scope, synchronously, as part of
 * importing the wire at all. Anything that arrives before the application is
 * ready is kept and handed over when it asks.
 *
 * ## Recorded always, not only while unheard
 *
 * Every message goes into the backlog and is then delivered — rather than being
 * buffered only while nobody is subscribed. The conditional version has a hole
 * exactly one `StrictMode` wide: a greeting landing after the doomed first
 * subscription but before its unmount is handed to a listener that is about to
 * be thrown away, and never written down, so the surviving mount replays a
 * backlog the greeting was never in. That failure is deeply confusing to read,
 * because the host sees a module that answered — the discarded listener really
 * did reply — while the module's own screen says nothing ever greeted it.
 *
 * The cost is a duplicate: a subscriber that comes and goes and comes back
 * answers the same greeting twice. That is the right trade. A second `roadmap.ready`
 * is the same sentence as the first and a host takes a module at its word
 * either way. Losing it is silence; repeating it is noise.
 */

/** Just enough of a window to listen to. `connect` takes one of these. */
export interface MessageSource {
  addEventListener(type: 'message', fn: (ev: MessageEvent) => void): void
  removeEventListener(type: 'message', fn: (ev: MessageEvent) => void): void
  /**
   * Who to answer if a greeting arrives without a `source` on it.
   *
   * A last resort and nothing more. Every real greeting carries the window it
   * came from, and that handle is the identity the whole wire is built on —
   * see the essay at the top of `host.ts`. This is the fallback for a message
   * whose source the browser did not give us, and the only sensible guess then
   * is the frame's own parent.
   */
  readonly parent?: Window | null
}

/**
 * How much is kept while nothing is listening.
 *
 * A greeting, a context and a handful of answers is the real backlog; anything
 * beyond that is a page that has not mounted for long enough that its problem
 * is not the buffer. Bounded so a host talking to a dead page cannot grow this
 * without limit — oldest go first, because the newest are the ones still worth
 * acting on.
 */
const KEEP = 64

const backlog: MessageEvent[] = []
const listeners = new Set<(ev: MessageEvent) => void>()

if (typeof window !== 'undefined') {
  window.addEventListener('message', (ev: MessageEvent) => {
    backlog.push(ev)
    if (backlog.length > KEEP) backlog.shift()
    for (const listener of listeners) listener(ev)
  })
}

/**
 * The page's inbox, shaped like the thing it replaces.
 *
 * `connect` used to take the real `window` and add a listener to it. It takes
 * this instead, which is the same two methods with one difference: subscribing
 * replays everything that has already arrived. Tests still pass their own fake
 * source and are unaffected — which is the reason for the shape rather than a
 * happy accident, because the wire's decisions are tested without a browser and
 * that has to keep being true.
 */
export const mailbox: MessageSource = {
  get parent() {
    return typeof window === 'undefined' ? null : window.parent
  },
  addEventListener(_type, fn) {
    for (const ev of backlog) fn(ev)
    listeners.add(fn)
  },
  removeEventListener(_type, fn) {
    listeners.delete(fn)
  },
}
