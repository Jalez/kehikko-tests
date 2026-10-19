import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GlobalRegistrator } from '@happy-dom/global-registrator'

/**
 * A document, for the tests that render one.
 *
 * Registered globally rather than per-file because half the value of these tests
 * is that they run the real components — the words on screen are the thing being
 * asserted, and a fake renderer would let a component say something different
 * from what it says in a browser.
 */
GlobalRegistrator.register()

/**
 * Where a person's confirmations are kept, for the tests: a temporary directory,
 * never this machine's own. Set here, before any test file loads, so no test can
 * write a confirmation where the real app would read it.
 */
process.env.TESTS_CONFIRMED_DIR = mkdtempSync(join(tmpdir(), 'tests-confirmed-'))

/**
 * The host, for the tests that are not about it: it holds every folder it is asked about. A test of what
 * the host says sets its own (`test/host.ts`) and puts this back.
 */
const { holdsEveryFolder } = await import('./host.ts')
holdsEveryFolder()
