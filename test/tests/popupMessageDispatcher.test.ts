import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import type { PopupMessageDispatcherContext } from '../../app/ts/background/popupMessageHandlerRegistry.js'
import type { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { TokenPriceService } from '../../app/ts/simulation/services/priceEstimator.js'
import type { Settings } from '../../app/ts/types/interceptor-messages.js'
import type { WebsiteAccess } from '../../app/ts/types/websiteAccessTypes.js'
import { settleWithin, waitFor } from '../harness/async.js'
import { createEthereumWithGetBlockCounter, createRestoringBrowserMockInstaller, createTestSimulationServicesOwner, installBackgroundBrowserMock } from './backgroundEthAccountsTestHarness.js'
import { withSilencedConsole } from './consoleSilence.js'

const installBrowserMock = createRestoringBrowserMockInstaller()

// The dispatcher modules check for the extension globals while they load, so they are imported under a mock that is removed again before the tests install their own.
const importTimeBrowserMock = installBackgroundBrowserMock()
const [
	{ dispatchPopupMessage },
	{ getLatestUnexpectedError },
	{ EthereumClientService: EthereumClientServiceConstructor },
	{ TokenPriceService: TokenPriceServiceConstructor },
	{ MessageToPopup },
] = await Promise.all([
	import('../../app/ts/background/popupMessageDispatcher.js'),
	import('../../app/ts/utils/unexpectedErrorStorage.js'),
	import('../../app/ts/simulation/services/EthereumClientService.js'),
	import('../../app/ts/simulation/services/priceEstimator.js'),
	import('../../app/ts/types/interceptor-messages.js'),
])
importTimeBrowserMock.restore()

type ContentScriptUpdate = { readonly id: string, readonly excludeMatches?: readonly string[] }
type DispatcherEvent = { readonly type: 'message', readonly message: unknown } | { readonly type: 'dynamicRuleUpdate' }

const isPopupMessage = (method: string) => (message: unknown) => {
	const parsed = MessageToPopup.safeParse(message)
	return parsed.success && parsed.value.method === method
}

// Installs a browser mock with the manifest v3 content scripts registered, and records content-script updates plus the order of popup broadcasts and dynamic rule updates.
async function installDispatcherBrowserMock({ websiteAccess }: { readonly websiteAccess?: readonly WebsiteAccess[] } = {}) {
	const browserMock = installBrowserMock({ storage: { local: websiteAccess === undefined ? {} : { websiteAccess } } })
	await browserMock.browser.scripting.registerContentScripts([
		{ id: 'inpage', excludeMatches: ['*://*.disabled.test/*'] },
		{ id: 'inpage2', excludeMatches: ['*://*.disabled.test/*'] },
	])
	const contentScriptUpdateBatches: ContentScriptUpdate[][] = []
	const scripting = browserMock.browser.scripting
	const updateContentScripts = scripting.updateContentScripts
	scripting.updateContentScripts = async (scripts) => {
		contentScriptUpdateBatches.push([...scripts])
		await updateContentScripts(scripts)
	}
	const dispatcherEvents: DispatcherEvent[] = []
	browserMock.handlers.runtimeMessage = (message) => {
		dispatcherEvents.push({ type: 'message', message })
		return undefined
	}
	const declarativeNetRequest = browserMock.browser.declarativeNetRequest
	const updateDynamicRules = declarativeNetRequest.updateDynamicRules
	declarativeNetRequest.updateDynamicRules = async (options) => {
		dispatcherEvents.push({ type: 'dynamicRuleUpdate' })
		await updateDynamicRules(options)
	}
	return {
		browserMock,
		sentMessages: browserMock.calls.runtimeSendMessage,
		contentScriptUpdateBatches,
		dispatcherEvents,
		dynamicRuleUpdates: () => browserMock.calls.declarativeNetRequestUpdates.flatMap(({ scope, options }) => scope === 'dynamic' ? [options] : []),
	}
}

const settings: Settings = {
	activeSimulationAddress: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
	activeSigningSafeAddress: undefined,
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

// Services built without their constructors, so a handler that unexpectedly reaches the RPC fails instead of polling it.
const createInertServices = () => {
	const ethereum: EthereumClientService = Object.create(EthereumClientServiceConstructor.prototype)
	const tokenPriceService: TokenPriceService = Object.create(TokenPriceServiceConstructor.prototype)
	return { ethereum, tokenPriceService }
}

function createDispatcherContext(resetSimulationState: () => Promise<void>, { ethereum, tokenPriceService } = createInertServices()): PopupMessageDispatcherContext {
	return {
		websiteTabConnections: new Map(),
		simulationServicesOwner: createTestSimulationServicesOwner({ ethereum, tokenPriceService }, () => ({ ethereum, tokenPriceService })),
		settings,
		publishRpcConnectionStatus: async () => undefined,
		simulationAbortController: new AbortController(),
		confirmTransactionAbortController: new AbortController(),
		resetSimulationState,
	}
}

describe('popup message dispatcher seams', () => {
	test('refreshes manifest v3 content script exclusions after removing a disabled website', async () => {
		const { browserMock, contentScriptUpdateBatches } = await installDispatcherBrowserMock({ websiteAccess: [disabledWebsiteAccess] })

		await dispatchPopupMessage(createDispatcherContext(async () => undefined), {
			method: 'popup_removeWebsiteAccess',
			data: { websiteOrigin: 'disabled.test' },
		})

		assert.deepEqual(browserMock.readStoredValue('websiteAccess'), [])
		assert.equal(contentScriptUpdateBatches.length, 1)
		assert.deepEqual(contentScriptUpdateBatches.at(-1)?.map(({ id, excludeMatches }) => ({ id, excludeMatches })), [
			{ id: 'inpage2', excludeMatches: [] },
			{ id: 'inpage', excludeMatches: [] },
		])
	})

	test('does not refresh content script exclusions after removing an enabled website', async () => {
		const { browserMock, contentScriptUpdateBatches } = await installDispatcherBrowserMock({ websiteAccess: [{ ...disabledWebsiteAccess, interceptorDisabled: false }] })

		await dispatchPopupMessage(createDispatcherContext(async () => undefined), {
			method: 'popup_removeWebsiteAccess',
			data: { websiteOrigin: 'disabled.test' },
		})

		assert.deepEqual(browserMock.readStoredValue('websiteAccess'), [])
		assert.equal(contentScriptUpdateBatches.length, 0)
	})

	test('refreshes manifest v3 content script exclusions after the access editor removes a disabled website', async () => {
		const { browserMock, contentScriptUpdateBatches } = await installDispatcherBrowserMock({ websiteAccess: [disabledWebsiteAccess] })

		await dispatchPopupMessage(createDispatcherContext(async () => undefined), {
			method: 'popup_changeInterceptorAccess',
			data: [{
				oldEntry: disabledWebsiteAccess,
				newEntry: disabledWebsiteAccess,
				removed: true,
			}],
		})

		assert.deepEqual(browserMock.readStoredValue('websiteAccess'), [])
		assert.equal(contentScriptUpdateBatches.length, 1)
		assert.deepEqual(contentScriptUpdateBatches.at(-1)?.map(({ id, excludeMatches }) => ({ id, excludeMatches })), [
			{ id: 'inpage2', excludeMatches: [] },
			{ id: 'inpage', excludeMatches: [] },
		])
	})

	test('snapshot registration captures at invocation and keeps one pair across awaits', async () => {
		await installDispatcherBrowserMock()
		const { popupSnapshotMessageHandler } = await import('../../app/ts/background/popupMessageHandlerRegistry.js')
		const context = createDispatcherContext(async () => undefined)
		const initial = context.simulationServicesOwner.getCurrent()
		const replacement = createDispatcherContext(async () => undefined).simulationServicesOwner.getCurrent()
		const last = createDispatcherContext(async () => undefined).simulationServicesOwner.getCurrent()
		let next = replacement
		context.simulationServicesOwner = createTestSimulationServicesOwner(initial, () => next)
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const observed: typeof initial[] = []
		const handler = popupSnapshotMessageHandler('popup_requestSimulationMetadata', async snapshot => {
			assert.equal('simulationServicesOwner' in snapshot, false)
			assert.equal('resetSimulationState' in snapshot, false)
			observed.push(snapshot.services)
			entered.resolve()
			await release.promise
			observed.push(snapshot.services)
		})
		const network = { ...settings.activeRpcNetwork, httpsRpc: 'https://snapshot.example' }
		context.simulationServicesOwner.reset(network)
		const pending = handler(context, { method: 'popup_requestSimulationMetadata' })
		await entered.promise
		next = last
		context.simulationServicesOwner.reset(network)
		release.resolve()
		await pending
		await handler(context, { method: 'popup_requestSimulationMetadata' })
		assert.equal(observed.length, 4)
		for (const [index, expected] of [replacement, replacement, last, last].entries()) assert.strictEqual(observed[index], expected)
	})

	test('returns a save failure when address-book persistence fails', async () => {
		const { browserMock } = await installDispatcherBrowserMock()
		browserMock.browser.storage.local.set = async () => { throw new Error('Address-book storage unavailable.') }

		const result = await withSilencedConsole(async () => await dispatchPopupMessage(createDispatcherContext(async () => undefined), {
			method: 'popup_addOrModifyAddressBookEntry',
			data: {
				type: 'contact',
				name: 'Alice',
				address: 1n,
				entrySource: 'User',
			},
		}))

		assert.deepEqual(result, {
			type: 'AddOrModifyAddressBookEntryReply',
			ok: false,
			message: 'Address-book storage unavailable.',
		})
	})

	test('returns and records a failure when active-address access refresh fails', async () => {
		const { browserMock, dynamicRuleUpdates } = await installDispatcherBrowserMock({ websiteAccess: [{
			website: {
				websiteOrigin: 'address-book-refresh-failure.test',
				icon: undefined,
				title: 'Address-book refresh failure',
			},
			addressAccess: [],
			access: true,
			declarativeNetRequestBlockMode: 'block-all',
		}] })
		const declarativeNetRequest = browserMock.browser.declarativeNetRequest
		const updateDynamicRules = declarativeNetRequest.updateDynamicRules
		declarativeNetRequest.updateDynamicRules = async () => { throw new Error('Access refresh unavailable.') }

		const result = await withSilencedConsole(async () => await dispatchPopupMessage(createDispatcherContext(async () => undefined), {
			method: 'popup_addOrModifyAddressBookEntry',
			data: {
				type: 'contact',
				name: 'Alice',
				address: 1n,
				entrySource: 'User',
				useAsActiveAddress: true,
			},
		}))
		const latestUnexpectedError = await getLatestUnexpectedError()

		assert.deepEqual(result, {
			type: 'AddOrModifyAddressBookEntryReply',
			ok: false,
			message: 'Access refresh unavailable.',
		})
		assert.equal(latestUnexpectedError?.data.source, 'address_book_save')
		assert.equal(latestUnexpectedError?.data.code, 'address_book_save_failed')

		declarativeNetRequest.updateDynamicRules = updateDynamicRules
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
		assert.equal(dynamicRuleUpdates().length, 1)
	})

	test('broadcasts address-book saves for metadata consumers to refresh themselves', async () => {
		const { sentMessages } = await installDispatcherBrowserMock()
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
		assert.equal(sentMessages.some(isPopupMessage('popup_addressBookEntriesChanged')), true)
	})

	test('returns a successful save reply without waiting for address-book refresh listeners', async () => {
		const { browserMock, sentMessages } = await installDispatcherBrowserMock()
		const releaseBroadcast = Promise.withResolvers<void>()
		browserMock.handlers.runtimeMessage = async (message) => {
			if (isPopupMessage('popup_addressBookEntriesChanged')(message)) await releaseBroadcast.promise
			return undefined
		}
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

		await waitFor(() => sentMessages.some(isPopupMessage('popup_addressBookEntriesChanged')), { description: 'the address-book broadcast' })
		const result = await settleWithin(dispatch, 50, 'The save reply waited for the address-book broadcast listeners')
		releaseBroadcast.resolve()
		await dispatch

		assert.deepEqual(result, { type: 'AddOrModifyAddressBookEntryReply', ok: true })
	})

	test('delegates simulation reset through the injected lifecycle callback', async () => {
		await installDispatcherBrowserMock()
		let resetCount = 0
		const result = await dispatchPopupMessage(createDispatcherContext(async () => {
			resetCount += 1
		}), { method: 'popup_resetSimulation' })
		assert.equal(result, undefined)
		assert.equal(resetCount, 1)
	})

	test('deliberately ignores popup window status probes handled by window listeners', async () => {
		await installDispatcherBrowserMock()
		const context = createDispatcherContext(async () => {
			throw new Error('Window status probes must not reset simulation state.')
		})
		assert.equal(await dispatchPopupMessage(context, { method: 'popup_isMainPopupWindowOpen' }), undefined)
		assert.equal(await dispatchPopupMessage(context, { method: 'popup_isSimulationVisualizerOpen' }), undefined)
	})

	test('does not identify an address using a different active chain', async () => {
		await installDispatcherBrowserMock()
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 }, { getChainId: () => 1n })
		const context = createDispatcherContext(async () => undefined, { ethereum, tokenPriceService })

		assert.deepEqual(await dispatchPopupMessage(context, {
			method: 'popup_requestIdentifyAddress',
			data: { address: 1n, chainId: 10n },
		}), {
			method: 'popup_requestIdentifyAddress',
			data: { chainId: 10n, addressBookEntry: undefined },
		})
	})

	test('routes Safe contract state through its dedicated protocol', async () => {
		await installDispatcherBrowserMock()
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
		const { browserMock, sentMessages, dynamicRuleUpdates } = await installDispatcherBrowserMock({ websiteAccess: [{
			website: { websiteOrigin: 'failure-refresh.test', icon: undefined, title: 'Failure refresh sentinel' },
			addressAccess: [],
			access: true,
			declarativeNetRequestBlockMode: 'block-all',
		}] })
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
		assert.equal(browserMock.readStoredValue('independentActiveSimulationAddress'), undefined)
		assert.deepEqual(dynamicRuleUpdates(), [])
	})

	test('reloads imported settings before refreshing access and broadcasting the update', async () => {
		const { sentMessages, dispatcherEvents, dynamicRuleUpdates } = await installDispatcherBrowserMock()
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
		assert.equal(messages[1].data.activeSimulationAddress, 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n)
		assert.equal(messages[1].data.activeRpcNetwork.httpsRpc, 'https://example.test/rpc')
		assert.equal(messages[1].data.simulationMode, false)
		assert.deepEqual(dynamicRuleUpdates(), [{
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
