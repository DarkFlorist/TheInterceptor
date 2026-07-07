import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { addressString, checksummedAddress } from '../../app/ts/utils/bigint.js'
import { ETHEREUM_LOGS_LOGGER_ADDRESS, MAKE_YOU_RICH_TRANSACTION } from '../../app/ts/utils/constants.js'

const defineGlobal = (name: PropertyKey, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })

function installBrowserMock(options: { onRuntimeSendMessage?: () => void } = {}) {
	const storageState: Record<string, unknown> = {}
	defineGlobal('browser', {
		runtime: {
			lastError: null,
			async sendMessage() {
				options.onRuntimeSendMessage?.()
				return undefined
			},
			getManifest: () => ({ manifest_version: 3 }),
			onMessage: { addListener: () => undefined, removeListener: () => undefined },
			onConnect: { addListener: () => undefined, removeListener: () => undefined },
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
			async query() { return [] },
			async get() { return undefined },
			async update() { return undefined },
			onUpdated: { addListener: () => undefined, removeListener: () => undefined },
			onRemoved: { addListener: () => undefined, removeListener: () => undefined },
		},
		windows: {
			async get() { return undefined },
			async update() { return undefined },
		},
		action: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
		browserAction: {
			async setIcon() { return undefined },
			async setTitle() { return undefined },
			async setBadgeText() { return undefined },
			async setBadgeBackgroundColor() { return undefined },
		},
	})
	defineGlobal('chrome', { runtime: { id: 'test-extension' } })
	return storageState
}

async function loadModules() {
	return {
		...await import('../../app/ts/background/popupMessageHandlers.js'),
		...await import('../../app/ts/background/settings.js'),
		...await import('../../app/ts/background/simulationUpdating.js'),
		...await import('../../app/ts/background/storageVariables.js'),
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

describe('requestMakeMeRichList resilience', () => {
	test('serializes rapid rich-list changes without duplicating addresses', async () => {
		const storageState = installBrowserMock()
		const { modifyMakeMeRich, setFixedMakeMeRichList, getFixedAddressRichList } = await loadModules()
		const address = 0x2000000000000000000000000000000000000002n

		await setFixedMakeMeRichList([])
		await Promise.all([
			modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address } }),
			modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address } }),
			modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address } }),
		])

		assert.deepEqual(await getFixedAddressRichList(), [{ address, makingRich: true, type: 'UserAdded' }])
		assert.deepEqual(storageState.fixedAddressRichList, [{ address: checksummedAddress(address), makingRich: true, type: 'UserAdded' }])
	})

	test('preserves user rich-list changes during previous active address tracking', async () => {
		installBrowserMock()
		const { modifyMakeMeRich, setFixedMakeMeRichList, getFixedAddressRichList, trackPreviousActiveAddressForMakeMeRichList } = await loadModules()
		const userAddedAddress = 0x3000000000000000000000000000000000000003n
		const previousActiveAddress = 0x4000000000000000000000000000000000000004n

		await setFixedMakeMeRichList([])
		await Promise.all([
			modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address: userAddedAddress } }),
			trackPreviousActiveAddressForMakeMeRichList(previousActiveAddress),
		])

		assert.deepEqual(await getFixedAddressRichList(), [
			{ address: userAddedAddress, makingRich: true, type: 'UserAdded' },
			{ address: previousActiveAddress, makingRich: false, type: 'PreviousActiveAddress' },
		])
	})

	test('skips popup visualisation refresh when current-address rich setting changes', async () => {
		let runtimeSendMessageCount = 0
		installBrowserMock({ onRuntimeSendMessage: () => { runtimeSendMessageCount += 1 } })
		const { modifyMakeMeRich, getMakeCurrentAddressRich } = await loadModules()

		await modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address: 'CurrentAddress' } })

		assert.equal(await getMakeCurrentAddressRich(), true)
		assert.equal(runtimeSendMessageCount, 0)
	})

	test('keeps existing rich address position and skips refresh when adding it again', async () => {
		let runtimeSendMessageCount = 0
		installBrowserMock({ onRuntimeSendMessage: () => { runtimeSendMessageCount += 1 } })
		const { modifyMakeMeRich, setFixedMakeMeRichList, getFixedAddressRichList } = await loadModules()
		const existingAddress = 0x5000000000000000000000000000000000000005n
		const laterAddress = 0x6000000000000000000000000000000000000006n

		await setFixedMakeMeRichList([
			{ address: existingAddress, makingRich: true, type: 'UserAdded' },
			{ address: laterAddress, makingRich: false, type: 'PreviousActiveAddress' },
		])
		await modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address: existingAddress } })

		assert.deepEqual(await getFixedAddressRichList(), [
			{ address: existingAddress, makingRich: true, type: 'UserAdded' },
			{ address: laterAddress, makingRich: false, type: 'PreviousActiveAddress' },
		])
		assert.equal(runtimeSendMessageCount, 0)
	})

	test('includes changed rich addresses in the next simulation input without a popup refresh', async () => {
		let runtimeSendMessageCount = 0
		installBrowserMock({ onRuntimeSendMessage: () => { runtimeSendMessageCount += 1 } })
		const { modifyMakeMeRich, getCurrentSimulationInput } = await loadModules()
		const richAddress = 0x7000000000000000000000000000000000000007n

		await modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address: richAddress } })

		const simulationInput = await getCurrentSimulationInput()
		assert.deepEqual(simulationInput[0]?.stateOverrides[addressString(richAddress)], { balance: MAKE_YOU_RICH_TRANSACTION.transaction.value })
		assert.equal(runtimeSendMessageCount, 0)
	})

	test('includes current-address rich mode in the next simulation input without a popup refresh', async () => {
		let runtimeSendMessageCount = 0
		installBrowserMock({ onRuntimeSendMessage: () => { runtimeSendMessageCount += 1 } })
		const { modifyMakeMeRich, changeSimulationMode, getCurrentSimulationInput } = await loadModules()
		const activeAddress = 0x8000000000000000000000000000000000000008n

		await changeSimulationMode({ simulationMode: true, activeSimulationAddress: activeAddress })
		await modifyMakeMeRich({ method: 'popup_modifyMakeMeRich', data: { add: true, address: 'CurrentAddress' } })

		const simulationInput = await getCurrentSimulationInput()
		assert.deepEqual(simulationInput[0]?.stateOverrides[addressString(activeAddress)], { balance: MAKE_YOU_RICH_TRANSACTION.transaction.value })
		assert.equal(runtimeSendMessageCount, 0)
	})

	test('falls back per address and preserves the underlying error message', async () => {
		const storageState = installBrowserMock()
		const { requestMakeMeRichList, setFixedMakeMeRichList, setMakeCurrentAddressRich, getInterceptorErrorDiagnostics, getLatestUnexpectedError } = await loadModules()
		const failingAddress = 0x1000000000000000000000000000000000000001n

		await setFixedMakeMeRichList([
			{ address: ETHEREUM_LOGS_LOGGER_ADDRESS, makingRich: true, type: 'UserAdded' },
			{ address: failingAddress, makingRich: false, type: 'PreviousActiveAddress' },
		])
		await setMakeCurrentAddressRich(true)

		const ethereumClientService = {
			getRpcEntry: () => undefined,
			getCode: async (address: bigint) => {
				if (address === failingAddress) throw new Error('boom')
				return new Uint8Array()
			},
			getChainId: () => 1n,
		}

		const reply = await withSilencedConsole(async () => await requestMakeMeRichList(ethereumClientService, undefined))
		assert.equal(reply.method, 'popup_requestMakeMeRichData')
		assert.equal(reply.makeCurrentAddressRich, true)
		assert.equal(reply.richList.length, 2)
		assert.equal(reply.richList[0]?.addressBookEntry.address, ETHEREUM_LOGS_LOGGER_ADDRESS)
		assert.equal(reply.richList[1]?.addressBookEntry.type, 'contact')
		assert.equal(reply.richList[1]?.addressBookEntry.name, checksummedAddress(failingAddress))
		assert.equal(reply.richList[1]?.makingRich, false)
		assert.equal(reply.richList[1]?.type, 'PreviousActiveAddress')
		assert.equal((await getLatestUnexpectedError())?.data.message, `Failed to identify rich list address ${ checksummedAddress(failingAddress) }: boom`)
		const diagnostics = await getInterceptorErrorDiagnostics()
		assert.equal(diagnostics.length, 1)
		assert.equal(diagnostics[0]?.cause, 'boom')
		assert.equal(diagnostics[0]?.details?.includes(checksummedAddress(failingAddress)), true)
		assert.equal(typeof storageState.latestUnexpectedError, 'object')
	})

	test('recovers from corrupt fixed rich list storage by resetting it to an empty list', async () => {
		const storageState = installBrowserMock()
		const { getFixedAddressRichList } = await loadModules()
		storageState.fixedAddressRichList = [{ address: null, makingRich: true, type: 'UserAdded' }]

		const richList = await withSilencedConsole(async () => await getFixedAddressRichList())
		assert.deepEqual(richList, [])
		assert.deepEqual(storageState.fixedAddressRichList, [])
	})

	test('recovers from corrupt makeCurrentAddressRich storage by resetting it to false', async () => {
		const storageState = installBrowserMock()
		const { requestMakeMeRichList } = await loadModules()
		storageState.makeCurrentAddressRich = null

		const reply = await withSilencedConsole(async () => await requestMakeMeRichList({}, undefined))

		assert.equal(reply.method, 'popup_requestMakeMeRichData')
		assert.equal(reply.makeCurrentAddressRich, false)
		assert.equal(storageState.makeCurrentAddressRich, false)
	})
})

describe('startup storage recovery', () => {
	test('recovers active addresses from corrupt user address book storage', async () => {
		const storageState = installBrowserMock()
		const { requestActiveAddresses, defaultActiveAddresses, getUserAddressBookEntries } = await loadModules()
		storageState.userAddressBookEntriesV3 = null

		const reply = await withSilencedConsole(async () => await requestActiveAddresses())

		assert.equal(reply.method, 'popup_requestActiveAddresses')
		assert.deepEqual(reply.activeAddresses, defaultActiveAddresses)
		assert.ok(Array.isArray(storageState.userAddressBookEntriesV3))
		assert.deepEqual(await getUserAddressBookEntries(), defaultActiveAddresses)
	})

	test('recovers latest unexpected error from corrupt storage by clearing it', async () => {
		const storageState = installBrowserMock()
		const { requestLatestUnexpectedError } = await loadModules()
		storageState.latestUnexpectedError = null

		const reply = await withSilencedConsole(async () => await requestLatestUnexpectedError())

		assert.equal(reply.method, 'popup_requestLatestUnexpectedError')
		assert.equal(reply.latestUnexpectedError, undefined)
		assert.equal(storageState.latestUnexpectedError, undefined)
	})

	test('recovers simulationMode from corrupt settings storage', async () => {
		const storageState = installBrowserMock()
		const { requestSimulationMode } = await loadModules()
		storageState.simulationMode = 'invalid'

		const reply = await withSilencedConsole(async () => await requestSimulationMode())

		assert.equal(reply.method, 'popup_requestSimulationMode')
		assert.equal(reply.simulationMode, true)
		assert.equal(storageState.simulationMode, true)
	})

	test('recovers corrupt websiteAccess without resetting valid settings keys', async () => {
		const storageState = installBrowserMock()
		const { getSettings } = await loadModules()
		storageState.websiteAccess = [null]
		storageState.simulationMode = false

		const settings = await withSilencedConsole(async () => await getSettings())

		assert.deepEqual(settings.websiteAccess, [])
		assert.equal(settings.simulationMode, false)
		assert.deepEqual(storageState.websiteAccess, [])
		assert.equal(storageState.simulationMode, false)
	})

	test('sanitizes remote website access icons in returned settings without mutating storage', async () => {
		const storageState = installBrowserMock()
		const { getSettings, getWebsiteAccess } = await loadModules()
		storageState.websiteAccess = [
			{ website: { websiteOrigin: 'remote.example', icon: 'https://remote.example/favicon.png', title: 'Remote' }, access: true },
			{ website: { websiteOrigin: 'cached.example', icon: 'data:image/png;base64,Y2FjaGVk', title: 'Cached' }, access: true },
		]

		const settings = await withSilencedConsole(async () => await getSettings())
		const websiteAccess = await withSilencedConsole(async () => await getWebsiteAccess())

		assert.equal(settings.websiteAccess[0]?.website.icon, undefined)
		assert.equal(settings.websiteAccess[1]?.website.icon, 'data:image/png;base64,Y2FjaGVk')
		assert.equal(websiteAccess[0]?.website.icon, undefined)
		assert.equal(websiteAccess[1]?.website.icon, 'data:image/png;base64,Y2FjaGVk')
		assert.equal(Array.isArray(storageState.websiteAccess), true)
		if (!Array.isArray(storageState.websiteAccess)) throw new Error('Expected websiteAccess to remain an array')
		assert.equal(storageState.websiteAccess[0]?.website.icon, 'https://remote.example/favicon.png')
		assert.equal(storageState.websiteAccess[1]?.website.icon, 'data:image/png;base64,Y2FjaGVk')
	})

	test('recovers corrupt openedPageV2 without resetting valid settings keys', async () => {
		const storageState = installBrowserMock()
		const { getSettings } = await loadModules()
		storageState.openedPageV2 = null
		storageState.useSignersAddressAsActiveAddress = true

		const settings = await withSilencedConsole(async () => await getSettings())

		assert.deepEqual(settings.openedPage, { page: 'Home' })
		assert.equal(settings.useSignersAddressAsActiveAddress, true)
		assert.deepEqual(storageState.openedPageV2, { page: 'Home' })
		assert.equal(storageState.useSignersAddressAsActiveAddress, true)
	})
})
