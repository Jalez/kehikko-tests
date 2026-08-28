/**
 * Reading pass and fail counts out of whatever a test runner prints.
 *
 * ## Why this is allowed to fail, and says so
 *
 * There is no standard for this and there is not going to be one. Bun prints
 * `3 pass`, Vitest prints `Tests  2 passed | 1 failed (3)`, Jest prints
 * `Tests:       1 failed, 2 passed, 3 total`, pytest prints `2 passed in 0.03s`,
 * `go test` prints nothing of the kind at all. So this file recognises a handful
 * of shapes and returns `null` for everything else — and `null` travels all the
 * way to the screen, where it is drawn as "its output did not say how many"
 * rather than as zero.
 *
 * That is the whole design rule. A parser that guessed would put a confident
 * `0 passed` under a suite that ran two hundred tests successfully, which is a
 * worse lie than saying nothing, because a reader has no way to tell a parse
 * failure from a real result.
 *
 * ## Last match wins
 *
 * Every recognised line overwrites the counts rather than accumulating them.
 * Runners print a per-file line and then a summary line, and adding those
 * together double-counts every test. The summary is the last such line, so the
 * last one seen is the one kept — which is also right for a runner that prints a
 * progress line repeatedly.
 *
 * ## Bounded, like everything else that touches output
 *
 * The regexes below are all anchored on short literal words and match at most a
 * handful of digits. Output is attacker-adjacent in the ordinary way — it is
 * whatever the configured command printed — and a pattern with nested
 * quantifiers over a long line is a way to spend a CPU on a log file.
 */

export interface Counts {
  passed: number | null
  failed: number | null
}

export const NOTHING: Counts = { passed: null, failed: null }

/** How much of one line is looked at. Longer than any real summary line. */
const MAX_SCANNED = 400

const PATTERNS: { re: RegExp; read: (m: RegExpMatchArray) => Partial<Counts> }[] = [
  /* Jest and Vitest, both spellings of the summary line. `1 failed, 2 passed`. */
  { re: /(\d{1,7})\s+failed/i, read: (m) => ({ failed: Number(m[1]) }) },
  { re: /(\d{1,7})\s+passed/i, read: (m) => ({ passed: Number(m[1]) }) },
  /* Bun's own, which is the one this repository's own suite prints. */
  { re: /(\d{1,7})\s+pass\b/i, read: (m) => ({ passed: Number(m[1]) }) },
  { re: /(\d{1,7})\s+fail\b/i, read: (m) => ({ failed: Number(m[1]) }) },
]

/**
 * What one line says about the counts, or nothing.
 *
 * Returns a PARTIAL: a line saying only `2 passed` must not reset a failure
 * count read from the line above it. Bun prints `pass` and `fail` on separate
 * lines, so a whole-record replacement here would mean this app never saw a
 * failure count from the runner it is most likely to be pointed at.
 */
export function readCounts(line: string): Partial<Counts> | null {
  const text = line.slice(0, MAX_SCANNED)
  let found: Partial<Counts> | null = null
  for (const { re, read } of PATTERNS) {
    const m = text.match(re)
    if (!m) continue
    const part = read(m)
    if (Number.isFinite(part.passed ?? part.failed ?? NaN)) found = { ...(found ?? {}), ...part }
  }
  return found
}

/** The counts after one more line, given what was known before it. */
export function fold(was: Counts, line: string): Counts {
  const part = readCounts(line)
  if (!part) return was
  return { passed: part.passed ?? was.passed, failed: part.failed ?? was.failed }
}
