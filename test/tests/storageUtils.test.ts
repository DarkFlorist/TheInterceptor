import * as assert from 'assert'
import { beforeEach, describe, test } from 'bun:test'
import type { RpcEntry } from '../../app/ts/types/rpc.js'

const storedItems: Record<string, unknown> = {}
const writes: Record<string, unknown>[] = []
const runtimeMessages: unknown[] = []
let nextStorageReadError: Error | undefined
let rpcConfigurationReadCount = 0
let failRpcConfigurationReadAt: number | undefined
let rpcConfigurationReadStarted: (() => void) | undefined
let resumeRpcConfigurationRead: Promise<void> | undefined

Object.defineProperty(globalThis, 'browser', {
	configurable: true,
	writable: true,
	value: {
		runtime: {
			lastError: undefined,
			sendMessage: async (message: unknown) => { runtimeMessages.push(message) },
		},
		storage: {
			local: {
				get: async (keys: string | readonly string[]) => {
					const requestedKeys = Array.isArray(keys) ? keys : [keys]
					const result = Object.fromEntries(requestedKeys.filter((key) => key in storedItems).map((key) => [key, storedItems[key]]))
					if (requestedKeys.includes('rpcEntries') && requestedKeys.includes('activeRpcNetwork')) {
						rpcConfigurationReadCount += 1
						if (rpcConfigurationReadCount === failRpcConfigurationReadAt) throw new Error('RPC configuration read failed')
						rpcConfigurationReadStarted?.()
						await resumeRpcConfigurationRead
					}
					if (nextStorageReadError !== undefined) {
						const error = nextStorageReadError
						nextStorageReadError = undefined
						throw error
					}
					return result
				},
				set: async (items: Record<string, unknown>) => {
					writes.push(items)
					Object.assign(storedItems, items)
				},
				remove: async () => undefined,
			},
		},
	},
})
Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: { runtime: { id: 'test-extension' } } })

const { browserStorageLocalGet, browserStorageLocalSet } = await import('../../app/ts/utils/storageUtils.js')
const { getRpcConfigurationState, getRpcConnectionStatus, getRpcList, promoteRpcAsPrimary, setRpcConfiguration } = await import('../../app/ts/background/storageVariables.js')
const { createSimulationServicesOwner } = await import('../../app/ts/simulation/serviceLifecycle.js')
const { getSettings } = await import('../../app/ts/background/settings.js')
const { restoreDefaultRpcConfiguration, retryRpcConfiguration, setNewRpcList, settingsOpened } = await import('../../app/ts/background/popupMessageHandlers/settings.js')
const { MessageToPopup } = await import('../../app/ts/types/interceptor-messages.js')
const ignoreRecoveryPublication = async () => undefined

describe('local storage codecs', () => {
	beforeEach(() => {
		for (const key of Object.keys(storedItems)) delete storedItems[key]
		writes.length = 0
		runtimeMessages.length = 0
		nextStorageReadError = undefined
		rpcConfigurationReadCount = 0
		failRpcConfigurationReadAt = undefined
		rpcConfigurationReadStarted = undefined
		resumeRpcConfigurationRead = undefined
	})

	test('serializes only present active-address properties, including explicit clears', async () => {
		await browserStorageLocalSet({ activeSigningAddress: undefined, activeSigningSafeAddress: 2n, independentActiveSimulationAddress: 1n })
		assert.deepEqual(writes[0], {
			activeSigningAddress: 'missing',
			activeSigningSafeAddress: '0x0000000000000000000000000000000000000002',
			independentActiveSimulationAddress: '0x0000000000000000000000000000000000000001',
		})

		await browserStorageLocalSet({ simulationMode: true })
		assert.deepEqual(writes[1], { simulationMode: true })
		assert.deepEqual(await browserStorageLocalGet(['activeSigningAddress', 'activeSigningSafeAddress', 'independentActiveSimulationAddress']), {
			activeSigningAddress: undefined,
			activeSigningSafeAddress: 2n,
			independentActiveSimulationAddress: 1n,
		}, ignoreRecoveryPublication)
	})

	test('distinguishes absent, explicitly cleared, and corrupt active-address properties', async () => {
		assert.deepEqual(await browserStorageLocalGet('activeSigningAddress'), {})

		storedItems.activeSigningAddress = 'missing'
		assert.deepEqual(await browserStorageLocalGet('activeSigningAddress'), { activeSigningAddress: undefined })

		storedItems.activeSigningAddress = 'not-an-address'
		await assert.rejects(browserStorageLocalGet('activeSigningAddress'))
	})
})

describe('RPC storage recovery', () => {
	const customPrimaryRpc: RpcEntry = {
		name: 'Custom primary',
		chainId: 1n,
		httpsRpc: 'https://primary.example',
		currencyName: 'Ether',
		currencyTicker: 'ETH',
		primary: true,
		minimized: true,
	}
	const customFallbackRpc: RpcEntry = {
		...customPrimaryRpc,
		name: 'Custom fallback',
		httpsRpc: 'https://fallback.example',
		primary: false,
	}

	beforeEach(async () => {
		for (const key of Object.keys(storedItems)) delete storedItems[key]
		writes.length = 0
		runtimeMessages.length = 0
		nextStorageReadError = undefined
		rpcConfigurationReadCount = 0
		failRpcConfigurationReadAt = undefined
		rpcConfigurationReadStarted = undefined
		resumeRpcConfigurationRead = undefined
		await browserStorageLocalSet({ rpcEntries: [customPrimaryRpc, customFallbackRpc], activeRpcNetwork: customPrimaryRpc })
		writes.length = 0
	})

	test('does not overwrite custom RPCs when extension storage temporarily rejects a read', async () => {
		const storedRpcEntries = storedItems.rpcEntries
		const readError = new Error('Extension storage is temporarily unavailable')
		nextStorageReadError = readError

		await assert.rejects(promoteRpcAsPrimary(customFallbackRpc), (error: unknown) => error === readError)

		assert.equal(writes.length, 0)
		assert.deepEqual(storedItems.rpcEntries, storedRpcEntries)
	})

	test('pauses instead of using defaults for corrupt RPC storage values', async () => {
		storedItems.rpcEntries = 'not-an-rpc-list'
		storedItems.rpcConnectionStatus = 'not-a-connection-status'
		const warnings: unknown[][] = []
		const originalWarn = console.warn
		console.warn = (...parameters: unknown[]) => { warnings.push(parameters) }
		try {
			await assert.rejects(getRpcList(), /RPC configuration is unavailable/)
			const connectionStatus = await getRpcConnectionStatus()

			assert.equal(connectionStatus, undefined)
			assert.equal(writes.length, 0)
			assert.equal(warnings.length, 4)
			assert.equal(warnings[0]?.[0], 'Rpc entries was corrupt:')
			assert.equal(typeof warnings[1]?.[0], 'object')
			assert.equal(warnings[2]?.[0], 'Connection status was corrupt:')
			assert.equal(typeof warnings[3]?.[0], 'object')
		} finally {
			console.warn = originalWarn
		}
	})

	test('initializes bundled defaults only when the RPC configuration has never been stored', async () => {
		for (const key of Object.keys(storedItems)) delete storedItems[key]
		writes.length = 0

		const configuration = await getRpcConfigurationState()

		assert.equal(configuration.status, 'ready')
		if (configuration.status !== 'ready') return
		assert.equal(configuration.rpcEntries[0]?.name, 'Ethereum Mainnet')
		assert.equal(configuration.activeRpcNetwork.name, 'Ethereum Mainnet')
		assert.equal(writes.length, 1)
		assert.deepEqual(Object.keys(writes[0] ?? {}).sort(), ['activeRpcNetwork', 'rpcEntries'])
	})

	test('treats a corrupt active RPC selection as unavailable without overwriting it', async () => {
		storedItems.activeRpcNetwork = 'not-an-rpc-network'
		const originalWarn = console.warn
		console.warn = () => undefined
		try {
			const configuration = await getRpcConfigurationState()
			assert.equal(configuration.status, 'unavailable')
			if (configuration.status === 'unavailable') assert.equal(configuration.reason, 'corrupt')
			assert.equal(writes.length, 0)
			assert.equal(storedItems.activeRpcNetwork, 'not-an-rpc-network')
		} finally {
			console.warn = originalWarn
		}
	})

	test('migrates a partial custom configuration without introducing bundled defaults', async () => {
		delete storedItems.rpcEntries
		writes.length = 0

		const configuration = await getRpcConfigurationState()

		assert.equal(configuration.status, 'ready')
		if (configuration.status !== 'ready') return
		assert.deepEqual(configuration.rpcEntries, [customPrimaryRpc])
		assert.equal(configuration.activeRpcNetwork.httpsRpc, customPrimaryRpc.httpsRpc)
		assert.deepEqual(writes, [{ rpcEntries: storedItems.rpcEntries }])
	})

	test('serializes settings snapshot migration with a concurrent RPC configuration save', async () => {
		delete storedItems.rpcEntries
		writes.length = 0
		let signalReadStarted: () => void = () => undefined
		const readStarted = new Promise<void>((resolve) => { signalReadStarted = resolve })
		let releaseRead: () => void = () => undefined
		resumeRpcConfigurationRead = new Promise<void>((resolve) => { releaseRead = resolve })
		rpcConfigurationReadStarted = signalReadStarted

		const settingsPromise = getSettings()
		await readStarted
		let saveSettled = false
		const savePromise = setRpcConfiguration([customFallbackRpc], customFallbackRpc).then(() => { saveSettled = true })
		await Promise.resolve()
		assert.equal(saveSettled, false)

		releaseRead()
		const [settings] = await Promise.all([settingsPromise, savePromise])
		assert.equal(settings.rpcConfigurationAvailable, true)
		const finalConfiguration = await getRpcConfigurationState()
		assert.equal(finalConfiguration.status, 'ready')
		if (finalConfiguration.status !== 'ready') return
		assert.deepEqual(finalConfiguration.rpcEntries, [customFallbackRpc])
		assert.deepEqual(finalConfiguration.activeRpcNetwork, customFallbackRpc)
	})

	test('treats an intentional signer-only selection without RPC entries as available configuration', async () => {
		const signerOnlyNetwork = {
			name: 'Signer only',
			chainId: 1n,
			httpsRpc: undefined,
			currencyName: 'Ether?' as const,
			currencyTicker: 'ETH?' as const,
			primary: false as const,
			minimized: true as const,
		}
		await browserStorageLocalSet({ activeRpcNetwork: signerOnlyNetwork })
		delete storedItems.rpcEntries
		writes.length = 0

		const configuration = await getRpcConfigurationState()

		assert.deepEqual(configuration, { status: 'ready', rpcEntries: [], activeRpcNetwork: signerOnlyNetwork })
		assert.deepEqual(writes, [{ rpcEntries: [] }])
	})

	test('keeps an empty stored RPC list paused until the user chooses a replacement', async () => {
		storedItems.rpcEntries = []
		writes.length = 0

		const unavailableConfiguration = await getRpcConfigurationState()
		assert.equal(unavailableConfiguration.status, 'unavailable')
		if (unavailableConfiguration.status === 'unavailable') assert.equal(unavailableConfiguration.reason, 'empty')
		assert.equal(writes.length, 0)

		await setRpcConfiguration([customFallbackRpc], customFallbackRpc)
		const restoredConfiguration = await getRpcConfigurationState()
		assert.equal(restoredConfiguration.status, 'ready')
		if (restoredConfiguration.status === 'ready') {
			assert.deepEqual(restoredConfiguration.rpcEntries, [customFallbackRpc])
			assert.equal(restoredConfiguration.activeRpcNetwork.httpsRpc, customFallbackRpc.httpsRpc)
		}
	})

	test('background retry resumes stored RPC services and pauses them again if validation fails', async () => {
		const owner = createSimulationServicesOwner(undefined, async () => undefined, async (_ethereum, error) => { throw error })
		await retryRpcConfiguration(owner)
		assert.equal(owner.isAvailable(), true)
		assert.equal(owner.getCurrent().ethereum.getRpcEntry().httpsRpc, customPrimaryRpc.httpsRpc)

		storedItems.rpcEntries = 'not-an-rpc-list'
		const originalWarn = console.warn
		console.warn = () => undefined
		try {
			await retryRpcConfiguration(owner)
			assert.equal(owner.isAvailable(), false)
			assert.equal(runtimeMessages.length, 2)
		} finally {
			console.warn = originalWarn
			owner.clear()
		}
	})

	test('settings keeps recovery visible until the paused background owner resumes', async () => {
		const owner = createSimulationServicesOwner(undefined, async () => undefined, async (_ethereum, error) => { throw error })
		await settingsOpened(owner)
		const settingsReply = MessageToPopup.parse(runtimeMessages.at(-1))
		assert.equal(settingsReply.method, 'popup_requestSettingsReply')
		if (settingsReply.method !== 'popup_requestSettingsReply') return
		assert.equal(settingsReply.data.rpcConfigurationAvailable, false)
		assert.deepEqual(settingsReply.data.rpcEntries, [])
		assert.equal(owner.isAvailable(), false)

		await retryRpcConfiguration(owner)
		assert.equal(owner.isAvailable(), true)
		owner.clear()
	})

	test('settings uses one coherent RPC configuration snapshot', async () => {
		const owner = createSimulationServicesOwner(customPrimaryRpc, async () => undefined, async (_ethereum, error) => { throw error })
		failRpcConfigurationReadAt = 2

		await settingsOpened(owner)
		const settingsReply = MessageToPopup.parse(runtimeMessages.at(-1))
		assert.equal(settingsReply.method, 'popup_requestSettingsReply')
		if (settingsReply.method !== 'popup_requestSettingsReply') return
		assert.equal(settingsReply.data.rpcConfigurationAvailable, true)
		assert.deepEqual(settingsReply.data.rpcEntries, [customPrimaryRpc, customFallbackRpc])
		assert.equal(rpcConfigurationReadCount, 1)
		assert.equal(owner.isAvailable(), true)
		owner.clear()
	})

	test('settings pauses running services after detecting corrupt RPC storage', async () => {
		const owner = createSimulationServicesOwner(customPrimaryRpc, async () => undefined, async (_ethereum, error) => { throw error })
		storedItems.rpcEntries = 'not-an-rpc-list'
		const originalWarn = console.warn
		console.warn = () => undefined
		try {
			await settingsOpened(owner)
			assert.equal((await getSettings()).rpcConfigurationAvailable, false)
			assert.equal(owner.isAvailable(), false)
		} finally {
			console.warn = originalWarn
			owner.clear()
		}
	})

	test('ordinary RPC configuration reads do not change the service lifecycle', async () => {
		const owner = createSimulationServicesOwner(customPrimaryRpc, async () => undefined, async (_ethereum, error) => { throw error })
		storedItems.rpcEntries = 'not-an-rpc-list'
		const originalWarn = console.warn
		console.warn = () => undefined
		try {
			const configuration = await getRpcConfigurationState()
			assert.equal(configuration.status, 'unavailable')
			assert.equal(owner.isAvailable(), true)
		} finally {
			console.warn = originalWarn
			owner.clear()
		}
	})

	test('explicit default restoration resumes a paused owner even when readable storage uses another chain', async () => {
		const privateRpc: RpcEntry = { ...customPrimaryRpc, name: 'Private chain', chainId: 31337n, httpsRpc: 'https://private.example' }
		await setRpcConfiguration([privateRpc], privateRpc)
		writes.length = 0
		const owner = createSimulationServicesOwner(undefined, async () => undefined, async (_ethereum, error) => { throw error })

		await restoreDefaultRpcConfiguration(owner, new Map(), {
			activeSimulationAddress: undefined,
			activeSigningSafeAddress: undefined,
			activeRpcNetwork: privateRpc,
			openedPage: { page: 'Settings' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			simulationMode: true,
		}, ignoreRecoveryPublication)

		assert.equal(owner.isAvailable(), true)
		assert.notEqual(owner.getCurrent().ethereum.getRpcEntry().httpsRpc, privateRpc.httpsRpc)
		assert.equal(writes.length, 1)
		assert.deepEqual(Object.keys(writes[0] ?? {}).sort(), ['activeRpcNetwork', 'rpcEntries'])
		owner.clear()
	})

	test.each([true, false])('normal RPC list saves cannot resume an owner paused while persistence is in flight (active primary: %j)', async (hasActivePrimary) => {
		const owner = createSimulationServicesOwner(customPrimaryRpc, async () => undefined, async (_ethereum, error) => { throw error })
		const replacementRpc: RpcEntry = { ...customPrimaryRpc, name: 'Replacement', httpsRpc: 'https://replacement.example', primary: hasActivePrimary }
		const originalSet = browser.storage.local.set.bind(browser.storage.local)
		Object.defineProperty(browser.storage.local, 'set', {
			configurable: true,
			value: async (items: Record<string, unknown>) => {
				await originalSet(items)
				if ('rpcEntries' in items && !('activeRpcNetwork' in items)) owner.clear()
			},
		})

		try {
			await assert.rejects(setNewRpcList(owner, new Map(), { method: 'popup_set_rpc_list', data: [replacementRpc] }, {
				activeSimulationAddress: undefined,
				activeSigningSafeAddress: undefined,
				activeRpcNetwork: customPrimaryRpc,
				openedPage: { page: 'Settings' },
				useSignersAddressAsActiveAddress: false,
				websiteAccess: [],
				simulationMode: true,
			}, ignoreRecoveryPublication), /RPC configuration became unavailable/)
			assert.equal(owner.isAvailable(), false)
			assert.equal(runtimeMessages.some((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_update_rpc_list'), false)
		} finally {
			Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: originalSet })
			owner.clear()
		}
	})

	test.each(['paused', 'corrupt'] as const)('ordinary RPC list saves refuse unavailable configuration without writing (%s)', async (failure) => {
		const owner = createSimulationServicesOwner(failure === 'paused' ? undefined : customPrimaryRpc, async () => undefined, async (_ethereum, error) => { throw error })
		if (failure === 'corrupt') {
			storedItems.rpcEntries = 'not-an-rpc-list'
		}
		writes.length = 0

		try {
			await assert.rejects(setNewRpcList(owner, new Map(), { method: 'popup_set_rpc_list', data: [customFallbackRpc] }, {
				activeSimulationAddress: undefined,
				activeSigningSafeAddress: undefined,
				activeRpcNetwork: customPrimaryRpc,
				rpcConfigurationAvailable: false,
				openedPage: { page: 'Settings' },
				useSignersAddressAsActiveAddress: false,
				websiteAccess: [],
				simulationMode: true,
			}, ignoreRecoveryPublication), /RPC configuration is unavailable/)
			assert.deepEqual(writes, [])
			assert.equal(owner.isAvailable(), false)
			assert.equal(runtimeMessages.some((message) => typeof message === 'object' && message !== null && 'method' in message && message.method === 'popup_update_rpc_list'), false)
		} finally {
			owner.clear()
		}
	})

	test('a deliberately emptied RPC list can be repopulated with a custom endpoint', async () => {
		const owner = createSimulationServicesOwner(customPrimaryRpc, async () => undefined, async (_ethereum, error) => { throw error })
		const settings: Parameters<typeof setNewRpcList>[3] = {
			activeSimulationAddress: undefined,
			activeSigningSafeAddress: undefined,
			activeRpcNetwork: customPrimaryRpc,
			rpcConfigurationAvailable: true,
			openedPage: { page: 'Settings' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			simulationMode: true,
		}

		await setNewRpcList(owner, new Map(), { method: 'popup_set_rpc_list', data: [] }, settings, ignoreRecoveryPublication)
		assert.equal(owner.isAvailable(), false)
		const unavailableListUpdate = MessageToPopup.parse(runtimeMessages.at(-1))
		assert.equal(unavailableListUpdate.method, 'popup_update_rpc_list')
		if (unavailableListUpdate.method === 'popup_update_rpc_list') {
			assert.deepEqual(unavailableListUpdate.data, { rpcEntries: [], rpcConfigurationAvailable: false })
		}

		await setNewRpcList(owner, new Map(), { method: 'popup_set_rpc_list', data: [customFallbackRpc] }, settings, ignoreRecoveryPublication)

		assert.equal(owner.isAvailable(), true)
		assert.equal(owner.getCurrent().ethereum.getRpcEntry().httpsRpc, customFallbackRpc.httpsRpc)
		assert.deepEqual(await getRpcList(), [customFallbackRpc])
		assert.deepEqual((await getRpcConfigurationState()).status, 'ready')
		owner.clear()
	})

	test('a signer-only selection can clear and repopulate its RPC list without requiring services', async () => {
		const signerOnlyNetwork = {
			name: 'Signer only',
			chainId: 1n,
			httpsRpc: undefined,
			currencyName: 'Ether?' as const,
			currencyTicker: 'ETH?' as const,
			primary: false as const,
			minimized: true as const,
		}
		await browserStorageLocalSet({ activeRpcNetwork: signerOnlyNetwork, rpcEntries: [customPrimaryRpc] })
		const owner = createSimulationServicesOwner(customPrimaryRpc, async () => undefined, async (_ethereum, error) => { throw error })
		const settings: Parameters<typeof setNewRpcList>[3] = {
			activeSimulationAddress: undefined,
			activeSigningSafeAddress: undefined,
			activeRpcNetwork: signerOnlyNetwork,
			rpcConfigurationAvailable: true,
			openedPage: { page: 'Settings' },
			useSignersAddressAsActiveAddress: false,
			websiteAccess: [],
			simulationMode: false,
		}

		await setNewRpcList(owner, new Map(), { method: 'popup_set_rpc_list', data: [] }, settings, ignoreRecoveryPublication)
		assert.equal(owner.isAvailable(), false)
		const emptyConfiguration = await getRpcConfigurationState()
		assert.deepEqual(emptyConfiguration, { status: 'ready', rpcEntries: [], activeRpcNetwork: signerOnlyNetwork })
		const emptyListUpdate = MessageToPopup.parse(runtimeMessages.at(-1))
		assert.equal(emptyListUpdate.method, 'popup_update_rpc_list')
		if (emptyListUpdate.method === 'popup_update_rpc_list') {
			assert.deepEqual(emptyListUpdate.data, { rpcEntries: [], rpcConfigurationAvailable: true })
		}

		await retryRpcConfiguration(owner)
		assert.equal(owner.isAvailable(), false)
		const retryListUpdate = MessageToPopup.parse(runtimeMessages.at(-1))
		assert.equal(retryListUpdate.method, 'popup_update_rpc_list')
		if (retryListUpdate.method === 'popup_update_rpc_list') {
			assert.deepEqual(retryListUpdate.data, { rpcEntries: [], rpcConfigurationAvailable: true })
		}

		await settingsOpened(owner)
		const settingsReply = MessageToPopup.parse(runtimeMessages.at(-1))
		assert.equal(settingsReply.method, 'popup_requestSettingsReply')
		if (settingsReply.method === 'popup_requestSettingsReply') assert.equal(settingsReply.data.rpcConfigurationAvailable, true)

		await setNewRpcList(owner, new Map(), { method: 'popup_set_rpc_list', data: [customFallbackRpc] }, settings, ignoreRecoveryPublication)
		assert.equal(owner.isAvailable(), false)
		assert.deepEqual(await getRpcList(), [customFallbackRpc])
		const repopulatedConfiguration = await getRpcConfigurationState()
		assert.equal(repopulatedConfiguration.status, 'ready')
		if (repopulatedConfiguration.status === 'ready') assert.deepEqual(repopulatedConfiguration.activeRpcNetwork, signerOnlyNetwork)
	})
})
