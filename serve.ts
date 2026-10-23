#!/usr/bin/env bun
import { run } from 'kehikot-module-protocol/run'

import { BUILD, MANIFEST, TICKET, answer, stream } from './doors.ts'
import { ID, PREFERRED_PORT } from './manifest.ts'
import { stopAll } from './runs/spawn.ts'

/**
 * This app over its BUILT page (`bun run build`), on the same doors and the same
 * port. `run.sh` starts this when `dist/` carries a stamp of the commit checked
 * out, and Vite otherwise.
 *
 * Everything this module says is decided elsewhere and shared with the dev
 * server: `answer` in `doors.ts` (the health check, the MCP door and this app's
 * `/api`) and `stream` beside it (the event stream, whose policy is
 * `runs/stream.ts`), mounted by the protocol's `run` exactly as `doors()`
 * mounts them on Vite.
 *
 * No `access-control-allow-origin`, on any door, ever. This module declares
 * `storage: true`, so its page has a real origin and every call it makes to its
 * own `/api` is same-origin; a permissive header would let any page in any tab
 * read `/app`, and the ticket in it, and then press Run here — which spawns a
 * process. `run` adds none.
 *
 * Nothing this app started outlives it. `spawn` puts each run in a process group
 * of its own, so a Ctrl-C would otherwise leave the group behind: `onStop` ends
 * them on SIGINT, SIGTERM and exit, as the dev server's `runs()` plugin does.
 * (Runs a previous life left saying "running" are swept per project as each is
 * read — `sweep` in `runs/store.ts`.)
 *
 * A build that is not this checkout's is never served: `run` answers the page
 * with a 503 saying which commit each is, and the command to run.
 */
await run({
  id: ID,
  prefer: PREFERRED_PORT,
  dir: import.meta.dirname,
  manifest: MANIFEST,
  answer,
  stream,
  build: BUILD,
  ticket: TICKET,
  onStop: stopAll,
})
