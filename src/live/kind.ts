/**
 * What a selected reference IS, which the reference itself does not say.
 *
 * ## The question, and why the answer is only ever a nicety here
 *
 * A selection carries refs and nothing else. `context.selection` is
 * `['gh#131', 'gh#105']`, and the protocol is explicit about why it is only
 * that: the host can vouch that these are the refs somebody picked, and cannot
 * vouch for what they ARE, because whichever module set the selection was
 * believed rather than checked. GitHub numbers issues and pull requests in one
 * sequence, so `gh#105` is unreadable on its own.
 *
 * The way out is the one the protocol points at, and the one References and the
 * Checklist both take: ask the host for the epic's reading and read the kind out
 * of the BAG the refresh filed it in. A refresh knew, and filing is how it told
 * us. Parsing the ref to decide would be this app guessing at a fact it was
 * handed.
 *
 * What is different here, and worth saying so that nobody later mistakes this
 * file for load-bearing: **nothing this module does depends on the answer.** A
 * run is keyed to a ref string, and a ref string is a ref string. The kind buys
 * one thing — the page saying "3 suites run against this pull request" instead
 * of "against this reference" — and where the host refuses, is not there, or has
 * never refreshed the epic, the page says "reference" and carries on doing
 * everything else. That is why `live:read` is declared as enrichment in the
 * manifest and why its absence is drawn as not knowing rather than as an error.
 *
 * ## Every bag, and the spellings are not ours to tidy
 *
 * GitLab's two bags are keyed by the bare number and GitHub's two by the ref as
 * written, which is how a host files them. The spellings are rebuilt here to
 * match how people say them out loud, and the asymmetry is not ours and is not
 * tidied — tidying it would mean this app and the host disagree about what a key
 * is, and the symptom would be a selected reference whose kind this page could
 * never find.
 */

/** What people call it, when anything knows. */
export type Kind = 'issue' | 'merge request' | 'pull request'

const BAGS = [
  { bag: 'issues', kind: 'issue', spell: (k: string) => `#${k}` },
  { bag: 'mrs', kind: 'merge request', spell: (k: string) => `!${k}` },
  { bag: 'ghIssues', kind: 'issue', spell: (k: string) => k },
  { bag: 'ghPrs', kind: 'pull request', spell: (k: string) => k },
] as const satisfies readonly { bag: string; kind: Kind; spell: (k: string) => string }[]

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Every reference in one reading, by the spelling people write, with its kind.
 *
 * Built by enumeration rather than by lookup, and the difference is a real
 * hazard rather than a style: `bag[ref]` with a `ref` that arrived from the wire
 * answers with something inherited when the string is `constructor`.
 * `Object.entries` returns own enumerable properties and nothing from a
 * prototype.
 *
 * The VALUE in each bag is deliberately not read. Sibling modules take a whole
 * `RefState` out of here and derive verdicts from it; this one wants the key it
 * was filed under and nothing else, so a bag whose entries are damaged still
 * answers the only question this file asks.
 */
export function kinds(live: unknown): Map<string, Kind> {
  const out = new Map<string, Kind>()
  if (!isObject(live)) return out
  for (const { bag, kind, spell } of BAGS) {
    const held = live[bag]
    if (!isObject(held)) continue
    for (const key of Object.keys(held)) out.set(spell(key), kind)
  }
  return out
}
