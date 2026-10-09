import { answered, ask } from 'kehikot-module-protocol/client'

import type { Run, Standing } from '../../runs/store.ts'
import type { Suite } from '../../suites/store.ts'

/**
 * Talking to this app's own server, which is the same origin this page came
 * from.
 *
 * ## Why these are plain relative fetches and it is worth saying so
 *
 * `/api/state`, `/api/standings`, `/api/run` and `/api/events` are relative
 * paths, so the browser resolves them against the document — which is
 * `http://127.0.0.1:7900/app`, framed or not, because this module declares
 * `storage: true` and therefore keeps its origin. Every request below is an
 * ordinary same-origin request: no preflight, no CORS header offered to anybody,
 * and no way for a page in another tab to make one of them. That last clause is
 * the whole reason the declaration was worth making here, because one of these
 * requests starts a process. See the essay in `manifest.ts`.
 *
 * ## The types come from the server's own files
 *
 * `Run`, `Standing` and `Suite` are imported from `runs/` and `suites/` above
 * the `src/` boundary, as types, and are erased at build. That is deliberate
 * rather than lazy: these shapes are decided in one place and drawn in another,
 * and a hand-written copy on this side would be a second definition that
 * silently disagrees the first time a field is added. The wire between this page
 * and this server is not a wire between two programs — it is one program with a
 * socket in the middle.
 *
 * ## The asking is the protocol's
 *
 * `ask()` carries the page's ticket on every write and turns every failure into one sentence:
 * the server said no (its own words), nothing answered, or this page is older than its server —
 * in which case the page reloads itself a moment later. It also keeps the one fact
 * `useServerStanding` reads, which is what draws the "own server is not answering" cover in
 * `App`. See the protocol's docs/module-plumbing.md.
 */

export interface Live {
  run: Run
  lines: string[]
  dropped: number
}

export interface State {
  /** No project is open, so there is no store to read. Not a fault; the page says so. */
  nowhere: boolean
  suites: Suite[]
  active: Live[]
  slots: number
  refs: string[]
  /** A store this app could not read, said in words rather than drawn as empty. */
  trouble: string | null
}

/** Everything this app holds that does not depend on which references are picked. */
/** `project=…`, or nothing: the store lives inside the project the host named. */

export async function state(project: string | null): Promise<State> {
  /* Thrown as `AskFailed` when it could not be read; its `kind` says whether nothing answered. */
  const body = answered(await ask<Partial<State>>('/api/state', { query: { project } })) ?? {}
  return {
    nowhere: body.nowhere === true,
    suites: Array.isArray(body.suites) ? body.suites : [],
    active: Array.isArray(body.active) ? body.active : [],
    slots: typeof body.slots === 'number' ? body.slots : 0,
    refs: Array.isArray(body.refs) ? body.refs : [],
    trouble: typeof body.trouble === 'string' ? body.trouble : null,
  }
}

/**
 * What has been run against each of these references.
 *
 * One request for the whole selection rather than one per ref: several round
 * trips would arrive out of order and paint the list several times.
 *
 * A ref with no runs still comes back, as a standing with an empty list. It must
 * never be quietly left out — a missing row looks exactly like a row that was
 * never meant to be there, and "nothing has been run against this" is the single
 * most important sentence this page has.
 */
export async function standings(project: string | null, refs: string[]): Promise<Standing[]> {
  if (!refs.length) return []
  const body = answered(await ask<{ standings?: unknown }>('/api/standings', { query: { refs: refs.join(','), project } })) ?? {}
  return Array.isArray(body.standings) ? (body.standings as Standing[]) : []
}

export type Started = { ok: true; run: Run } | { ok: false; error: string }

/**
 * Press Run, which is the one thing this page does that starts a process.
 *
 * It sends a suite NAME and a reference and nothing else — there is no field
 * here that could carry a command, because there is no such field on the server
 * either. See `suites/store.ts`; that is the whole security argument of the
 * module and this function is the client half of it.
 *
 * A refusal comes back as a sentence and is shown beside the button that was
 * pressed. Refusals here are ordinary — the suite is already running, both slots
 * are busy — and each one names what to do instead.
 */
export async function run(project: string | null, suite: string, ref: string): Promise<Started> {
  const asked = await ask<{ run?: unknown }>('/api/run', { body: { project, suite, ref } })
  if (!asked.ok) return { ok: false, error: asked.error }
  if (asked.body?.run) return { ok: true, run: asked.body.run as Run }
  return { ok: false, error: 'it did not start, and said nothing about why' }
}

/** Stop a run that is going. It ends as `stopped`, which is deliberately not `failed`. */
export async function stop(id: string): Promise<{ ok: boolean; error?: string }> {
  const asked = await ask('/api/stop', { body: { id } })
  return asked.ok ? { ok: true } : { ok: false, error: asked.error }
}
