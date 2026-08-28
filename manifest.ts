import { MANIFEST_KIND, PROTOCOL, manifestSchema, type Manifest } from 'roadmap-module-protocol'

export const ID = 'roadmap.tests'
export const VERSION = '1.0.0'

/**
 * What this app says about itself when a host asks.
 *
 * The manifest is the smallest half of this program and the only half a host
 * ever reads. Everything else here works with nothing on the other end — the
 * suites are configured over this app's own MCP door, the runs happen in this
 * app's own process, and the page draws all of it unframed. So read this as a
 * description of the ENRICHMENT: which tab to give the page, and the one
 * question the app would like to be allowed to ask if there is anybody to ask.
 *
 * ## What it declares, and the longer list of what it does not
 *
 * - **`live:read` — declared, and it is the only thing declared.** It buys
 *   exactly one thing, and it is worth being precise about how small that thing
 *   is: a selection carries refs and NOTHING ELSE. `gh#105` does not say whether
 *   it is an issue or a pull request, and this page would like to say "3 suites
 *   run against this pull request" rather than "against this reference". The
 *   only honest place to learn which it is, is the bag a host's own refresh
 *   filed it in — the same fact References reads, from the same place, for the
 *   same reason. Without this capability the page still names every run against
 *   every selected ref; it simply calls each one a reference and says so.
 *   Nothing about running tests depends on it.
 * - **`epics:read` and `steps:read` — not declared.** A run is keyed to a
 *   reference, and the canvas is what says which reference. A picker of our own
 *   over the host's epics would be a second answer to "what are we looking at"
 *   that can disagree with the first, and a capability asked for and never
 *   exercised is the fastest way to teach somebody to press yes without reading.
 * - **`selection:set` — not declared.** This app REACTS to a selection. A
 *   module whose page can spawn processes asking to also steer every other pane
 *   on the canvas is a larger thing than anybody needs it to be.
 * - **`stage:report` — not declared, and it is the tempting one.** A red suite
 *   looks like grounds to report `blocked`, and it is not: a test failing is
 *   this app's observation, and where the work has got to is a claim belonging
 *   to whoever is doing it. An app that reported a stage off an exit code would
 *   be putting words in somebody's mouth every time a flake went red at 3am.
 * - **`view:navigate` — not declared.** This is a pane a reader is already
 *   standing in; what it wants is to be walked TO, which is `roadmap.goto`
 *   arriving and needs no declaration.
 * - **Tracker access — not declared, and there is no capability for it.** This
 *   app never speaks to GitHub or GitLab, holds no credential, and has no code
 *   path that could. It has no opinion about CI either: a pipeline result is a
 *   thing a tracker knows and the Checklist reads. What is recorded here is what
 *   THIS PROGRAM ran on THIS MACHINE, which is a different fact, and the page
 *   never blurs the two.
 * - **No extensions.** Emitting a notification on every finished run is a panel
 *   full of noise, and `consumes` is unimplemented everywhere, so declaring it
 *   would be declaring an intention this app cannot act on.
 *
 * And per the protocol's own README: a declaration is not a request and is not
 * answered. The host refuses whatever it likes at every call whatever is written
 * here, so the page is built to be refused — the kind of a reference arriving is
 * drawn as enrichment, and its absence is drawn as not knowing.
 *
 * ## `prompt: false`, and this module is the one where the question is live
 *
 * The protocol offers a module a prompt: a paragraph a person writes on the
 * canvas, aimed at one pane, composed by the host and delivered in every
 * context. Declaring it makes a host OFFER one. The brief for this module raised
 * the question sharply, because this app IS configured in prose — an agent
 * converses with it over MCP and says how the project is tested. So why is a
 * paragraph on the canvas not the same thing?
 *
 * Because of what happens to the paragraph. A suite configured over MCP is
 * PARSED: a name, an argv array, an absolute directory that is checked to exist,
 * a timeout that is clamped. It is refused with a sentence when any of that is
 * wrong, and what lands in the store is a structure this program can spawn from
 * safely and print back verbatim. `context.prompt` is free text with no reply
 * channel at all — the host composes it, delivers it, and there is nowhere for
 * this app to say "that directory does not exist". Accepting configuration
 * through a door that cannot refuse would mean a person writing "run the
 * integration tests in ../ci" on the canvas and getting silence, forever, with
 * no way to learn whether it was read.
 *
 * There is a second reason and it is the harder one. This module spawns
 * processes. Everything it will run is written down, reviewable, and arrived
 * through a door that validated it. A free-text channel into a program that
 * spawns is a thing to be extremely reluctant about even when the code behind it
 * is careful, because the reluctance is what keeps it careful — the day somebody
 * reaches for "just interpret the prompt a bit" is the day the argument that a
 * command is never taken from a request quietly stops being true.
 *
 * The field is carried through the wire anyway and read by nothing; see the note
 * in `src/wire/host.ts`. The day this app grows something a person would
 * sensibly write prose about that is NOT a command — "only show me the suites
 * for the frontend" is the honest candidate — this line becomes `true` and the
 * prompt is read where that filtering is decided.
 *
 * ## The mode
 *
 * One epic-scoped mode, which becomes an ordinary tab in the mode row beside
 * every other module's. `scope: 'epic'` is what makes a host send
 * `roadmap.context` on load and on every switch, and that context is the only
 * inbound channel carrying the selection this page keys everything to.
 *
 * ## Storage, and why THIS module asks for it
 *
 * `storage: true` makes the host frame this page with `allow-same-origin`, so it
 * keeps its real origin instead of running opaque. Modules that hold nothing and
 * ask the host for everything are right to declare `false`; an origin would be a
 * thing they had no use for.
 *
 * This module is not one of those, and the gap between it and them is wider here
 * than for any sibling. It owns its suites and its runs, serves them from its
 * own `/api`, takes writes — and one of those writes STARTS A PROCESS. Opaque,
 * that combination has a hole in it:
 *
 *   - An opaque page's fetches to its own `/api` are CROSS-origin, because its
 *     origin is `null` and matches nothing. So the server has to answer with
 *     permissive CORS or the app cannot read its own runs.
 *   - Permissive CORS means any page anywhere can read this origin. Including
 *     `/app`. Including the ticket printed into it. Journeys had exactly that
 *     hole, and it was demonstrated rather than theorised:
 *
 *         $ curl -H 'Origin: https://evil.example' http://127.0.0.1:7840/app
 *         Access-Control-Allow-Origin: *
 *         ...ticket" type="application/json">"e75d4d01-…
 *
 *     There the prize was the ability to tick a box. Here it would be the
 *     ability to press Run on somebody's machine from a tab they had open.
 *
 * So this manifest declares storage and `vite.config.ts` sets no `server.cors`.
 * With a real origin, this page's scripts, its `/api` calls and its `EventSource`
 * are ordinary same-origin requests: no CORS is involved, nothing is offered to
 * strangers, and `/app` is unreadable from another origin.
 *
 * The sandbox is weakened by exactly what that costs, which is little. The
 * origin this page regains is `127.0.0.1:7900`; the host is on `127.0.0.1:4181`.
 * Different ports are different origins, so the page still cannot reach into the
 * host — it can only reach itself, which is all it asked for.
 */
export const MANIFEST: Manifest = manifestSchema.parse({
  kind: MANIFEST_KIND,
  /**
   * Parsed rather than shipped as a bare object.
   *
   * The protocol package is explicit that its schemas are a convenience and
   * never the host's check — the host runs its own copy over what arrives on the
   * wire. That cuts both ways: running it HERE is the cheapest way for this app
   * to learn it has written a manifest no host will accept, and to learn it when
   * this file is imported rather than from a host's refusal in somebody else's
   * log.
   */
  protocol: PROTOCOL,
  id: ID,
  name: 'Tests',
  version: VERSION,
  summary: 'How this project is tested, and what was actually run against the change you are looking at.',
  entry: '/app',
  modes: [{ id: 'tests', label: 'Tests', scope: 'epic' }],
  mcp: {
    url: '/mcp',
    transport: 'http',
    about: 'Say how a project is tested — named suites, each a command in a directory — then run one and read what happened.',
  },
  extensions: { emits: [], consumes: [] },
  declares: {
    protocol: `>=${PROTOCOL} <${PROTOCOL + 1}`,
    uses: ['live:read'],
    storage: true,
    prompt: false,
  },
  health: '/healthz',
})
