import { establishBuild, mintTicket, refuseTicket, type Reply } from 'kehikot-module-protocol/serve'

import { ID, MANIFEST, VERSION } from './manifest.ts'
import { NOWHERE, projectOf } from './store.ts'
import { isConfirmed, keepConfirmed, fingerprint } from './suites/confirmed.ts'
import { AWAITS, BOUNDS, configure, forget, listed, outsideProject, spell, suite as findSuite, suites, trouble as suiteTrouble } from './suites/store.ts'
import { active, begin, end, isLive, MAX_LIVE, runningSuite, suitesChanged, waitFor } from './runs/spawn.ts'
import { ago, knownRefs, run as findRun, standingFor, sweep, type Run } from './runs/store.ts'
import { attach } from './runs/stream.ts'

/**
 * Every door this app answers on that is not the page: `answer` for the ones that reply with a
 * document, and `stream` at the bottom for the one that stays open.
 *
 * ## Why this is a file of functions rather than a server
 *
 * A module is ONE ORIGIN or it is nothing. The protocol refuses a manifest whose
 * `entry` points anywhere but the origin that served the manifest, and it is
 * right to — a program that could name somebody else's page would be a program
 * that could have the host frame somebody else. The page is Vite's, because a
 * `dist/` served off disk has cost this codebase whole afternoons of a stale page
 * answering 200 with every symptom of a working app and none of the changes. So
 * the manifest, the health check, the MCP door and this app's own store have to
 * be Vite's too — they cannot be a second process on a second port however much
 * tidier that would look.
 *
 * Hence: no listener here. `answer()` takes a method, a path, a query and a body
 * and returns a status and a document, and `vite.config.ts` adapts a node request
 * to it. The one door that is NOT here is `/api/events`, which is Server-Sent
 * Events and needs the raw response object; it lives in `vite.config.ts` beside
 * the adapter, and the essay on why it is SSE and not a socket is there.
 *
 * `answer` is async, unlike its equivalent in the sibling modules, and for one
 * reason: `run_tests` can WAIT. An MCP client has no stream, so an agent that
 * asked to run the tests and got back a receipt would have to poll; being able to
 * hold the request open until the run finishes is what makes the tool useful in
 * one call.
 *
 * ## What the ticket does and does not protect, which matters more here
 *
 * `TICKET` is minted once per process and printed into `/app`. It separates
 * "this app's own page did that" from "something else on this machine found the
 * port and posted" — nothing more. It is not an authorization check and it never
 * was.
 *
 * On this module the thing behind it is a `spawn`, so it is worth being exact
 * about the shape of the protection:
 *
 * - **It does protect against a page in another tab.** That is the whole reason
 *   the manifest declares `storage: true` and `vite.config.ts` sets no
 *   `server.cors`: with a real origin, `/app` is unreadable cross-origin, so the
 *   ticket in it cannot be lifted by a page somebody happened to visit. Journeys
 *   had exactly that hole and it was demonstrated with a curl.
 * - **It does not protect against another program on this machine.** Anything
 *   running as this user can read the page over loopback and take the ticket.
 *   That is not a hole this design can close, and it is why the ticket is the
 *   SECOND line rather than the first. The first line is that a request cannot
 *   name a command: the worst a program holding the ticket can do is run a suite
 *   somebody already wrote down and could have run themselves.
 * - **It gates the page's reads and its stream too.** They answer with a
 *   project's suites and with what its runs printed, and this app's own page is
 *   the only caller they have; an agent reads the same through `/mcp`.
 * - **It does not gate `/mcp`, and that is the interesting exception.** An MCP
 *   client is not a browser: it has no page, was handed no ticket, and requiring
 *   one there would shut the door this module exists to be configured through.
 *   So configuring a suite and starting a run are both available over `/mcp`
 *   without a ticket — which is a real widening, and the thing that makes it
 *   acceptable is the same first line as above. `configure_suite` validates an
 *   argv array and an absolute directory that must exist inside the project;
 *   `run_tests` takes a name. There is no spelling of either that turns this
 *   port into a shell.
 * - **What `/mcp` cannot do is say yes for a person.** A suite runs only once
 *   its command has been confirmed, and confirming is the page's alone: a
 *   ticketed press in the suite's own row, of the command the page drew
 *   (`suites/confirmed.ts`). So what an agent writes down, and what arrives in a
 *   project's files, waits for somebody to read it.
 */

/* ------------------------------------------------------------------ *
 * Everything that arrives, bounded before it is looked at
 *
 * Nothing here trusts its caller. The page is one caller, an agent over MCP is
 * another, and a third is whatever else on this machine found the port —
 * loopback is a fence around the machine and not around the programs on it. A
 * string has a length before it has a meaning.
 * ------------------------------------------------------------------ */

const MAX_REF = 64
const MAX_ID = 64
const MAX_BY = 80
/** How many references one standings query may ask about. The protocol caps a
 *  selection at 32; this is that with room, rather than that number exactly,
 *  because a bound that tracked another program's constant would break quietly
 *  the day that constant moved. */
const MAX_REFS_PER_ASK = 64
/** The longest an MCP `run_tests` may hold its request open waiting for a verdict. */
const MAX_WAIT_MS = 600_000
/** As long as a path may be, matching the protocol's own `LIMITS.PATH`. */
const MAX_PROJECT = 4096

/**
 * The project a caller named, resolved, with this process's orphaned runs in it
 * swept — or null for none.
 *
 * Every door that reads a project goes through here, so `sweep` happens on the
 * read that would otherwise have drawn an orphan as running. See `sweep` in
 * `runs/store.ts` for why it is per project and not once at startup.
 */
function projectIn(value: unknown): string | null {
  const project = projectOf(str(value, MAX_PROJECT))
  if (project !== null) sweep(project, isLive)
  return project
}

/** Why a named project cannot be used, for a door that has to say so. */
function refusedProject(value: unknown): string {
  const named = str(value, MAX_PROJECT)
  if (!named) return NOWHERE
  return suiteTrouble(named, true) ?? NOWHERE
}

function str(value: unknown, max: number): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max)
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

/**
 * The ticket a write or a run has to carry.
 *
 * Minted once per process and printed into the page this server serves. It dies
 * with this process, the way a host's own send ticket does, because a secret
 * that outlives the thing that issued it is one nobody can revoke by restarting.
 * What it separates, and what it does not, is the essay above.
 */
export const TICKET = mintTicket()

/**
 * What this process is built from: this module's version, the checkout's commit, and when the
 * process started. Both servers say it in the manifest, at `/healthz`, in the page and on every
 * answer, which is how a page notices that the server answering it is not the one that served it.
 */
export const BUILD = establishBuild({ version: VERSION, dir: import.meta.dirname })

/** What the page is called when it starts a run, and what an agent is called when it does not say. */
const OWNER = 'the owner, on this app’s own page'
const AGENT = process.env.TESTS_AGENT ?? process.env.KEHIKOT_AGENT ?? process.env.ROADMAP_AGENT ?? 'an agent'

/* ------------------------------------------------------------------ *
 * How a run reads, in words
 * ------------------------------------------------------------------ */

/**
 * One run, as a sentence.
 *
 * Every branch names the verdict rather than a symbol, and the three that are
 * not `passed`/`failed` say what to do about it — a timeout and a red suite send
 * a person to different places, and a run this server lost to its own restart
 * sends them to a third.
 */
export function tellRun(r: Run): string {
  const counted =
    r.passed === null && r.failed === null
      ? 'its output did not say how many tests ran'
      : `${r.passed ?? 0} passed, ${r.failed ?? 0} failed`
  const when = `${ago(r.startedAt)} ago`
  const head = `${r.suite} — ${r.verdict}`
  if (r.verdict === 'running') return `${head}, started ${when} by ${r.by}`
  if (r.verdict === 'timeout') return `${head} — this app killed it because it exceeded the suite's own bound. Nothing was asserted; it hung. (${when})`
  if (r.verdict === 'stopped') return `${head} — somebody stopped it, so there is no verdict about the code. (${when})`
  if (r.verdict === 'crashed') {
    return `${head} — the process could not be started or was killed by something outside this app; that is not a test failure. (${when})`
  }
  return `${head} (exit ${r.exitCode ?? '?'}, ${counted}, ${when}, by ${r.by})`
}

/** What has been run against one reference, in words, including having run nothing. */
export function tellRef(project: string, ref: string): string {
  const s = standingFor(project, ref)
  if (!s.runs.length) {
    /* The sentence this whole module is for. Nothing having been run is an
       ordinary state with a remedy, and it is not a failure, an error or an
       empty result — an agent told "no data" here would reasonably conclude the
       tests were red. */
    const configured = suites(project)
    return `${ref}: nothing has been run against this reference in this project. That is not a pass and not a failure — nobody has asked. ${
      configured.length ? `Configured suites: ${configured.map((x) => x.name).join(', ')}.` : 'No suites are configured yet either.'
    }`
  }
  const lines = s.bySuite.map((r) => `  ${tellRun(r)}`)
  const more = s.runs.length - s.bySuite.length
  return [
    `${ref}: ${s.bySuite.length === 1 ? 'one suite has' : `${s.bySuite.length} suites have`} been run against this reference. The newest of each:`,
    ...lines,
    more > 0 ? `  (${more} older ${more === 1 ? 'run' : 'runs'} also recorded)` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/* ------------------------------------------------------------------ *
 * The agent's door
 * ------------------------------------------------------------------ */

/** The `project` argument every project-bound tool takes, described once. */
const PROJECT = {
  type: 'string',
  description:
    'Absolute path of the project folder — the same path a host puts in kehikot.context.projectPath. Suites and runs '
    + 'live inside it, at .kehikot/tests/. Required: this app does not guess which project was meant.',
} as const

function tools() {
  return [
    {
      name: 'how_tested',
      description:
        'How this project is tested, as it has been told: every configured suite, the exact command it runs, '
        + 'where it runs, and what it proves. Also what is running right now. Read this before running anything — the '
        + 'names here are the only things run_tests accepts, and it says which of them a person has yet to confirm.',
      inputSchema: { type: 'object', properties: { project: PROJECT }, required: ['project'] },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'configure_suite',
      description:
        'Write down how something is tested, under a name. The command is an ARRAY of arguments — ["bun", "test"], not '
        + '"bun test" — because this server never hands anything to a shell; there is nothing to interpret a pipe or a '
        + 'semicolon, so split the command yourself. The directory must be absolute, must exist, and must be the '
        + 'project folder or a folder inside it. Calling this again with the same name replaces that suite. A suite '
        + 'does not run until a person has confirmed its command in the Tests page, and needs that again whenever its '
        + 'command or directory changes — so tell the person when you configure or change one. Say what the suite '
        + 'PROVES in `what`: it is what somebody reads six weeks later when it goes red.',
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT,
          name: { type: 'string', description: 'Lowercase letters, digits, dash, underscore. e.g. "unit", "e2e-smoke".' },
          what: { type: 'string', description: 'One sentence: what passing this suite would mean.' },
          command: {
            type: 'array',
            items: { type: 'string' },
            description: 'Argument array. ["bun", "test"] — the first element is the program.',
          },
          dir: { type: 'string', description: 'Absolute path to the directory to run in: the project folder or a folder inside it. Must exist.' },
          timeoutMs: {
            type: 'number',
            description: `How long before the run is killed. Clamped to ${BOUNDS.TIMEOUT_MIN_MS}–${BOUNDS.TIMEOUT_MAX_MS}; defaults to ${BOUNDS.TIMEOUT_DEFAULT_MS}.`,
          },
          agent: { type: 'string', description: 'Your name, recorded against the suite.' },
        },
        required: ['project', 'name', 'what', 'command', 'dir'],
      },
      /* It writes: a suite of the same name is replaced, and what it then awaits is a person's confirmation. */
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'forget_suite',
      description: 'Take a suite off the list. Runs already recorded against it are kept — they are facts about what happened.',
      inputSchema: {
        type: 'object',
        properties: { project: PROJECT, name: { type: 'string' } },
        required: ['project', 'name'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'run_tests',
      description:
        `Run one configured suite, optionally against the issue, merge request or pull request it is being run FOR — so `
        + `the answer to "was this change tested" has something in it. Suites are per project; call how_tested for the `
        + `ones configured in yours. This `
        + `server runs at most ${MAX_LIVE} suites at once and one copy of any given suite, and refuses rather than `
        + `queueing. A suite a person has not confirmed in the Tests page, or whose command or directory changed since `
        + `they did, is not run: the answer says it awaits confirmation there. By default it waits for the verdict; `
        + `pass waitMs: 0 to be told the run started and read it later with test_runs.`,
      inputSchema: {
        type: 'object',
        properties: {
          project: PROJECT,
          suite: { type: 'string', description: 'The suite name, as how_tested lists it.' },
          ref: { type: 'string', description: 'What this run is for: "!1848", "gh#1888", "#204". Optional.' },
          waitMs: { type: 'number', description: 'How long to wait for the verdict. 0 returns immediately. Default 120000.' },
          agent: { type: 'string' },
        },
        required: ['project', 'suite'],
      },
      /* Not a read: it starts a program on this machine, which may write and reach whatever that program does. */
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    {
      name: 'test_runs',
      description:
        'What has been run against a reference in this project, and how it went. A reference nothing has been run '
        + 'against says so in those words — that is not a pass and not a failure. Omit the ref for every reference '
        + 'anything is recorded against.',
      inputSchema: { type: 'object', properties: { project: PROJECT, ref: { type: 'string' } }, required: ['project'] },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'stop_run',
      description: 'Stop a run that is going. The run ends as "stopped", which is deliberately not "failed" — nobody learned anything about the code.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      /* It ends a process, and what that run would have said is lost. */
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
  ]
}

function suitesText(project: string): string {
  const list = suites(project)
  const going = active()
  const head = list.length
    ? list
        .map(
          (s) =>
            `${spell(s)}${isConfirmed(project, s) ? '' : `\n      NOT CONFIRMED, so it will not run. ${AWAITS}`}`
            + `${runningSuite(project, s.name) ? '\n      RUNNING NOW' : ''}`,
        )
        .join('\n')
    : 'Nothing has been configured in this project. This app does not guess how a project is tested — say so with configure_suite, and nothing runs until you do.'
  const busy = going.length
    ? `\n\n${going.length} of ${MAX_LIVE} run slots busy: ${going.map((g) => `${g.run.suite} (${g.run.id})`).join(', ')}`
    : `\n\n0 of ${MAX_LIVE} run slots busy.`
  return head + busy
}

/* A status and a document — the protocol's `Reply`. Nothing here writes bytes; the adapter does that. */
export type { Reply }

const ok = (body: unknown): Reply => ({ status: 200, body })
const bad = (why: string, status = 400): Reply => ({ status, body: { ok: false, error: why } })

interface Rpc {
  id?: number | string
  method?: string
  params?: { name?: string; arguments?: Record<string, unknown> }
}

async function mcp(rpc: Rpc): Promise<Reply> {
  const reply = (result: unknown) => ok({ jsonrpc: '2.0', id: rpc.id ?? null, result })
  const text = (s: string, isError = false) =>
    reply({ content: [{ type: 'text', text: s }], ...(isError ? { isError } : {}) })

  if (rpc.method === 'initialize') {
    return reply({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: ID, version: VERSION },
      instructions:
        'How this project is tested, and what was actually run. Configure named suites here — each one an argument '
        + 'array and a directory, never a command line, because nothing is handed to a shell — then run one against '
        + 'the change it is for. This app runs nothing it was not told about, and a reference nothing has been run '
        + 'against says exactly that rather than reading as a pass.',
    })
  }
  /* A notification carries no id and is answered with nothing. */
  if (typeof rpc.method === 'string' && rpc.method.startsWith('notifications/')) {
    return { status: 202, body: null }
  }
  if (rpc.method === 'tools/list') return reply({ tools: tools() })

  if (rpc.method === 'tools/call') {
    const name = String(rpc.params?.name ?? '')
    const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>
    try {
      /* Every tool but stop_run is about one project's suites and runs, and is
         refused with a sentence when it names none — see `NOWHERE`. stop_run
         takes a run id, which is unique across projects. */
      const project = name === 'stop_run' ? null : projectIn(args.project)
      if (name !== 'stop_run' && project === null) return text(refusedProject(args.project), true)

      if (name === 'how_tested') return text(suitesText(project as string))

      if (name === 'configure_suite') {
        const out = configure(project, {
          name: args.name,
          what: args.what,
          command: args.command,
          dir: args.dir,
          timeoutMs: args.timeoutMs,
          by: str(args.agent, MAX_BY) || AGENT,
        })
        if (!out.ok) return text(out.error, true)
        suitesChanged(project)
        return text(
          isConfirmed(project, out.suite)
            ? `Configured:\n${spell(out.suite)}\n\nIts command and directory are as a person confirmed them. Nothing has run yet. run_tests ${out.suite.name} starts it.`
            : `Configured:\n${spell(out.suite)}\n\nNothing has run yet, and it will not until a person confirms it. ${AWAITS} Tell them; after that, run_tests ${out.suite.name} starts it.`,
        )
      }

      if (name === 'forget_suite') {
        const out = forget(project, str(args.name, BOUNDS.NAME))
        if (!out.ok) return text(out.error ?? 'it did not work', true)
        suitesChanged(project)
        return text(`"${str(args.name, BOUNDS.NAME)}" is off the list. Runs already recorded against it are kept.`)
      }

      if (name === 'run_tests') {
        const started = begin({
          project,
          suite: str(args.suite, BOUNDS.NAME),
          ref: str(args.ref, MAX_REF),
          by: str(args.agent, MAX_BY) || AGENT,
        })
        if (!started.ok) return text(started.error, true)
        const asked = typeof args.waitMs === 'number' && Number.isFinite(args.waitMs) ? args.waitMs : 120_000
        const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Math.round(asked)))
        const where = started.run.ref ? ` for ${started.run.ref}` : ' (for no particular reference)'
        if (waitMs === 0) {
          return text(
            `Started ${started.run.suite}${where}: ${started.run.command.join(' ')} in ${started.run.dir}. Run id ${started.run.id}. Read it later with test_runs.`,
          )
        }
        const done = await waitFor(started.run.id, waitMs)
        if (!done) {
          /* Not an error, and the wording has to make that plain: the run is
             still going, and an agent told "timed out" would reasonably think
             something went wrong with the suite rather than with its own
             patience. */
          return text(
            `${started.run.suite} is still running after ${Math.round(waitMs / 1000)}s — that is this call's patience running out, not the suite's timeout. Run id ${started.run.id}; test_runs will have the verdict.`,
          )
        }
        const body = done.tail.slice(-40).join('\n')
        /* A failure comes back as a tool error so an agent does not read past it,
           and with the tail attached so it has something to act on. A timeout is
           `isError` too: nothing was proved. */
        const wrong = done.verdict !== 'passed'
        return text(`${tellRun(done)}${done.dropped ? `\n(${done.dropped} earlier lines not kept)` : ''}\n\n${body}`, wrong)
      }

      if (name === 'test_runs') {
        const ref = str(args.ref, MAX_REF)
        if (ref) return text(tellRef(project as string, ref))
        const refs = knownRefs(project)
        if (!refs.length) return text('Nothing has been run against any reference in this project yet.')
        return text(
          refs
            .map((r) => {
              const s = standingFor(project, r)
              const label = r || '(no reference)'
              return `${label}: ${s.bySuite.map((x) => `${x.suite} ${x.verdict}`).join(', ')}`
            })
            .join('\n'),
        )
      }

      if (name === 'stop_run') {
        const id = str(args.id, MAX_ID)
        const out = end(id, 'stopped', 'stopped over the MCP door.')
        if (!out.ok) return text(out.error ?? 'it did not work', true)
        return text(`${id}: asked to stop. It ends as "stopped", not "failed" — nothing was learned about the code.`)
      }
    } catch (e) {
      /* A refusal is an answer, and the sentence is the useful half. So it comes
         back as a tool error the agent reads, not as a transport failure it
         retries. */
      return text(e instanceof Error ? e.message : String(e), true)
    }
    const shown = name.length > 60 ? `${name.slice(0, 60)}…` : name
    return text(`no tool "${shown}" here`, true)
  }

  return {
    status: 404,
    body: { jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: String(rpc.method) } },
  }
}

/**
 * Every door but the page and the event stream, as one function.
 *
 * `null` means "this path is not ours", and the caller passes it on to Vite —
 * which is how the page, the client modules and Vite's own hot-reload socket keep
 * working without being enumerated here.
 */
export async function answer(
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  ticket: string | null,
): Promise<Reply | null> {
  if (path === '/healthz') {
    /* No suite count: suites are per project, and a health check is about this program. */
    return ok({ ok: true, id: ID, version: VERSION, running: active().length, slots: MAX_LIVE })
  }

  if (path === '/mcp') {
    if (method !== 'POST') return bad('the MCP door takes POST', 405)
    if (!body || typeof body.method !== 'string') {
      return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a request' } } }
    }
    return mcp(body as Rpc)
  }

  /* The page's reads ask for its ticket too. They answer with a project's suites and with what
     its runs printed, and this app's own page is the only caller they have; an agent reads the
     same through the MCP door. Marked as a ticket refusal, so a page older than this server knows
     to reload itself. */
  if (method === 'GET' && path.startsWith('/api/')) {
    const stranger = refuseTicket(ticket, TICKET, 'that was not asked by this app’s own page')
    if (stranger) return stranger
  }

  if (method === 'GET' && path === '/api/state') {
    /* One project's, named by `?project=` — the page takes it off
       `kehikot.context.projectPath`. With none, `nowhere` says so and the page
       draws that rather than an empty list of suites. */
    const project = projectIn(query.get('project'))
    const named = str(query.get('project'), MAX_PROJECT)
    return ok({
      ok: true,
      nowhere: !named,
      /* Each with whether a person has confirmed it here, and the fingerprint a confirmation is of. */
      suites: listed(project),
      /* The live runs travel with everything they have said so far, so a page
         that has just loaded draws a run in progress with its output rather than
         an empty box that fills in only from the next line onwards. */
      active: (project === null ? [] : active(project)).map((a) => ({ run: a.run, lines: a.lines, dropped: a.dropped })),
      slots: MAX_LIVE,
      refs: knownRefs(project),
      trouble: named ? suiteTrouble(named) : null,
    })
  }

  if (method === 'GET' && path === '/api/standings') {
    const asked = (query.get('refs') ?? '')
      .split(',')
      .map((r) => str(r, MAX_REF))
      .filter(Boolean)
      .slice(0, MAX_REFS_PER_ASK)
    /* A ref with nothing recorded still comes back, as a standing with no runs.
       It must never be quietly left out: a missing row looks exactly like a row
       that was never meant to be there, and "nothing has been run for this" is
       the single most important thing this module has to be able to say. */
    const project = projectIn(query.get('project'))
    return ok({ ok: true, standings: asked.map((ref) => standingFor(project, ref)) })
  }

  if (method === 'GET' && path === '/api/run') {
    const id = str(query.get('id'), MAX_ID)
    const found = findRun(projectIn(query.get('project')), id)
    return found ? ok({ ok: true, run: found }) : bad('there is no run with that id here', 404)
  }

  if (method === 'POST' && path.startsWith('/api/')) {
    /* The gate on every write and every run. The essay at the top of this file
       says what it separates and what it does not; the short version is that it
       stops another page, not another program, and the thing that stops another
       program doing damage is that a request cannot name a command. */
    /* `refuseTicket` marks the refusal, so a page that is merely older than this process — the
       server restarted under it — is told so by its own `ask()` and reloads, instead of every
       press being called a stranger's. */
    const refused = refuseTicket(ticket, TICKET, 'that press did not come from this app’s own page')
    if (refused) return refused
    if (!body) return bad('that was not a request')

    if (path === '/api/run') {
      const started = begin({
        project: str(body.project, MAX_PROJECT),
        suite: str(body.suite, BOUNDS.NAME),
        ref: str(body.ref, MAX_REF),
        by: OWNER,
      })
      if (!started.ok) return bad(started.error, 409)
      return ok({ ok: true, run: started.run })
    }

    /*
     * A person saying yes to one suite's command, from its row in this app's own page.
     *
     * The page sends back the fingerprint of the command it drew. If the suite is not that any more
     * — an agent changed it between the drawing and the press — nothing is confirmed, and the page
     * reads again so the person sees what they would be confirming. There is no door for this but
     * the page's: an agent cannot confirm what it configured.
     */
    if (path === '/api/confirm') {
      const project = projectIn(body.project)
      if (project === null) return bad(refusedProject(body.project))
      const name = str(body.suite, BOUNDS.NAME)
      const found = findSuite(project, name)
      if (!found) return bad(`there is no suite called "${name}" in this project, so there is nothing to confirm.`, 404)
      if (fingerprint(found) !== str(body.fingerprint, 128)) {
        suitesChanged(project)
        return bad(`"${name}" changed since this page drew it, so nothing was confirmed. Read the command as it is now and confirm that.`, 409)
      }
      const outside = outsideProject(project, found.dir)
      if (outside) return bad(`"${name}" cannot be confirmed. ${outside}`, 409)
      keepConfirmed(project, found)
      suitesChanged(project)
      return ok({ ok: true, suites: listed(project) })
    }

    if (path === '/api/stop') {
      const out = end(str(body.id, MAX_ID), 'stopped', 'stopped from this app’s own page.')
      if (!out.ok) return bad(out.error ?? 'it did not work', 409)
      return ok({ ok: true })
    }
  }

  /* An unknown path under `/api/` is ours to refuse rather than Vite's to try to
     serve as a source file. Anything else is not ours at all. */
  if (path.startsWith('/api/')) return bad('not here', 404)
  return null
}

/**
 * The one door that stays open: `GET /api/events?project`, server-sent events of one project's
 * runs. `emit(data, name)` is the protocol's — a NAMED event per kind (`hello`, `started`, `line`,
 * `counts`, `ended`, `beat`). What is sent and when is `attach`'s, for both servers; this only
 * hands it somewhere to write.
 *
 * Behind the ticket, like the reads: it carries what a run prints. `null`: not this door; a
 * `reply`: a refusal to send instead of opening the stream.
 */
export function stream(
  method: string,
  path: string,
  query: URLSearchParams,
  emit: (event: unknown, name?: string) => void,
  ticket: string | null = null,
): { close: () => void } | { reply: Reply } | null {
  if (method !== 'GET' || path !== '/api/events') return null
  /* What a run prints goes down this stream, so it is the page's like the reads are. An
     `EventSource` cannot carry a header, so the ticket rides in the address, as the page that
     opened the stream printed it. */
  const stranger = refuseTicket(query.get('ticket') ?? ticket, TICKET, 'that stream was not opened by this app’s own page')
  if (stranger) return { reply: stranger }
  /* The stream is one project's: a page standing in one project is never shown another's runs. */
  return { close: attach({ write: (event, data) => emit(data, event) }, projectOf(query.get('project'))) }
}

export { MANIFEST }
