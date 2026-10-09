#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'

import { WELL_KNOWN } from 'kehikot-module-protocol'
import { claim, doorsFetch, fillPage, registerAt, sayClaim } from 'kehikot-module-protocol/serve'

import { answer, BUILD, MANIFEST, stream, TICKET } from './doors.ts'
import { ID, PREFERRED_PORT, VERSION } from './manifest.ts'
import { stopAll } from './runs/spawn.ts'

/**
 * This app over a BUILT page, on the same doors and the same port.
 *
 *   bun run build && bun run start
 *
 * ## What this is for, and what it is emphatically not for
 *
 * `run.sh` still runs Vite, and that is still how anybody edits this module. The
 * essay in `run.sh` about why there is no `dist` on the development path is
 * unretracted and worth re-reading before touching this file: a stale build
 * served with a 200 has every symptom of a working app and none of the changes,
 * and that has cost this codebase whole afternoons three separate times. Nothing
 * here should tempt anybody to point `run.sh` at it.
 *
 * What it is for is the case `run.sh` cannot cover: running this module
 * somewhere that is not the machine it is edited on, and running fourteen of
 * them without fourteen bundlers resident. Measured on this machine, with every
 * module up and idle, a Vite dev server for this app holds 81–94 MB; the whole
 * fleet of fourteen came to 1061 MB. This process holds a manifest, a run store
 * and three files off disk.
 *
 * The failure mode `run.sh` warns about is answered here by REFUSING rather than
 * by rebuilding. `/app` with no `dist` is a 503 saying which command to run — a
 * missing build announces itself, which was always the argument. What this file
 * must never do is shell out to a build on start: a start that builds is a start
 * that fails when the network is down, and one that silently rebuilds is one
 * that can serve a page nobody asked for.
 *
 * ## Why the doors are here rather than imported from the dev server
 *
 * They are not duplicated. `answer()` in `doors.ts` is the whole of the health
 * check, the MCP door and this app's `/api`, and `stream()` beside it is the
 * event stream; both were written transport-neutral, so that a second adapter
 * would not be a second implementation. The adapter is the protocol's
 * `doorsFetch`: the same doors `doors()` gives the dev server, from a `Request`
 * to a `Response`. So this file decides nothing about what this app says, and
 * the only things it owns are the ones a dev server owns for itself: the port,
 * the registration, and the page and its assets off disk.
 *
 * ## No `access-control-allow-origin`, on any door, ever
 *
 * This is the line to be most careful about when editing this file, because
 * adding it is a one-word change that looks like a fix for a CORS error and is
 * a hole. The essay in `vite.config.ts` has the whole argument and the curl that
 * demonstrated it on a sibling; the short version is that this module declares
 * `storage: true`, so a host frames it WITH `allow-same-origin`, so this page has
 * a real origin and every call it makes to its own `/api` is same-origin and
 * needs no header at all. A permissive header would mean any page in any tab
 * could read `/app` off loopback, and therefore the write ticket printed into it,
 * and then press Run here — which on this module spawns a process.
 *
 * The sibling that DOES need `cors: true` is Atlas, and it needs it because it
 * declares `storage: false` and has nothing behind any door to steal. That
 * asymmetry is the whole design and it is not a thing to make uniform.
 */

const HERE = import.meta.dirname
const BUILT = join(HERE, 'dist')
const INDEX = join(BUILT, 'index.html')

/**
 * The port, decided the same way `serves()` decides it for the dev server, by
 * the same function.
 *
 * `claim` is exported from the protocol package on its own — beside the Vite
 * plugin rather than inside it — for exactly this: a module that does not use
 * Vite is an ordinary module and should not have to reimplement the drift rules
 * to say so. What it costs here is the three lines below, which are the ones
 * `serves()` also writes: exit 0 when this module is already answering, exit 1
 * when there is nowhere to go, and say so out loud when it moves.
 *
 * `PORT` from the environment wins, because a host that starts a module passes
 * the port from the registration it is about to go and read.
 */
const prefer = Number.isInteger(Number(process.env.PORT)) && Number(process.env.PORT) > 0
  ? Number(process.env.PORT)
  : PREFERRED_PORT

const claimed = await claim({ id: ID, prefer })

if (claimed.status === 'already-running') {
  /* Exit 0, not 1. Nothing failed: the thing being asked for exists. And it
     exits rather than drifting, which is the one place drift is refused — a
     second copy of THIS module is two processes spawning runs against one
     `runs/` store, with two event streams and one of them invisible. */
  console.log(sayClaim(claimed))
  process.exit(0)
}
if (claimed.status === 'nowhere') {
  console.error(sayClaim(claimed))
  process.exit(1)
}
if (claimed.moved) console.log(sayClaim(claimed))

/* Runs a previous life of this process left saying "running" are swept per
   project as each project is read, not here: the runs live inside the projects,
   and at startup this server knows of none. See `sweep` in `runs/store.ts`. */

/* Nothing this app started outlives it. `spawn` puts each run in a process group
   of its own so a runner's children die with it, and the flip side is that a
   Ctrl-C here would otherwise leave the group behind. `exit` is included because
   a crash is also a way for this process to end. */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopAll()
    process.exit(0)
  })
}
process.once('exit', stopAll)

/**
 * One file out of the build, or nothing.
 *
 * `normalize` and the prefix check together are what stop `/assets/../../etc/x`
 * from leaving the build directory. It is a small surface — only `/assets/`
 * reaches this — but "small surface" has never been a reason a path traversal did
 * not work, and the check is two lines.
 */
function asset(pathname: string): Response | null {
  const wanted = normalize(join(BUILT, pathname))
  if (!wanted.startsWith(BUILT + '/')) return null
  if (!existsSync(wanted)) return null
  return new Response(Bun.file(wanted), {
    /* Vite fingerprints every filename under `/assets/` with a content hash, so
       one of these files can never change meaning. Immutable is exactly true of
       them, and exactly false of the document below. */
    headers: { 'cache-control': 'public, max-age=31536000, immutable' },
  })
}

/**
 * Every door, and the page with this process's ticket and build put into it (`fillPage`: the build
 * compiled neither).
 *
 * Read from disk on every request rather than once at start. That costs a
 * sub-millisecond read of a 450-byte file and buys the thing worth having: a
 * rebuild while this is running is picked up by the next reload, instead of this
 * process serving the document it happened to read at boot for as long as it
 * lives. Which is the stale-page failure `run.sh` is an essay about, and it
 * would be a poor showing to reintroduce it in the file that claims to have
 * thought about it.
 */
const through = doorsFetch({
  manifest: MANIFEST,
  answer,
  stream,
  build: BUILD,
  page: () => fillPage(readFileSync(INDEX, 'utf8'), { ticket: TICKET, build: BUILD }),
})

/* A sentence, not a stack trace. Whoever sees this cloned the repository and
   started the server before building the page; the one command is worth more
   than any amount of detail about which file was missing. */
const unbuilt = (): Response =>
  new Response(
    'Tests has no built page. Run `bun install && bun run build` in this directory, then start it again.\n'
      + 'To edit this module instead, run ./run.sh, which serves the page from source with hot reload.\n',
    { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } },
  )

const server = Bun.serve({
  /* Loopback only, like the dev server. The port is the one `claim` decided, and
     `server.port` below is the one actually bound — which is the number that
     gets registered, because it is the only one that cannot be wrong. */
  hostname: '127.0.0.1',
  port: claimed.port,
  /* A test suite can print for a long time before it finishes, and `run_tests`
     over MCP deliberately holds the request open until the run ends rather than
     handing back a receipt an agent would have to poll. Bun's default idle
     timeout would cut both that and the event stream. */
  idleTimeout: 0,

  async fetch(request) {
    const path = new URL(request.url).pathname

    /* `/app/` and `/app` are different base URLs to a browser: the built
       document links its bundle as `./assets/…`, which resolves to `/assets/…`
       from the first and `/app/assets/…` from the second. The dev server does
       not care, because Vite serves absolute paths there. Rather than answer two
       shapes of asset path, the trailing slash is redirected away — and it is a
       308 so that the method survives, though nothing POSTs here. */
    if (path === '/app/') return Response.redirect('/app', 308)
    if ((path === '/app' || path === '/') && !existsSync(INDEX)) return unbuilt()

    /* Every door, then a file out of the build. Under Vite "not one of mine" is handed on to the
       rest of the middleware stack; here there is nothing behind this, so it is a 404. */
    return (
      (await through(request))
      ?? (path.startsWith('/assets/') ? asset(path) : null)
      ?? new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    )
  },
})

/**
 * The address, written down after the socket is bound rather than before.
 *
 * `server.port` is the port this process is ACTUALLY answering on. The gap
 * between the port that was asked for and the one that was bound is exactly
 * where a stale registration comes from, and a registration naming a port this
 * app has drifted off is one the host sweeps to find nothing — it reports this
 * module as stopped while it runs one port over, and offers a Start that would
 * put a second spawner on the same store.
 */
const origin = `http://127.0.0.1:${server.port}`
const written = registerAt({ id: ID, origin, dir: HERE })

console.log(`Tests ${VERSION} on ${origin}`)
console.log(`  page      ${origin}/app`)
console.log(`  manifest  ${origin}${WELL_KNOWN}`)
console.log(`${ID} registered: ${written.file} -> ${origin}`)
if (written.was) console.log(`  (was ${written.was.url}${written.was.dir ? ` in ${written.was.dir}` : ''})`)
if (!existsSync(INDEX)) console.log('  no dist/index.html yet — run `bun run build`; /app says so too.')
