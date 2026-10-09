import type { Build } from 'kehikot-module-protocol'
import { pageDocument } from 'kehikot-module-protocol/serve'

/**
 * The page document, for both servers — and it is the protocol's `pageDocument` now.
 *
 * In dev, `doors()` in `vite.config.ts` builds it per request from `PAGE` with this process's
 * ticket and build in it, and runs it through Vite's `transformIndexHtml`. What used to be written
 * out here (the shell, the ticket island, the function replacement that keeps a `$&` in a ticket
 * from being mangled) is `kehikot-module-protocol/serve`; see its docs/module-plumbing.md.
 *
 * What is left here is the half the protocol does not have: a BUILT page. `build.ts` compiles a
 * document once and `serve.ts` serves it for the life of many processes, and neither the ticket
 * nor the build identity can be compiled in — both are per process.
 */

/** What both servers pass to `pageDocument`, apart from the ticket and the build. */
export const PAGE = { title: 'Tests' } as const

/**
 * The ticket a BUILT page is compiled with, and which `serve.ts` swaps out on
 * every request.
 *
 * A build happens once and a ticket is minted once per process, so the two
 * cannot be the same act: a `dist/index.html` with a real ticket baked into it
 * would be a write credential sitting in a build artefact, valid only for
 * whichever process happened to run the build and refused by every process
 * afterwards. So the build compiles this sentinel and the server replaces it per
 * request, which is the same per-process substitution the dev server does.
 *
 * It is a sentence rather than a plausible UUID on purpose: when the
 * substitution fails, this is what lands in the page, and a reader looking at a
 * refused write should be able to see the cause in the document.
 */
export const TICKET_SLOT = 'ticket-not-substituted-by-the-server'

/**
 * The same, for the build identity printed beside the ticket. A page served with this still in it
 * reads as a page with no build (the version is not one any server has), which costs only the
 * early notice that its server restarted; the ticket's refusal still says so.
 */
export const BUILD_SLOT: Build = {
  version: 'build-not-substituted-by-the-server',
  commit: null,
  started: '1970-01-01T00:00:00.000Z',
  protocol: '0.0.0',
}

/** JSON as `pageDocument` prints it into an island: nothing in it can close the script element. */
const island = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')

/** The quoted, printed forms `serve.ts` looks for. Quotes included, so a bundled asset that happened to contain the bare words is never touched. */
export const TICKET_SLOT_JSON = island(TICKET_SLOT)
export const BUILD_SLOT_JSON = island(BUILD_SLOT)

/** The document `build.ts` hands Vite as its entry: the dev page, with the two sentinels in it. */
export function builtPage(): string {
  return pageDocument({ ...PAGE, ticket: TICKET_SLOT, build: BUILD_SLOT })
}

/**
 * A built document with this process's ticket and build put where the sentinels are.
 *
 * The replacements are given as FUNCTIONS. `String.replace` reads `$&`, `$1` and friends out of a
 * replacement string, and a ticket is random text — a function replacement is taken literally.
 */
export function fill(html: string, ticket: string, build: Build): string {
  return html.replace(TICKET_SLOT_JSON, () => island(ticket)).replace(BUILD_SLOT_JSON, () => island(build))
}
