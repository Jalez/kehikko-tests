# Tests

How a project is tested, kept as named suites; running one of them under a
bound; and what was actually run against the issue, merge request or pull
request you are looking at.

An app. Its own store, its own page, its own port. A host may frame it — and
then it learns which reference the canvas has picked out — but nothing here
needs one.

    ./run.sh                 # serves on 7900
    bun run register         # tells a host on this machine where it answers

## What it is for

Three sentences, and the third is the one that makes it more than a task runner:

1. **You say how the project is tested, over MCP.** A suite is a name, a
   sentence saying what it proves, an argument array and an absolute directory.
   That configuration lives in the project itself, at `.kehikot/tests/`.
2. **You run one, and watch it.** Output, pass and fail counts as they arrive,
   and the verdict — streamed over Server-Sent Events rather than polled for.
3. **It is keyed to a reference.** What was run for `!1848`, when, by whom, and
   what happened. A reference nothing has been run against says exactly that.

## The three answers it keeps apart

`not run`, `passed` and `we do not know` are three different things, and the
whole value of this module is telling them apart. So there is no boolean
anywhere in the store, and the verdicts are six words rather than two:

| word      | means                                                      |
| --------- | ---------------------------------------------------------- |
| `running` | a process is alive right now. Not a verdict.               |
| `passed`  | the process exited 0.                                      |
| `failed`  | the process exited non-zero. The runner said no.           |
| `timeout` | this app killed it for exceeding its bound. It hung.       |
| `stopped` | somebody stopped it. Nothing was learned about the code.   |
| `crashed` | it could not start, or something outside killed it.        |

And a reference with no runs gets a sentence rather than a mark: *nothing has
been run against this in this project — that is not a pass and not a failure.*

## A parts focus hides nothing here, and the page says so

An epic may be divided into parts, and a person may pick some of them out in
the host's bar. `context.parts` (protocol 0.29.0) lists every part of the open
epic with the references the host says belong to it, and flags the picked
ones; this module says `reacts: ['selection', 'parts']`.

The modules that list an epic's worth of things narrow to the picked parts.
This one lists nothing per epic — it follows the selection — so it narrows
nothing, and says where things stand instead (`src/live/focus.ts`):

- **A selected reference outside the picked parts is still drawn.** Its card
  says `Outside the picked part (The posting seam). It is shown because it is
  selected.` ahead of the sentence about runs, so "nothing has been run against
  this" is not read as a gap in the part somebody meant to be looking at.
- **A line at the top counts them** while any part is picked: `1 of 2
  references shown here is outside the picked part (The posting seam). Nothing
  is hidden: this page follows what is selected, not the parts.`
- **With nothing selected**, the references this project has runs for are
  counted the same way and none is removed. That list is the project's and has
  never been narrowed to the open epic, so narrowing it to parts of one would
  hide every run made under another epic. The suites are not about a reference.
- **Nothing picked** — an epic with no parts, no epic, a host that has never
  heard of parts — and the page says nothing about parts at all.

A reference no part lists is outside every focus (`refInFocus`, the protocol's
rule). The MCP door is not told the focus and answers as it always did.

## Where the data lives

Per project, at `<project>/.kehikot/tests/suites.json` and `runs.json`, using the
`kehikot-module-protocol` helpers every module shares. The page learns the
project from `kehikot.context.projectPath`; MCP tools take a required `project`
argument (the absolute path). With no project the page says so and every write
is refused with a sentence — nothing falls back to a folder beside this program.
Whether `.kehikot/` is committed is the host's per-project setting.

The old single store (`data/` beside this program) is handed out on first
contact: when a project is opened, it takes every legacy suite and run whose
recorded `dir` is inside it (unless a nested repository or kehikot project sits
between), plus anything whose `dir` is empty or no longer exists. The rest stays
in `data/` for its own project; `data/` is removed once empty. A project that
already has its own file is never written over. `TESTS_DATA` now only says where
that old store is looked for, which is what the tests use it for.

## Running processes safely, which is the whole design

This module spawns. Every line of that is arranged around one rule, and
`suites/store.ts` is where it is enforced:

> **A suite names a directory and a command, both of which are CONFIGURED, and
> the run door takes a NAME and looks it up.**

There is no code path from an HTTP body to an executable name. The alternative —
a run endpoint accepting a command line — is not a smaller version of this; it
is a shell on an HTTP port. Around that:

- `spawn(cmd, args, { shell: false })`. An argv array, never a string. With no
  shell there is nothing to interpret a `;` or a `$(…)`, so nothing here has to
  sanitise them — and nothing here should ever start interpolating near a
  command.
- Directories are absolute, checked at configuration time and again at run time.
- One run at a time per suite, two runs at a time in total, a per-suite timeout
  that kills the process **group**, and a visible way to stop one.
- Writes and runs from the page carry a ticket minted per process. What that
  does and does not protect is written out at the top of `doors.ts`.
- The manifest declares `storage: true` and there is no `server.cors`, so the
  page keeps a real origin and `/app` — and the ticket in it — is unreadable
  from another origin.

## Real-time, and why SSE rather than a socket

`EventSource` is same-origin by default, and with a real origin that protection
is free. **A WebSocket is not subject to CORS at all** — the handshake would
have to check `Origin` and the ticket by hand before attaching. Nothing here
needs a second direction: starting and stopping are ordinary ticketed POSTs.
The argument in full is in `vite.config.ts` beside `/api/events`.

**If the page reloads mid-run, the run continues.** It lives in the server
process; the page is a viewer. A reloaded page reconnects, is sent every live
run with everything it has said so far, and picks up mid-flight.

**If the SERVER stops, the run does not.** Its process group is killed on the way
out, and any record left saying `running` is rewritten as `crashed` on the next
start, with a sentence saying what happened — so the page never draws a spinner
for a process that is not there.

## The MCP door

`how_tested`, `configure_suite`, `forget_suite`, `run_tests`, `test_runs`,
`stop_run`. `run_tests` waits for the verdict by default, because an MCP client
has no stream and an agent that asked to run the tests wants the answer rather
than a receipt.

## The page is on the house stack

Tailwind v4 and shadcn, the same as every other module here: `components.json`,
`src/components/ui/`, `src/lib/utils.ts`, and the Vite plugin. There is no
`tailwind.config.js` and there must not be — version 4 is configured in CSS, and
the palette, the container and the `dark` variant are all in `src/index.css`.

Two rules in that file are load-bearing rather than cosmetic, and both are argued
out where they live. The `dark` variant is bound to the `.dark` class the wire
sets from `kehikot.context.theme`, NOT to `prefers-color-scheme`, so a container told
"light" on a machine set to dark does not come out half of each. And every
responsive class measures the PANE — `@min-[300px]/container:`, against the container
declared on `<body>` — because a viewport breakpoint fires on the monitor, and
this page's normal case is three per cent of one.

## Where things are

    manifest.ts        what this app says about itself, and what it refuses to declare
    doors.ts           every door but the page and the stream; the MCP tools
    vite.config.ts     the doors as middleware, and the SSE stream
    suites/store.ts    how a project is tested — and the refusals that make spawning safe
    runs/spawn.ts      the spawn, the bounds, the kill, the event bus
    runs/store.ts      what was run against what, and the six verdicts
    store.ts           where a project's files are, the fence, and the legacy hand-out
    runs/ago.ts        the one function both sides need, and why it is not in the store
    src/               the page: the wire, the stream, the cards
    src/index.css      the palette, the seven verdict colours, and the container container
    src/components/ui/ shadcn's button and badge, with the six verdicts as variants
