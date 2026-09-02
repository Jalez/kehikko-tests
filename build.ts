#!/usr/bin/env bun
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { build } from 'vite'

import { page, TICKET_SLOT } from './page/document.ts'

/**
 * Compile this app's page to static assets.
 *
 *   bun run build            # then: bun run start
 *
 * ## Why there is a script here at all, and not just `vite build`
 *
 * `"build": "vite build"` was in this repository's siblings for a long time and
 * it was DEAD in every one of them that generates its document. Run it here
 * before this file existed and the whole of what happens is:
 *
 *     ✗ Build failed in 3ms
 *     error during build: Could not resolve entry module "index.html".
 *
 * Vite's build starts from an HTML file on disk, walks the scripts it links, and
 * emits a bundle. This module has no such file — the document is assembled in
 * `page/document.ts`, for the reason the essay there gives: the write ticket is
 * minted per process and has to reach the page without being fetchable on a door
 * of its own. In dev that is fine, because `vite.config.ts` runs the generated
 * string through `transformIndexHtml` and Vite never needs the file. A build has
 * no such hook; it needs the entry to exist.
 *
 * ## So the entry is written, built, and taken away again
 *
 * The alternative was to commit an `index.html` beside `document.ts` holding the
 * same shell, and it is the wrong shape for the ordinary reason: two copies of
 * one document, and the day somebody adds a `<meta>` to the generated one and
 * not the committed one is the day the built page and the dev page stop being
 * the same page. Nobody would notice, because nobody develops against the built
 * page. So `document.ts` stays the only place the shell is written, and this
 * file borrows it.
 *
 * The file is written at the REPOSITORY ROOT rather than next to
 * `document.ts`, because the shell says `src="/src/main.tsx"` and that leading
 * slash is resolved against Vite's `root`. Written into `page/`, the build would
 * look for `page/src/main.tsx`, fail to resolve it, and say so — which is at
 * least loud. Written at the root, it resolves to the same module the dev server
 * serves, which is the point.
 *
 * `finally` removes it. A leftover `index.html` at the root is worse than it
 * looks: `/app` is claimed by the doors middleware before Vite's resolver sees
 * it, but `/` under the dev server is not, and an `index.html` on disk would
 * quietly start being what the dev server hands back at the root — a document
 * with a sentinel where the ticket goes, and every run refused. It is
 * gitignored as a second line of defence, so a build interrupted with SIGKILL
 * cannot leave one in a commit.
 */

const ROOT = import.meta.dirname
const ENTRY = join(ROOT, 'index.html')

writeFileSync(ENTRY, page(TICKET_SLOT), 'utf8')

try {
  /**
   * The config is read from `vite.config.ts` rather than passed here, so there
   * is one answer to what this app compiles like. That file's `serves()` plugin
   * is `apply: 'serve'` and does not run — deliberately, and the reason is in
   * the plugin: a build has no port to claim and no address to register, and one
   * that wrote into somebody's home directory would be a build with a side
   * effect on a machine it was only compiling for.
   */
  await build({ root: ROOT })
} finally {
  rmSync(ENTRY, { force: true })
}
