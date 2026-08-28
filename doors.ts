import { ID, MANIFEST, VERSION } from './manifest.ts'
import { BOUNDS, configure, forget, spell, suites, trouble as suiteTrouble } from './suites/store.ts'
import { active, begin, end, MAX_LIVE, runningSuite, waitFor } from './runs/spawn.ts'
import { ago, knownRefs, run as findRun, standingFor, type Run } from './runs/store.ts'

/**
 * Every door this app answers on that is not the page and not the event stream.
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
 * - **It does not gate reads, deliberately.** How a project is tested is not a
 *   secret, and requiring a ticket to look would only mean an agent's curl needs
 *   one to read a page it can already open.
 * - **It does not gate `/mcp`, and that is the interesting exception.** An MCP
 *   client is not a browser: it has no page, was handed no ticket, and requiring
 *   one there would shut the door this module exists to be configured through.
 *   So configuring a suite and starting a run are both available over `/mcp`
 *   without a ticket — which is a real widening, and the thing that makes it
 *   acceptable is the same first line as above. `configure_suite` validates an
 *   argv array and an absolute directory that must exist; `run_tests` takes a
 *   name. There is no spelling of either that turns this port into a shell.
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
export const TICKET = crypto.randomUUID()

/** What the page is called when it starts a run, and what an agent is called when it does not say. */
const OWNER = 'the owner, on this app’s own page'
const AGENT = process.env.TESTS_AGENT ?? process.env.ROADMAP_AGENT ?? 'an agent'

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
export function tellRef(ref: string): string {
  const s = standingFor(ref)
  if (!s.runs.length) {
    /* The sentence this whole module is for. Nothing having been run is an
       ordinary state with a remedy, and it is not a failure, an error or an
       empty result — an agent told "no data" here would reasonably conclude the
       tests were red. */
    return `${ref}: nothing has been run against this reference on this machine. That is not a pass and not a failure — nobody has asked. ${
      suites().length ? `Configured suites: ${suites().map((x) => x.name).join(', ')}.` : 'No suites are configured yet either.'
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

function tools() {
  const configured = suites().map((s) => s.name)
  return [
    {
      name: 'how_tested',
      description:
        'How this project is tested, as this machine has been told: every configured suite, the exact command it runs, '
        + 'where it runs, and what it proves. Also what is running right now. Read this before running anything — the '
        + 'names here are the only things run_tests accepts.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'configure_suite',
      description:
        'Write down how something is tested, under a name. The command is an ARRAY of arguments — ["bun", "test"], not '
        + '"bun test" — because this server never hands anything to a shell; there is nothing to interpret a pipe or a '
        + 'semicolon, so split the command yourself. The directory must be absolute and must exist. Calling this again '
        + 'with the same name replaces that suite. Say what the suite PROVES in `what`: it is what somebody reads six '
        + 'weeks later when it goes red.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Lowercase letters, digits, dash, underscore. e.g. "unit", "e2e-smoke".' },
          what: { type: 'string', description: 'One sentence: what passing this suite would mean.' },
          command: {
            type: 'array',
            items: { type: 'string' },
            description: 'Argument array. ["bun", "test"] — the first element is the program.',
          },
          dir: { type: 'string', description: 'Absolute path to the directory to run in. Must exist.' },
          timeoutMs: {
            type: 'number',
            description: `How long before the run is killed. Clamped to ${BOUNDS.TIMEOUT_MIN_MS}–${BOUNDS.TIMEOUT_MAX_MS}; defaults to ${BOUNDS.TIMEOUT_DEFAULT_MS}.`,
          },
          agent: { type: 'string', description: 'Your name, recorded against the suite.' },
        },
        required: ['name', 'what', 'command', 'dir'],
      },
    },
    {
      name: 'forget_suite',
      description: 'Take a suite off the list. Runs already recorded against it are kept — they are facts about what happened.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    {
      name: 'run_tests',
      description:
        `Run one configured suite, optionally against the issue, merge request or pull request it is being run FOR — so `
        + `the answer to "was this change tested" has something in it. Suites configured as this server started: `
        + `${configured.length ? configured.join(', ') : '(none yet — use configure_suite first)'}; the list is editable, `
        + `so call how_tested for the one in force rather than trusting this sentence, which your client cached. This `
        + `server runs at most ${MAX_LIVE} suites at once and one copy of any given suite, and refuses rather than `
        + `queueing. By default it waits for the verdict; pass wait: 0 to be told the run started and read it later with `
        + `test_runs.`,
      inputSchema: {
        type: 'object',
        properties: {
          suite: { type: 'string', description: 'The suite name, as how_tested lists it.' },
          ref: { type: 'string', description: 'What this run is for: "!1848", "gh#1888", "#204". Optional.' },
          waitMs: { type: 'number', description: 'How long to wait for the verdict. 0 returns immediately. Default 120000.' },
          agent: { type: 'string' },
        },
        required: ['suite'],
      },
    },
    {
      name: 'test_runs',
      description:
        'What has been run against a reference on this machine, and how it went. A reference nothing has been run '
        + 'against says so in those words — that is not a pass and not a failure. Omit the ref for every reference '
        + 'anything is recorded against.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' } } },
    },
    {
      name: 'stop_run',
      description: 'Stop a run that is going. The run ends as "stopped", which is deliberately not "failed" — nobody learned anything about the code.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  ]
}

function suitesText(): string {
  const list = suites()
  const going = active()
  const head = list.length
    ? list.map((s) => `${spell(s)}${runningSuite(s.name) ? '\n      RUNNING NOW' : ''}`).join('\n')
    : 'Nothing has been configured on this machine. This app does not guess how a project is tested — say so with configure_suite, and nothing runs until you do.'
  const busy = going.length
    ? `\n\n${going.length} of ${MAX_LIVE} run slots busy: ${going.map((g) => `${g.run.suite} (${g.run.id})`).join(', ')}`
    : `\n\n0 of ${MAX_LIVE} run slots busy.`
  return head + busy
}

/** A status and a document. Nothing here writes bytes; the adapter does that. */
export interface Reply {
  status: number
  /** `null` means "answer with no body", which is what a notification gets. */
  body: unknown
}

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
      if (name === 'how_tested') return text(suitesText())

      if (name === 'configure_suite') {
        const out = configure({
          name: args.name,
          what: args.what,
          command: args.command,
          dir: args.dir,
          timeoutMs: args.timeoutMs,
          by: str(args.agent, MAX_BY) || AGENT,
        })
        if (!out.ok) return text(out.error, true)
        return text(`Configured:\n${spell(out.suite)}\n\nNothing has run yet. run_tests ${out.suite.name} starts it.`)
      }

      if (name === 'forget_suite') {
        const out = forget(str(args.name, BOUNDS.NAME))
        if (!out.ok) return text(out.error ?? 'it did not work', true)
        return text(`"${str(args.name, BOUNDS.NAME)}" is off the list. Runs already recorded against it are kept.`)
      }

      if (name === 'run_tests') {
        const started = begin({
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
        if (ref) return text(tellRef(ref))
        const refs = knownRefs()
        if (!refs.length) return text('Nothing has been run against any reference on this machine yet.')
        return text(
          refs
            .map((r) => {
              const s = standingFor(r)
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
    return ok({ ok: true, id: ID, version: VERSION, suites: suites().length, running: active().length, slots: MAX_LIVE })
  }

  if (path === '/mcp') {
    if (method !== 'POST') return bad('the MCP door takes POST', 405)
    if (!body || typeof body.method !== 'string') {
      return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a request' } } }
    }
    return mcp(body as Rpc)
  }

  /* Reads are GET and are not gated on the ticket. How a project is tested is
     not a secret, and a ticket on a read would only mean an agent's curl needs
     one to see a page it can already open. */
  if (method === 'GET' && path === '/api/state') {
    return ok({
      ok: true,
      suites: suites(),
      /* The live runs travel with everything they have said so far, so a page
         that has just loaded draws a run in progress with its output rather than
         an empty box that fills in only from the next line onwards. */
      active: active().map((a) => ({ run: a.run, lines: a.lines, dropped: a.dropped })),
      slots: MAX_LIVE,
      refs: knownRefs(),
      trouble: suiteTrouble(),
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
    return ok({ ok: true, standings: asked.map((ref) => standingFor(ref)) })
  }

  if (method === 'GET' && path === '/api/run') {
    const id = str(query.get('id'), MAX_ID)
    const found = findRun(id)
    return found ? ok({ ok: true, run: found }) : bad('there is no run with that id here', 404)
  }

  if (method === 'POST' && path.startsWith('/api/')) {
    /* The gate on every write and every run. The essay at the top of this file
       says what it separates and what it does not; the short version is that it
       stops another page, not another program, and the thing that stops another
       program doing damage is that a request cannot name a command. */
    if (ticket !== TICKET) return bad('that press did not come from this app’s own page', 403)
    if (!body) return bad('that was not a request')

    if (path === '/api/run') {
      const started = begin({
        suite: str(body.suite, BOUNDS.NAME),
        ref: str(body.ref, MAX_REF),
        by: OWNER,
      })
      if (!started.ok) return bad(started.error, 409)
      return ok({ ok: true, run: started.run })
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

export { MANIFEST }
