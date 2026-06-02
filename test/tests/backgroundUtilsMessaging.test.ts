import * as assert from 'assert'
import { describe, test } from 'bun:test'

const ASYNC_RESPONSE_CLOSED_MESSAGE = 'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'

function installBrowserMock(errorMessage: string) {
	const storageState: Record<string, unknown> = {}
	globalThis.browser = {
		runtime: {
			lastError: null,
			async sendMessage() {
				throw new Error(errorMessage)
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: {
				addListener: () => undefined,
				removeListener: () => undefined,
			},
			onConnect: {
				addListener: () => undefined,
				removeListener: () => undefined,
			},
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return { [keys]: storageState[keys] }
					return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
				},
			},
		},
		tabs: {
			async query() {
				return []
			},
			async get() {
				return undefined
			},
			async update() {
				return undefined
			},
			onUpdated: {
				addListener: () => undefined,
				removeListener: () => undefined,
			},
			onRemoved: {
				addListener: () => undefined,
				removeListener: () => undefined,
			},
		},
		windows: {
			async get() {
				return undefined
			},
			async update() {
				return undefined
			},
		},
		action: {
			async setIcon() {
				return undefined
			},
			async setTitle() {
				return undefined
			},
			async setBadgeText() {
				return undefined
			},
			async setBadgeBackgroundColor() {
				return undefined
			},
		},
		browserAction: {
			async setIcon() {
				return undefined
			},
			async setTitle() {
				return undefined
			},
			async setBadgeText() {
				return undefined
			},
			async setBadgeBackgroundColor() {
				return undefined
			},
		},
	} as unknown as typeof globalThis.browser
	;(globalThis as typeof globalThis & { chrome: { runtime: { id: string } } }).chrome = { runtime: { id: 'test-extension' } }
	return storageState
}

async function loadModules() {
	return {
		...(await import('../../app/ts/background/backgroundUtils.js')),
		...(await import('../../app/ts/background/storageVariables.js')),
		...(await import('../../app/ts/background/background.js')),
		...(await import('../../app/ts/types/interceptor-reply-messages.js')),
	}
}

async function withSilencedConsole<T>(runWithConsoleSilenced: () => Promise<T>) {
	const originalConsole = {
		error: console.error,
		trace: console.trace,
		warn: console.warn,
	}
	console.error = () => undefined
	console.trace = () => undefined
	console.warn = () => undefined
	try {
		return await runWithConsoleSilenced()
	} finally {
		console.error = originalConsole.error
		console.trace = originalConsole.trace
		console.warn = originalConsole.warn
	}
}

describe('backgroundUtils messaging', () => {
	test('ignore closed async response errors for popup fire-and-forget messages', async () => {
		const storageState = installBrowserMock(ASYNC_RESPONSE_CLOSED_MESSAGE)
		const { sendPopupMessageToBackgroundPage, getLatestUnexpectedError } = await loadModules()

		await sendPopupMessageToBackgroundPage({ method: 'popup_requestSettings' })
		assert.equal(storageState.latestUnexpectedError, undefined)
		assert.equal(await getLatestUnexpectedError(), undefined)
	})

	test('ignore closed async response errors when broadcasting to open popups', async () => {
		const storageState = installBrowserMock(ASYNC_RESPONSE_CLOSED_MESSAGE)
		const { sendPopupMessageToOpenWindows, getLatestUnexpectedError } = await loadModules()

		await sendPopupMessageToOpenWindows({
			method: 'popup_addressBookEntriesChanged',
		})

		assert.equal(storageState.latestUnexpectedError, undefined)
		assert.equal(await getLatestUnexpectedError(), undefined)
	})

	test('treat null popup replies as no reply without recording an unexpected error', async () => {
		const storageState = installBrowserMock('')
		globalThis.browser.runtime.sendMessage = async () => null
		const { sendPopupMessageWithReply, getLatestUnexpectedError } = await loadModules()

		const reply = await sendPopupMessageWithReply({
			method: 'popup_requestSimulationMode',
		})

		assert.equal(reply, undefined)
		assert.equal(storageState.latestUnexpectedError, undefined)
		assert.equal(await getLatestUnexpectedError(), undefined)
	})

	test('parses a normal popup reply round-trip', async () => {
		installBrowserMock('unused')
		const { sendPopupMessageWithReply, PopupRequestsReplies } = await loadModules()
		globalThis.browser.runtime.sendMessage = async () =>
			PopupRequestsReplies.popup_requestMakeMeRichData.serialize({
				method: 'popup_requestMakeMeRichData',
				richList: [],
				makeCurrentAddressRich: true,
			})

		const reply = await sendPopupMessageWithReply({
			method: 'popup_requestMakeMeRichData',
		})

		assert.deepEqual(reply, {
			method: 'popup_requestMakeMeRichData',
			richList: [],
			makeCurrentAddressRich: true,
		})
	})

	test('parses latest unexpected error replies with the requested reply parser', async () => {
		installBrowserMock('unused')
		const { sendPopupMessageWithReply, PopupRequestsReplies } = await loadModules()
		const timestamp = new Date('2024-01-01T00:00:00.000Z')
		globalThis.browser.runtime.sendMessage = async () =>
			PopupRequestsReplies.popup_requestLatestUnexpectedError.serialize({
				method: 'popup_requestLatestUnexpectedError',
				latestUnexpectedError: {
					method: 'popup_UnexpectedErrorOccured',
					data: {
						timestamp,
						message: 'boom',
						source: 'internal',
						code: 'unexpected_error',
						debugId: 'debug-1234',
					},
				},
			})

		const reply = await sendPopupMessageWithReply({
			method: 'popup_requestLatestUnexpectedError',
		})

		assert.equal(reply?.method, 'popup_requestLatestUnexpectedError')
		assert.equal(reply?.latestUnexpectedError?.data.message, 'boom')
		assert.equal(reply?.latestUnexpectedError?.data.timestamp.valueOf(), timestamp.valueOf())
		assert.equal(reply?.latestUnexpectedError?.data.source, 'internal')
		assert.equal(reply?.latestUnexpectedError?.data.code, 'unexpected_error')
		assert.equal(reply?.latestUnexpectedError?.data.debugId, 'debug-1234')
	})

	test('reports request-specific parse errors for mismatched popup replies', async () => {
		const storageState = installBrowserMock('unused')
		const { sendPopupMessageWithReply, PopupRequestsReplies, getLatestUnexpectedError } = await loadModules()
		globalThis.browser.runtime.sendMessage = async () =>
			PopupRequestsReplies.popup_requestSimulationMode.serialize({
				method: 'popup_requestSimulationMode',
				simulationMode: true,
			})

		const reply = await withSilencedConsole(
			async () =>
				await sendPopupMessageWithReply({
					method: 'popup_requestLatestUnexpectedError',
				}),
		)
		const latestUnexpectedError = await getLatestUnexpectedError()

		assert.equal(reply, undefined)
		assert.equal(typeof storageState.latestUnexpectedError, 'object')
		assert.equal(latestUnexpectedError?.method, 'popup_UnexpectedErrorOccured')
		assert.ok(latestUnexpectedError?.data.message.includes('popup_requestLatestUnexpectedError'))
		assert.ok(!latestUnexpectedError?.data.message.includes('popup_requestMakeMeRichData'))
	})

	test('returns the complete visualized simulation reply instead of dropping it', async () => {
		installBrowserMock('unused')
		globalThis.browser.runtime.sendMessage = async () => undefined
		const { popupMessageHandler, PopupRequestsReplies } = await loadModules()

		const reply = await popupMessageHandler(
			new Map() as unknown as import('../../app/ts/types/user-interface-types.js').WebsiteTabConnections,
			{} as unknown as import('../../app/ts/simulation/services/EthereumClientService.js').EthereumClientService,
			{} as unknown as import('../../app/ts/simulation/services/priceEstimator.js').TokenPriceService,
			(() => undefined) as unknown as import('../../app/ts/simulation/serviceLifecycle.js').ResetSimulationServices,
			{ method: 'popup_requestCompleteVisualizedSimulation' },
			{
				activeSimulationAddress: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
				openedPage: { page: 'Home' },
				useSignersAddressAsActiveAddress: false,
				websiteAccess: [],
				activeRpcNetwork: {
					name: 'Ethereum Mainnet',
					chainId: 1n,
					httpsRpc: 'https://ethereum.dark.florist',
					currencyName: 'Ether',
					currencyTicker: 'ETH',
					currencyLogoUri: '../img/ethereum.svg',
					primary: true,
					minimized: true,
				},
				simulationMode: true,
			},
		)

		const parsedReply = PopupRequestsReplies.popup_requestCompleteVisualizedSimulation.parse(reply)
		assert.equal(parsedReply.method, 'popup_requestCompleteVisualizedSimulation')
	})
})
