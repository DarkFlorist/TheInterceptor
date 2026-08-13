import * as assert from 'assert'
import { beforeEach, describe, test } from 'bun:test'
import type { PopupMessageDispatcherContext } from '../../app/ts/background/popupMessageDispatcher.js'
import type { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import type { Settings } from '../../app/ts/types/interceptor-messages.js'

const storageState: Record<string, unknown> = {}
const sentMessages: unknown[] = []
const dynamicRuleUpdates: unknown[] = []
const dispatcherEvents: ({ type: 'message', message: unknown } | { type: 'dynamicRuleUpdate' })[] = []
const registeredContentScripts = new Map<string, { readonly id: string, readonly js?: readonly string[] }>()
let storageSetError: Error | undefined
let dynamicRuleUpdateError: Error | undefined

Reflect.set(globalThis, 'chrome', { runtime: { id: 'test-extension' } })
Reflect.set(globalThis, 'browser', {
	runtime: {
		lastError: undefined,
		getManifest: () => ({ manifest_version: 3 }),
		sendMessage: async (message: unknown) => {
			sentMessages.push(message)
			dispatcherEvents.push({ type: 'message', message })
			return undefined
		},
		onMessage: { addListener: () => undefined, removeListener: () => undefined },
		onConnect: { addListener: () => undefined, removeListener: () => undefined },
	},
	storage: {
		local: {
			async get(keys?: string | string[] | Record<string, unknown> | null) {
				if (keys === undefined || keys === null) return { ...storageState }
				if (Array.isArray(keys)) return Object.fromEntries(keys.filter((key) => key in storageState).map((key) => [key, storageState[key]]))
				if (typeof keys === 'string') return keys in storageState ? { [keys]: storageState[keys] } : {}
				return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
			},
			async set(items: Record<string, unknown>) {
				if (storageSetError !== undefined) throw storageSetError
				Object.assign(storageState, items)
			},
			async remove(keys: string | string[]) {
				for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
			},
		},
	},
	scripting: {
		getRegisteredContentScripts: async () => [...registeredContentScripts.values()],
		unregisterContentScripts: async (filter?: { readonly ids?: readonly string[] }) => {
			const ids = filter?.ids ?? [...registeredContentScripts.keys()]
			for (const id of ids) registeredContentScripts.delete(id)
		},
		registerContentScripts: async (scripts: readonly { readonly id: string, readonly js?: readonly string[] }[]) => {
			for (const script of scripts) registeredContentScripts.set(script.id, script)
		},
		updateContentScripts: async (scripts: readonly { readonly id: string, readonly js?: readonly string[] }[]) => {
			for (const script of scripts) registeredContentScripts.set(script.id, script)
		},
	},
	tabs: {
		query: async () => [],
		get: async () => undefined,
		update: async () => undefined,
		onUpdated: { addListener: () => undefined, removeListener: () => undefined },
		onRemoved: { addListener: () => undefined, removeListener: () => undefined },
	},
	windows: {
		get: async () => undefined,
		update: async () => undefined,
	},
	action: {
		setIcon: async () => undefined,
		setTitle: async () => undefined,
		setBadgeText: async () => undefined,
		setBadgeBackgroundColor: async () => undefined,
	},
	browserAction: {
		setIcon: async () => undefined,
		setTitle: async () => undefined,
		setBadgeText: async () => undefined,
		setBadgeBackgroundColor: async () => undefined,
	},
	declarativeNetRequest: {
		getDynamicRules: async () => [],
		getSessionRules: async () => [],
		updateDynamicRules: async (update: unknown) => {
			if (dynamicRuleUpdateError !== undefined) throw dynamicRuleUpdateError
			dynamicRuleUpdates.push(update)
			dispatcherEvents.push({ type: 'dynamicRuleUpdate' })
			return undefined
		},
		updateSessionRules: async () => undefined,
	},
})

const [
	{ dispatchPopupMessage },
	{ getLatestUnexpectedError },
	{ EthereumClientService: EthereumClientServiceConstructor },
	{ TokenPriceService: TokenPriceServiceConstructor },
	{ MessageToPopup },
] = await Promise.all([
	import('../../app/ts/background/popupMessageDispatcher.js'),
	import('../../app/ts/background/storageVariables.js'),
	import('../../app/ts/simulation/services/EthereumClientService.js'),
	import('../../app/ts/simulation/services/priceEstimator.js'),
	import('../../app/ts/types/interceptor-messages.js'),
])

const settings: Settings = {
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
}

function createDispatcherContext(resetSimulationState: () => Promise<void>): PopupMessageDispatcherContext {
	const ethereum: EthereumClientService = Object.create(EthereumClientServiceConstructor.prototype)
	const tokenPriceService: TokenPriceService = Object.create(TokenPriceServiceConstructor.prototype)
	return {
		websiteTabConnections: new Map(),
		ethereum,
		tokenPriceService,
		resetSimulationServices: () => undefined,
		settings,
		publishRpcConnectionStatus: async () => undefined,
		simulationAbortController: new AbortController(),
		confirmTransactionAbortController: new AbortController(),
		resetSimulationState,
	}
}

beforeEach(() => {
	storageSetError = undefined
	dynamicRuleUpdateError = undefined
	for (const key of Object.keys(storageState)) delete storageState[key]
	sentMessages.splice(0, sentMessages.length)
	dynamicRuleUpdates.splice(0, dynamicRuleUpdates.length)
	dispatcherEvents.splice(0, dispatcherEvents.length)
	registeredContentScripts.clear()
})

describe('popup message dispatcher seams', () => {
	test('returns a save failure when address-book persistence fails', async () => {
		storageSetError = new Error('Address-book storage unavailable.')

		const result = await dispatchPopupMessage(createDispatcherContext(async () => undefined), {
			method: 'popup_addOrModifyAddressBookEntry',
			data: {
				type: 'contact',
				name: 'Alice',
				address: 1n,
				entrySource: 'User',
			},
		})

		assert.deepEqual(result, {
			type: 'AddOrModifyAddressBookEntryReply',
			ok: false,
			message: 'Address-book storage unavailable.',
		})
	})

	test('returns and records a failure when active-address access refresh fails', async () => {
		storageState.websiteAccess = [{
			website: {
				websiteOrigin: 'address-book-refresh-failure.test',
				icon: undefined,
				title: 'Address-book refresh failure',
			},
			addressAccess: [],
			access: true,
			declarativeNetRequestBlockMode: 'block-all',
		}]
		dynamicRuleUpdateError = new Error('Access refresh unavailable.')

		const result = await dispatchPopupMessage(createDispatcherContext(async () => undefined), {
			method: 'popup_addOrModifyAddressBookEntry',
			data: {
				type: 'contact',
				name: 'Alice',
				address: 1n,
				entrySource: 'User',
				useAsActiveAddress: true,
			},
		})
		const latestUnexpectedError = await getLatestUnexpectedError()

		assert.deepEqual(result, {
			type: 'AddOrModifyAddressBookEntryReply',
			ok: false,
			message: 'Access refresh unavailable.',
		})
		assert.equal(latestUnexpectedError?.data.source, 'address_book_save')
		assert.equal(latestUnexpectedError?.data.code, 'address_book_save_failed')

		dynamicRuleUpdateError = undefined
		const retryResult = await dispatchPopupMessage(createDispatcherContext(async () => undefined), {
			method: 'popup_addOrModifyAddressBookEntry',
			data: {
				type: 'contact',
				name: 'Alice',
				address: 1n,
				entrySource: 'User',
				useAsActiveAddress: true,
			},
		})

		assert.deepEqual(retryResult, {
			type: 'AddOrModifyAddressBookEntryReply',
			ok: true,
		})
		assert.equal(dynamicRuleUpdates.length, 1)
	})

	test('broadcasts address-book saves for metadata consumers to refresh themselves', async () => {
		const result = await dispatchPopupMessage(createDispatcherContext(async () => undefined), {
			method: 'popup_addOrModifyAddressBookEntry',
			data: {
				type: 'contact',
				name: 'Updated Safe participant',
				address: 1n,
				entrySource: 'User',
			},
		})

		assert.deepEqual(result, { type: 'AddOrModifyAddressBookEntryReply', ok: true })
		assert.equal(sentMessages.some((message) => {
			const parsed = MessageToPopup.safeParse(message)
			return parsed.success && parsed.value.method === 'popup_addressBookEntriesChanged'
		}), true)
	})

	test('delegates simulation reset through the injected lifecycle callback', async () => {
		let resetCount = 0
		const result = await dispatchPopupMessage(createDispatcherContext(async () => {
			resetCount += 1
		}), { method: 'popup_resetSimulation' })
		assert.equal(result, undefined)
		assert.equal(resetCount, 1)
	})

	test('deliberately ignores popup window status probes handled by window listeners', async () => {
		const context = createDispatcherContext(async () => {
			throw new Error('Window status probes must not reset simulation state.')
		})
		assert.equal(await dispatchPopupMessage(context, { method: 'popup_isMainPopupWindowOpen' }), undefined)
		assert.equal(await dispatchPopupMessage(context, { method: 'popup_isSimulationVisualizerOpen' }), undefined)
	})

	test('does not identify an address using a different active chain', async () => {
		const context = createDispatcherContext(async () => undefined)
		Object.defineProperty(context.ethereum, 'getChainId', { value: () => 1n })

		assert.deepEqual(await dispatchPopupMessage(context, {
			method: 'popup_requestIdentifyAddress',
			data: { address: 1n, chainId: 10n },
		}), {
			method: 'popup_requestIdentifyAddress',
			data: { chainId: 10n, addressBookEntry: undefined },
		})
	})

	test('routes Safe contract state through its dedicated protocol', async () => {
		const context = createDispatcherContext(async () => undefined)
		assert.deepEqual(await dispatchPopupMessage(context, {
			method: 'popup_requestSafeContractState',
			data: { address: 1n, chainId: 'AllChains' },
		}), {
			method: 'popup_requestSafeContractState',
			data: {
				chainId: 'AllChains',
				result: { ok: false, message: 'Gnosis Safe wallets must use a specific chain to load their signers.' },
			},
		})
	})

	test('broadcasts an import failure without refreshing settings', async () => {
		storageState.websiteAccess = [{
			website: { websiteOrigin: 'failure-refresh.test', icon: undefined, title: 'Failure refresh sentinel' },
			addressAccess: [],
			access: true,
			declarativeNetRequestBlockMode: 'block-all',
		}]
		await dispatchPopupMessage(
			createDispatcherContext(async () => undefined),
			{ method: 'popup_import_settings', data: { fileContents: 'not json' } },
		)

		const messages = sentMessages.map((message) => MessageToPopup.parse(message))
		assert.equal(messages.length, 1)
		const importFailure = messages[0]
		assert.equal(importFailure?.method, 'popup_initiate_export_settings_reply')
		if (importFailure?.method !== 'popup_initiate_export_settings_reply') throw new Error('Expected failed import broadcast.')
		assert.equal(importFailure.data.success, false)
		assert.equal(storageState.activeSimulationAddress, undefined)
		assert.deepEqual(dynamicRuleUpdates, [])
	})

	test('reloads imported settings before refreshing access and broadcasting the update', async () => {
		const importedSettings = JSON.stringify({
			name: 'InterceptorSettingsAndAddressBook',
			version: '1.4',
			exportedDate: '2026-07-28',
			settings: {
				activeSimulationAddress: '0x0000000000000000000000000000000000000002',
				rpcNetwork: {
					name: 'Imported network',
					chainId: '0x1',
					httpsRpc: 'https://example.test/rpc',
					currencyName: 'Ether',
					currencyTicker: 'ETH',
					primary: true,
					minimized: true,
				},
				openedPage: { page: 'Home' },
				useSignersAddressAsActiveAddress: false,
				websiteAccess: [{
					website: { websiteOrigin: 'success-refresh.test', title: 'Imported blocked website' },
					addressAccess: [],
					access: true,
					declarativeNetRequestBlockMode: 'block-all',
				}],
				simulationMode: false,
				addressBookEntries: [],
				useTabsInsteadOfPopup: false,
				metamaskCompatibilityMode: false,
			},
		})

		await dispatchPopupMessage(
			createDispatcherContext(async () => undefined),
			{ method: 'popup_import_settings', data: { fileContents: importedSettings } },
		)

		const messages = sentMessages.map((message) => MessageToPopup.parse(message))
		assert.equal(messages.length, 2)
		const importSuccess = messages[0]
		assert.equal(importSuccess?.method, 'popup_initiate_export_settings_reply')
		if (importSuccess?.method !== 'popup_initiate_export_settings_reply') throw new Error('Expected successful import broadcast.')
		assert.equal(importSuccess.data.success, true)
		assert.equal(messages[1]?.method, 'popup_settingsUpdated')
		if (messages[1]?.method !== 'popup_settingsUpdated') throw new Error('Expected imported settings broadcast.')
		assert.equal(messages[1].data.activeSimulationAddress, 2n)
		assert.equal(messages[1].data.activeRpcNetwork.httpsRpc, 'https://example.test/rpc')
		assert.equal(messages[1].data.simulationMode, false)
		assert.deepEqual(registeredContentScripts.get('inpage')?.js, ['/inpage/js/inpage.js'])
		assert.deepEqual(dynamicRuleUpdates, [{
			removeRuleIds: [],
			addRules: [{
				id: 1,
				priority: 1,
				action: { type: 'block' },
				condition: { initiatorDomains: ['success-refresh.test'], domainType: 'thirdParty' },
			}],
		}])
		const successReplyEventIndex = dispatcherEvents.findIndex((event) => event.type === 'message' && MessageToPopup.parse(event.message).method === 'popup_initiate_export_settings_reply')
		const dynamicRuleEventIndex = dispatcherEvents.findIndex((event) => event.type === 'dynamicRuleUpdate')
		const settingsUpdatedEventIndex = dispatcherEvents.findIndex((event) => event.type === 'message' && MessageToPopup.parse(event.message).method === 'popup_settingsUpdated')
		assert.ok(successReplyEventIndex < dynamicRuleEventIndex)
		assert.ok(dynamicRuleEventIndex < settingsUpdatedEventIndex)
	})
})
