import * as assert from 'node:assert'
import { afterAll, afterEach, describe, test } from 'bun:test'
import { replaceGlobal, replaceProperty } from '../harness/globals.js'
import { createPerTestRestorer } from '../harness/perTest.js'

const fetchCalls: string[] = []
const warnings: string[] = []
const { installBrowserMockForTest, restoreAfterTest } = createPerTestRestorer()

function installSuccessfulFileReader(result: string) {
	function SuccessfulFileReader(this: { result: string | undefined, onabort?: () => void, onerror?: () => void, onloadend?: () => void, readAsDataURL: (_blob: Blob) => void }) {
		this.result = undefined
		this.readAsDataURL = () => {
			this.result = result
			this.onloadend?.()
		}
	}

	restoreAfterTest(replaceGlobal('FileReader', SuccessfulFileReader))
}

const restoreFileLevelGlobals = [
	replaceGlobal('fetch', async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
		fetchCalls.push(url)
		return new Response(new Blob(['icon'], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } })
	}),
	replaceGlobal('createImageBitmap', async () => ({ width: 16, height: 16, close: () => undefined })),
	replaceProperty(console, 'warn', (...args: unknown[]) => {
		warnings.push(args.map((arg) => String(arg)).join(' '))
	}),
]

afterEach(() => {
	fetchCalls.splice(0, fetchCalls.length)
	warnings.splice(0, warnings.length)
})

afterAll(() => {
	for (const restore of restoreFileLevelGlobals.reverse()) restore()
})

const { addBlockingShieldToIcon, retrieveWebsiteDetails } = await import('../../app/ts/background/iconHandler.js')
const { TabIcon } = await import('../../app/ts/types/user-interface-types.js')
const { parseTabStateItems } = await import('../../app/ts/utils/storageUtils.js')

describe('blocking shield icon selection', () => {
	test('maps every valid icon to its blocking equivalent without double shielding', () => {
		const expectedBlockingIcons = new Map([
			['../img/head.png', '../img/head-shield.png'],
			['../img/head-access-denied.png', '../img/head-access-denied.png'],
			['../img/head-not-active.png', '../img/head-not-active-shield.png'],
			['../img/head-simulating.png', '../img/head-simulating-shield.png'],
			['../img/head-signing.png', '../img/head-signing-shield.png'],
			['../img/head-signing-unsupported-network.png', '../img/head-signing-unsupported-network-shield.png'],
			['../img/head-interceptor-disabled.png', '../img/head-interceptor-disabled.png'],
			['../img/head-shield.png', '../img/head-shield.png'],
			['../img/head-not-active-shield.png', '../img/head-not-active-shield.png'],
			['../img/head-simulating-shield.png', '../img/head-simulating-shield.png'],
			['../img/head-signing-shield.png', '../img/head-signing-shield.png'],
			['../img/head-signing-unsupported-network-shield.png', '../img/head-signing-unsupported-network-shield.png'],
		] as const)
		for (const [icon, expectedBlockingIcon] of expectedBlockingIcons) {
			assert.equal(addBlockingShieldToIcon(TabIcon.parse(icon)), expectedBlockingIcon, icon)
		}
	})

	test('rejects the nonexistent access-denied shield icon', () => {
		assert.equal(TabIcon.safeParse('../img/head-access-denied-shield.png').success, false)
	})

	test('normalizes a previously stored access-denied shield icon', () => {
		const { tabState_1: storedTabState } = parseTabStateItems({
			tabState_1: {
				tabId: 1,
				website: undefined,
				signerConnected: false,
				signerName: 'NoSignerDetected',
				signerAccounts: [],
				signerAccountError: undefined,
				signerChain: undefined,
				tabIconDetails: {
					icon: '../img/head-access-denied-shield.png',
					iconReason: 'Denied',
				},
				activeSigningAddress: undefined,
			},
		})
		assert.equal(storedTabState?.tabIconDetails.icon, '../img/head-access-denied.png')
	})
})

describe('retrieveWebsiteDetails favicon handling', () => {
	test('rethrows unexpected tab lookup failures', async () => {
		const browserMock = installBrowserMockForTest()
		browserMock.browser.tabs.get = async () => { throw new Error('tabs permission missing') }

		await assert.rejects(async () => await retrieveWebsiteDetails(13), /tabs permission missing/)
		assert.equal(browserMock.browser.tabs.onUpdated.hasListeners(), false)
	})

	test('returns no icon and does not fetch when favIconUrl is undefined', async () => {
		installBrowserMockForTest({ tabs: [{ id: 1, status: 'complete', title: 'Undefined favicon', url: 'https://undefined.test' }] })

		const result = await retrieveWebsiteDetails(1)

		assert.deepEqual(result, { title: 'Undefined favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.equal(warnings.length, 0)
	})

	test('returns no icon and does not fetch when favIconUrl is empty', async () => {
		installBrowserMockForTest({ tabs: [{ id: 2, status: 'complete', title: 'Empty favicon', url: 'https://empty.test', favIconUrl: '' }] })

		const result = await retrieveWebsiteDetails(2)

		assert.deepEqual(result, { title: 'Empty favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.equal(warnings.length, 0)
	})

	test('warns for unsupported favicon schemes', async () => {
		installBrowserMockForTest({ tabs: [{ id: 3, status: 'complete', title: 'Unsupported favicon', url: 'https://scheme.test', favIconUrl: 'chrome://branding/content/icon32.png' }] })

		const result = await retrieveWebsiteDetails(3)

		assert.deepEqual(result, { title: 'Unsupported favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.deepEqual(warnings, [
			'Failed to load favicon for tab 3 (https://scheme.test): unsupported URL scheme chrome:'
		])
	})

	test('rejects file favicon urls', async () => {
		installBrowserMockForTest({ tabs: [{ id: 6, status: 'complete', title: 'File favicon', url: 'https://file.test', favIconUrl: 'file:///etc/passwd' }] })

		const result = await retrieveWebsiteDetails(6)

		assert.deepEqual(result, { title: 'File favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.deepEqual(warnings, [
			'Failed to load favicon for tab 6 (https://file.test): unsupported URL scheme file:'
		])
	})

	test('fetches same-origin favicon urls once for stored websites that are missing an icon', async () => {
		installSuccessfulFileReader('data:image/png;base64,b2s=')
		installBrowserMockForTest({
			storage: { local: { websiteAccess: [{
				website: { websiteOrigin: 'same-origin.test', icon: undefined, title: 'Same origin favicon' },
				access: true,
			}] } },
			tabs: [{ id: 4, status: 'complete', title: 'Same origin favicon', url: 'https://same-origin.test/page', favIconUrl: '/favicon.png' }],
		})

		const result = await retrieveWebsiteDetails(4, 'same-origin.test')

		assert.deepEqual(result, { title: 'Same origin favicon', icon: 'data:image/png;base64,b2s=' })
		assert.deepEqual(fetchCalls, ['https://same-origin.test/favicon.png'])
		assert.equal(warnings.length, 0)
	})

	test('does not fetch same-origin favicon urls for websites without stored access', async () => {
		installSuccessfulFileReader('data:image/png;base64,b2s=')
		const browserMock = installBrowserMockForTest({ tabs: [{ id: 11, status: 'complete', title: 'Untracked favicon', url: 'https://untracked.test/page', favIconUrl: '/favicon.png' }] })

		const result = await retrieveWebsiteDetails(11, 'untracked.test')

		assert.deepEqual(result, { title: 'Untracked favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.equal(warnings.length, 0)
		assert.equal(browserMock.browser.tabs.onUpdated.hasListeners(), false)
	})

	test('reuses cached favicon data urls without refetching them', async () => {
		const browserMock = installBrowserMockForTest({
			storage: { local: { websiteAccess: [{
				website: { websiteOrigin: 'cached.test', icon: 'data:image/png;base64,Y2FjaGVk', title: 'Cached favicon' },
				access: true,
			}] } },
			tabs: [{ id: 8, status: 'complete', title: 'Cached favicon', url: 'https://cached.test/page', favIconUrl: '/favicon.png' }],
		})

		const result = await retrieveWebsiteDetails(8, 'cached.test')

		assert.deepEqual(result, { title: 'Cached favicon', icon: 'data:image/png;base64,Y2FjaGVk' })
		assert.equal(fetchCalls.length, 0)
		assert.equal(warnings.length, 0)
		assert.equal(browserMock.browser.tabs.onUpdated.hasListeners(), false)
	})

	test('allows image data url favicons for stored websites without fetching them in the background', async () => {
		installBrowserMockForTest({
			storage: { local: { websiteAccess: [{
				website: { websiteOrigin: 'data-icon.test', icon: undefined, title: 'Data favicon' },
				access: true,
			}] } },
			tabs: [{ id: 7, status: 'complete', title: 'Data favicon', url: 'https://data-icon.test/page', favIconUrl: 'data:image/png;base64,Zm9v' }],
		})

		const result = await retrieveWebsiteDetails(7, 'data-icon.test')

		assert.deepEqual(result, { title: 'Data favicon', icon: 'data:image/png;base64,Zm9v' })
		assert.equal(fetchCalls.length, 0)
		assert.equal(warnings.length, 0)
	})

	test('does not store data url favicons for websites without stored access', async () => {
		installBrowserMockForTest({ tabs: [{ id: 12, status: 'complete', title: 'Untracked data favicon', url: 'https://untracked-data.test/page', favIconUrl: 'data:image/png;base64,Zm9v' }] })

		const result = await retrieveWebsiteDetails(12, 'untracked-data.test')

		assert.deepEqual(result, { title: 'Untracked data favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.equal(warnings.length, 0)
	})

	test('rejects non-image data url favicons', async () => {
		installBrowserMockForTest({ tabs: [{ id: 9, status: 'complete', title: 'HTML favicon', url: 'https://html-icon.test/page', favIconUrl: 'data:text/html;base64,Zm9v' }] })

		const result = await retrieveWebsiteDetails(9)

		assert.deepEqual(result, { title: 'HTML favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.deepEqual(warnings, [
			'Failed to load favicon for tab 9 (https://html-icon.test/page): favicon data URL was not an image or exceeded the size limit'
		])
	})

	test('rejects oversized data url favicons', async () => {
		installBrowserMockForTest({ tabs: [{ id: 10, status: 'complete', title: 'Oversized favicon', url: 'https://oversized-icon.test/page', favIconUrl: `data:image/png;base64,${ 'a'.repeat(1_048_576) }` }] })

		const result = await retrieveWebsiteDetails(10)

		assert.deepEqual(result, { title: 'Oversized favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.deepEqual(warnings, [
			'Failed to load favicon for tab 10 (https://oversized-icon.test/page): favicon data URL was not an image or exceeded the size limit'
		])
	})

	test('rejects cross-origin favicon urls without fetching them in the background', async () => {
		installBrowserMockForTest({ tabs: [{ id: 5, status: 'complete', title: 'Cross origin favicon', url: 'https://page.test/app', favIconUrl: 'https://cdn.test/favicon.png' }] })

		const firstResult = await retrieveWebsiteDetails(5)
		const secondResult = await retrieveWebsiteDetails(5)

		assert.deepEqual(firstResult, { title: 'Cross origin favicon', icon: undefined })
		assert.deepEqual(secondResult, { title: 'Cross origin favicon', icon: undefined })
		assert.equal(fetchCalls.length, 0)
		assert.deepEqual(warnings, [
			'Failed to load favicon for tab 5 (https://page.test/app): favicon origin https://cdn.test did not match page origin https://page.test',
			'Failed to load favicon for tab 5 (https://page.test/app): favicon origin https://cdn.test did not match page origin https://page.test'
		])
	})
})
