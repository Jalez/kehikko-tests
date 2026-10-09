import { pageDocument } from 'kehikot-module-protocol/serve'

/**
 * The page document, for both servers — and it is the protocol's `pageDocument` now.
 *
 * In dev, `doors()` in `vite.config.ts` builds it per request from `PAGE` with this process's
 * ticket and build in it, and runs it through Vite's `transformIndexHtml`. What used to be written
 * out here (the shell, the ticket island, the function replacement that keeps a `$&` in a ticket
 * from being mangled) is `kehikot-module-protocol/serve`; see its docs/module-plumbing.md.
 *
 * A BUILT page is the same document with neither in it: `build.ts` compiles it once and `serve.ts`
 * serves it for the life of many processes, and a ticket or a build identity compiled in would be
 * one process's, refused by every process afterwards. `serve.ts` puts its own in per request with
 * the protocol's `fillPage`, which needs no placeholder to agree on.
 */

/** What both servers pass to `pageDocument`, apart from the ticket and the build. */
export const PAGE = { title: 'Tests' } as const

/** The document `build.ts` hands Vite as its entry: the dev page, without a ticket or a build. */
export function builtPage(): string {
  return pageDocument(PAGE)
}
