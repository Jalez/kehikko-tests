import type { Run, Verdict } from '../../runs/store.ts'

/**
 * A verdict, drawn.
 *
 * ## Seven words, and the word is never dropped
 *
 * Six verdicts plus `none`, each with its own colour, and each one always
 * accompanied by its name in text. The square is a fast channel and the word is
 * the only one everybody can read: colour alone is a claim a person with any
 * kind of colour blindness cannot make out, and a page whose entire purpose is
 * telling "not run" from "passed" from "we do not know" cannot afford to say the
 * distinction in hue only.
 *
 * `none` is the one that is easiest to get wrong and matters most. A reference
 * nothing has been run against is NOT a failure and must not be drawn as one; it
 * gets the quietest colour on the page and a sentence rather than a mark, so that
 * red keeps meaning something.
 */
export function Mark({ verdict }: { verdict: Verdict | 'none' }) {
  return <span className={`mark m-${verdict}`} aria-hidden="true" />
}

/**
 * The counts, in the three states they actually have.
 *
 * `null` is not zero. A runner whose output this app could not parse has told us
 * nothing about how many tests ran, and "0 passed" under a suite that ran two
 * hundred successfully is a worse lie than silence, because a reader cannot tell
 * a parse failure from a real result. So the words say which.
 */
export function counted(run: Run): string {
  if (run.passed === null && run.failed === null) return 'its output did not say how many'
  const passed = run.passed ?? 0
  const failed = run.failed ?? 0
  return `${passed} passed, ${failed} failed`
}

/** The one-line reading of a run, with the verdict named. */
export function RunLine({ run, ago }: { run: Run; ago: string }) {
  return (
    <div className="row runline">
      <Mark verdict={run.verdict} />
      <span className={`verdict v-${run.verdict}`}>{run.verdict}</span>
      <span className="ref">{run.suite}</span>
      <span className="said">
        {run.verdict === 'running'
          ? `started ${ago} ago by ${run.by}`
          : `${counted(run)} · ${ago} ago · ${run.by}`}
      </span>
    </div>
  )
}

/**
 * What a verdict MEANS, for the four that are not self-explanatory.
 *
 * `passed` and `failed` need no gloss. The other four do, and leaving them
 * unglossed is how a hung suite gets read as a broken one: a person seeing
 * `timeout` with no explanation reasonably assumes the tests said no, and goes
 * looking for an assertion that never ran.
 */
export function gloss(run: Run): string | null {
  if (run.verdict === 'timeout') {
    return 'This app killed it for exceeding the suite’s own time bound. It hung — nothing was asserted, so this is not the tests saying no.'
  }
  if (run.verdict === 'stopped') return 'Somebody stopped it. Nothing was learned about the code either way.'
  if (run.verdict === 'crashed') {
    return 'The process could not be started, or something outside this app killed it — including this server itself being restarted mid-run. Not a test failure.'
  }
  if (run.verdict === 'running') return null
  return null
}
