import { resolveDoorProject, type DoorProject } from 'kehikot-module-protocol/serve'

/**
 * Which project is this folder? Asked of the host, in this server, wherever a folder a caller named
 * is about to be read or written under (protocol 2.3.0, `resolveDoorProject`). A page's word, or an
 * agent's, is not the host's.
 *
 * What is worked on is the path the answer gives back, never the folder that was asked about: a caller
 * that learnt a path before the folder was renamed is followed to where the project is now, once, and
 * only after the host has said the new path is the same project. A host that says no, and no host
 * answering at all, are refusals: nothing is read and nothing is written. A run that is going when its
 * project is renamed asks here too, to find where its record goes (`runs/spawn.ts`).
 */
export type Resolve = (folder: string) => Promise<DoorProject>

export const resolveProject: Resolve = (folder) => resolveDoorProject(folder)

let resolver: Resolve = resolveProject

/** For the tests: the host's answer, stubbed. `null` puts the real one back. */
export function setHostResolve(resolve: Resolve | null): void {
  resolver = resolve ?? resolveProject
}

export const resolveFolder: Resolve = (folder) => resolver(folder)
