import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ID } from '../manifest.ts'
/* `ago` comes from its own file and `Standing` is a TYPE. That split is
   load-bearing: `runs/store.ts` imports `node:fs`, so a value imported from it
   would be pulled into this bundle and throw on evaluation, leaving a page that
   loads, renders nothing, and never answers the host. See `runs/ago.ts`. */
import { ago } from '../runs/ago.ts'
import type { Standing } from '../runs/store.ts'

import { kinds, type Kind } from '@/live/kind.ts'
import { run as startRun, standings, stop as stopRun, type Live } from '@/store/ask.ts'
import { useRuns } from '@/store/use-runs.ts'
import { useRoadmap, type GotoHandler } from '@/wire/use-roadmap.ts'
import { Log } from '@/view/log.tsx'
import { gloss, Mark, RunLine } from '@/view/verdict.tsx'

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
 * - A reference with no runs gets a **sentence**, not a mark: nothing has been
 *   run against it, that is not a pass and not a failure, and nobody has asked.
 *   Drawing it as red would train a reader to ignore red; drawing it as green
 *   would be a lie of exactly the kind this module exists to prevent.
 * - A run in progress is `running` and is never rounded to a verdict.
 * - `timeout`, `stopped` and `crashed` are each their own word with their own
 *   gloss, because a hung suite, an abandoned one and a missing binary send a
 *   person to three different places, and calling any of them `failed` would send
 *   them to a fourth that has nothing for them.
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

  return (
    <div className="app" ref={shell}>
      {framed ? null : (
        <header>
          <h1 className="title">Tests</h1>
          <p className="said">
            How this project is tested, and what was actually run against a change. The suites are configured over this
            app’s own MCP door — a name, an argument array and a directory — and the runs happen in this process, on this
            machine. Nothing here reads a tracker or a CI pipeline: what is recorded is what this program ran.
          </p>
        </header>
      )}

      {state?.trouble ? <p className="trouble">{state.trouble}</p> : null}

      {/*
        Whether the page is actually live, said rather than implied.

        A page whose stream has dropped and which went on drawing a still,
        blue "running" would be claiming to be watching something it is not.
        `EventSource` reconnects on its own, so this is usually a flicker; when
        it is not, the reader needs to know that what they are looking at has
        stopped moving.
      */}
      {busy || !connected ? (
        <p className="said">
          {connected
            ? `Watching live. ${busy} of ${state?.slots ?? 0} run slots busy.`
            : 'The live stream is not attached, so what is on screen may have stopped moving. It reconnects by itself.'}
        </p>
      ) : null}

      {standing.length ? (
        <>
          <p className="said">
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
              <div className="card" key={l.run.id}>
                <RunLine run={l.run} ago={ago(l.run.startedAt)} />
                <p className="said">Not run for any particular reference.</p>
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
    <div className="card" data-ref={standing.ref}>
      <div className="row">
        <span className="ref">{standing.ref}</span>
        <span className="said">{kind ?? 'reference'}</span>
      </div>

      {!standing.runs.length && !live.length ? (
        /* The sentence the whole module is for. Not a mark, not a colour, and
           emphatically not a cross: nobody has asked, which is neither a pass nor
           a failure. */
        <p className="said">
          Nothing has been run against this on this machine. That is not a pass and not a failure — nobody has asked.
        </p>
      ) : null}

      {all.length ? (
        all.map((name) => {
          const run = newest.get(name)
          const now = going.get(name)
          const said = trouble[`${standing.ref}|${name}`]
          return (
            <div className="suite" key={name}>
              <div className="suite-head">
                <div className="row">
                  <Mark verdict={now ? 'running' : (run?.verdict ?? 'none')} />
                  <span className="ref">{name}</span>
                  {gone.includes(name) ? <span className="said">no longer configured</span> : null}
                </div>
                {gone.includes(name) ? null : (
                  <button onClick={() => onRun(name)} disabled={Boolean(now)}>
                    {now ? 'running…' : run ? 'run again' : 'run'}
                  </button>
                )}
              </div>

              {now ? (
                <>
                  <p className={`said verdict v-running`}>
                    running · started {ago(now.run.startedAt)} ago by {now.run.by}
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
                  <RunLine run={run} ago={ago(run.startedAt)} />
                  {gloss(run) ? <p className="said">{gloss(run)}</p> : null}
                  {run.verdict === 'failed' || run.verdict === 'timeout' || run.verdict === 'crashed' ? (
                    <Log lines={run.tail.slice(-30)} dropped={run.dropped} />
                  ) : null}
                </>
              ) : (
                <p className="said">not run against this reference</p>
              )}

              {said ? <p className="trouble">{said}</p> : null}
            </div>
          )
        })
      ) : (
        <p className="said">No suites are configured on this machine, so there is nothing that could be run.</p>
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
 * four minutes for a suite would rather not lose it to one stray click.
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
      <div className="buttons">
        <button className="danger" onClick={onAsk} data-stop={id}>
          stop
        </button>
      </div>
    )
  }
  return (
    <div className="buttons">
      <span className="said">Stop it? Nothing will be learned about the code.</span>
      <button className="danger" onClick={onConfirm} data-stop-confirm={id}>
        yes, stop
      </button>
      <button onClick={onCancel}>keep going</button>
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
        <div>
          <p className="said">
            Something has been run against {refs.length === 1 ? 'one reference' : `${refs.length} references`}. Open one
            here without a canvas:
          </p>
          <div className="buttons">
            {refs.map((ref) => (
              <button key={ref} onClick={() => onPick(ref)} data-pick={ref}>
                {ref}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="card">
        <p className="title">How this project is tested</p>
        {state.suites.length ? (
          state.suites.map((s) => (
            <div className="suite" key={s.name}>
              <div className="suite-head">
                <span className="ref">{s.name}</span>
                <button onClick={() => onRun(s.name)} data-run={s.name}>
                  run
                </button>
              </div>
              <p className="said">{s.what}</p>
              <p className="cmd">{s.command.join(' ')}</p>
              <p className="cmd">
                in {s.dir} · killed after {Math.round(s.timeoutMs / 1000)}s · configured by {s.by}
              </p>
              {trouble[`|${s.name}`] ? <p className="trouble">{trouble[`|${s.name}`]}</p> : null}
            </div>
          ))
        ) : (
          <p className="said">
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
  return <p className="said">{said}</p>
}
