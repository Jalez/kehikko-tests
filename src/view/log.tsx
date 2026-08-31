import { useEffect, useRef } from 'react'

/**
 * The output of a run, as it arrives.
 *
 * ## Sticky, but only while the reader is at the bottom
 *
 * A log that always scrolls to the newest line is a log nobody can read a
 * failure in: the moment somebody scrolls up to look at a stack trace, the next
 * line yanks them away. So the box follows the tail only while it is ALREADY at
 * the tail, within a few pixels, and stops the instant a reader scrolls up.
 * There is no button to re-attach because there does not need to be: scrolling
 * back to the bottom re-attaches it, which is what a reader does anyway.
 *
 * ## What `dropped` is for
 *
 * The server holds a couple of hundred lines per run and no more, because a
 * transcript of every run of every suite is an unbounded file in a program
 * nobody is watching. `dropped` is how many lines came before the ones here, and
 * it is printed rather than swallowed: "the last 200 lines of 4000" and "all 200
 * lines" look identical on screen unless somebody says which, and a person
 * debugging a failure needs to know they are looking at the end of something.
 *
 * ## Lines are text, and nothing here interprets them
 *
 * Test output is whatever a configured command printed. It goes into a text node
 * — React escapes it — and is never parsed for markup, colour codes or links. A
 * log viewer that rendered its input is a log viewer that a test's own output
 * can draw on.
 */
export function Log({ lines, dropped }: { lines: string[]; dropped: number }) {
  const box = useRef<HTMLDivElement | null>(null)
  const stuck = useRef(true)

  useEffect(() => {
    const node = box.current
    if (!node || !stuck.current) return
    node.scrollTop = node.scrollHeight
  }, [lines])

  if (!lines.length && !dropped) return null

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {dropped ? (
        <p className="text-[11px] leading-tight text-muted-foreground">
          The {lines.length} newest lines. {dropped} earlier {dropped === 1 ? 'line is' : 'lines are'} not kept — this
          app holds the tail of a run, not the whole of it.
        </p>
      ) : null}
      {/*
        The one box on this page allowed to scroll sideways.

        `whitespace-pre` and `overflow-auto` together, deliberately: wrapping a
        stack trace at 220 pixels destroys the column alignment that makes it
        readable, and `overflow-hidden` would lose the right-hand half of every
        line silently. A box with its own visible edges and its own scrollbar is
        a thing a reader can understand — and because it is `overflow-auto`
        rather than `overflow-visible`, the page AROUND it stays exactly as wide
        as the frame. That is the whole of "the log scrolls and the container does
        not".

        `overscroll-contain` so that reaching the bottom of the log does not
        hand the scroll to the container, and then to the canvas behind it.
      */}
      <div
        /* Named for a probe rather than for a stylesheet. Every class on this
           page is a utility now, so there is no `.log` left for a measuring
           script to find the one box that is ALLOWED to scroll sideways — and a
           test that cannot tell it from the page around it cannot check the rule
           that matters. */
        data-log=""
        className="max-h-45 min-w-0 overflow-auto overscroll-contain rounded bg-muted p-1.5 font-mono text-[10.5px] leading-snug whitespace-pre"
        ref={box}
        onScroll={() => {
          const node = box.current
          if (!node) return
          /* Four pixels of slack, because a browser's own rounding at some zoom
             levels means an element scrolled fully to the bottom is a fraction
             short of it, and a strict comparison would detach the log for
             somebody who had done nothing at all. */
          stuck.current = node.scrollHeight - node.scrollTop - node.clientHeight < 4
        }}
      >
        {lines.map((line, at) => (
          // eslint-disable-next-line react/no-array-index-key -- output lines are
          // not identities: two runs of one suite print the same line twice and
          // the position IS the distinction. Nothing here is reordered.
          <div key={at}>{line || ' '}</div>
        ))}
      </div>
    </div>
  )
}
