import { describe, expect, test } from 'bun:test'

import { fallbackShows } from '../src/view/header-fallback.tsx'

describe('the in-frame fallback menu', () => {
  test('a host that says it draws the header: never drawn, press or no press', () => {
    expect(fallbackShows('hosted', true, false)).toBe(false)
    expect(fallbackShows('hosted', true, true)).toBe(false)
  })
  test('a host that says it draws none: drawn, even after a press', () => {
    expect(fallbackShows('hosted', false, false)).toBe(true)
    expect(fallbackShows('hosted', false, true)).toBe(true)
  })
  test('an older host that says nothing: drawn until a press has arrived, then gone', () => {
    expect(fallbackShows('hosted', null, false)).toBe(true)
    expect(fallbackShows('hosted', null, true)).toBe(false)
  })
  test('a page nobody frames always draws it', () => {
    expect(fallbackShows('standalone', true, true)).toBe(true)
  })
})
