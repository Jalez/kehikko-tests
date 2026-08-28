/**
 * How long ago, in the shorthand the page and the MCP door both use.
 *
 * ## Why this is a file of its own, which is not a style decision
 *
 * It lived in `runs/store.ts` for an afternoon and had to be moved, and the
 * failure is worth recording because it is silent in the browser and invisible
 * in every other check.
 *
 * `runs/store.ts` reads and writes a file: it imports `node:fs`, and through
 * `../store.ts` it calls `mkdirSync`. The page imports its TYPES from there, and
 * a type import is erased at build, so that costs nothing. Importing `ago` from
 * there does not — it is a VALUE, so Vite follows the import, pulls the whole
 * store into the client bundle, and externalises `node:fs` with a stub. The
 * module then throws on evaluation:
 *
 *     Module "node:fs" has been externalized for browser compatibility.
 *     Cannot access "node:fs.mkdirSync" in client code.
 *
 * And the symptom of that is not an error anybody sees. The document loads, the
 * frame's `load` event fires, the host greets it, and no script in the page ever
 * ran — so nothing answers, the pane reports a module that will not speak, and
 * the only place the real reason appears is the browser console. It is the exact
 * shape of the CORS failure the sibling modules lost days to, arriving through a
 * completely different door.
 *
 * So anything both sides need lives here: no imports, no I/O, nothing but
 * arithmetic on a string. `runs/store.ts` re-exports it so the server keeps one
 * name for it.
 */
export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}
