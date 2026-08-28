import type { Run, Verdict as Word } from '../../runs/store.ts'

import { Badge } from '@/components/ui/badge.tsx'

/**
 * A verdict, drawn as a shadcn badge.
 *
 * ## Seven words, and the word is never dropped
 *
 * Six verdicts plus `none`, each with its own badge variant, and each one always
 * carrying its name in text. The dot is a fast channel and the word is the only
 * one everybody can read: colour alone is a claim a person with any kind of
 * colour blindness cannot make out, and a page whose entire purpose is telling
 * "not run" from "passed" from "we do not know" cannot afford to say the
 * distinction in hue only.
 *
 * ## `running` is not a seventh terminal state
 *
 * The other six are things that HAPPENED. `running` is a process that is alive
 * right now, and the page has to read as live rather than as having reached a
 * blue conclusion. So it is the only badge with a ring and the only thing on the
 * page that moves — the dot breathes, on a keyframe declared in `index.css`, and
 * stops dead under `prefers-reduced-motion`. Nothing else animates, because a
 * pulse beside a finished verdict would be a claim that something is still
 * happening.
 *
 * ## `none` is the one that matters most
 *
 * A reference nothing has been run against is NOT a failure and must not be
 * drawn as one — and it is not a pass either, which is the easier mistake to
 * make in a redesign. It gets the quietest thing on the page: a dashed, muted
 * badge that says the words "not run", never a tick and never a cross. And the
 * badge is never the whole answer. The card prints the sentence in full beside
 * it, because a chip is a thing a reader skims and this is the sentence the
 * module exists to say. See `RefCard` in `src/app.tsx`.
 */
export function Verdict({ verdict, className }: { verdict: Word | 'none'; className?: string }) {
  return (
    <Badge variant={verdict} className={className}>
      <span
        aria-hidden="true"
        className={`inline-block size-1.5 shrink-0 rounded-[1px] bg-current${verdict === 'running' ? ' tests-live-dot' : ''}`}
      />
      {verdict === 'none' ? 'not run' : verdict}
    </Badge>
  )
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

/**
 * The one-line reading of a run, with the verdict named.
 *
 * `flex-wrap` and `min-w-0` rather than a grid: a suite name and a "by" are both
 * arbitrary strings, and at 220 pixels the honest thing for them to do is wrap
 * onto a second line rather than push the pane wider than its frame.
 */
export function RunLine({ run, ago }: { run: Run; ago: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1">
      <Verdict verdict={run.verdict} />
      <span className="font-mono text-xs font-semibold">{run.suite}</span>
      <span className="text-[11px] leading-tight text-muted-foreground">
        {run.verdict === 'running' ? `started ${ago} ago by ${run.by}` : `${counted(run)} · ${ago} ago · ${run.by}`}
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
