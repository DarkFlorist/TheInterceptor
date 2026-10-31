import { createDeferredValue, createPort, createTestSimulationServicesOwner } from './backgroundEthAccountsTestHarness.js'
import * as assert from 'assert'
import { beforeEach, describe, test } from 'bun:test'
import type { PopupMessageDispatcherContext } from '../../app/ts/background/popupMessageDispatcher.js'
import type { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import type { Settings } from '../../app/ts/types/interceptor-messages.js'
import { isRpcConfigurationUnavailableError } from '../../app/ts/utils/rpcConfigurationError.js'

const storageState: Record<string, unknown> = {}
const sentMessages: unknown[] = []
const dynamicRuleUpdates: unknown[] = []
const contentScriptUpdateBatches: { readonly id: string, readonly excludeMatches?: readonly string[] }[][] = []
const dispatcherEvents: ({ type: 'message', message: unknown } | { type: 'dynamicRuleUpdate' })[] = []
let storageSetError: Error | undefined
let dynamicRuleUpdateError: Error | undefined
let addressBookBroadcastWait: Promise<void> | undefined
let afterStorageWrite: ((items: Record<string, unknown>) => void) | undefined
let contentScriptRegistrationWait: { readonly started: () => void, readonly release: Promise<void> } | undefined

const registeredContentScripts = [
	{ id: 'inpage', excludeMatches: ['*://*.disabled.test/*'] },
	{ id: 'inpage2', excludeMatches: ['*://*.disabled.test/*'] },
]

Reflect.set(globalThis, 'chrome', { runtime: { id: 'test-extension' } })
Reflect.set(globalThis, 'browser', {
	runtime: {
		lastError: undefined,
		getManifest: () => ({ manifest_version: 3 }),
		sendMessage: async (message: unknown) => {
			sentMessages.push(message)
			dispatcherEvents.push({ type: 'message', message })
			const parsed = MessageToPopup.safeParse(message)
			if (parsed.success && parsed.value.method === 'popup_addressBookEntriesChanged') await addressBookBroadcastWait
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
				afterStorageWrite?.(items)
			},
			async remove(keys: string | string[]) {
				for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
			},
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
	scripting: {
		getRegisteredContentScripts: async () => {
			contentScriptRegistrationWait?.started()
			await contentScriptRegistrationWait?.release
			return registeredContentScripts
		},
		registerContentScripts: async () => undefined,
		updateContentScripts: async (scripts: { readonly id: string, readonly excludeMatches?: readonly string[] }[]) => { contentScriptUpdateBatches.push(scripts) },
		unregisterContentScripts: async () => undefined,
	},
})

const [
	{ dispatchPopupMessage },
	{ websiteSocketToString },
	{ getLatestUnexpectedError, setFetchSimulationStackRequestPromise, updatePendingAccessRequests },
	{ exportSettingsAndAddressBook, getRequiredSettings, updateWebsiteAccess },
	{ updateWebsiteApprovalAccesses },
	{ ExportedSettings },
	{ serialize },
	{ EthereumClientService: EthereumClientServiceConstructor },
	{ TokenPriceService: TokenPriceServiceConstructor },
	{ MessageToPopup },
] = await Promise.all([
	import('../../app/ts/background/popupMessageDispatcher.js'),
	import('../../app/ts/background/backgroundUtils.js'),
	import('../../app/ts/background/storageVariables.js'),
	import('../../app/ts/background/settings.js'),
	import('../../app/ts/background/accessManagement.js'),
	import('../../app/ts/types/exportedSettingsTypes.js'),
	import('../../app/ts/types/wire-types.js'),
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

const disabledWebsiteAccess: Settings['websiteAccess'][number] = {
	website: {
		websiteOrigin: 'disabled.test',
		icon: undefined,
		title: 'Disabled website',
	},
	addressAccess: [],
	access: false,
	interceptorDisabled: true,
	declarativeNetRequestBlockMode: 'disabled',
}

function createDispatcherContext(resetSimulationState: () => Promise<void>): PopupMessageDispatcherContext {
	const ethereum: EthereumClientService = Object.create(EthereumClientServiceConstructor.prototype)
	const tokenPriceService: TokenPriceService = Object.create(TokenPriceServiceConstructor.prototype)
	return {
		websiteTabConnections: new Map(),
		simulationServicesOwner: createTestSimulationServicesOwner({ ethereum, tokenPriceService }, () => ({ ethereum, tokenPriceService })),
		settings,
		rpcConfiguration: { status: 'ready', rpcEntries: [settings.activeRpcNetwork], activeRpcNetwork: settings.activeRpcNetwork },
		publishRpcConnectionStatus: async () => undefined,
		simulationAbortController: new AbortController(),
		confirmTransactionAbortController: new AbortController(),
		resetSimulationState,
	}
}

// Makes the RPC configuration unreadable right after the next write of `key` is persisted.
function corruptActiveRpcNetworkAfterWriting(key: string) {
	afterStorageWrite = (items) => {
		if (!(key in items)) return
		afterStorageWrite = undefined
		storageState.activeRpcNetwork = 'corrupt'
	}
}

beforeEach(() => {
	storageSetError = undefined
	dynamicRuleUpdateError = undefined
	addressBookBroadcastWait = undefined
	afterStorageWrite = undefined
	contentScriptRegistrationWait = undefined
	for (const key of Object.keys(storageState)) delete storageState[key]
	sentMessages.splice(0, sentMessages.length)
	dynamicRuleUpdates.splice(0, dynamicRuleUpdates.length)
	contentScriptUpdateBatches.splice(0, contentScriptUpdateBatches.length)
	dispatcherEvents.splice(0, dispatcherEvents.length)
})

describe('popup message dispatcher seams', () => {
	test('refreshes manifest v3 content script exclusions after removing a disabled website', async () => {
		storageState.websiteAccess = [disabledWebsiteAccess]

		await dispatchPopupMessage(createDispatcherContext(async () => undefined), {
			method: 'popup_removeWebsiteAccess',
			data: { websiteOrigin: 'disabled.test' },
		})

		assert.deepEqual(storageState.websiteAccess, [])
		assert.equal(contentScriptUpdateBatches.length, 1)
		assert.deepEqual(contentScriptUpdateBatches.at(-1)?.map(({ id, excludeMatches }) => ({ id, excludeMatches })), [
			{ id: 'inpage2', excludeMatches: [] },
			{ id: 'inpage', excludeMatches: [] },
		])
	})

	test('does not refresh content script exclusions after removing an enabled website', async () => {
		storageState.websiteAccess = [{ ...disabledWebsiteAccess, interceptorDisabled: false }]

		await dispatchPopupMessage(createDispatcherContext(async () => undefined), {
			method: 'popup_removeWebsiteAccess',
			data: { websiteOrigin: 'disabled.test' },
		})

		assert.deepEqual(storageState.websiteAccess, [])
		assert.equal(contentScriptUpdateBatches.length, 0)
	})

	test('refreshes manifest v3 content script exclusions after the access editor removes a disabled website', async () => {
		storageState.websiteAccess = [disabledWebsiteAccess]

		await dispatchPopupMessage(createDispatcherContext(async () => undefined), {
			method: 'popup_changeInterceptorAccess',
			data: [{
				oldEntry: disabledWebsiteAccess,
				newEntry: disabledWebsiteAccess,
				removed: true,
			}],
		})

		assert.deepEqual(storageState.websiteAccess, [])
		assert.equal(contentScriptUpdateBatches.length, 1)
		assert.deepEqual(contentScriptUpdateBatches.at(-1)?.map(({ id, excludeMatches }) => ({ id, excludeMatches })), [
			{ id: 'inpage2', excludeMatches: [] },
			{ id: 'inpage', excludeMatches: [] },
		])
	})

	test('reconciles an access-editor revocation against the committed permissions', async () => {
		const grantedAccess = { ...disabledWebsiteAccess, access: true, interceptorDisabled: false }
		const revokedAccess = { ...grantedAccess, access: false }
		storageState.websiteAccess = [grantedAccess]
		const portMessages: { readonly method?: string, readonly result?: unknown }[] = []
		const socket = { tabId: 1, connectionName: 0n }
		const connection = {
			port: { postMessage: (message: { readonly method?: string, readonly result?: unknown }) => portMessages.push(message) } as browser.runtime.Port,
			socket,
			websiteOrigin: grantedAccess.website.websiteOrigin,
			approved: true,
			wantsToConnect: false,
		}
		const context = createDispatcherContext(async () => undefined)
		context.settings = { ...settings, websiteAccess: [grantedAccess] }
		context.websiteTabConnections.set(socket.tabId, { connections: { '1-0x0': connection } })

		await dispatchPopupMessage(context, {
			method: 'popup_changeInterceptorAccess',
			data: [{ oldEntry: grantedAccess, newEntry: revokedAccess, removed: false }],
		})

		assert.deepEqual(storageState.websiteAccess, [revokedAccess])
		assert.equal(connection.approved, false)
		assert.deepEqual(portMessages.map(({ method, result }) => ({ method, result })), [
			{ method: 'accountsChanged', result: [] },
			{ method: 'disconnect', result: [] },
		])
	})

	test('routes recovery handlers through the registry when settings are unavailable', async () => {
		const context = createDispatcherContext(async () => undefined)
		context.settings = undefined
		context.rpcConfiguration = { status: 'unavailable', reason: 'read-failed', error: new Error('Storage unavailable') }

		assert.deepEqual(await dispatchPopupMessage(context, { method: 'popup_requestSimulationMode' }), {
			error: {
				code: 4900,
				message: 'Interceptor RPC configuration is unavailable. Network requests are paused until the user restores it.',
			},
		})
		await dispatchPopupMessage(context, { method: 'popup_requestSettings' })
		assert.equal(sentMessages.some((message) => {
			const parsed = MessageToPopup.safeParse(message)
			return parsed.success && parsed.value.method === 'popup_requestSettingsReply'
		}), true)
	})

	test('keeps Safe failures typed and local contact writes available when settings are unavailable', async () => {
		const context = createDispatcherContext(async () => undefined)
		context.settings = undefined
		context.rpcConfiguration = { status: 'unavailable', reason: 'read-failed', error: new Error('Storage unavailable') }
		const message = 'Interceptor RPC configuration is unavailable. Network requests are paused until the user restores it.'

		assert.deepEqual(await dispatchPopupMessage(context, {
			method: 'popup_setSafeSimulationSigner',
			data: { chainId: 1n, safeAddress: 2n, safeSimulationSignerAddress: 3n },
		}), { type: 'SetSafeSimulationSignerReply', ok: false, message })
		assert.deepEqual(await dispatchPopupMessage(context, {
			method: 'popup_addOrModifyAddressBookEntry',
			data: {
				type: 'safe',
				name: 'Unavailable Safe',
				address: 2n,
				chainId: 1n,
				entrySource: 'User',
				useAsActiveAddress: false,
				safeSimulationSignerAddress: 3n,
			},
		}), { type: 'AddOrModifyAddressBookEntryReply', ok: false, message })
		assert.deepEqual(await dispatchPopupMessage(context, {
			method: 'popup_addOrModifyAddressBookEntry',
			data: { type: 'contact', name: 'Offline contact', address: 4n, entrySource: 'User' },
		}), { type: 'AddOrModifyAddressBookEntryReply', ok: true })
		assert.equal(storageState.userAddressBookEntriesV3?.some((entry) => entry.address === '0x0000000000000000000000000000000000000004'), true)
	})

	test('ready-and-listening bootstraps dialogs without RPC services and gives confirmTransaction a typed unavailable reply', async () => {
		const context = createDispatcherContext(async () => undefined)
		context.settings = undefined
		context.rpcConfiguration = { status: 'unavailable', reason: 'read-failed', error: new Error('Storage unavailable') }
		context.simulationServicesOwner.clear()
		const popupOrTabId = { type: 'popup', id: 7 } as const
		await setFetchSimulationStackRequestPromise({
			website: { websiteOrigin: 'stack.test', icon: undefined, title: undefined },
			popupOrTabId,
			simulationOverlayEnabled: false,
			simulationStackVersion: '2.0.0',
			uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 0n } },
		})

		assert.deepEqual(await dispatchPopupMessage(context, { method: 'popup_readyAndListening', data: { page: 'fetchSimulationStack' } }), {
			method: 'popup_readyAndListening',
			ok: true,
			data: { popupOrTabId, confirmTransactionBootstrap: undefined },
		})
		assert.deepEqual(await dispatchPopupMessage(context, { method: 'popup_readyAndListening', data: { page: 'confirmTransaction' } }), {
			method: 'popup_readyAndListening',
			ok: false,
			message: 'Interceptor RPC configuration is unavailable. Network requests are paused until the user restores it.',
		})
	})

	test('ready-and-listening bootstraps and publishes pending access requests while the active RPC network is unavailable', async () => {
		storageState.activeRpcNetwork = 'corrupt'
		const context = createDispatcherContext(async () => undefined)
		context.settings = undefined
		context.rpcConfiguration = { status: 'unavailable', reason: 'corrupt' }
		context.simulationServicesOwner.clear()
		const popupOrTabId = { type: 'popup', id: 8 } as const
		const website = { websiteOrigin: 'pending-access.test', icon: undefined, title: undefined }
		await updatePendingAccessRequests(async () => [{
			website,
			requestAccessToAddress: undefined,
			originalRequestAccessToAddress: undefined,
			associatedAddresses: [],
			signerAccounts: [],
			signerName: 'NoSigner',
			simulationMode: true,
			popupOrTabId,
			socket: { tabId: 1, connectionName: 0n },
			request: undefined,
			activeAddress: undefined,
			accessRequestId: 'undefined || pending-access.test',
		}])
		const originalWarn = console.warn
		console.warn = () => undefined
		try {
			assert.deepEqual(await dispatchPopupMessage(context, { method: 'popup_readyAndListening', data: { page: 'interceptorAccess' } }), {
				method: 'popup_readyAndListening',
				ok: true,
				data: { popupOrTabId, confirmTransactionBootstrap: undefined },
			})
		} finally {
			console.warn = originalWarn
		}

		const published = sentMessages.flatMap((message) => {
			const parsed = MessageToPopup.safeParse(message)
			return parsed.success && parsed.value.method === 'popup_interceptorAccessDialog' ? [parsed.value.data] : []
		})
		assert.equal(published.length, 1)
		assert.deepEqual(published[0]?.activeAddresses, [])
		assert.deepEqual(published[0]?.pendingAccessRequests.map((pendingRequest) => pendingRequest.website.websiteOrigin), [website.websiteOrigin])
	})

	test('unexpected-error reporting, fetching and clearing work while settings are unavailable', async () => {
		const context = createDispatcherContext(async () => undefined)
		context.settings = undefined
		context.rpcConfiguration = { status: 'unavailable', reason: 'read-failed', error: new Error('Storage unavailable') }

		const originalError = console.error
		console.error = () => undefined
		try {
			assert.equal(await dispatchPopupMessage(context, {
				method: 'popup_UnexpectedErrorOccured',
				data: { timestamp: new Date('2024-01-01T00:00:00.000Z'), message: 'Popup failure during outage', source: 'popup', code: 'popup_failure', debugId: undefined },
			}), undefined)
		} finally {
			console.error = originalError
		}
		const reported = await dispatchPopupMessage(context, { method: 'popup_requestLatestUnexpectedError' })
		assert.equal(reported !== undefined && 'latestUnexpectedError' in reported ? reported.latestUnexpectedError?.data.message : undefined, 'Popup failure during outage')

		assert.equal(await dispatchPopupMessage(context, { method: 'popup_clearUnexpectedError' }), undefined)
		assert.deepEqual(await dispatchPopupMessage(context, { method: 'popup_requestLatestUnexpectedError' }), { method: 'popup_requestLatestUnexpectedError', latestUnexpectedError: undefined })
	})

	test.each(['corrupt', 'empty'] as const)('block-explorer lookups get a typed unavailable reply for a %s RPC list with a readable active network', async (reason) => {
		storageState.rpcEntries = reason === 'corrupt' ? 'not-an-rpc-list' : []
		const context = createDispatcherContext(async () => undefined)
		context.rpcConfiguration = { status: 'unavailable', reason, activeRpcNetwork: settings.activeRpcNetwork }

		assert.deepEqual(await dispatchPopupMessage(context, { method: 'popup_requestAbiAndNameFromBlockExplorer', data: { address: 0x1234n, chainId: 1n } }), {
			method: 'popup_requestAbiAndNameFromBlockExplorer',
			data: { success: false, error: 'Interceptor RPC configuration is unavailable. Network requests are paused until the user restores it.' },
		})
		assert.equal(await getLatestUnexpectedError(), undefined)
	})

	test('snapshot registration captures at invocation and keeps one pair across awaits', async () => {
		const { popupSnapshotMessageHandler } = await import('../../app/ts/background/popupMessageHandlerRegistry.js')
		const context = createDispatcherContext(async () => undefined)
		const initial = context.simulationServicesOwner.requireCurrent()
		const replacement = createDispatcherContext(async () => undefined).simulationServicesOwner.requireCurrent()
		const last = createDispatcherContext(async () => undefined).simulationServicesOwner.requireCurrent()
		let next = replacement
		context.simulationServicesOwner = createTestSimulationServicesOwner(initial, () => next)
		const entered = createDeferredValue<void>()
		const release = createDeferredValue<void>()
		const observed: typeof initial[] = []
		const handler = popupSnapshotMessageHandler('popup_requestSimulationMetadata', async snapshot => {
			assert.equal('simulationServicesOwner' in snapshot, false)
			assert.equal('resetSimulationState' in snapshot, false)
			observed.push(snapshot.services)
			entered.resolve(undefined)
			await release.promise
			observed.push(snapshot.services)
		})
		const network = { ...settings.activeRpcNetwork, httpsRpc: 'https://snapshot.example' }
		context.simulationServicesOwner.reset(network)
		const pending = handler(context, { method: 'popup_requestSimulationMetadata' })
		await entered.promise
		next = last
		context.simulationServicesOwner.reset(network)
		release.resolve(undefined)
		await pending
		await handler(context, { method: 'popup_requestSimulationMetadata' })
		assert.equal(observed.length, 4)
		for (const [index, expected] of [replacement, replacement, last, last].entries()) assert.strictEqual(observed[index], expected)
	})

	test.each(['unavailable', 'signer-only'] as const)('RPC-backed popup handlers stop at the shared boundary for %s configuration', async (configurationKind) => {
		const context = createDispatcherContext(async () => { throw new Error('reset must not run') })
		if (configurationKind === 'unavailable') {
			context.rpcConfiguration = { status: 'unavailable', reason: 'corrupt' }
		} else {
			const signerOnlyNetwork = { ...context.settings.activeRpcNetwork, httpsRpc: undefined, currencyName: 'Ether?' as const, currencyTicker: 'ETH?' as const, primary: false as const }
			context.settings = { ...context.settings, activeRpcNetwork: signerOnlyNetwork }
			context.rpcConfiguration = { status: 'ready', rpcEntries: [], activeRpcNetwork: signerOnlyNetwork }
			context.simulationServicesOwner.clear()
		}
		const ownerWasAvailable = context.simulationServicesOwner.getCurrent() !== undefined
		const unavailableReply = {
			error: {
				code: 4900,
				message: 'Interceptor RPC configuration is unavailable. Network requests are paused until the user restores it.',
			},
		}

		assert.deepEqual(await dispatchPopupMessage(context, { method: 'popup_refreshSimulation' }), unavailableReply)
		assert.deepEqual(await dispatchPopupMessage(context, {
			method: 'popup_confirmDialog',
			data: {
				action: 'reject',
				errorString: undefined,
				uniqueRequestIdentifier: { requestId: 1, requestSocket: { tabId: 1, connectionName: 1n } },
			},
		}), unavailableReply)
		assert.deepEqual(await dispatchPopupMessage(context, { method: 'popup_resetSimulation' }), unavailableReply)
		assert.deepEqual(await dispatchPopupMessage(context, {
			method: 'popup_setSafeSimulationSigner',
			data: { chainId: 1n, safeAddress: 2n, safeSimulationSignerAddress: 3n },
		}), {
			type: 'SetSafeSimulationSignerReply',
			ok: false,
			message: 'Interceptor RPC configuration is unavailable. Network requests are paused until the user restores it.',
		})
		assert.deepEqual(await dispatchPopupMessage(context, {
			method: 'popup_addOrModifyAddressBookEntry',
			data: {
				type: 'safe',
				name: 'Unavailable Safe',
				address: 2n,
				chainId: 1n,
				entrySource: 'User',
				useAsActiveAddress: false,
				safeSimulationSignerAddress: 3n,
			},
		}), {
			type: 'AddOrModifyAddressBookEntryReply',
			ok: false,
			message: 'Interceptor RPC configuration is unavailable. Network requests are paused until the user restores it.',
		})
		assert.deepEqual(await dispatchPopupMessage(context, {
			method: 'popup_addOrModifyAddressBookEntry',
			data: { type: 'contact', name: 'Offline contact', address: 4n, entrySource: 'User' },
		}), { type: 'AddOrModifyAddressBookEntryReply', ok: true })
		assert.equal(Array.isArray(storageState.userAddressBookEntriesV3), true)
		assert.equal(context.simulationServicesOwner.getCurrent() !== undefined, ownerWasAvailable)
	})

	test.each([
		{ method: 'popup_removeAddressBookEntry' },
		{ method: 'popup_addOrModifyAddressBookEntry' },
	] as const)('$method reconciles website approvals read after the write instead of the admitted snapshot', async ({ method }) => {
		const websiteOrigin = 'revoked-after-admission.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		// The site was revoked after the popup request was admitted, so only the admitted snapshot still approves it.
		storageState.websiteAccess = [{ website, addressAccess: [], access: false }]
		const context = createDispatcherContext(async () => undefined)
		context.settings = { ...settings, websiteAccess: [{ website, access: true, addressAccess: [{ address: settings.activeSimulationAddress ?? 0n, access: true }] }] }
		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const connection = { port, socket, websiteOrigin, approved: true, wantsToConnect: true }
		context.websiteTabConnections = new Map([[socket.tabId, { connections: { [websiteSocketToString(socket)]: connection } }]])

		if (method === 'popup_removeAddressBookEntry') {
			await dispatchPopupMessage(context, { method, data: { address: 5n, chainId: 1n, addressBookCategory: 'My Active Addresses' } })
		} else {
			assert.deepEqual(await dispatchPopupMessage(context, { method, data: { type: 'contact', name: 'Active contact', address: 5n, entrySource: 'User', useAsActiveAddress: true } }), { type: 'AddOrModifyAddressBookEntryReply', ok: true })
		}

		assert.equal(connection.approved, false)
	})

	test('settings import does not restore website access revoked while content-script registration is pending', async () => {
		const websiteOrigin = 'revoked-during-import.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const context = createDispatcherContext(async () => undefined)
		await updateWebsiteAccess(() => [{ website, access: true, addressAccess: [{ address: settings.activeSimulationAddress ?? 0n, access: true }] }])
		const exportedSettings = await exportSettingsAndAddressBook()
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connection = { port, socket, websiteOrigin, approved: false, wantsToConnect: false }
		context.websiteTabConnections = new Map([[socket.tabId, { connections: { [websiteSocketToString(socket)]: connection } }]])
		const registrationStarted = createDeferredValue<void>()
		const releaseRegistration = createDeferredValue<void>()
		contentScriptRegistrationWait = { started: () => registrationStarted.resolve(undefined), release: releaseRegistration.promise }

		const importing = dispatchPopupMessage(context, { method: 'popup_import_settings', data: { fileContents: JSON.stringify(serialize(ExportedSettings, exportedSettings)) } })
		await registrationStarted.promise
		// The imported approval is revoked and reconciled while the import awaits content-script registration.
		await updateWebsiteAccess(() => [{ website, access: false, addressAccess: undefined }])
		await updateWebsiteApprovalAccesses(undefined, context.websiteTabConnections, await getRequiredSettings(), false)
		releaseRegistration.resolve(undefined)
		await importing

		assert.equal(connection.approved, false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged' && Array.isArray(message.result) && message.result.length > 0), false)
	})

	test.each([
		{ method: 'popup_removeWebsiteAccess' },
		{ method: 'popup_removeWebsiteAddressAccess' },
	] as const)('$method unapproves the website when settings become unreadable right after the revocation is persisted', async ({ method }) => {
		const websiteOrigin = 'revoked-then-corrupted.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		const activeAddress = settings.activeSimulationAddress ?? 0n
		storageState.websiteAccess = [{ website, access: true, addressAccess: [{ address: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045', access: true }] }]
		const context = createDispatcherContext(async () => undefined)
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connection = { port, socket, websiteOrigin, approved: true, wantsToConnect: false }
		context.websiteTabConnections = new Map([[socket.tabId, { connections: { [websiteSocketToString(socket)]: connection } }]])
		corruptActiveRpcNetworkAfterWriting('websiteAccess')
		const originalWarn = console.warn
		console.warn = () => undefined
		try {
			const removal = method === 'popup_removeWebsiteAccess'
				? dispatchPopupMessage(context, { method, data: { websiteOrigin } })
				: dispatchPopupMessage(context, { method, data: { websiteOrigin, address: activeAddress } })
			await assert.rejects(removal, isRpcConfigurationUnavailableError)
		} finally {
			console.warn = originalWarn
		}

		assert.equal(connection.approved, false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged' && Array.isArray(message.result) && message.result.length > 0), false)
	})

	test('an address-consent change unapproves connections when settings become unreadable right after it is persisted', async () => {
		const websiteOrigin = 'consent-change-then-corrupted.test'
		storageState.websiteAccess = [{ website: { websiteOrigin, icon: undefined, title: undefined }, access: true, addressAccess: undefined }]
		const activeEntry = { type: 'contact' as const, name: 'Active', address: settings.activeSimulationAddress ?? 0n, entrySource: 'User' as const, useAsActiveAddress: true, askForAddressAccess: false }
		const context = createDispatcherContext(async () => undefined)
		assert.deepEqual(await dispatchPopupMessage(context, { method: 'popup_addOrModifyAddressBookEntry', data: activeEntry }), { type: 'AddOrModifyAddressBookEntryReply', ok: true })
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connection = { port, socket, websiteOrigin, approved: true, wantsToConnect: false }
		context.websiteTabConnections = new Map([[socket.tabId, { connections: { [websiteSocketToString(socket)]: connection } }]])
		corruptActiveRpcNetworkAfterWriting('userAddressBookEntriesV3')
		const originalWarn = console.warn
		console.warn = () => undefined
		try {
			// The address now requires per-address consent, which this site never granted.
			const reply = await dispatchPopupMessage(context, { method: 'popup_addOrModifyAddressBookEntry', data: { ...activeEntry, askForAddressAccess: true } })
			assert.deepEqual(reply, { type: 'AddOrModifyAddressBookEntryReply', ok: false, message: 'Interceptor RPC configuration is unavailable. Network requests are paused until the user restores it.' })
		} finally {
			console.warn = originalWarn
		}

		assert.equal(connection.approved, false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged' && Array.isArray(message.result) && message.result.length > 0), false)
	})

	test('removing an active address unapproves connections when settings become unreadable right after it is persisted', async () => {
		const websiteOrigin = 'removal-then-corrupted.test'
		storageState.websiteAccess = [{ website: { websiteOrigin, icon: undefined, title: undefined }, access: true, addressAccess: undefined }]
		const context = createDispatcherContext(async () => undefined)
		const socket = { tabId: 1, connectionName: 0n }
		const { port, messages } = createPort(socket.tabId)
		const connection = { port, socket, websiteOrigin, approved: true, wantsToConnect: false }
		context.websiteTabConnections = new Map([[socket.tabId, { connections: { [websiteSocketToString(socket)]: connection } }]])
		corruptActiveRpcNetworkAfterWriting('userAddressBookEntriesV3')
		const originalWarn = console.warn
		console.warn = () => undefined
		try {
			await assert.rejects(dispatchPopupMessage(context, { method: 'popup_removeAddressBookEntry', data: { address: settings.activeSimulationAddress ?? 0n, chainId: 1n, addressBookCategory: 'My Active Addresses' } }), isRpcConfigurationUnavailableError)
		} finally {
			console.warn = originalWarn
		}

		assert.equal(connection.approved, false)
		assert.equal(messages.some((message) => message.method === 'accountsChanged' && Array.isArray(message.result) && message.result.length > 0), false)
	})

	test('a block-all toggle installs its request rule when settings become unreadable right after it is persisted', async () => {
		const websiteOrigin = 'block-then-corrupted.test'
		const website = { websiteOrigin, icon: undefined, title: undefined }
		storageState.websiteAccess = [{ website, access: true, addressAccess: undefined }]
		corruptActiveRpcNetworkAfterWriting('websiteAccess')
		const originalWarn = console.warn
		console.warn = () => undefined
		try {
			await assert.rejects(dispatchPopupMessage(createDispatcherContext(async () => undefined), { method: 'popup_blockOrAllowExternalRequests', data: { website, shouldBlock: true } }), isRpcConfigurationUnavailableError)
		} finally {
			console.warn = originalWarn
		}

		assert.equal(JSON.stringify(dynamicRuleUpdates.at(-1)).includes(websiteOrigin), true)
	})

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

	test('returns a successful save reply without waiting for address-book refresh listeners', async () => {
		let releaseBroadcast: (() => void) | undefined
		addressBookBroadcastWait = new Promise<void>((resolve) => { releaseBroadcast = resolve })
		const dispatch = dispatchPopupMessage(createDispatcherContext(async () => undefined), {
			method: 'popup_addOrModifyAddressBookEntry',
			data: {
				type: 'contract',
				name: 'Contract with fetched ABI',
				address: 1n,
				entrySource: 'User',
				abi: '[{"type":"function","name":"read","inputs":[],"outputs":[],"stateMutability":"view"}]',
			},
		})

		while (!sentMessages.some((message) => {
			const parsed = MessageToPopup.safeParse(message)
			return parsed.success && parsed.value.method === 'popup_addressBookEntriesChanged'
		})) await Promise.resolve()
		const result = await Promise.race([
			dispatch,
			new Promise<'save reply timeout'>((resolve) => { setTimeout(() => resolve('save reply timeout'), 50) }),
		])
		releaseBroadcast?.()
		await dispatch

		assert.deepEqual(result, { type: 'AddOrModifyAddressBookEntryReply', ok: true })
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
		Object.defineProperty(context.simulationServicesOwner.requireCurrent().ethereum, 'getChainId', { value: () => 1n })

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
		assert.equal(storageState.independentActiveSimulationAddress, undefined)
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
					interceptorDisabled: true,
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
		assert.equal(messages[1].data.activeSimulationAddress, 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n)
		assert.equal(messages[1].data.activeRpcNetwork.httpsRpc, 'https://example.test/rpc')
		assert.equal(messages[1].data.simulationMode, false)
		assert.deepEqual(contentScriptUpdateBatches.at(-1)?.map(({ id, excludeMatches }) => ({ id, excludeMatches })), [
			{ id: 'inpage2', excludeMatches: ['*://*.success-refresh.test/*'] },
			{ id: 'inpage', excludeMatches: ['*://*.success-refresh.test/*'] },
		])
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
