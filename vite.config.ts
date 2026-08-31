import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { WELL_KNOWN } from 'roadmap-module-protocol'
import { serves } from 'roadmap-module-protocol/serve'
import { defineConfig, type Plugin } from 'vite'

import { MANIFEST, TICKET, answer } from './doors.ts'
import { ID, PREFERRED_PORT } from './manifest.ts'
import { page } from './page/document.ts'
import { active, MAX_LIVE, stopAll, subscribe } from './runs/spawn.ts'
import { sweep } from './runs/store.ts'

/**
 * Every door this app answers on, served by the one process that serves the
 * page.
 *
 * ## Why they cannot be a second server
 *
 * A module is ONE ORIGIN or it is nothing: the protocol refuses a manifest whose
 * `entry` points anywhere but the origin that served the manifest, and it is
 * right to — a program that could name somebody else's page would be a program
 * that could have the host frame somebody else.
 *
 * That argument is usually made about the manifest and the health check. Here it
 * reaches further, because this module holds its own material AND streams it.
 * The page fetches `/api/state` and opens an `EventSource` on `/api/events` as
 * relative paths, which is how the app works with nothing else running at all. A
 * store on a second port would make every one of those cross-origin — and an
 * `EventSource` cross-origin is a CORS request, which is the whole thing this
 * module's `storage: true` was declared to avoid needing.
 *
 * ## Why the page is generated rather than a file
 *
 * `/app` is answered here with a document this process builds, and then run
 * through Vite's own `transformIndexHtml` so that the client and the module graph
 * are injected exactly as they would be for an `index.html` on disk. The reason
 * is the write ticket: it is minted once per process and has to reach the page
 * without being fetchable on a door of its own. See `TICKET` in `doors.ts`.
 *
 * It also sidesteps the collision Atlas lost half a day to. `entry` is `/app`,
 * and under Vite dev an extensionless path is not free — a request for `/app`
 * next to an `app.tsx` resolves to that module and answers `200
 * text/javascript` with compiled source. A browser loads such a document happily
 * and runs nothing in it: the frame's `load` fires, the host greets it, and
 * nothing answers. Here `/app` is claimed before Vite's resolver ever sees it,
 * so no file that happens to sit next to this one can take it. This repository
 * has a `src/app.tsx`, which is exactly that collision, so the order is
 * load-bearing rather than defensive.
 */
function doors(): Plugin {
  return {
    name: 'tests-doors',
    configureServer(server) {
      /**
       * Every run that a previous life of this process left saying "running".
       *
       * A run exists only inside the process that spawned it. Restart this
       * server and the record on disk still says `running`, and a page drawing
       * that would be claiming a process is alive that this program cannot see,
       * cannot stream and cannot stop. `sweep` turns those into `crashed` with a
       * sentence about what happened. See the essay in `runs/store.ts`.
       */
      const swept = sweep()
      if (swept) {
        server.config.logger.info(
          `tests: ${swept} run${swept === 1 ? ' was' : 's were'} left saying "running" by a previous server and ${swept === 1 ? 'is' : 'are'} now recorded as crashed.`,
        )
      }

      /**
       * Nothing this app started outlives it.
       *
       * `spawn` gives each run a process group of its own so that a test
       * runner's children can be killed with it — and the flip side of that is
       * that Ctrl-C on this server would otherwise leave the group behind. So
       * the signals are caught and the groups are killed. `exit` is included
       * because a crash in Vite's own machinery is also a way for this process
       * to end.
       */
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
          stopAll()
          process.exit(0)
        })
      }
      process.once('exit', stopAll)

      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const path = url.pathname
        const method = (request.method ?? 'GET').toUpperCase()

        const send = (status: number, body: unknown) => {
          if (body === null) {
            response.statusCode = status
            response.end()
            return
          }
          response.statusCode = status
          response.setHeader('content-type', 'application/json; charset=utf-8')
          response.end(JSON.stringify(body, null, 2))
        }

        /* Spelled by the protocol package so that this app and every host cannot
           disagree about it by a character. */
        if (path === WELL_KNOWN) return send(200, MANIFEST)

        if (path === '/app' || path === '/app/' || path === '/') {
          void server
            .transformIndexHtml(request.url ?? '/app', page(TICKET), request.originalUrl)
            .then((html) => {
              response.statusCode = 200
              response.setHeader('content-type', 'text/html; charset=utf-8')
              /* Never cached. The ticket in this document is minted per process,
                 so a cached copy is a page whose every run is refused for a
                 reason nobody would look for. */
              response.setHeader('cache-control', 'no-store')
              /*
               * Framed by a host and by nothing else — and by nothing at all is
               * fine too, which is what opening this page directly is.
               *
               * `frame-ancestors` is the module's own half of the arrangement: a
               * host says which origins IT will frame, and this says who may
               * frame this. It is deliberately not a list of one: whoever is
               * running this decides, through `ROADMAP_ORIGIN`, and the default
               * is the address the host in this workspace actually serves on.
               */
              response.setHeader(
                'content-security-policy',
                `frame-ancestors 'self' ${process.env.ROADMAP_ORIGIN ?? 'http://127.0.0.1:4181 http://localhost:4181'}`,
              )
              response.end(html)
            })
            .catch(next)
          return
        }

        /* The stream is handled here rather than in `doors.ts`, because it is the
           one door that holds the raw response open instead of answering with a
           document. */
        if (path === '/api/events') return events(request, response)

        const ours = path === '/healthz' || path === '/mcp' || path.startsWith('/api/')
        if (!ours) return next()

        /* Only the paths above read a body, and only those wait for one. Vite's
           own middleware stack has to keep seeing an unconsumed request for
           everything else. */
        void body(request)
          .then((parsed) =>
            answer(method, path, url.searchParams, parsed, readTicket(request.headers['x-tests-ticket'])),
          )
          .then((reply) => {
            if (!reply) return next()
            send(reply.status, reply.body)
          })
          .catch(next)
      })
    },
  }
}

/**
 * The live stream: Server-Sent Events over plain HTTP.
 *
 * ## Why SSE and not a WebSocket
 *
 * The user asked to WATCH a run rather than poll for a verdict, and both would
 * do that. SSE is chosen, and the reason is what each one costs in exposure
 * rather than what either one costs to write:
 *
 * - **An `EventSource` is same-origin by default.** This module declares
 *   `storage: true`, so its page has a real origin, and `new EventSource('/api/events')`
 *   from that page is an ordinary same-origin GET. A page on another origin
 *   cannot open this stream at all — the browser refuses before a byte is sent,
 *   with no header from this server involved. That protection is free and
 *   automatic, and it is the same protection every other door in this module
 *   already relies on.
 * - **A WebSocket is NOT subject to CORS.** This is the part worth writing down,
 *   because it inverts the intuition: the same-origin policy does not apply to
 *   the WebSocket handshake, so `storage: true` and the absence of `server.cors`
 *   would protect nothing there. Any page in any tab could open a socket to
 *   `ws://127.0.0.1:7900` and be attached. Doing it safely would mean checking
 *   the `Origin` header on the handshake AND requiring the ticket before
 *   attaching — two checks written by hand, in a module whose other doors need
 *   neither, guarding a stream that carries the output of processes on somebody's
 *   machine.
 * - **Nothing here needs a second direction.** Starting and stopping a run are
 *   ordinary ticketed POSTs. A socket would buy a channel this app has no traffic
 *   for.
 *
 * So: SSE. If a future version needs the client to push — a live filter, an
 * interactive runner — the two checks above are what has to be written first,
 * and this comment is the note saying so.
 *
 * ## What is streamed
 *
 * A run starting, every line of output as it is read, the pass and fail counts
 * whenever they change, and the run ending with its verdict. The first event on
 * every connection is a `hello` carrying every run alive right now WITH what it
 * has already said — so a page that connects mid-run is not staring at an empty
 * box waiting for the next line.
 *
 * ## What happens when the page reloads mid-run
 *
 * **The run continues.** It lives in this server process; the page is a viewer
 * and closing it detaches a listener and nothing else. A reloaded page opens a
 * new stream, gets the `hello`, and picks the run back up with its output so far.
 * The only thing it cannot get back is output older than the couple of hundred
 * lines this app holds, and the page says where that gap is rather than
 * presenting a partial log as a whole one.
 *
 * The run does NOT survive this server stopping — see `stopAll` above and
 * `sweep` in `runs/store.ts`, which is what makes the page able to say so.
 *
 * ## Not gated on the ticket, and why that is safe here
 *
 * The stream is a read. It carries what configured commands printed, which is
 * the same material `/api/state` hands out unticketed, and requiring a ticket
 * would mean an `EventSource` — which cannot set a header — could not open it at
 * all without a query parameter carrying the ticket, and a secret in a URL is a
 * secret in a log file.
 */
function events(request: IncomingMessage, response: ServerResponse): void {
  response.statusCode = 200
  response.setHeader('content-type', 'text/event-stream; charset=utf-8')
  /* No buffering anywhere in between, and no caching of a stream that is by
     definition not a document. */
  response.setHeader('cache-control', 'no-store')
  response.setHeader('connection', 'keep-alive')
  response.setHeader('x-accel-buffering', 'no')
  /* Nagle would hold a short line back waiting for company, which on a stream
     whose whole point is immediacy turns "live" into "live, in bursts". */
  request.socket.setNoDelay(true)

  const write = (event: string, data: unknown) => {
    /* A write to a socket the browser closed a moment ago throws, and it must
       not take the run down with it. */
    try {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch {
      /* ignore */
    }
  }

  write('hello', { active: active().map((a) => ({ run: a.run, lines: a.lines, dropped: a.dropped })), slots: MAX_LIVE })

  const off = subscribe((e) => write(e.kind, e))

  /**
   * A comment frame every twenty seconds.
   *
   * Not a heartbeat for the application's sake — the page does not care — but
   * for everything between it and this process. An idle TCP connection through a
   * proxy or a laptop's power manager is a connection something eventually
   * decides is dead, and a stream that goes quiet during a slow test suite is
   * exactly the case that would break. A line beginning with a colon is an SSE
   * comment and is discarded by the client.
   */
  const beat = setInterval(() => write('beat', { at: Date.now() }), 20_000)

  const close = () => {
    clearInterval(beat)
    off()
    try {
      response.end()
    } catch {
      /* ignore */
    }
  }
  request.on('close', close)
  request.on('error', close)
}

/** One header, which node hands over as a string, an array, or nothing. */
function readTicket(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0] ?? null
  return null
}

/**
 * The request body, as JSON, or null.
 *
 * Bounded at a megabyte, because the caller is whatever on this machine found
 * the port — loopback is a fence around the machine and not around the programs
 * on it — and a handler that reads until the socket closes is a handler that can
 * be asked to read forever. Nothing this app accepts is anywhere near this size;
 * the bound is a bound rather than a budget.
 *
 * Unparseable is null rather than a throw, and `doors.ts` says "that was not a
 * request" about it. A malformed body is an ordinary answer to give.
 */
const MAX_BODY_BYTES = 1_000_000

async function body(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  if ((request.method ?? 'GET').toUpperCase() !== 'POST') return null
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const piece = chunk as Buffer
    size += piece.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(piece)
  }
  if (!chunks.length) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * The dev server, and the one line missing from it that decides whether the
 * ticket in this page is worth anything.
 *
 * ## No `server.cors` — this module declares storage instead
 *
 * Atlas and References set `cors: true` and have to. A host frames a module
 * WITHOUT `allow-same-origin` unless its manifest declares storage, which puts
 * the page on an opaque origin — and `<script type="module">` is ALWAYS fetched
 * in CORS mode, so with no permissive header not one script in the page runs.
 * The document loads, `load` fires, the host greets it, and nothing answers.
 * `curl` cannot see it, being unsubject to CORS; only the browser console can.
 * That has cost this codebase days.
 *
 * This module must not go that way, for a reason those two do not have: it owns
 * data, takes writes, and one of those writes STARTS A PROCESS. A permissive
 * `Access-Control-Allow-Origin` means any page in any tab can read `/app`, and
 * therefore the ticket in it, off loopback — and then press Run here. Measured on
 * Journeys rather than theorised, before that module was moved to this shape:
 *
 *     $ curl -H 'Origin: https://evil.example' http://127.0.0.1:7840/app
 *     Access-Control-Allow-Origin: *
 *     ...ticket" type="application/json">"e75d4d01-…
 *
 * So the manifest declares `storage: true` and this line is absent. With a real
 * origin, this page's scripts, its `/api` calls and its `EventSource` are
 * ordinary same-origin requests: no CORS is involved at all, nothing is offered
 * to strangers, and the ticket is unreadable from anywhere but inside.
 *
 * ## No alias for `roadmap-module-protocol`
 *
 * There used to be one, in every app here, pointing at the protocol's source in
 * the repository they all used to live in. It is gone and must not come back:
 * the package's `exports` are correct, reaching past them is what made a whole
 * class of bug possible, and a module that resolved its contract differently
 * from the host it talks to is a module testing something nobody ships.
 *
 * The `@` alias below is a different thing entirely — it points inside this
 * repository, at `src`, and is what shadcn's generated components import
 * through.
 *
 * ## Tailwind is a plugin here and there is no `tailwind.config.js`
 *
 * Version 4 is configured in CSS. The palette, the container, the verdict
 * colours and the `dark` variant are all in `src/index.css` under `@theme` and
 * `@custom-variant`, and a JavaScript config file alongside them would be a
 * second place to answer the same questions — which is how a token ends up
 * defined twice with two values and a component picking whichever the build
 * happened to resolve last. The plugin below is the whole of the wiring.
 *
 * ## No `server.port`, because `serves()` decides it
 *
 * 7900 used to be written on the `bunx vite` line in `run.sh` and again in
 * `register.ts`, and true in neither the moment something else held the port:
 * `--strictPort` meant this app printed `Error: Port 7900 is already in use` and
 * exited 1, so a program with no interest in test suites could stop the suites
 * from opening. It is `PREFERRED_PORT` in `manifest.ts` now, said once beside
 * the id and read from there by this file and `register.ts` both.
 *
 * `serves()` is FIRST in the plugin list because it has to claim a port before
 * anything else in this config asks for one. A free 7900 is taken in silence;
 * this module already answering there ends the start cleanly rather than making
 * a second copy — which here would be a second process spawning test runs
 * against the same `runs/` store, with two event streams and one of them
 * invisible; anything else is a loud move to the next free port with the
 * registration rewritten to the port the server ACTUALLY bound, read off
 * `httpServer.address()` after `listening` rather than off what was asked for.
 */
export default defineConfig({
  /**
   * `base: './'`, because this page is served at `/app` here and framed by a
   * host at whatever address that host wrote down. Absolute asset paths are
   * correct in the first case and a guess in the second; relative ones are a fact
   * in both, because the browser resolves them against the document it just
   * fetched.
   */
  base: './',
  plugins: [serves({ id: ID, prefer: PREFERRED_PORT }), doors(), react(), tailwindcss()],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  build: { outDir: 'dist', emptyOutDir: true },
})
