import { describe, expect, test } from 'bun:test'
import { headerItemsSchema } from 'kehikot-module-protocol'

import { headerOf, keyOf, type HeaderState } from '../src/header.ts'
import type { Listed } from '../suites/store.ts'

const suite = (name: string, confirmed = true): Listed =>
  ({ name, what: `the ${name} suite`, command: ['bun', 'test'], dir: '/p', timeoutMs: 60000, by: 'a person', fingerprint: `f-${name}`, confirmed }) as Listed

const base: HeaderState = { suites: [suite('unit'), suite('e2e')], refs: [], live: [], newest: new Map(), slots: 2 }

describe('what this page declares for the container’s header', () => {
  test('is a list the protocol reads, with every kind of item in it', () => {
    const state: HeaderState = {
      ...base,
      suites: [suite('unit'), suite('fresh', false)],
      refs: ['gh#7', '!4'],
      live: [{ id: 'run1', suite: 'unit', ref: 'gh#7' }],
      newest: new Map([[keyOf.run('!4', 'unit'), 'failed']]),
    }
    const declared = headerOf(state)
    expect(() => headerItemsSchema.parse(declared.items)).not.toThrow()
    expect(declared.items.every((one) => one.kind === 'run')).toBe(true)
  })

  test('a run is a run item per suite and reference, naming the door’s own tool, and no item is for agents', () => {
    const { items } = headerOf({ ...base, refs: ['gh#7'] })
    expect(items.map((one) => one.label)).toEqual(['Run unit', 'Run e2e'])
    expect(items.every((one) => (one as { tool?: string }).tool === 'run_tests')).toBe(true)
    expect(items.some((one) => (one as { agents?: boolean }).agents === true)).toBe(false)
    expect(items[0]).toMatchObject({ group: 'gh#7' })
  })

  test('with no reference picked, the run is for none in particular, and has no group', () => {
    const { items, offered } = headerOf(base)
    expect(items).toHaveLength(2)
    expect(items[0]).not.toHaveProperty('group')
    expect(offered.has(keyOf.run('', 'unit'))).toBe(true)
  })

  test('a suite nobody confirmed is offered as confirming its command, with the host’s two presses, and no Run', () => {
    const { items, by } = headerOf({ ...base, suites: [suite('fresh', false)] })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'run', label: 'Confirm command: fresh', confirm: true })
    expect(items[0]).not.toHaveProperty('agents')
    expect(by.get(items[0]!.id)).toMatchObject({ kind: 'confirm' })
  })

  test('a live run is Stop, armed by the host, naming stop_run; the run itself is busy and cannot be pressed twice', () => {
    const { items } = headerOf({ ...base, live: [{ id: 'run1', suite: 'unit', ref: '' }] })
    const stop = items.find((one) => one.label === 'Stop unit')
    expect(stop).toMatchObject({ confirm: true, tool: 'stop_run' })
    expect(items.find((one) => one.label === 'Run unit')).toMatchObject({ state: 'busy' })
  })

  test('every slot taken says why the others cannot be run', () => {
    const { items } = headerOf({ ...base, live: [{ id: 'a', suite: 'unit', ref: '' }, { id: 'b', suite: 'e2e', ref: 'x' }], slots: 2 })
    const idle = items.find((one) => one.label === 'Run e2e' && (one as { state?: string }).state !== 'busy') as { disabled?: string } | undefined
    expect(idle?.disabled).toContain('slot')
  })

  test('the newest verdict is the result, and nothing else moves the list: no counts, no time', () => {
    const a = headerOf({ ...base, newest: new Map([[keyOf.run('', 'unit'), 'passed']]) })
    expect(a.items[0]).toMatchObject({ result: 'passed' })
    expect(JSON.stringify(headerOf(base).items)).toBe(JSON.stringify(headerOf({ ...base }).items))
  })

  test('more than a header holds: stops, then confirmations, then runs, and the page draws a button for the rest', () => {
    const suites = Array.from({ length: 5 }, (_, i) => suite(`s${i}`))
    const refs = Array.from({ length: 8 }, (_, i) => `gh#${i}`)
    const { items, offered } = headerOf({ ...base, suites, refs })
    expect(items).toHaveLength(24)
    expect(offered.size).toBe(24)
    expect(offered.has(keyOf.run('gh#7', 's4'))).toBe(false)
  })
})
