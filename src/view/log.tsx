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
    <div>
      {dropped ? (
        <p className="said">
          The {lines.length} newest lines. {dropped} earlier {dropped === 1 ? 'line is' : 'lines are'} not kept — this
          app holds the tail of a run, not the whole of it.
        </p>
      ) : null}
      <div
        className="log"
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
