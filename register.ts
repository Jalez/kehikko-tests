#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ID } from './manifest.ts'

/**
 * Tell a host on this machine where this app answers.
 *
 *   bun run register            # or: PORT=7900 bun run register
 *
 * A separate program from `run.sh` on purpose. Registration writes into
 * somebody's home directory and says "frame this", which is a decision a person
 * makes once; a start script that did it quietly would be making that decision on
 * their behalf every time they pressed start. That is a stronger argument for
 * this module than for its siblings — registering this one is registering a
 * program that can be asked to spawn processes.
 *
 * ## The filename is the module id
 *
 * Not a field inside the file — the NAME. A host sweeps the directory and takes
 * the id from the filename, so `roadmap.tests.json` is what makes this
 * `roadmap.tests`. Two files naming the same port under different names are two
 * modules as far as a host is concerned.
 *
 * ## `dir` is written too, and it is what makes Start work
 *
 * A registration with only a URL is a module a host can find and cannot start.
 * The directory is what `roadmap/src/launch.ts` resolves `run.sh` inside, and it
 * checks that the script stays within it. So the pair is the whole registration:
 * where to knock, and where the program lives.
 *
 * ## Where a host looks
 *
 * This line must say exactly what a host's own registry sweep says, and it is
 * copied rather than imported because this directory is meant to stand alone.
 * Writing to the wrong directory is the worst failure a module can have: the host
 * finds nothing, and finds it silently.
 */
const registryDir = process.env.ROADMAP_MODULES_DIR ?? join(homedir(), '.roadmap', 'modules')

const port = Number(process.env.PORT ?? 7900)
const origin = `http://127.0.0.1:${port}`

mkdirSync(registryDir, { recursive: true })
const file = join(registryDir, `${ID}.json`)
writeFileSync(file, `${JSON.stringify({ url: origin, dir: import.meta.dir }, null, 2)}\n`)
console.log(`registered: ${file} -> ${origin}`)
console.log('Start the app with ./run.sh, then reload the host; it sweeps the directory on every read.')
