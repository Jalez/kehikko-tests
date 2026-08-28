import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'

import { suite as findSuite, suites } from '../suites/store.ts'
import { fold, NOTHING, type Counts } from './counts.ts'
import { KEEP_LINES, record, type Run, type Verdict } from './store.ts'

/**
 * Starting a process, which is the one thing in this program that can hurt
 * somebody.
 *
 * The argument for every line below is the one `roadmap/src/launch.ts` makes
 * about starting a module, and it applies harder here, because a module is
 * started by a person pressing a button once and a test suite is meant to be run
 * over and over by an agent. Read that file's opening comment; this is the same
 * discipline pointed at a different noun.
 *
 * ## The five bounds, and what each one closes
 *
 * 1. **The command is never in the request.** `begin()` takes a suite NAME and
 *    looks it up in a store that validated the argv array and the directory when
 *    an agent configured them. There is no code path from an HTTP body to an
 *    executable name. `suites/store.ts` is the file that makes this true and
 *    says so at length; without it this port is a shell.
 * 2. **`spawn(cmd, args, { shell: false })`.** An argv array, never a string.
 *    With no shell there is nothing to interpret a `;`, a backtick or a `$(…)`,
 *    so those characters are just characters — which is why nothing in this
 *    program has to sanitise them, and why nothing in this program should ever
 *    start doing string interpolation near a command.
 * 3. **The directory is checked again, here, at the moment of the run.** It was
 *    checked at configuration time too; that check landed on the agent that made
 *    the mistake, and this one catches the directory being deleted in the weeks
 *    since. Neither makes the other redundant.
 * 4. **It is bounded three ways.** One run at a time per suite, because two
 *    copies of the same test suite in the same directory fight over the same
 *    build artefacts and the second one's result is meaningless. `MAX_LIVE` runs
 *    in total, because a page that can spawn without limit is a fork bomb with a
 *    button on it. And a per-suite timeout that kills, because a run nothing
 *    reaps holds a slot forever, which is the same failure approached slowly.
 * 5. **Everything that is started can be stopped**, by the page and by the MCP
 *    door, and `stopAll()` is called when this process is shutting down.
 *
 * ## The process group, and why `detached: true`
 *
 * `bun test` is a program that starts other programs. Killing the pid we hold
 * would leave its children running with nothing watching them — which for a test
 * suite means a compiler or a browser sitting on a machine indefinitely. So the
 * child is given a process group of its own with `detached: true`, and every kill
 * here targets `-pid`, the group. That is the same reasoning `launch.ts` gives
 * for stopping a module, and it matters more here because a run's whole job is
 * to start things.
 *
 * `detached` does NOT mean the child outlives this server: it is not `unref`'d,
 * and `stopAll()` on shutdown kills the group. A run belongs to the process that
 * started it, and the honest thing for a page to say after a restart is "the
 * server went away while this was running" — which `sweep()` in `store.ts` makes
 * it able to say.
 *
 * ## What happens when the PAGE reloads mid-run, which is a different question
 *
 * **The run continues.** It lives in this server process; the page is a viewer.
 * A reloaded page opens a new `EventSource`, is sent the live runs as its first
 * event, and picks the stream back up mid-flight. What it does NOT get is the
 * output from before it connected beyond the tail this program is holding — and
 * the page says exactly that where the gap is, rather than presenting a partial
 * log as a whole one.
 */

/** How many runs may be alive at once, across every suite. */
export const MAX_LIVE = 2

/** How many output lines are held in memory for a live run, to replay to a new page. */
const HOLD_LINES = KEEP_LINES

/** How long the group is given to go quietly before it is killed outright. */
const GRACE_MS = 3_000

/**
 * The longest line this app will hold from a child's output.
 *
 * A test that prints a megabyte on one line is a test doing something odd, and
 * a stream that faithfully forwarded it would push it through an SSE frame, into
 * a browser, and into `runs.json`. Truncated with a mark, so the page can say the
 * line was cut rather than showing a plausible-looking short line.
 */
const MAX_LINE = 2_000

export type Event =
  | { kind: 'started'; run: Run }
  | { kind: 'line'; id: string; stream: 'out' | 'err'; text: string }
  | { kind: 'counts'; id: string; passed: number | null; failed: number | null }
  | { kind: 'ended'; run: Run }

type Listener = (event: Event) => void

const listeners = new Set<Listener>()

/**
 * Watch every run, from anywhere in this process.
 *
 * Deliberately not per-run. A page shows several references and any of them may
 * have something running; a subscription per run would mean the page opening and
 * closing streams as the selection moved, and missing the start of a run
 * somebody triggered from an agent while it was between subscriptions. One
 * stream, every event, and the page filters — which is the arrangement that
 * makes "a run started somewhere else appears on your screen" work at all.
 */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function tell(event: Event): void {
  for (const fn of [...listeners]) {
    /* One bad listener must not stop the others hearing, and must not stop the
       run. A listener here is an SSE response that may have been closed by a
       browser half a millisecond ago. */
    try {
      fn(event)
    } catch {
      /* ignore */
    }
  }
}

interface Live {
  run: Run
  child: ChildProcess
  timer: ReturnType<typeof setTimeout>
  killer: ReturnType<typeof setTimeout> | null
  counts: Counts
  lines: string[]
  dropped: number
  /** Set when we are the ones ending it, so the exit handler knows what to call it. */
  ending: Verdict | null
  /** Partial lines, per stream, waiting for their newline. */
  rest: { out: string; err: string }
}

const live = new Map<string, Live>()

/** Every run alive right now, with what it has said so far. */
export function active(): { run: Run; lines: string[]; dropped: number }[] {
  return [...live.values()].map((l) => ({ run: { ...l.run, tail: l.lines }, lines: l.lines, dropped: l.dropped }))
}

/** Whether a suite is running right now, which the page draws and `begin` refuses on. */
export function runningSuite(name: string): Run | null {
  for (const l of live.values()) if (l.run.suite === name) return l.run
  return null
}

export type Begun = { ok: true; run: Run } | { ok: false; error: string }

/**
 * Start one configured suite.
 *
 * Everything that can be refused is refused before a process exists, and each
 * refusal is a sentence rather than a code, because the caller is as often an
 * agent as a person and an agent given `409` will retry it.
 */
export function begin(input: { suite: string; ref?: string; by?: string }): Begun {
  const name = String(input.suite ?? '').slice(0, 40)
  const found = findSuite(name)
  if (!found) {
    const known = suites().map((s) => s.name)
    return {
      ok: false,
      error: known.length
        ? `there is no suite called "${name}". Configured here: ${known.join(', ')}. Suites are configured over this app's MCP door with configure_suite; a run only ever names one.`
        : `there is no suite called "${name}", and in fact nothing has been configured on this machine yet. Say how this project is tested first, with configure_suite over this app's MCP door.`,
    }
  }

  const already = runningSuite(name)
  if (already) {
    /* One at a time per suite, and the reason is not politeness: two copies of a
       test suite in one directory share a build cache, a port, a database and a
       temporary directory, and the second one's verdict is not a fact about the
       code. Refusing is more useful than producing a number nobody can trust. */
    return {
      ok: false,
      error: `"${name}" is already running (started ${new Date(already.startedAt).toISOString()}). Two copies of one suite in one directory share whatever it builds, binds and writes, so the second result would not mean anything. Wait for it, or stop it.`,
    }
  }

  if (live.size >= MAX_LIVE) {
    const busy = [...live.values()].map((l) => l.run.suite).join(', ')
    return {
      ok: false,
      error: `this server runs at most ${MAX_LIVE} suites at once and both slots are busy (${busy}). The cap is deliberate — a page that could spawn without limit is a fork bomb with a button on it — so wait for one to finish, or stop one.`,
    }
  }

  /* Checked again, at the moment of the run. See the note at the top on why this
     is not redundant with the check `configure` already made. */
  if (!existsSync(found.dir) || !statSync(found.dir).isDirectory()) {
    return {
      ok: false,
      error: `"${name}" is configured to run in ${found.dir}, and that is not a directory on this machine any more. Nothing was started. Reconfigure the suite, or put the directory back.`,
    }
  }

  const ref = String(input.ref ?? '').slice(0, 64)
  const by = String(input.by ?? '').slice(0, 80) || 'somebody here'
  const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
  const run: Run = {
    id,
    suite: found.name,
    ref,
    startedAt: new Date().toISOString(),
    endedAt: null,
    verdict: 'running',
    exitCode: null,
    signal: null,
    passed: null,
    failed: null,
    tail: [],
    dropped: 0,
    by,
    /* Copied onto the run rather than looked up later. What was executed is a
       fact about this run, and a suite that is reconfigured tomorrow must not
       silently rewrite the history of what happened today. */
    command: [...found.command],
    dir: found.dir,
  }

  let child: ChildProcess
  try {
    /**
     * The line the whole module is arranged around.
     *
     * A program and an argv array, `shell: false`, a `cwd` that was validated
     * twice, and this process's environment. Nothing in this call is built by
     * concatenating anything: `found.command` came out of the store as an array
     * and goes to `spawn` as an array.
     *
     * `stdio: 'pipe'` because streaming the output IS the feature. `detached` for
     * the process group, per the note at the top.
     */
    child = spawn(found.command[0] as string, found.command.slice(1), {
      cwd: found.dir,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
  } catch (e) {
    /* `spawn` mostly reports failure on a later tick rather than throwing, so
       this branch is the rare synchronous one — an invalid argument, usually. The
       common "there is no such program" case lands in the `error` handler below,
       and both end as `crashed` with the message the operating system gave. */
    const dead: Run = { ...run, verdict: 'crashed', endedAt: new Date().toISOString(), tail: [String(e)] }
    record(dead)
    tell({ kind: 'ended', run: dead })
    return { ok: false, error: `"${name}" could not be started: ${e instanceof Error ? e.message : String(e)}` }
  }

  const state: Live = {
    run,
    child,
    counts: { ...NOTHING },
    lines: [],
    dropped: 0,
    ending: null,
    rest: { out: '', err: '' },
    killer: null,
    /**
     * The timeout, which is the bound that makes a run finite.
     *
     * It fires `timeout` rather than `failed`, and the distinction is not
     * pedantry: a hung suite and a red suite send a person to completely
     * different places, and a runner that called the first one a failure would
     * have somebody reading assertions that never executed.
     */
    timer: setTimeout(() => {
      end(id, 'timeout', `nothing finished within ${Math.round(found.timeoutMs / 1000)}s, so this run was killed.`)
    }, found.timeoutMs),
  }
  live.set(id, state)

  /* Written to disk BEFORE the first byte of output. A page that arrives
     mid-run has to be able to find out that something is going; discovering it
     only from the live stream would mean a page loaded one second too late
     reports that nothing was ever run. */
  record(run)
  tell({ kind: 'started', run })

  child.stdout?.on('data', (chunk: Buffer) => take(id, 'out', chunk))
  child.stderr?.on('data', (chunk: Buffer) => take(id, 'err', chunk))

  child.on('error', (e: Error) => {
    /* The ordinary "no such program" path. It arrives here and not from the
       `try` above, which is exactly the trap `launch.ts` warns about: a Start
       that reported success on the return of `spawn` would be reporting that
       nothing had gone wrong YET. */
    say(id, 'err', e.message)
    end(id, 'crashed', e.message)
  })

  child.on('close', (code, signal) => {
    const l = live.get(id)
    if (!l) return
    /* Both normalised to null. Bun hands `undefined` here on the path where a
       program did not exist at all, and the record on disk is schema-checked on
       every write — so an `undefined` would throw inside the write that settles
       the run, which is the one place a throw is least recoverable. */
    l.run.exitCode = code ?? null
    l.run.signal = signal ?? null
    /* A verdict we already decided — a timeout, a stop — wins over the exit code,
       because the exit code in those cases is our own SIGTERM reflected back and
       says nothing about the tests. */
    if (l.ending) return finish(id, l.ending)
    if (signal) return finish(id, 'crashed')
    finish(id, code === 0 ? 'passed' : 'failed')
  })

  return { ok: true, run }
}

/**
 * A chunk of output, turned into whole lines.
 *
 * Chunks are not lines: a child writing 8KB gets split wherever the pipe felt
 * like it, and a stream that forwarded chunks would show half a sentence, then
 * the other half prefixed as if it were new. So the remainder is held per stream
 * until its newline arrives.
 */
function take(id: string, stream: 'out' | 'err', chunk: Buffer): void {
  const l = live.get(id)
  if (!l) return
  const text = l.rest[stream] + chunk.toString('utf8')
  const parts = text.split('\n')
  /* The last piece has no newline yet, so it is not a line. */
  l.rest[stream] = parts.pop() ?? ''
  /* A child that writes an enormous amount without ever printing a newline
     would otherwise grow `rest` without bound. Cut it and treat it as a line;
     the mark says what happened. */
  if (l.rest[stream].length > MAX_LINE) {
    say(id, stream, `${l.rest[stream].slice(0, MAX_LINE)} …[cut: no newline]`)
    l.rest[stream] = ''
  }
  for (const line of parts) say(id, stream, line)
}

/** One line: held for a page that arrives later, folded into the counts, streamed. */
function say(id: string, stream: 'out' | 'err', raw: string): void {
  const l = live.get(id)
  if (!l) return
  const text = raw.length > MAX_LINE ? `${raw.slice(0, MAX_LINE)} …[cut]` : raw
  l.lines.push(text)
  if (l.lines.length > HOLD_LINES) {
    l.lines.shift()
    /* Counted rather than silently forgotten. "The last 200 lines of 4000" and
       "all 200 lines" look identical on screen unless somebody says which. */
    l.dropped += 1
  }
  const was = l.counts
  l.counts = fold(was, text)
  tell({ kind: 'line', id, stream, text })
  if (l.counts.passed !== was.passed || l.counts.failed !== was.failed) {
    /* Sent as it changes rather than only at the end, because watching the
       numbers move is the difference between a progress bar and a spinner. */
    tell({ kind: 'counts', id, passed: l.counts.passed, failed: l.counts.failed })
  }
}

/**
 * Ask a run to stop, for a reason.
 *
 * SIGTERM to the process GROUP first, then SIGKILL after a grace period, because
 * a test runner asked politely will usually tear down its own children and a
 * runner that will not needs to go anyway. The verdict is decided here and the
 * `close` handler honours it — see the note there about the exit code being our
 * own signal reflected back.
 */
export function end(id: string, verdict: Verdict, why: string): { ok: boolean; error?: string } {
  const l = live.get(id)
  if (!l) return { ok: false, error: 'that run is not going here — it has already finished, or it belonged to a server that has since been restarted.' }
  if (l.ending) return { ok: true }
  l.ending = verdict
  say(id, 'err', `— ${why}`)
  kill(l, 'SIGTERM')
  l.killer = setTimeout(() => {
    if (live.has(id)) kill(l, 'SIGKILL')
  }, GRACE_MS)
  return { ok: true }
}

function kill(l: Live, signal: 'SIGTERM' | 'SIGKILL'): void {
  const pid = l.child.pid
  if (!pid) return
  try {
    /* The GROUP, not the pid. `detached: true` gave the child one of its own, and
       a test runner's children are the whole reason this matters. */
    process.kill(-pid, signal)
  } catch {
    /* Already gone, or never there. Both are fine: the `close` handler is what
       actually settles the run, and it will fire either way. */
  }
}

/** Settle a run: write it down, tell everybody, stop holding it. */
function finish(id: string, verdict: Verdict): void {
  const l = live.get(id)
  if (!l) return
  clearTimeout(l.timer)
  if (l.killer) clearTimeout(l.killer)
  /* Whatever was written without a trailing newline is still output. */
  for (const stream of ['out', 'err'] as const) {
    if (l.rest[stream]) {
      const text = l.rest[stream]
      l.rest[stream] = ''
      l.lines.push(text)
      l.counts = fold(l.counts, text)
    }
  }
  const done: Run = {
    ...l.run,
    verdict,
    endedAt: new Date().toISOString(),
    passed: l.counts.passed,
    failed: l.counts.failed,
    tail: l.lines.slice(-KEEP_LINES),
    dropped: l.dropped,
  }
  live.delete(id)
  record(done)
  tell({ kind: 'ended', run: done })
  for (const w of waiting.get(id) ?? []) w(done)
  waiting.delete(id)
}

/**
 * Everything waiting to be told one run is over.
 *
 * An MCP client is not a browser and has no stream. An agent that asked to run
 * the tests wants the verdict, not a receipt — so `run_suite` can wait, and this
 * is what it waits on. Bounded by the caller rather than here: the wait is the
 * agent's patience, and the run's own timeout is what bounds the run.
 */
const waiting = new Map<string, ((run: Run) => void)[]>()

export function waitFor(id: string, ms: number): Promise<Run | null> {
  if (!live.has(id)) return Promise.resolve(null)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const list = waiting.get(id)?.filter((f) => f !== onDone)
      if (list?.length) waiting.set(id, list)
      else waiting.delete(id)
      resolve(null)
    }, ms)
    const onDone = (run: Run) => {
      clearTimeout(timer)
      resolve(run)
    }
    waiting.set(id, [...(waiting.get(id) ?? []), onDone])
  })
}

/**
 * Kill everything on the way out.
 *
 * Registered by `vite.config.ts` on this process's signals. Without it, stopping
 * the dev server with Ctrl-C leaves a detached test runner and its children
 * behind — which is precisely the thing `detached` is otherwise good for, and
 * precisely the thing that must not happen to somebody who thought they had
 * closed the app.
 */
export function stopAll(): void {
  for (const id of [...live.keys()]) end(id, 'stopped', 'this server is shutting down.')
  for (const l of live.values()) kill(l, 'SIGKILL')
}
