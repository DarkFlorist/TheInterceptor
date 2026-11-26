import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { withBrowserFixtureSetup } from '../benchmarks/browserFixtureSetup.js'
import { waitForExtensionPage } from '../benchmarks/browserHarness.js'
import type { BrowserEngine } from '../benchmarks/browserTypes.js'
import type { ViewportDriverPage, ViewportDriverSession } from '../benchmarks/browserViewport.js'

function createSession(browser: BrowserEngine, discoveredWebsite = false) {
	const calls: string[] = []
	const page = (id: string, url: string): ViewportDriverPage => ({
		id, url, navigate: async () => undefined, evaluate: async () => undefined,
		reload: async () => undefined, setViewport: async () => { calls.push('viewport') }, captureScreenshot: async () => '', close: async () => undefined,
	})
	const control = page('control', `${ browser === 'chrome' ? 'chrome' : 'moz' }-extension://test/html/settingsView.html`)
	const website = page('website', 'https://fixture.test/')
	const underlying: ViewportDriverSession = {
		browser, browserVersion: 'test', openPage: async (url, _wait, prepare) => { const opened = page('opened', url); await prepare(opened); return opened }, openExtensionPage: async (_path, prepare) => { await prepare(control); return control },
		pages: async () => discoveredWebsite ? [control, website] : [control], close: async () => undefined,
		addPreloadScript: async () => { calls.push('preload') }, routeResponses: async () => { calls.push('routes') },
	}
	return { session: withBrowserFixtureSetup(underlying), calls }
}

for (const browser of ['chrome', 'firefox'] as const) {
	test(`${ browser } extension-page discovery, waiting and control use leave fixture setup available`, async () => {
		const { session, calls } = createSession(browser)
		await session.openExtensionPage('html/settingsView.html')
		await session.pages()
		const control = await waitForExtensionPage(session, 'settingsView.html')
		await control.evaluate('browser.runtime.getURL("")')
		await control.reload()
		await session.addPreloadScript('globalThis.fixture = true')
		await session.routeResponses([{ url: 'https://fixture.test/', body: 'fixture' }])
		assert.deepEqual(calls, ['preload', 'routes'])
	})

	test(`${ browser } opening a website finalizes fixture setup`, async () => {
		const { session } = createSession(browser)
		await session.openPage('https://fixture.test/')
		await assert.rejects(session.addPreloadScript('late'), /before using website documents/)
		await assert.rejects(session.routeResponses([]), /before using website documents/)
	})

	test(`${ browser } extension-page navigation to a website finalizes setup and updates its URL`, async () => {
		const { session } = createSession(browser)
		const control = await waitForExtensionPage(session, 'settingsView.html')
		await session.addPreloadScript('globalThis.fixture = true')
		await control.navigate('https://fixture.test/')
		assert.equal(control.url, 'https://fixture.test/')
		await assert.rejects(session.routeResponses([]), /before using website documents/)
	})

	test(`${ browser } discovering a website is pure but reading that document finalizes setup`, async () => {
		const { session, calls } = createSession(browser, true)
		const website = (await session.pages()).find(({ id }) => id === 'website')
		assert.ok(website)
		await session.addPreloadScript('globalThis.fixture = true')
		await website.evaluate('document.title')
		await assert.rejects(session.routeResponses([]), /before using website documents/)
		assert.deepEqual(calls, ['preload'])
	})

	test(`${ browser } resizing extension controls alone leaves fixture setup available`, async () => {
		const { session, calls } = createSession(browser)
		await session.setViewport(220, 700)
		await session.addPreloadScript('configured after extension resize')
		assert.deepEqual(calls, ['viewport', 'preload'])
	})

	test(`${ browser } a session resize freezes fixtures for an otherwise unused website`, async () => {
		const { session } = createSession(browser, true)
		await session.setViewport(220, 700)
		await assert.rejects(session.addPreloadScript('late'), /before using website documents/)
		await assert.rejects(session.routeResponses([]), /before using website documents/)
	})

	test(`${ browser } an implicit new extension-page resize freezes fixtures for other unused websites`, async () => {
		let websiteExists = false
		const url = `${ browser === 'chrome' ? 'chrome' : 'moz' }-extension://test/popup.html`
		const page = (id: string, pageUrl: string): ViewportDriverPage => ({ id, url: pageUrl, navigate: async () => undefined, evaluate: async () => undefined, reload: async () => undefined, setViewport: async () => undefined, captureScreenshot: async () => '', close: async () => undefined })
		const initial = page('initial', url)
		const popup = page('popup', url)
		const website = page('website', 'https://unused.test/')
		const session = withBrowserFixtureSetup({ browser, browserVersion: 'test', openPage: async (_url, _wait, prepare) => { await prepare(initial); return initial }, openExtensionPage: async (_path, prepare) => { await prepare(initial); return initial }, pages: async () => websiteExists ? [initial, popup, website] : [initial], addPreloadScript: async () => undefined, routeResponses: async () => undefined, close: async () => undefined })
		await session.setViewport(220, 700)
		websiteExists = true
		const discovered = (await session.pages()).find(({ id }) => id === popup.id)
		assert.ok(discovered)
		await session.addPreloadScript('enumeration is pure')
		await discovered.evaluate('document.title')
		await assert.rejects(session.routeResponses([]), /before using website documents/)
	})

	for (const operation of ['navigate', 'reload'] as const) {
		test(`${ browser } ${ operation } of a discovered website finalizes fixture setup`, async () => {
			const { session } = createSession(browser, true)
			const website = (await session.pages()).find(({ id }) => id === 'website')
			assert.ok(website)
			await session.routeResponses([{ url: 'https://fixture.test/', body: 'fixture' }])
			if (operation === 'navigate') await website.navigate('https://fixture.test/next')
			else await website.reload()
			await assert.rejects(session.addPreloadScript('late'), /before using website documents/)
		})
	}
}
