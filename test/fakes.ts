import { act } from '@testing-library/react'

import { mailbox, resetServerStanding } from 'kehikot-module-protocol/client'

/**
 * What the page tests stand in for: this app's own server (`fetch`), its event stream
 * (`EventSource`) and a host (messages posted to the window, which under happy-dom is its own
 * parent). The page's own code — the hooks, the protocol's client — is the real thing.
 */

const realFetch = globalThis.fetch
const realSource = globalThis.EventSource

/** An `EventSource` a test drives by hand: named events, and the three states of the line. */
export class Line {
  static made: Line[] = []
  static latest(): Line {
    return Line.made.at(-1)!
  }
  readyState = 0
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((message: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  private heard = new Map<string, ((message: MessageEvent) => void)[]>()
  constructor(public url: string) {
    Line.made.push(this)
  }
  addEventListener(name: string, listener: (message: MessageEvent) => void): void {
    this.heard.set(name, [...(this.heard.get(name) ?? []), listener])
  }
  close(): void {
    this.closed = true
    this.readyState = 2
  }
  /** The stream opened. */
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
  /** The stream dropped; the browser is retrying by itself. */
  drop(): void {
    this.readyState = 0
    this.onerror?.()
  }
  /** One named event, as the server frames it. */
  send(name: string, data: unknown): void {
    for (const listener of this.heard.get(name) ?? []) listener({ data: JSON.stringify(data) } as MessageEvent)
  }
}

export type Served = (method: string, url: URL, body: Record<string, unknown> | null, ticket: string | null) =>
  | { status: number; body: unknown }
  | null
  | Promise<{ status: number; body: unknown } | null>

export const server = {
  /** Set, nothing answers: the server is stopped. */
  down: false,
  asked: [] as { method: string; path: string; ticket: string | null }[],
}

/** Stand in for this app's own server and stream, and forget what any earlier test left behind. */
export function install(serve: Served, ticket?: string): void {
  server.down = false
  server.asked = []
  Line.made = []
  resetServerStanding()
  /* The mailbox replays what it kept to every new listener: an earlier test's greeting would greet this one. */
  mailbox.forget?.()
  globalThis.EventSource = Line as unknown as typeof EventSource
  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    if (server.down) throw new TypeError('Load failed')
    const url = new URL(String(input), 'http://127.0.0.1')
    const method = (init.method ?? 'GET').toUpperCase()
    const carried = (init.headers as Record<string, string> | undefined)?.['x-module-ticket'] ?? null
    server.asked.push({ method, path: url.pathname, ticket: carried })
    const said = await serve(method, url, init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null, carried)
    return new Response(JSON.stringify(said?.body ?? null), { status: said?.status ?? 404 })
  }) as unknown as typeof fetch
  if (ticket !== undefined) {
    const island = document.createElement('script')
    island.id = 'ticket'
    island.type = 'application/json'
    island.textContent = JSON.stringify(ticket)
    document.body.appendChild(island)
  }
}

export function uninstall(): void {
  globalThis.fetch = realFetch
  globalThis.EventSource = realSource
  document.getElementById('ticket')?.remove()
  document.documentElement.className = ''
  mailbox.forget?.()
}

/**
 * Let what was posted arrive and what it caused be drawn. Twice, because `act` runs the effects a
 * message caused only as it ends — so what THOSE post (a question to the host, a read from the
 * server) needs a second turn to arrive.
 */
export async function settle(ms = 25): Promise<void> {
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))))
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))))
}

const context = (over: Record<string, unknown>) => ({ epic: null, theme: 'light', selection: [], ...over })

/** A host greets the page. */
export async function greet(over: Record<string, unknown> = {}): Promise<void> {
  window.postMessage({ type: 'kehikot.hello', protocol: 2, session: `s-${Math.random()}`, state: null, context: context(over) }, '*')
  await settle()
}

/** A host says the context again. */
export async function say(over: Record<string, unknown> = {}): Promise<void> {
  window.postMessage({ type: 'kehikot.context', protocol: 2, ...context(over) }, '*')
  await settle()
}

/** Every `live.get` the page asks the host, held until a test answers it. */
export function hostQuestions(): { asked: { epic: string; answer: (data: unknown) => Promise<void> }[]; stop: () => void } {
  const asked: { epic: string; answer: (data: unknown) => Promise<void> }[] = []
  const hear = (event: MessageEvent) => {
    const message = event.data as { type?: string; id?: string; method?: string; params?: { epic?: string } } | null
    if (message?.type !== 'kehikot.request' || message.method !== 'live.get') return
    asked.push({
      epic: String(message.params?.epic),
      answer: async (data) => {
        window.postMessage({ type: 'kehikot.response', protocol: 2, id: message.id, ok: true, result: data }, '*')
        await settle()
      },
    })
  }
  window.addEventListener('message', hear)
  return { asked, stop: () => window.removeEventListener('message', hear) }
}
