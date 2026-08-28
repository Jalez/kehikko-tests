#!/usr/bin/env bash
#
# The one name every module ships this under, so a host that offers to start one
# has a script to run rather than a command line to build.
#
#   - No arguments. A registration names a directory and one script inside it,
#     never a command line: a string a host handed to a shell would make a
#     registration file a place to write shell. That rule is the same one this
#     module applies to its own suites, one level down — see `suites/store.ts`.
#   - $PORT from the environment. Whoever starts this chose the port; a script
#     that picked its own would answer somewhere nobody is looking. 7900 is the
#     default, and it is the number in the registration too — 7820, 7830, 7840,
#     7850 and 7860 belong to References, Atlas, Journeys, the orchestrator and
#     the Checklist on this machine.
#   - `exec`, and the foreground. A script that forks and returns leaves whoever
#     started it holding a pid that stops nothing, and Stop is only ever offered
#     for what a host started. It matters more here than in a sibling: this
#     process owns running test suites, and stopping it has to actually reach
#     them.
#   - `cd` to this script's own directory, so the app's store is beside the
#     program however it was invoked, and TESTS_DATA set explicitly on top of
#     that — see the essay in `store.ts` about what Vite's config bundling does
#     to `import.meta.dir`.
#
# It does NOT register. Registration is a deliberate act by a person — see
# `register.ts` — and a start script that quietly wrote into somebody's home
# directory would be doing it on their behalf.
#
# ## There is no build here, and no `dist`
#
# The argument for one is that starting should be starting: a start that shells
# out to a build is a start that fails when the network is down. The argument is
# fine and the shape is still wrong, because this program is not deployed — it
# runs on the machine of the person editing it. What `dist` actually buys is a
# STALE page served with a 200, every symptom of a working app and none of the
# changes, and that failure has cost this codebase whole afternoons three
# separate times in three different programs. A missing build announces itself. A
# stale one does not.
#
# So Vite serves the page, as Vite is for. The manifest, the health check, the
# MCP door, this app's own store and the event stream are middleware in front of
# the same server — see `doors()` in `vite.config.ts` — because a module is one
# origin or it is nothing, and because a page whose EventSource pointed at a
# second port would be opening a cross-origin stream, which is the one thing this
# module's `storage: true` was declared to avoid needing.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "installing…" >&2
  bun install >&2
fi

export TESTS_DATA="${TESTS_DATA:-$PWD/data}"

exec bunx vite --host 127.0.0.1 --port "${PORT:-7900}" --strictPort
