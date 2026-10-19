import { resolveDoorProject } from 'kehikot-module-protocol/serve'

import { setHostResolve } from '../host-ask.ts'

/** The host holds every folder it is asked about, at that path. What every test but the ones about the host starts from. */
export const holdsEveryFolder = () => setHostResolve(async (folder) => ({ ok: true, path: folder }))

/**
 * The real `resolveDoorProject` against a host that is only a table: `held` is the folders it holds
 * (path to id), `former` the paths a project had (path to where it is now, or with the id the host says it had). Nothing is listening.
 */
export function hostThat(held: Record<string, string>, former: Record<string, string | { to: string; id: string }> = {}): void {
  setHostResolve((folder) =>
    resolveDoorProject(folder, {
      env: { KEHIKOT_ORIGINS: 'http://127.0.0.1:9' },
      fetch: (async (url: string) => {
        const path = new URL(url).searchParams.get('path')!
        const was = former[path]
        const to = typeof was === 'string' ? was : was?.to
        const body = held[path]
          ? { ok: true, project: true, path, id: held[path] }
          : to
            ? { ok: true, project: false, movedTo: to, id: typeof was === 'string' ? held[to] : was!.id }
            : { ok: true, project: false }
        return new Response(JSON.stringify(body), { status: 200 })
      }) as unknown as typeof fetch,
    }),
  )
}

/** No host answering at all. */
export function noHost(): void {
  setHostResolve((folder) =>
    resolveDoorProject(folder, {
      env: { KEHIKOT_ORIGINS: 'http://127.0.0.1:9' },
      fetch: (async () => {
        throw new Error('nobody is listening')
      }) as unknown as typeof fetch,
    }),
  )
}
