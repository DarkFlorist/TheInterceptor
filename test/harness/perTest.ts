// Per-test installs for files whose tests each need their own browser mock (browserMock.ts) or replaced globals (globals.ts).
//
// Usage (at the top level of a test file, so the afterEach hook belongs to that file):
//   const installBrowserMock = createPerTestBrowserMockInstaller()
//   const browserMock = installBrowserMock({ tabs: [{ id: 1 }] })            // restored after the current test
//   const { installBrowserMockForTest, restoreAfterTest } = createPerTestRestorer()
//   restoreAfterTest(replaceGlobal('fetch', async () => new Response()))    // any restore function, run after the current test
import { afterEach } from 'bun:test'
import { installBrowserMock } from './browserMock.js'

export function createPerTestRestorer() {
	const pendingRestores: (() => void)[] = []
	// Restores run newest first, so stacked replacements of the same global unwind back to the value from before the test.
	afterEach(() => {
		for (const restore of pendingRestores.splice(0).reverse()) restore()
	})
	const restoreAfterTest = (restore: () => void) => {
		pendingRestores.push(restore)
	}
	const installForTest = <Arguments extends unknown[], Installed extends { readonly restore: () => void }>(install: (...args: Arguments) => Installed) => (...args: Arguments): Installed => {
		const installed = install(...args)
		restoreAfterTest(installed.restore)
		return installed
	}
	const installBrowserMockForTest = installForTest(installBrowserMock)
	return { installForTest, installBrowserMockForTest, restoreAfterTest }
}

// For files that only replace the browser global: installing again inside one test stacks a new mock, and every mock the test installed is restored after it.
export function createPerTestBrowserMockInstaller() {
	return createPerTestRestorer().installBrowserMockForTest
}
