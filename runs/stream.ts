import { active, MAX_LIVE, subscribe } from './spawn.ts'

/**
 * What goes down the event stream, and when — said once, for both servers.
 *
 * ## Why this was pulled out of `vite.config.ts`
 *
 * There are now two programs that serve this module's doors: Vite in dev, and
 * `serve.ts` over a built page. Everything else they have in common was already
 * shared — the manifest is one constant, `answer()` in `doors.ts` is one
 * function, and the two servers are thin adapters over it. The stream was the
 * exception, because it is the one door that holds a response open instead of
 * returning a document, and node's `ServerResponse` and Bun's `ReadableStream`
 * are not the same object.
 *
 * The obvious thing was to write it twice, twenty lines each, and it is the
 * wrong thing for a reason this codebase has paid for elsewhere: a page
 * connecting to the dev server and a page connecting to the built server would
 * be two implementations of one protocol, and they would drift. Not in the
 * framing — that is four lines of string concatenation nobody gets wrong — but
 * in the POLICY: which event is sent first, what the `hello` carries, whether
 * there is a heartbeat and how often. A built page that missed the `hello` would
 * show an empty box during a live run and look exactly like a page whose run had
 * not started, and it would look that way only in the mode nobody develops in.
 *
 * So the policy is here, once, and a `Sink` is the whole of what an adapter has
 * to provide. `vite.config.ts` implements it with `response.write`; `serve.ts`
 * implements it with a `ReadableStreamDefaultController`. Neither of them
 * decides anything.
 */
export interface Sink {
  /**
   * One SSE frame.
   *
   * **Must not throw.** The adapter owns that, because only the adapter knows
   * what a dead connection looks like in its own transport — a write to a socket
   * the browser closed a moment ago throws in node and enqueues to a cancelled
   * controller in Bun, and neither may take a running test suite down with it.
   */
  write(event: string, data: unknown): void
}

/**
 * How often a comment frame goes out on an otherwise silent stream.
 *
 * Not a heartbeat for the application's sake — the page does not care — but for
 * everything between it and this process. An idle TCP connection through a proxy
 * or a laptop's power manager is one something eventually decides is dead, and a
 * stream that goes quiet during a slow test suite is exactly the case that would
 * break.
 */
const BEAT_MS = 20_000

/**
 * Attach a sink to this process's runs, and hand back the way to detach it.
 *
 * The first frame on every connection is a `hello` carrying every run alive
 * right now WITH what it has already said, so a page that connects mid-run is
 * not staring at an empty box waiting for the next line. Everything after that
 * is what `spawn.ts` announces, verbatim.
 *
 * The returned function is idempotent by construction — `clearInterval` on a
 * cleared timer and `Set.delete` of an absent member are both no-ops — because
 * an adapter can plausibly be told twice that a connection ended (node fires
 * both `close` and `error` on some failures) and a second detach must not be an
 * error somebody has to remember to guard.
 */
export function attach(sink: Sink): () => void {
  sink.write('hello', {
    active: active().map((a) => ({ run: a.run, lines: a.lines, dropped: a.dropped })),
    slots: MAX_LIVE,
  })

  const off = subscribe((event) => sink.write(event.kind, event))
  const beat = setInterval(() => sink.write('beat', { at: Date.now() }), BEAT_MS)

  return () => {
    clearInterval(beat)
    off()
  }
}

/**
 * One frame, as bytes on the wire.
 *
 * Both adapters need exactly this string and neither should be spelling `\n\n`
 * itself: a missing blank line is a frame the browser holds forever waiting for
 * the rest of it, which presents as a stream that connects and then says
 * nothing — the hardest symptom here to tell from "no runs are happening".
 */
export function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}
