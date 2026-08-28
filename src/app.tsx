import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ID } from '../manifest.ts'
/* `ago` comes from its own file and `Standing` is a TYPE. That split is
   load-bearing: `runs/store.ts` imports `node:fs`, so a value imported from it
   would be pulled into this bundle and throw on evaluation, leaving a page that
   loads, renders nothing, and never answers the host. See `runs/ago.ts`. */
import { ago } from '../runs/ago.ts'
import type { Standing } from '../runs/store.ts'

import { Button } from '@/components/ui/button.tsx'
import { kinds, type Kind } from '@/live/kind.ts'
import { run as startRun, standings, stop as stopRun, type Live } from '@/store/ask.ts'
import { useRuns } from '@/store/use-runs.ts'
import { useRoadmap, type GotoHandler } from '@/wire/use-roadmap.ts'
import { Log } from '@/view/log.tsx'
import { counted, gloss, RunLine, Verdict } from '@/view/verdict.tsx'

/**
 * The page.
 *
 * ## What it shows, and the sentence that decides it
 *
 * > "kind of like a checklist but with tests statistics for each mr/pr"
 *
 * So there are two states and the selection decides which. With references
 * picked out, this page draws each of them with what has been run against it —
 * the newest run of every suite, its verdict, its counts and when — and a button
 * per suite to run it FOR that reference. With nothing picked, it draws how this
 * project is tested, which is material this app holds and is worth reading on
 * its own.
 *
 * ## The three answers, kept apart, which is the whole job
 *
 * "not run", "passed" and "we do not know" are three different things.
 *
 * - A reference with no runs gets a **sentence**, not just a mark: nothing has
 *   been run against it, that is not a pass and not a failure, and nobody has
 *   asked. Drawing it as red would train a reader to ignore red; drawing it as
 *   green would be a lie of exactly the kind this module exists to prevent; and
 *   drawing it as a quiet grey chip and nothing else — which is what a redesign
 *   reaches for — is the same lie said more politely, because a reader skims a
 *   grey chip as "no problem here". The badge says "not run" and the sentence
 *   below it says why that is not an answer. Both, always.
 * - A run in progress is `running` and is never rounded to a verdict.
 * - `timeout`, `stopped` and `crashed` are each their own word with their own
 *   gloss, because a hung suite, an abandoned one and a missing binary send a
 *   person to three different places, and calling any of them `failed` would send
 *   them to a fourth that has nothing for them.
 *
 * ## Everything measures the PANE
 *
 * There is not a viewport breakpoint in this file. The one responsive rule is
 * `@min-[300px]/pane:`, which asks the container declared on `<body>` how wide
 * IT is — see the essay in `index.css`. A `sm:` here would be true on every
 * monitor this app will ever be opened on and would lay a 220-pixel column out
 * as though it were a page.
 *
 * ## Identity is printed only when nothing is framing this page
 *
 * A host prints the module's name in the pane header and hangs the manifest's
 * `summary` off it. A page that also printed "Tests" at the top of itself would
 * be saying the name twice and spending a fixed strip of a 340-pixel-tall pane on
 * the repetition. Unframed there is no pane header and nothing else would ever
 * say what this program is, so the heading stays. The test is
 * `window.parent !== window`, which is answerable before first paint and
 * therefore does not blink.
 */
const framed = typeof window !== 'undefined' && window.parent !== window

/** Muted prose, which is most of what this page says. One spelling, used everywhere. */
const SAID = 'text-[11px] leading-tight text-muted-foreground'
/** A name the app holds verbatim: a ref, a suite. Monospace, because it is a key rather than a word. */
const NAME = 'font-mono text-xs font-semibold'
/** A refusal, kept beside whatever caused it. */
const TROUBLE = 'border-l-2 border-failed pl-1.5 text-[11px] leading-tight text-failed'
/** A card. `min-w-0` because everything inside it can hold an absolute path. */
const CARD = 'flex min-w-0 flex-col gap-1.5 rounded-md border bg-card p-2'

export function App() {
  /**
   * References picked here rather than on a canvas.
   *
   * This app works with nothing else running, and "nothing else running" is
   * exactly when there is no selection to react to. So the refs it already has
   * runs against are offered as buttons. It is deliberately NOT merged with
   * `selection`: a canvas selection is a fact about the canvas that this page
   * reports, and a local pick is this page's own. When the host says something,
   * the host wins and this is cleared — otherwise a stale local pick would sit
   * under a canvas that had moved on, with no way for a reader to tell them
   * apart.
   */
  const [picked, setPicked] = useState<string[]>([])
  const [standing, setStanding] = useState<Standing[]>([])
  /** A refusal, kept beside the button that caused it rather than at the top. */
  const [trouble, setTrouble] = useState<Record<string, string>>({})
  /** Which run a reader has asked to stop and not yet confirmed. See `Stop` below. */
  const [confirming, setConfirming] = useState<string | null>(null)

  const { state, live, connected, ended } = useRuns()

  const onGoto = useCallback<GotoHandler>((message, answer) => {
    /* A `goto` may name an epic, a step, or a reference, and only the last of
       those is a thing this pane draws. Answering "not found" for the other two
       is the honest reply rather than a failure: this page has no epic of its own
       to move to and no steps at all. Saying so quickly is what gets the reader
       the host's fallback link instead of a twelve-second wait. */
    const ref = message.ref
    if (!ref) {
      answer(false, 'This pane shows what has been run against references, so there is nothing here to walk to by epic or step.')
      return
    }
    const card = document.querySelector(`[data-ref="${CSS.escape(ref)}"]`)
    if (!card) {
      answer(false, 'This pane is showing what the canvas has selected, and that reference is not among them.')
      return
    }
    card.scrollIntoView({ block: 'start', behavior: 'smooth' })
    answer(true, '')
  }, [])

  const { sight, selection, resize } = useRoadmap(ID, onGoto)

  /* The host's selection wins the moment there is one — and the guard is not
     tidiness. `selection` is a fresh array on every context, and the host sends a
     context after every selection change anywhere on the canvas, so an
     unconditional `setPicked([])` would set state on every one of them and
     refetch every standing, triggered by exactly the event this page is supposed
     to be quietly reacting to. It only writes when there is something to clear. */
  useEffect(() => {
    if (selection.length) setPicked((was) => (was.length ? [] : was))
  }, [selection])

  /**
   * The references to draw, memoised on their SPELLING rather than on the arrays.
   *
   * `selection` is a new array every context even when it names the same three
   * refs, so a memo keyed on the array identity is no memo at all — and
   * everything downstream of this, including the fetch, would fire on every
   * context. The joined key is the honest dependency: what this page cares about
   * is which references are picked, not which array carried them.
   */
  const key = (selection.length ? selection : picked).join(' ')
  const refs = useMemo(() => (key ? key.split(' ') : []), [key])

  /**
   * What this app has recorded against each picked reference.
   *
   * Refetched when the set of refs changes, and again whenever a run ENDS — that
   * second dependency is what makes the card repaint itself the moment a suite
   * goes green without the reader touching anything. It is keyed on the number of
   * ended runs rather than on the array, for the same reason `refs` is keyed on
   * a string: a new array every render would make this fire forever.
   *
   * `alive` rather than an AbortController, because what must not happen is a
   * slower earlier answer painting over a newer one; cancelling the request
   * itself buys nothing on a loopback GET.
   */
  const endedCount = ended.length
  useEffect(() => {
    if (!refs.length) {
      setStanding([])
      return
    }
    let alive = true
    void standings(refs)
      .then((rows) => {
        if (alive) setStanding(rows)
      })
      .catch(() => {
        if (alive) setStanding([])
      })
    return () => {
      alive = false
    }
  }, [refs, endedCount])

  /**
   * What each selected reference IS, where the host's reading says.
   *
   * Enrichment and nothing more — see `live/kind.ts`. Where this is empty the
   * page says "reference", which is true and slightly less useful, and every
   * other thing on the page works identically.
   */
  const kindOf = useMemo(() => (sight.at === 'read' ? kinds(sight.live) : new Map<string, Kind>()), [sight])

  /** Say how tall we would like to be, whenever what is drawn changes size. */
  const shell = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = shell.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(() => resize(Math.ceil(node.getBoundingClientRect().height) + 16))
    watch.observe(node)
    return () => watch.disconnect()
  })

  const press = useCallback(async (suite: string, ref: string) => {
    const answer = await startRun(suite, ref)
    setTrouble((was) => ({ ...was, [`${ref}|${suite}`]: answer.ok ? '' : answer.error }))
  }, [])

  const liveFor = useCallback((ref: string) => live.filter((l) => l.run.ref === ref), [live])

  const suites = state?.suites ?? []
  const busy = live.length
  const slots = state?.slots ?? 0
  /**
   * Whether the next press will be refused, worked out BEFORE it is pressed.
   *
   * Two runs at a time is the whole of this app's concurrency, and the server
   * enforces it with a sentence. A page that let the third press look identical
   * to the first two and then printed a refusal beside one of them would be
   * teaching a reader that Run sometimes does nothing — which is the single
   * worst thing a button that starts a process can teach. So the cap is said out
   * loud while it is full, in the same place the live count is said, and the
   * press is still allowed: a slot can free between the render and the click,
   * and a button disabled on a stale count is its own kind of lie.
   */
  const full = slots > 0 && busy >= slots

  return (
    <div className="flex flex-col gap-2 p-2" ref={shell}>
      {framed ? null : (
        <header className="flex flex-col gap-1">
          <h1 className="text-[13px] font-semibold">Tests</h1>
          <p className={SAID}>
            How this project is tested, and what was actually run against a change. The suites are configured over this
            app’s own MCP door — a name, an argument array and a directory — and the runs happen in this process, on this
            machine. Nothing here reads a tracker or a CI pipeline: what is recorded is what this program ran.
          </p>
        </header>
      )}

      {state?.trouble ? <p className={TROUBLE}>{state.trouble}</p> : null}

      {/*
        Whether the page is actually live, said rather than implied, and what
        the run slots are doing.

        A page whose stream has dropped and which went on drawing a still,
        pulsing "running" would be claiming to be watching something it is not.
        `EventSource` reconnects on its own, so this is usually a flicker; when
        it is not, the reader needs to know that what they are looking at has
        stopped moving.
      */}
      {busy || !connected ? (
        <div className={`flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 ${SAID}`}>
          {connected ? (
            <>
              <Verdict verdict="running" />
              <span>
                Watching live. {busy} of {slots} run {slots === 1 ? 'slot' : 'slots'} busy.
                {full ? ' Both are taken, so starting another suite will be refused until one finishes.' : ''}
              </span>
            </>
          ) : (
            <span className="text-failed">
              The live stream is not attached, so what is on screen may have stopped moving. It reconnects by itself.
            </span>
          )}
        </div>
      ) : null}

      {standing.length ? (
        <>
          <p className={SAID}>
            {selection.length
              ? `${standing.length === 1 ? 'One reference is' : `${standing.length} references are`} selected on the canvas.`
              : `Showing ${standing.length === 1 ? 'a reference' : `${standing.length} references`} you picked here. Selecting on a canvas replaces this.`}
          </p>
          {standing.map((s) => (
            <RefCard
              key={s.ref}
              standing={s}
              kind={kindOf.get(s.ref) ?? null}
              suites={suites.map((x) => x.name)}
              live={liveFor(s.ref)}
              trouble={trouble}
              onRun={(suite) => void press(suite, s.ref)}
              onStop={(id) => setConfirming(id)}
              confirming={confirming}
              onConfirm={(id) => {
                setConfirming(null)
                void stopRun(id)
              }}
              onCancel={() => setConfirming(null)}
            />
          ))}
        </>
      ) : (
        <>
          <Sightline sight={sight} hasSuites={suites.length > 0} />
          {/* Runs going with no reference attached: somebody pressed Run on the
              bare list, or an agent ran a suite without saying what for. They are
              drawn rather than hidden, because a process this app started that
              appears nowhere on its own page is the worst thing this page could
              do. */}
          {live
            .filter((l) => !l.run.ref)
            .map((l) => (
              <div className={CARD} key={l.run.id}>
                <RunLine run={l.run} ago={ago(l.run.startedAt)} />
                <p className={SAID}>Not run for any particular reference.</p>
                <Log lines={l.lines} dropped={l.dropped} />
                <Stop
                  id={l.run.id}
                  confirming={confirming === l.run.id}
                  onAsk={() => setConfirming(l.run.id)}
                  onConfirm={() => {
                    setConfirming(null)
                    void stopRun(l.run.id)
                  }}
                  onCancel={() => setConfirming(null)}
                />
              </div>
            ))}
          <SuiteList
            state={state}
            onRun={(suite) => void press(suite, '')}
            trouble={trouble}
            onPick={(ref) => setPicked([ref])}
          />
        </>
      )}
    </div>
  )
}

/**
 * One reference, and what has been run against it.
 *
 * Every configured suite gets a row, whether or not it has ever been run here.
 * That is the checklist half of the brief: a list of what SHOULD have been run
 * beside what was, so that a suite nobody has run against this change is visible
 * as an absence rather than being missing from the page. A suite with a run and
 * a suite without one are drawn with the same weight and different words.
 */
export function RefCard({
  standing,
  kind,
  suites,
  live,
  trouble,
  onRun,
  onStop,
  confirming,
  onConfirm,
  onCancel,
}: {
  standing: Standing
  kind: Kind | null
  suites: string[]
  live: Live[]
  trouble: Record<string, string>
  onRun: (suite: string) => void
  onStop: (id: string) => void
  confirming: string | null
  onConfirm: (id: string) => void
  onCancel: () => void
}) {
  const newest = new Map(standing.bySuite.map((r) => [r.suite, r]))
  const going = new Map(live.map((l) => [l.run.suite, l]))
  /* Suites that have runs here but are no longer configured. Kept, because "the
     unit suite failed against this on Tuesday" is a fact about Tuesday and does
     not stop being one when somebody deletes the suite. */
  const gone = standing.bySuite.filter((r) => !suites.includes(r.suite)).map((r) => r.suite)
  const all = [...suites, ...gone]

  return (
    <div className={CARD} data-ref={standing.ref}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1">
        <span className={NAME}>{standing.ref}</span>
        <span className={SAID}>{kind ?? 'reference'}</span>
      </div>

      {!standing.runs.length && !live.length ? (
        /* The sentence the whole module is for. Not a mark, not a colour, and
           emphatically not a cross: nobody has asked, which is neither a pass nor
           a failure. It is prose rather than a chip on purpose — see the essay at
           the top of this file. */
        <p className={SAID}>
          Nothing has been run against this on this machine. That is not a pass and not a failure — nobody has asked.
        </p>
      ) : null}

      {all.length ? (
        all.map((name) => {
          const run = newest.get(name)
          const now = going.get(name)
          const said = trouble[`${standing.ref}|${name}`]
          return (
            <div className="flex min-w-0 flex-col gap-1 border-t pt-1.5" key={name}>
              {/*
                Name on the left, Run on the right — but only once the pane is
                wide enough for that to be true. Under about 300 pixels the
                button ends up alone on a line of its own anyway, and a
                `justify-between` row that has wrapped leaves a gap that reads as
                a mistake. The query measures the PANE, not the monitor.
              */}
              <div className="flex min-w-0 flex-col gap-1 @min-[300px]/pane:flex-row @min-[300px]/pane:items-baseline @min-[300px]/pane:justify-between">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1">
                  <Verdict verdict={now ? 'running' : (run?.verdict ?? 'none')} />
                  <span className={NAME}>{name}</span>
                  {gone.includes(name) ? <span className={SAID}>no longer configured</span> : null}
                </div>
                {gone.includes(name) ? null : (
                  <Button
                    variant="outline"
                    size="pane"
                    className="self-start"
                    onClick={() => onRun(name)}
                    disabled={Boolean(now)}
                    data-run={name}
                  >
                    {now ? 'running…' : run ? 'run again' : 'run'}
                  </Button>
                )}
              </div>

              {now ? (
                <>
                  <p className={SAID}>
                    started {ago(now.run.startedAt)} ago by {now.run.by}
                    {now.run.passed === null && now.run.failed === null
                      ? ''
                      : ` · ${now.run.passed ?? 0} passed, ${now.run.failed ?? 0} failed so far`}
                  </p>
                  <Log lines={now.lines} dropped={now.dropped} />
                  <Stop
                    id={now.run.id}
                    confirming={confirming === now.run.id}
                    onAsk={() => onStop(now.run.id)}
                    onConfirm={() => onConfirm(now.run.id)}
                    onCancel={onCancel}
                  />
                </>
              ) : run ? (
                <>
                  {/* The verdict is already named by the badge in the head of
                      this row, so this line carries only what the badge cannot:
                      how many, how long ago, and who asked. Printing the word a
                      second time is how a 220-pixel row ends up saying "passed"
                      twice and nothing else. */}
                  <p className={SAID}>
                    {counted(run)} · {ago(run.startedAt)} ago · {run.by}
                  </p>
                  {gloss(run) ? <p className={SAID}>{gloss(run)}</p> : null}
                  {run.verdict === 'failed' || run.verdict === 'timeout' || run.verdict === 'crashed' ? (
                    <Log lines={run.tail.slice(-30)} dropped={run.dropped} />
                  ) : null}
                </>
              ) : (
                <p className={SAID}>not run against this reference</p>
              )}

              {said ? <p className={TROUBLE}>{said}</p> : null}
            </div>
          )
        })
      ) : (
        <p className={SAID}>No suites are configured on this machine, so there is nothing that could be run.</p>
      )}
    </div>
  )
}

/**
 * Stopping a run, confirmed inline.
 *
 * There is no `confirm()` here and there cannot be. A host frames this page in a
 * sandbox WITHOUT `allow-modals`, and in that sandbox `confirm()` does not
 * prompt: it returns `false` silently. So a confirmation written that way would
 * make the button do nothing at all, framed, while working perfectly when the
 * page is opened directly — which is the worst possible distribution of a bug.
 * The two-press version below behaves identically in both places.
 *
 * It is confirmed at all because stopping is destructive in a quiet way: the run
 * ends as `stopped`, which is honestly not a verdict, and somebody who has waited
 * four minutes for a suite would rather not lose it to one stray click. The
 * `destructive` variant is the first half of saying so and the second press is
 * the second.
 */
function Stop({
  id,
  confirming,
  onAsk,
  onConfirm,
  onCancel,
}: {
  id: string
  confirming: boolean
  onAsk: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!confirming) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        <Button variant="destructive" size="pane" onClick={onAsk} data-stop={id}>
          stop
        </Button>
      </div>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className={`w-full ${SAID}`}>Stop it? Nothing will be learned about the code.</span>
      <Button variant="destructive" size="pane" onClick={onConfirm} data-stop-confirm={id}>
        yes, stop
      </Button>
      <Button variant="outline" size="pane" onClick={onCancel}>
        keep going
      </Button>
    </div>
  )
}

/**
 * How this project is tested, which is what the page shows with nothing picked.
 *
 * The exact command and the exact directory are printed, in full. That is
 * deliberate and it is the counterpart of the security argument in
 * `suites/store.ts`: the only reason it is safe for this app to spawn anything is
 * that everything it will spawn was written down in advance, so the page has to
 * be the place a person can read what that is without opening a JSON file.
 */
function SuiteList({
  state,
  onRun,
  trouble,
  onPick,
}: {
  state: ReturnType<typeof useRuns>['state']
  onRun: (suite: string) => void
  trouble: Record<string, string>
  onPick: (ref: string) => void
}) {
  if (!state) return null
  const refs = state.refs.filter(Boolean)
  return (
    <>
      {refs.length ? (
        <div className="flex flex-col gap-1.5">
          <p className={SAID}>
            Something has been run against {refs.length === 1 ? 'one reference' : `${refs.length} references`}. Open one
            here without a canvas:
          </p>
          <div className="flex flex-wrap gap-1">
            {refs.map((ref) => (
              <Button variant="outline" size="pane" className="font-mono" key={ref} onClick={() => onPick(ref)} data-pick={ref}>
                {ref}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <div className={CARD}>
        <p className="text-[13px] font-semibold">How this project is tested</p>
        {state.suites.length ? (
          state.suites.map((s) => (
            <div className="flex min-w-0 flex-col gap-1 border-t pt-1.5" key={s.name}>
              <div className="flex min-w-0 flex-col gap-1 @min-[300px]/pane:flex-row @min-[300px]/pane:items-baseline @min-[300px]/pane:justify-between">
                <span className={NAME}>{s.name}</span>
                <Button variant="outline" size="pane" className="self-start" onClick={() => onRun(s.name)} data-run={s.name}>
                  run
                </Button>
              </div>
              <p className={SAID}>{s.what}</p>
              <p className="font-mono text-[10.5px] text-muted-foreground [overflow-wrap:anywhere]">{s.command.join(' ')}</p>
              <p className="font-mono text-[10.5px] text-muted-foreground [overflow-wrap:anywhere]">
                in {s.dir} · killed after {Math.round(s.timeoutMs / 1000)}s · configured by {s.by}
              </p>
              {trouble[`|${s.name}`] ? <p className={TROUBLE}>{trouble[`|${s.name}`]}</p> : null}
            </div>
          ))
        ) : (
          <p className={SAID}>
            Nothing has been configured on this machine. This app does not guess how a project is tested and will not
            run anything it was not told about — an agent says so over this app’s MCP door, with a name, an argument
            array and a directory, and then there is something here to run.
          </p>
        )}
      </div>
    </>
  )
}

/**
 * What this page can currently see of a host, in words, when nothing is picked.
 *
 * Six sentences for six states, and they are six because they send a reader to
 * six different places. None of them is a spinner: `listening` says what it is
 * waiting for and lasts under a second.
 *
 * Every one of them ends the same way, and that is the important part — the host
 * being absent, silent or refusing changes NOTHING about this module except
 * whether it can name the kind of a reference. The suites and the runs are this
 * app's own.
 */
function Sightline({ sight, hasSuites }: { sight: ReturnType<typeof useRoadmap>['sight']; hasSuites: boolean }) {
  const tail = hasSuites
    ? ' The suites below are this app’s own and run with nothing else here.'
    : ' Nothing is configured yet either, so there is nothing to run.'
  const said =
    sight.at === 'listening'
      ? 'Waiting to hear whether anything is framing this page.'
      : sight.at === 'unhosted'
        ? `Nothing is framing this page, so nothing has said which reference to show runs for.${tail}`
        : sight.at === 'no-epic'
          ? `A host is here and no epic is open, so there is nothing selected to show runs against.${tail}`
          : sight.at === 'asking'
            ? `Asking the host what it last read about ${sight.epic}, to learn what kind of thing each reference is.`
            : sight.at === 'refused'
              ? `The host was asked about ${sight.epic} and said no: ${sight.refusal.error} Selected references will be called “reference” rather than named as issues or pull requests; everything else works.${tail}`
              : sight.at === 'unread'
                ? `The host has no reading for ${sight.epic}, so a selected reference will be called “reference” rather than named as an issue or a pull request. Everything else works.${tail}`
                : `Nothing is selected on the canvas. Pick a reference and this pane shows what has been run against it.${tail}`
  return <p className={SAID}>{said}</p>
}
