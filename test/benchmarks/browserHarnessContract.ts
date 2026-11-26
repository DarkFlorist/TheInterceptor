import * as assert from 'node:assert/strict'
import { launchBrowserSession, selectedBrowser, waitForExtensionPage } from './browserHarness.js'
import type { BrowserPage, BrowserSession } from './browserTypes.js'

async function verifyViewportAndScreenshot(session: BrowserSession, page: BrowserPage) {
	for (const { width, height } of [{ width: 220, height: 700 }, { width: 1280, height: 900 }]) {
		await session.setViewport(width, height)
		for (const current of await session.pages()) assert.deepEqual(await current.evaluate('[innerWidth, innerHeight]'), [width, height], 'Session viewport must resize every exposed page')
		assert.deepEqual(await page.evaluate('[innerWidth, innerHeight]'), [width, height], 'Viewport sizing must achieve exact content dimensions')
	}
	const screenshot = Buffer.from(await page.captureScreenshot(), 'base64')
	assert.equal(screenshot.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Both website and privileged extension pages must return real PNG screenshots')
}

// This is a harness integration check, independent of provider injection and wallet behavior. The server's fallback makes missed fixture interception observable.
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<!doctype html>Unrouted fixture', { status: 404 }) })
try {
	const session = await launchBrowserSession(selectedBrowser())
	try {
		const control = await session.openExtensionPage('html/popup.html?browser-fixture-control')
		try {
			const fixture = await waitForExtensionPage(session, 'popup.html?browser-fixture-control')
			assert.equal(fixture.id, control.id)
			await verifyViewportAndScreenshot(session, fixture)
			assert.deepEqual(await fixture.evaluate('Promise.resolve({ browserContract: [1, true, "value"] })'), { browserContract: [1, true, 'value'] })
			assert.equal(await fixture.evaluate('(() => { const value = 2; return value + 1 })()'), 3)
			assert.equal(await fixture.evaluate('undefined'), undefined)
			await assert.rejects(fixture.evaluate('const value = 1; value'), 'Statement-form source must reject in both engines')
			await assert.rejects(fixture.evaluate('1n'), 'A BigInt result must reject in both engines')
			const fixtureUrl = `${ server.url.origin }/browser-fixture-setup`
			await session.addPreloadScript('globalThis.browserFixturePreloaded = true')
			const decoyRoutes = [{ url: fixtureUrl, body: '<!doctype html><script>globalThis.browserFixtureLoaded = false</script>' }]
			await session.routeResponses(decoyRoutes)
			await control.reload()
			await session.routeResponses([])
			await control.reload()
			await session.routeResponses(decoyRoutes)
			await session.routeResponses([{ url: fixtureUrl, body: '<!doctype html><script>globalThis.browserFixtureStartupViewport = [innerWidth, innerHeight]; globalThis.browserFixtureLoaded = globalThis.browserFixturePreloaded === true</script>' }])
			const startupPage = await session.openPage(fixtureUrl)
			try {
				assert.deepEqual(await startupPage.evaluate('globalThis.browserFixtureStartupViewport'), [1280, 900], 'Driver-opened documents must receive the session viewport before their first script')
			} finally { await startupPage.close() }
			const future = await session.openExtensionPage('html/popup.html?future-viewport')
			try {
				assert.deepEqual(await future.evaluate('[innerWidth, innerHeight]'), [1280, 900], 'Future pages must inherit the session viewport before return')
				await session.setViewport(220, 700)
				assert.deepEqual(await fixture.evaluate('[innerWidth, innerHeight]'), [220, 700])
				assert.deepEqual(await future.evaluate('[innerWidth, innerHeight]'), [220, 700])
			} finally { await future.close() }
			await fixture.navigate(fixtureUrl)
			await verifyViewportAndScreenshot(session, fixture)
			assert.equal(await fixture.evaluate('globalThis.browserFixtureLoaded'), true)
			await assert.rejects(session.addPreloadScript('throw new Error("late fixture")'), /before using website documents/)
			await assert.rejects(session.routeResponses([]), /before using website documents/)
			const discovered = (await session.pages()).find(({ id }) => id === fixture.id)
			assert.ok(discovered, 'Fixture page was not enumerated')
			await discovered.reload()
			assert.equal(await discovered.evaluate('globalThis.browserFixtureLoaded'), true)
			console.warn(`${ session.browser } browser harness fixture contract passed (${ session.browserVersion })`)
		} finally { await control.close() }
	} finally { await session.close() }
} finally { await server.stop(true) }
