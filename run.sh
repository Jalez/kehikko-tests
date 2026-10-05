#!/usr/bin/env bash
#
# The one name every module ships this under, so a host that offers to start one
# has a script to run rather than a command line to build.
#
#   - No arguments. A registration names a directory and one script inside it,
#     never a command line: a string a host handed to a shell would make a
#     registration file a place to write shell. That rule is the same one this
#     module applies to its own suites, one level down — see `suites/store.ts`.
#   - No port on the `vite` line, and no `--strictPort`. Both used to be there,
#     with 7900 written here and again in `register.ts` — 7820 through 7960
#     belong to the other modules on this machine — so moving this one meant two
#     edits and then remembering that the file in `~/Library/Application Support/Kehikot/modules` still
#     named the old address. It is said once now, beside the id, as
#     `PREFERRED_PORT` in `manifest.ts`.
#
#     $PORT is still honoured, by `serves()` in `vite.config.ts` rather than by
#     this line, and for the reason this bullet always gave: whoever starts this
#     chose the port, and an app that picked its own would answer somewhere
#     nobody is looking. A host passes the port from the registration when it
#     spawns this script, which is the address it is about to go and read.
#
#     What `--strictPort` bought was an app that DIED on a taken port rather than
#     one answering quietly somewhere else, and that was the only honest option
#     while nothing handled a collision. `serves()` handles it: a free 7900 is
#     taken in silence, this module already answering there ends the start
#     cleanly instead of making a second copy — two processes spawning runs
#     against one `runs/` store, one of the two event streams invisible — and
#     anything else is a loud move with the registration rewritten to the port
#     actually bound.
#   - `exec`, and the foreground. A script that forks and returns leaves whoever
#     started it holding a pid that stops nothing, and Stop is only ever offered
#     for what a host started. It matters more here than in a sibling: this
#     process owns running test suites, and stopping it has to actually reach
#     them.
#   - `cd` to this script's own directory, and TESTS_DATA set explicitly to the
#     `data/` there. The store is not in it any more — suites and runs live in
#     each project at `.kehikot/tests/` — but that is where the OLD store was,
#     and this is how it is found to be handed out. See `legacyDir` in
#     `store.ts`.
#
# It does NOT register a module that had none. Registration is a deliberate act
# by a person — see `register.ts` — and a start script that quietly wrote into
# somebody's home directory would be doing it on their behalf, which matters more
# here than in a sibling because registering this one registers a program that
# can be asked to spawn processes. That argument is untouched. What the Vite
# plugin now writes on every start is this module's ADDRESS, which is a different
# sentence: the person decided to be framed, they did not decide to be framed at
# 7900 in particular, and a registration still naming a port this app has drifted
# off is one the host sweeps to find nothing.
#
# ## This script does not build, and must not start being the one that does
#
# There IS a build now — `bun run build`, served by `bun run start`, which is
# `serve.ts` — and this line still runs Vite. That is a decision rather than an
# omission, and it is the same decision this comment has always recorded.
#
# The argument for building here is that starting should be starting: a start
# that shells out to a build is a start that fails when the network is down. The
# argument is fine and the shape is still wrong, because on THIS path the program
# is not deployed — it runs on the machine of the person editing it. What a
# `dist` buys them is a STALE page served with a 200, every symptom of a working
# app and none of the changes, and that failure has cost this codebase whole
# afternoons three separate times in three different programs. A missing build
# announces itself. A stale one does not.
#
# `serve.ts` exists for the case this one cannot cover — running this module
# somewhere that is not the machine it is edited on, and running fourteen of
# these without fourteen bundlers resident, which was measured at 1061 MB across
# the fleet. It answers a missing `dist` with a 503 naming the command rather
# than by building, for the reason above. The two paths share every door: the
# manifest is one constant, `answer()` in `doors.ts` is one function, and the
# event stream's policy is one file, `runs/stream.ts`. Only the page differs, and
# only in how it is compiled.
#
# So here, Vite serves the page, as Vite is for. The manifest, the health check,
# the MCP door, this app's own store and the event stream are middleware in front
# of the same server — see `doors()` in `vite.config.ts` — because a module is one
# origin or it is nothing, and because a page whose EventSource pointed at a
# second port would be opening a cross-origin stream, which is the one thing this
# module's `storage: true` was declared to avoid needing.
set -euo pipefail
cd "$(dirname "$0")"

# Install when nothing is installed, AND whenever bun.lock or package.json is
# newer than the last install here, the same rule as the host's own run.sh. A
# pull that moves the protocol pin leaves the old package in node_modules, and
# a page that imports a name the old package does not have draws nothing.
# `--frozen-lockfile`, so a start installs exactly what bun.lock says and never
# rewrites it behind somebody's back. The stamp is written only after an
# install that succeeded.
INSTALLED=node_modules/.kehikot-installed
VITE_FORCE=
if [ ! -d node_modules ] || [ ! -f "$INSTALLED" ] || [ bun.lock -nt "$INSTALLED" ] || [ package.json -nt "$INSTALLED" ]; then
  echo "installing…" >&2
  if [ -f bun.lock ]; then
    bun install --frozen-lockfile >&2 || { echo "bun install --frozen-lockfile failed: bun.lock does not match package.json. Run \`bun install\` and commit bun.lock." >&2; exit 1; }
  else
    bun install >&2
  fi
  touch "$INSTALLED"
  # Rebuild Vite's pre-bundle rather than trust one made from the old packages.
  VITE_FORCE=--force
fi

export TESTS_DATA="${TESTS_DATA:-$PWD/data}"

exec bunx vite $VITE_FORCE
