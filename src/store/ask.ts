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
 */

/**
 * The ticket, read once off the inert JSON island the document carries.
 *
 * Read at module load rather than per request, because it cannot change while
 * this document is open: it is minted per server process and printed into the
 * page. A missing island is an empty string rather than a throw — that is a page
 * served by something other than this app's own server, which is a real state
 * during a build, and the runs will be refused with a sentence rather than the
 * page failing to render at all.
 */
function readTicket(): string {
  const island = typeof document === 'undefined' ? null : document.getElementById('ticket')
  if (!island?.textContent) return ''
  try {
    const parsed: unknown = JSON.parse(island.textContent)
    return typeof parsed === 'string' ? parsed : ''
  } catch {
    return ''
  }
}

const TICKET = readTicket()

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tests-ticket': TICKET },
    body: JSON.stringify(body),
  })
  return response.json()
}

export interface Live {
  run: Run
  lines: string[]
  dropped: number
}

export interface State {
  suites: Suite[]
  active: Live[]
  slots: number
  refs: string[]
  /** A store this app could not read, said in words rather than drawn as empty. */
  trouble: string | null
}

/** Everything this app holds that does not depend on which references are picked. */
export async function state(): Promise<State> {
  const response = await fetch('/api/state')
  const body = (await response.json()) as Partial<State>
  return {
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
export async function standings(refs: string[]): Promise<Standing[]> {
  if (!refs.length) return []
  const response = await fetch(`/api/standings?refs=${encodeURIComponent(refs.join(','))}`)
  const body = (await response.json()) as { standings?: unknown }
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
export async function run(suite: string, ref: string): Promise<Started> {
  const body = (await post('/api/run', { suite, ref })) as { ok?: unknown; run?: unknown; error?: unknown }
  if (body.ok === true && body.run) return { ok: true, run: body.run as Run }
  return { ok: false, error: typeof body.error === 'string' ? body.error : 'it did not start, and said nothing about why' }
}

/** Stop a run that is going. It ends as `stopped`, which is deliberately not `failed`. */
export async function stop(id: string): Promise<{ ok: boolean; error?: string }> {
  const body = (await post('/api/stop', { id })) as { ok?: unknown; error?: unknown }
  if (body.ok === true) return { ok: true }
  return { ok: false, error: typeof body.error === 'string' ? body.error : 'it did not stop, and said nothing about why' }
}
