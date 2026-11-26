import * as assert from 'node:assert/strict'
import { test } from 'bun:test'
import { withSessionViewport, type ViewportDriverPage, type ViewportDriverSession } from '../benchmarks/browserViewport.js'

for (const browser of ['chrome', 'firefox'] as const) {
	test(`${ browser } exposes one viewport for existing and future session pages`, async () => {
		const sizes = new Map<string, number[]>()
		const resizeCounts = new Map<string, number>()
		const startupSizes = new Map<string, number[] | undefined>()
		const pages: ViewportDriverPage[] = []
		const createPage = async (url: string) => {
			const id = String(pages.length)
			const page: ViewportDriverPage = { id, url, navigate: async () => undefined, reload: async () => undefined, evaluate: async () => undefined, captureScreenshot: async () => 'png', close: async () => undefined, setViewport: async (width, height) => { sizes.set(id, [width, height]); resizeCounts.set(id, (resizeCounts.get(id) ?? 0) + 1) } }
			pages.push(page)
			return page
		}
		const driver: ViewportDriverSession = { browser, browserVersion: 'test', openPage: async (url, _wait, prepare) => { const page = await createPage(url); await prepare(page); startupSizes.set(page.id, sizes.get(page.id)); return page }, openExtensionPage: async (url, prepare) => { const page = await createPage(url); await prepare(page); startupSizes.set(page.id, sizes.get(page.id)); return page }, pages: async () => pages, addPreloadScript: async () => undefined, routeResponses: async () => undefined, close: async () => undefined }
		const session = withSessionViewport(driver)
		const first = await session.openPage('https://fixture.test/')
		await session.setViewport(220, 700)
		const future = await session.openExtensionPage('popup')
		assert.deepEqual(sizes.get(first.id), [220, 700])
		assert.deepEqual(sizes.get(future.id), [220, 700])
		assert.deepEqual(startupSizes.get(future.id), [220, 700], 'Driver factories must receive the viewport preparation before starting the document')
		assert.equal('setViewport' in first, false, 'Page geometry must not advertise an independently scoped operation')
		const popup = await createPage('popup-created-outside-the-harness')
		const enumerated = await session.pages()
		assert.equal(sizes.has(popup.id), false, 'Enumeration must not mutate newly discovered documents')
		await enumerated.find(({ id }) => id === popup.id)?.evaluate('innerWidth')
		assert.deepEqual(sizes.get(popup.id), [220, 700])
		await first.evaluate('innerHeight')
		await future.captureScreenshot()
		await session.pages()
		assert.deepEqual([...resizeCounts.values()], [1, 1, 1], 'Polling and repeated page interactions must not reapply an unchanged viewport')
		await session.setViewport(1280, 900)
		assert.deepEqual([...sizes.values()], [[1280, 900], [1280, 900], [1280, 900]])
		assert.equal(await future.captureScreenshot(), 'png')
	})
}

test('viewport defaults work before any page exists, and invalid requests never reach a driver', async () => {
	const session = withSessionViewport({ browser: 'chrome', browserVersion: 'test', openPage: async () => { throw new Error('unused') }, openExtensionPage: async () => { throw new Error('unused') }, pages: async () => [], addPreloadScript: async () => undefined, routeResponses: async () => undefined, close: async () => undefined })
	await session.setViewport(220, 700)
	for (const width of [0, -1, 1.5, Number.NaN]) await assert.rejects(session.setViewport(width, 700), /positive safe integers/)
})
