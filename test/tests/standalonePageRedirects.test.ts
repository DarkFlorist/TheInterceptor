import * as assert from 'assert'
import { describe, test } from 'bun:test'

function replaceGlobal(name: string, value: unknown) {
	const previous = Object.getOwnPropertyDescriptor(globalThis, name)
	Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
	return () => {
		if (previous === undefined) Reflect.deleteProperty(globalThis, name)
		else Object.defineProperty(globalThis, name, previous)
	}
}

async function loadStandaloneEntry(entry: string, hash: string, manifestVersion: 2 | 3) {
	const redirects: string[] = []
	const restoreLocation = replaceGlobal('location', { hash, pathname: '/legacy.html', search: '', replace: (url: string) => { redirects.push(url) } })
	const restoreBrowser = replaceGlobal('browser', { runtime: { getManifest: () => ({ manifest_version: manifestVersion }) } })
	try {
		await import(`../../app/ts/${ entry }.ts?redirect-test=${ crypto.randomUUID() }`)
		return redirects
	} finally {
		restoreBrowser()
		restoreLocation()
	}
}

describe('pre-shell standalone pages', () => {
	test('continue saved links in the management shell instead of rendering their own page', async () => {
		assert.deepEqual(await loadStandaloneEntry('addressBookRender', '', 3), ['/html3/managementViewV3.html#address-book'])
		assert.deepEqual(await loadStandaloneEntry('websiteAccess', '#origin:example.com', 3), ['/html3/managementViewV3.html#websites?origin=example.com'])
		assert.deepEqual(await loadStandaloneEntry('simulationStack', '#simulation-stack-target=simulation-stack-transaction-0x1', 2), ['/html/managementView.html#simulation-stack?simulation-stack-target=simulation-stack-transaction-0x1'])
	})

	test('falls back to the page tab when a saved hash belongs to another page', async () => {
		assert.deepEqual(await loadStandaloneEntry('simulationStack', '#origin:example.com', 3), ['/html3/managementViewV3.html#simulation-stack'])
	})
})
