import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { doors, serves } from 'kehikot-module-protocol/serve'
import { defineConfig, type Plugin } from 'vite'

import { BUILD, MANIFEST, TICKET, answer, stream } from './doors.ts'
import { ID, PREFERRED_PORT } from './manifest.ts'
import { PAGE } from './page/document.ts'
import { stopAll } from './runs/spawn.ts'

/**
 * The one thing this server does that the protocol's `doors()` does not, kept in a plugin of its
 * own beside it: nothing this app started outlives it.
 *
 * `spawn` gives each run a process group of its own so that a test runner's children can be
 * killed with it — and the flip side of that is that Ctrl-C on this server would otherwise leave
 * the group behind. So the signals are caught and the groups are killed. `exit` is included
 * because a crash in Vite's own machinery is also a way for this process to end.
 *
 * (Runs a previous life of this process left saying "running" are swept per project as each
 * project is read, not here: the runs live inside the projects, and at startup this server knows
 * of none. See `sweep` in `runs/store.ts`.)
 */
function runs(): Plugin {
  return {
    name: 'tests-runs',
    apply: 'serve',
    configureServer() {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
          stopAll()
          process.exit(0)
        })
      }
      process.once('exit', stopAll)
    },
  }
}

/**
 * The dev server.
 *
 * - `serves()` first: it decides the port from `PREFERRED_PORT` (or $PORT from a host) and keeps
 *   the registration true, so there is no `server.port` here. This module already answering
 *   there ends the start cleanly rather than making a second copy — which here would be a second
 *   process spawning test runs against the same `runs/` store.
 * - `runs()`: this module's own lines of server; see above.
 * - `doors()` is every door this app answers on, served by the one process that serves the page:
 *   the manifest, `/app` with the write ticket and the build printed into it, the event stream
 *   (`/api/events`) through `stream`, and `/healthz`, `/mcp` and `/api/*` through `answer` in
 *   doors.ts. A module is ONE ORIGIN — the page fetches `/api/state` and opens an `EventSource`
 *   on `/api/events` as relative paths — and `/app` has to be claimed before Vite's resolver
 *   sees it, because this repository has a `src/app.tsx`. See the protocol's
 *   docs/module-plumbing.md. `serve.ts` is the same doors over a built page.
 * - No `server.cors`: this module owns data, takes writes, and one of those writes STARTS A
 *   PROCESS. A permissive `Access-Control-Allow-Origin` would let any page in any tab read
 *   `/app`, and the ticket in it, off loopback — and then press Run here. The manifest declares
 *   `storage: true` instead, so the page has a real origin and its scripts, its `/api` calls and
 *   its `EventSource` are ordinary same-origin requests.
 * - Why the live stream is SSE and not a WebSocket: an `EventSource` is same-origin by default,
 *   so a page on another origin cannot open it at all, with no header from this server involved.
 *   A WebSocket handshake is NOT subject to the same-origin policy — `storage: true` and the
 *   absent `server.cors` would protect nothing there, and it would take an `Origin` check and
 *   the ticket, written by hand, to guard a stream carrying the output of processes on
 *   somebody's machine. And nothing here needs a second direction: starting and stopping a run
 *   are ordinary ticketed POSTs. If a future version needs the client to push, those two checks
 *   are what has to be written first.
 * - What is streamed is decided in `runs/stream.ts`, for this server and `serve.ts` both. A run
 *   continues when the page reloads (it lives in this process; a reloaded page gets the `hello`
 *   and picks it back up) and does NOT survive this server stopping — `stopAll` above, and
 *   `sweep` in `runs/store.ts`, which is what makes the page able to say so.
 * - No alias for `kehikot-module-protocol`: it resolves through its exports, as the host's does.
 *   The `@` alias points at `src`, which is what shadcn's generated components import through.
 * - Tailwind is a plugin and there is no `tailwind.config.js`: version 4 is configured in CSS.
 * - `base: './'`, because a host frames this page at whatever address it wrote down.
 */
export default defineConfig({
  base: './',
  plugins: [
    serves({ id: ID, prefer: PREFERRED_PORT }),
    runs(),
    doors({ manifest: MANIFEST, answer, stream, build: BUILD, page: { ...PAGE, ticket: TICKET } }),
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  build: { outDir: 'dist', emptyOutDir: true },
})
