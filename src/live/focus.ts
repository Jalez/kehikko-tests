import { anchorInFocus, focusSentence, isFocused, partsSchema, pickedParts, type EpicPart } from 'kehikot-module-protocol'

/**
 * The parts focus, and the little this page does about it.
 *
 * ## What a focus is
 *
 * An epic may be divided into parts, and a person may pick some of them out in
 * the host's bar. `context.parts` lists every part of the open epic with the
 * references the host says belong to it, and flags the picked ones. None
 * picked means the whole epic — the resting state, and what a host that has
 * never heard of parts says by sending nothing.
 *
 * ## Nothing here is hidden by it, and that is the decision
 *
 * The other modules that honour a focus list an epic's worth of things and
 * narrow the list. This page lists nothing per epic. What it draws is decided
 * by somebody's finger: the references SELECTED on the canvas, each with what
 * has been run against it, or — with nothing selected — how the project is
 * tested and the references this project has runs for.
 *
 * So a selected reference that is outside the picked parts is still drawn. A
 * person who clicked `gh#105` and was shown nothing because a part elsewhere
 * was picked would be looking at a page that disagreed with their own click;
 * and "nothing has been run against this" must never be confusable with "this
 * was put aside". What the page owes instead is the sentence: this reference
 * is outside the parts you picked, so if you meant to be looking at that part,
 * you are not.
 *
 * The references the project has runs for are not narrowed either. That list
 * is the project's, not the epic's — it has never been narrowed to the open
 * epic — and narrowing it to PARTS of an epic it is not scoped to would hide
 * every run made under another epic for a reason nobody on this page chose.
 * The suites are not about a reference at all.
 *
 * What is left is counting, and saying it: a reference's anchor is `{ ref }`,
 * the protocol's `anchorInFocus` decides which are outside — which, because
 * here they are marked rather than dropped — and its `focusSentence` is the
 * sentence every module says about them. A reference no part lists is outside
 * every focus.
 *
 * Pure, like `kind.ts` beside it.
 */
export interface Focus {
  /** Every part of the epic, the picked ones flagged: what the sentence is made from. */
  parts: readonly EpicPart[]
  /** How many references the count was taken over. */
  among: number
  /** Those of them no picked part lists, in the order given. Drawn, and marked. */
  outside: string[]
}

/** What the focus says about these references, or null when no part is picked out — the cue to say nothing. */
export function focusOf(parts: readonly EpicPart[], refs: readonly string[]): Focus | null {
  if (!isFocused(parts)) return null
  return { parts, among: refs.length, outside: refs.filter((ref) => !anchorInFocus(parts, { ref })) }
}

/** "the picked part (The posting seam)", or "the 2 picked parts (The method, The results)". */
export function focusNamed(focus: Focus): string {
  const picked = pickedParts(focus.parts).map((part) => part.heading || part.id)
  return `${picked.length === 1 ? 'the picked part' : `the ${picked.length} picked parts`} (${picked.join(', ')})`
}

/**
 * The line at the top of the page while parts are picked out.
 *
 * `what` is which references were counted, because the page has two states:
 * the ones selected (or picked here), and — with nothing selected — the ones
 * this project has runs for. It always says nothing is hidden, because on a
 * canvas where every neighbouring pane has just got shorter, a pane that did
 * not has to say that it did not.
 */
export function focusSaid(focus: Focus, what: 'shown' | 'with-runs'): string {
  if (focus.among === 0) return `This epic is focused on ${focusNamed(focus)}. Nothing on this page is narrowed by that.`
  const noun = what === 'shown' ? (['reference shown here', 'references shown here'] as const) : (['reference with runs', 'references with runs'] as const)
  return `${focusSentence(focus.parts, focus.outside.length, noun, { total: focus.among })} Nothing is hidden: this page follows what is selected, not the parts.`
}

/**
 * `context.parts`, read with the protocol's own schema. Anything that does not
 * parse is no parts, which is no focus: a doubtful field must not be the
 * reason a card says a reference is outside something.
 */
export function partsFrom(value: unknown): EpicPart[] {
  const read = partsSchema.safeParse(value ?? [])
  return read.success ? read.data : []
}
