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
 * to provide. `stream()` in `doors.ts` is that adapter for both servers now: it
 * hands each event to the protocol's `emit`, and the protocol's doors do the
 * framing and hold the response open (`doors()` under Vite, `doorsFetch` in
 * `serve.ts`).
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
export function attach(sink: Sink, project: string | null): () => void {
  /* One project's runs and nothing else. `project` is resolved by the caller
     (`projectOf`), and so is every event's, so the comparison is between two
     real paths. With no project there is nothing of this page's to watch — but
     the stream still opens, so the page can tell "attached and quiet" from
     "not attached". */
  sink.write('hello', {
    active: (project === null ? [] : active(project)).map((a) => ({ run: a.run, lines: a.lines, dropped: a.dropped })),
    slots: MAX_LIVE,
  })

  const off = subscribe((event) => {
    if (project !== null && event.project === project) sink.write(event.kind, event)
  })
  const beat = setInterval(() => sink.write('beat', { at: Date.now() }), BEAT_MS)

  return () => {
    clearInterval(beat)
    off()
  }
}
