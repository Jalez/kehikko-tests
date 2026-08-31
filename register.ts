#!/usr/bin/env bun
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { originFor, registerAt } from 'roadmap-module-protocol/serve'

import { ID, PREFERRED_PORT } from './manifest.ts'

/**
 * Tell a host on this machine where this app answers.
 *
 *   bun run register            # or: PORT=7901 bun run register
 *
 * A separate program from `run.sh` on purpose. Registration writes into
 * somebody's home directory and says "frame this", which is a decision a person
 * makes once; a start script that did it quietly would be making that decision on
 * their behalf every time they pressed start. That is a stronger argument for
 * this module than for its siblings — registering this one is registering a
 * program that can be asked to spawn processes.
 *
 * ## The plugin writes this file too, and does not weaken that
 *
 * `serves()` in `vite.config.ts` rewrites this registration every time the
 * server starts, which reads like exactly what the paragraph above forbids. It
 * is not, and the difference is worth being exact about — the more so here,
 * where being framed is consequential.
 *
 * ADOPTION is the decision a person makes once, and this program is it. Running
 * this is how a module nobody had put on their canvas gets onto it, spawning and
 * all; deleting the file is how it comes off again. Nothing the plugin does can
 * put this module on a canvas it was not already invited to.
 *
 * The ADDRESS is not a decision anybody made. Nobody chose 7900 — they chose to
 * be framed, and 7900 is a fact about where this process happened to bind, one
 * that changes between one start and the next when something else has the port.
 * A registration still naming the old number is one the host sweeps to find
 * nothing: it reports this app as stopped while it runs one port over, and
 * offers a Start button that would put a second spawner on the same `runs/`
 * store. Rewriting the address keeps the decision the person made TRUE. It does
 * not make one.
 *
 * ## `dir` is written too, and it is what makes Start work
 *
 * A registration with only a URL is a module a host can find and cannot start.
 * The directory is what `roadmap/src/launch.ts` resolves `run.sh` inside, and it
 * checks that the script stays within it. So the pair is the whole registration:
 * where to knock, and where the program lives.
 *
 * It comes from this file's own location rather than from `process.cwd()`, so
 * `bun run register` works from anywhere and records where the program actually
 * is instead of where somebody happened to be standing. That is the one thing
 * the package cannot work out for itself, which is why it is still spelled here.
 *
 * ## Where a host looks is no longer copied into this file
 *
 * The registry directory, the rule that the FILENAME carries the id — a host
 * sweeps the directory and reads the id off the name, so `roadmap.tests.json` is
 * what makes this `roadmap.tests` — and the shape of the document are all in
 * `roadmap-module-protocol/serve` now. This file used to say the path itself,
 * with a note explaining that the copy was deliberate so the directory could
 * stand alone; fourteen deliberate copies of one path are fourteen chances to
 * disagree by a character, and writing to the wrong directory is the worst
 * failure a module can have, because the host finds nothing and finds it
 * silently.
 *
 * `registerAt` MERGES rather than overwrites, so a field somebody set beside the
 * url by hand survives a rewrite that had nothing to do with it.
 */
const port = Number(process.env.PORT ?? PREFERRED_PORT)
const written = registerAt({
  id: ID,
  origin: originFor(port),
  dir: dirname(fileURLToPath(import.meta.url)),
})

console.log(`registered: ${written.file} -> ${written.url} (${written.dir})`)
if (written.was) console.log(`  (was ${written.was.url} in ${written.was.dir})`)
console.log('Start the app with ./run.sh, then reload the host; it sweeps the directory on every read.')
console.log(`If ${port} is taken, ./run.sh moves to the next free port and rewrites this file to match.`)
