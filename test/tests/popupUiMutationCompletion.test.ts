import * as assert from 'node:assert'
import { afterEach, describe, test } from 'bun:test'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import type { ModifyAddressWindowState, PreSimulationTransaction } from '../../app/ts/types/visualizer-types.js'
import { createTestSimulationServicesOwner, createDeferredSignal, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules } from './backgroundEthAccountsTestHarness.js'
import { waitForBackgroundTasks } from './backgroundTasksTestHarness.js'
import { pendingTransaction, signedTransaction } from './confirmTransactionTestHarness.js'
import { isPendingTransactionGasLimitCurrent } from '../../app/ts/utils/pendingTransactionSimulation.js'

const transaction: PreSimulationTransaction = {
	signedTransaction,
	website: pendingTransaction.website,
	created: pendingTransaction.created,
	originalRequestParameters: pendingTransaction.originalRequestParameters,
	transactionIdentifier: pendingTransaction.transactionIdentifier,
}

afterEach(waitForBackgroundTasks)

async function completesPromptly<T>(result: Promise<T>) {
	let timeout: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			result,
			new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('UI command waited for follow-up work')), 1000) }),
		])
	} finally { clearTimeout(timeout) }
}

describe('UI mutation completion', () => {
	test.each(['rich', 'reset', 'remove', 'time', 'transaction time', 'gas', 'network', 'mode', 'safe'] as const)('%s edit completes while its simulation refresh is pending', async operation => {
		const { runtimeMessages } = installBrowserMock()
		const modules = await loadModules()
		const handlers = await import('../../app/ts/background/popupMessageHandlers.js')
		const { dispatchPopupMessage } = await import('../../app/ts/background/popupMessageDispatcher.js')
		await modules.changeSimulationMode({ simulationMode: operation !== 'mode' && operation !== 'safe', activeSimulationAddress: signedTransaction.from, activeSigningAddress: signedTransaction.from })
		await modules.setMakeCurrentAddressRich(false)
		if (operation === 'remove' || operation === 'transaction time' || operation === 'gas') {
			await modules.updateInterceptorTransactionStack(() => ({ operations: [{ type: 'Transaction', preSimulationTransaction: transaction }] }))
		}
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })
		const owner = createTestSimulationServicesOwner({ ethereum, tokenPriceService })
		const context = {
			simulationServicesOwner: owner, settings: await modules.getSettings(), websiteTabConnections: new Map(),
			publishRpcConnectionStatus: async () => undefined,
			simulationAbortController: new AbortController(), confirmTransactionAbortController: new AbortController(),
			resetSimulationState: async () => await modules.resetSimulationStateFromConfig(owner),
		}
		const refreshStarted = createDeferredSignal()
		const releaseRefresh = createDeferredSignal()
		const originalSend = browser.runtime.sendMessage.bind(browser.runtime)
		Object.defineProperty(browser.runtime, 'sendMessage', { configurable: true, value: async (message: { method?: string }) => {
			if (message.method === 'popup_isSimulationVisualizerOpen') {
				refreshStarted.resolve()
				await releaseRefresh.promise
			}
			return await originalSend(message)
		} })
		const time = { type: 'AddToTimestamp', deltaToAdd: 60n, deltaUnit: 'Seconds' } as const
		try {
			const edit = operation === 'rich' ? dispatchPopupMessage(context, { method: 'popup_modifyMakeMeRich', data: { address: 'CurrentAddress', add: true } })
				: operation === 'reset' ? modules.resetSimulationStateFromConfig(owner)
				: operation === 'remove' ? handlers.removeTransactionOrSignedMessage(ethereum, tokenPriceService, { method: 'popup_removeTransactionOrSignedMessage', data: { type: 'Transaction', transactionIdentifier: transaction.transactionIdentifier } })
				: operation === 'time' ? handlers.changePreSimulationBlockTimeManipulation(ethereum, tokenPriceService, { method: 'popup_changePreSimulationBlockTimeManipulation', data: { blockTimeManipulation: time } })
				: operation === 'transaction time' ? handlers.setTransactionOrMessageBlockTimeManipulator(ethereum, tokenPriceService, { method: 'popup_setTransactionOrMessageBlockTimeManipulator', data: { transactionOrMessageIdentifier: { type: 'Transaction', transactionIdentifier: transaction.transactionIdentifier }, blockTimeManipulation: time } })
				: operation === 'gas' ? handlers.forceSetGasLimitForTransaction(ethereum, tokenPriceService, { method: 'popup_forceSetGasLimitForTransaction', data: { transactionIdentifier: transaction.transactionIdentifier, gasLimit: 30_000n } })
				: operation === 'network' ? dispatchPopupMessage(context, { method: 'popup_changeActiveRpc', data: { ...context.settings.activeRpcNetwork, httpsRpc: 'https://next.invalid' } })
				: operation === 'mode' ? dispatchPopupMessage(context, { method: 'popup_enableSimulationMode', data: true })
				: modules.activateAddressSelection(owner, new Map(), { type: 'addressBookEntry', entry: { type: 'safe', address: 3n, chainId: context.settings.activeRpcNetwork.chainId, name: 'Safe', entrySource: 'User', useAsActiveAddress: true, safeSignerAddresses: [signedTransaction.from] } }, { simulationMode: false, signerAddress: signedTransaction.from, promptForAccessesIfNeeded: false })
			await completesPromptly(edit)
			await completesPromptly(refreshStarted.promise)
			const state = await modules.getPopupVisualisationState()
			assert.equal(state.simulationUpdatingState, 'updating')
			assert.equal(state.simulationResultState, 'invalid')
			if (operation === 'rich') assert.equal(await modules.getMakeCurrentAddressRich(), true)
			if (operation === 'reset' || operation === 'remove') assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 0)
			if (operation === 'gas') {
				const saved = (await modules.getInterceptorTransactionStack()).operations[0]
				assert.ok(saved?.type === 'Transaction')
				assert.equal(saved.preSimulationTransaction.signedTransaction.gas, 30_000n)
				assert.equal(runtimeMessages.some(message => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions'), false, 'Stack-only gas edits must not broadcast an empty confirmation list')
			}
			// The settings coordinator must be available even while the earlier refresh is blocked.
			const next = await completesPromptly(dispatchPopupMessage(context, { method: 'popup_modifyMakeMeRich', data: { address: 'CurrentAddress', add: false } }))
			assert.equal(next?.type, 'PopupSettingsChangeReply')
			assert.ok(next !== undefined && 'ok' in next && next.ok)
		} finally {
			releaseRefresh.resolve()
			await waitForBackgroundTasks()
			Object.defineProperty(browser.runtime, 'sendMessage', { configurable: true, value: originalSend })
		}
	})

	test('simulation stack import acknowledges persisted operations while refresh is pending', async () => {
		installBrowserMock()
		const modules = await loadModules()
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })
		const started = createDeferredSignal()
		const release = createDeferredSignal()
		const originalSend = browser.runtime.sendMessage.bind(browser.runtime)
		Object.defineProperty(browser.runtime, 'sendMessage', { configurable: true, value: async (message: { method?: string }) => {
			if (message.method === 'popup_isSimulationVisualizerOpen') { started.resolve(); await release.promise }
			return await originalSend(message)
		} })
		try {
			const reply = await completesPromptly(modules.importSimulationStack(ethereum, tokenPriceService, { method: 'popup_importSimulationStack', data: {
				name: 'Interceptor Simulation Export', version: '1.0.0',
				eth_simulateV1: { method: 'eth_simulateV1', params: [{ blockStateCalls: [], traceTransfers: true, validation: true }, 'latest'] },
				interceptorSimulateStack: { operations: [{ type: 'Transaction', preSimulationTransaction: transaction }] },
			} }))
			assert.equal(reply.ok, true)
			await completesPromptly(started.promise)
			assert.equal((await modules.getInterceptorTransactionStack()).operations.length, 1)
			assert.equal((await modules.getPopupVisualisationState()).simulationResultState, 'invalid')
		} finally { release.resolve(); await waitForBackgroundTasks() }
	})

	test('address form validation checks local duplicates without requesting on-chain metadata', async () => {
		installBrowserMock()
		const modules = await loadModules()
		const { ethereum } = createEthereumWithGetBlockCounter({ count: 0 })
		const address = '0x9999999999999999999999999999999999999999'
		const state: ModifyAddressWindowState = { windowStateId: 'local-validation', errorState: undefined, incompleteAddressBookEntry: {
			addingAddress: true, type: 'contact', address, chainId: 1n, name: 'My contact', entrySource: 'User',
			askForAddressAccess: true, symbol: undefined, decimals: undefined, logoUri: undefined, abi: undefined,
			useAsActiveAddress: undefined, declarativeNetRequestBlockMode: undefined,
		} }
		await modules.setPage({ page: 'AddNewAddress', state })
		const originalFetch = globalThis.fetch
		let requests = 0
		globalThis.fetch = async () => { requests++; throw new Error('Validation must not make remote requests') }
		try {
			await completesPromptly(modules.changeAddOrModifyAddressWindowState(ethereum, { method: 'popup_changeAddOrModifyAddressWindowState', data: { windowStateId: state.windowStateId, newState: state } }))
			assert.equal(requests, 0)
			await modules.updateUserAddressBookEntries(() => [{ type: 'contact', address: BigInt(address), chainId: 1n, name: 'Existing', entrySource: 'User' }])
			await completesPromptly(modules.changeAddOrModifyAddressWindowState(ethereum, { method: 'popup_changeAddOrModifyAddressWindowState', data: { windowStateId: state.windowStateId, newState: state } }))
			const page = await modules.getPage()
			assert.ok(page.page === 'AddNewAddress')
			assert.equal(page.state.errorState?.blockEditing, true)
			assert.match(page.state.errorState?.message ?? '', /already exists/)
			assert.equal(requests, 0)
		} finally { globalThis.fetch = originalFetch }
	})

	test('revokes access before acknowledgement and reloads only the affected website in the background', async () => {
		installBrowserMock()
		const modules = await loadModules()
		const { allowOrPreventAddressAccessForWebsite } = await import('../../app/ts/background/popupMessageHandlers/websiteAccess.js')
		const address = signedTransaction.from
		await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: address })
		await modules.updateUserAddressBookEntries(() => [{ type: 'contact', address, name: 'Account', chainId: 'AllChains', entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: true }])
		const website = { websiteOrigin: 'changed.test' }
		await modules.updateWebsiteAccess(() => [website, { websiteOrigin: 'unrelated.test' }].map(website => ({ website, access: true, addressAccess: [{ address, access: true }] })))
		const connections: WebsiteTabConnections = new Map()
		for (const [tabId, websiteOrigin] of [[1, website.websiteOrigin], [2, 'unrelated.test']] as const) {
			const socket = { tabId, connectionName: 0n }
			const { port } = createPort(tabId)
			connections.set(tabId, { connections: { [modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: true, wantsToConnect: true } } })
		}
		const started = createDeferredSignal()
		const release = createDeferredSignal()
		const reloaded: number[] = []
		Object.defineProperty(browser.tabs, 'reload', { configurable: true, value: async (tabId: number) => {
			reloaded.push(tabId)
			started.resolve()
			await release.promise
		} })
		try {
			await completesPromptly(allowOrPreventAddressAccessForWebsite(connections, { method: 'popup_allowOrPreventAddressAccessForWebsite', data: { website, address, allowAccess: false } }))
			await completesPromptly(started.promise)
			assert.deepEqual(reloaded, [1])
			assert.equal(Object.values(connections.get(1)?.connections ?? {})[0]?.approved, false)
			assert.equal(Object.values(connections.get(2)?.connections ?? {})[0]?.approved, true)
			assert.equal((await modules.getSettings()).websiteAccess[0]?.addressAccess?.[0]?.access, false)
		} finally { release.resolve(); await waitForBackgroundTasks() }
	})

	test.each(['before write', 'after write'] as const)('reconciles persisted permissions when a mutation rejects %s', async failure => {
		const { runtimeMessages } = installBrowserMock()
		const modules = await loadModules()
		const { applyWebsiteAccessChange } = await import('../../app/ts/background/accessManagement.js')
		const address = signedTransaction.from
		await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: address })
		await modules.updateUserAddressBookEntries(() => [{ type: 'contact', address, name: 'Account', chainId: 'AllChains', entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: true }])
		await modules.updateWebsiteAccess(() => ['edited.test', 'unrelated.test'].map(websiteOrigin => ({ website: { websiteOrigin }, access: true, addressAccess: [{ address, access: true }] })))
		const approvals: boolean[] = []
		const connections: WebsiteTabConnections = Object.assign(new Map(), { lifecycle: { approvalChanged: (_socket: unknown, approved: boolean) => { approvals.push(approved) } } })
		for (const [tabId, websiteOrigin] of [[1, 'edited.test'], [2, 'unrelated.test']] as const) {
			const socket = { tabId, connectionName: 0n }
			connections.set(tabId, { connections: { [modules.websiteSocketToString(socket)]: { port: createPort(tabId).port, socket, websiteOrigin, approved: true, wantsToConnect: true } } })
		}
		const error = new Error(`Mutation failed ${ failure }`)
		const originalSet = browser.storage.local.set.bind(browser.storage.local)
		Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: async (items: Record<string, unknown>) => {
			if (failure === 'before write' && 'websiteAccess' in items) throw error
			return await originalSet(items)
		} })
		try {
			await assert.rejects(applyWebsiteAccessChange(connections, async () => {
				await modules.updateWebsiteAccess(entries => entries.map(entry => entry.website.websiteOrigin === 'edited.test' ? { ...entry, access: false } : entry))
				// Represents content-script setup rejecting after the permission write has resolved.
				throw error
			}), caught => caught === error)
			assert.equal(Object.values(connections.get(1)?.connections ?? {})[0]?.approved, failure === 'before write')
			assert.equal(Object.values(connections.get(2)?.connections ?? {})[0]?.approved, true)
			assert.deepEqual(approvals, failure === 'before write' ? [] : [false])
			assert.equal(runtimeMessages.some(message => message.method === 'popup_websiteAccess_changed'), false)
		} finally { Object.defineProperty(browser.storage.local, 'set', { configurable: true, value: originalSet }) }
	})

	test('failed reconciliation clears every approval and notifies lifecycle despite a broken port', async () => {
		installBrowserMock()
		const modules = await loadModules()
		const { reconcileCommittedWebsiteAccess } = await import('../../app/ts/background/accessManagement.js')
		const revokedTabs: number[] = []
		const connections: WebsiteTabConnections = Object.assign(new Map(), { lifecycle: { approvalChanged: (socket: { tabId: number }, approved: boolean) => { if (!approved) revokedTabs.push(socket.tabId) } } })
		const healthyPort = createPort(2)
		for (const tabId of [1, 2, 3]) {
			const socket = { tabId, connectionName: 0n }
			const port = tabId === 2 ? healthyPort.port : createPort(tabId, () => { throw new Error('Broken port notification') }).port
			connections.set(tabId, { connections: { [modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: 'unknown.test', approved: tabId !== 3, wantsToConnect: true } } })
		}
		const error = new Error('Cannot read committed settings')
		const originalGet = browser.storage.local.get.bind(browser.storage.local)
		Object.defineProperty(browser.storage.local, 'get', { configurable: true, value: async (keys?: string | string[] | Record<string, unknown> | null) => {
			if (Array.isArray(keys) && keys.includes('openedPageV2')) throw error
			return await originalGet(keys)
		} })
		try {
			await assert.rejects(reconcileCommittedWebsiteAccess(connections), caught => caught === error)
			assert.equal([...connections.values()].some(tab => Object.values(tab.connections).some(connection => connection.approved)), false)
			assert.deepEqual(revokedTabs, [1, 2, 3])
			assert.deepEqual(healthyPort.messages.map(message => message.method), ['accountsChanged', 'disconnect'])
		} finally { Object.defineProperty(browser.storage.local, 'get', { configurable: true, value: originalGet }) }
	})

	test.each([
		['individual', 'settings read'], ['individual', 'blocking rules'], ['individual', 'tab read'],
		['bulk', 'settings read'], ['bulk', 'blocking rules'], ['bulk', 'tab read'],
	] as const)('%s revocation fails closed without a success reply when %s fails', async (mode, failure) => {
		const { runtimeMessages } = installBrowserMock()
		const modules = await loadModules()
		const { allowOrPreventAddressAccessForWebsite } = await import('../../app/ts/background/popupMessageHandlers/websiteAccess.js')
		const address = signedTransaction.from
		const website = { websiteOrigin: `revocation-${ mode }-${ failure.replaceAll(' ', '-') }.test` }
		await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: address })
		await modules.updateUserAddressBookEntries(() => [{ type: 'contact', address, name: 'Account', chainId: 'AllChains', entrySource: 'User', useAsActiveAddress: true, askForAddressAccess: true }])
		await modules.updateWebsiteAccess(() => [website, { websiteOrigin: 'still-allowed.test' }].map(website => ({ website, access: true, addressAccess: [{ address, access: true }], declarativeNetRequestBlockMode: 'block-all' })))
		const entry = (await modules.getSettings()).websiteAccess.find(entry => entry.website.websiteOrigin === website.websiteOrigin)
		assert.ok(entry)
		const connections: WebsiteTabConnections = new Map()
		for (const [tabId, websiteOrigin] of [[1, website.websiteOrigin], [2, 'still-allowed.test']] as const) {
			const socket = { tabId, connectionName: 0n }
			const { port } = createPort(tabId)
			connections.set(tabId, { connections: { [modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin, approved: tabId === 1, wantsToConnect: true } } })
		}
		const error = new Error(`Failed ${ failure }`)
		const readStarted = createDeferredSignal()
		const releaseRead = createDeferredSignal()
		const originalGet = browser.storage.local.get.bind(browser.storage.local)
		Object.defineProperty(browser.storage.local, 'get', { configurable: true, value: async (keys?: string | string[] | Record<string, unknown> | null) => {
			if (failure === 'settings read' && Array.isArray(keys) && keys.includes('openedPageV2')) throw error
			if (failure === 'tab read' && keys === 'tabState_1') throw error
			if (failure === 'tab read' && keys === 'tabState_2') { readStarted.resolve(); await releaseRead.promise }
			return await originalGet(keys)
		} })
		if (failure === 'blocking rules') Object.defineProperty(browser.declarativeNetRequest, 'getDynamicRules', { configurable: true, value: async () => { throw error } })
		let settled = false
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })
		const request = mode === 'bulk'
			? modules.changeInterceptorAccess(createTestSimulationServicesOwner({ ethereum, tokenPriceService }), connections, { method: 'popup_changeInterceptorAccess', data: [{ oldEntry: entry, newEntry: entry, removed: true }] })
			: allowOrPreventAddressAccessForWebsite(connections, { method: 'popup_allowOrPreventAddressAccessForWebsite', data: { website, address, allowAccess: false } })
		const change = request.then(
			() => { settled = true; return undefined },
			caught => { settled = true; return caught },
		)
		try {
			if (failure === 'tab read') {
				await completesPromptly(readStarted.promise)
				await new Promise(resolve => setTimeout(resolve, 0))
				assert.equal(settled, false, 'Wait for other reconciliation tasks before clearing approvals; they could otherwise approve a tab after failure')
				releaseRead.resolve()
			}
			assert.equal(await completesPromptly(change), error)
			assert.equal([...connections.values()].some(tab => Object.values(tab.connections).some(connection => connection.approved)), false)
			assert.equal(runtimeMessages.some(message => message.method === 'popup_websiteAccess_changed' || message.method === 'popup_interceptor_access_changed'), false)
		} finally { releaseRead.resolve(); await change; Object.defineProperty(browser.storage.local, 'get', { configurable: true, value: originalGet }) }
	})

	test.each(['bulk', 'disable', 'remove'] as const)('%s access change fails closed if content-script setup rejects after saving permissions', async operation => {
		const { runtimeMessages } = installBrowserMock()
		const modules = await loadModules()
		const handlers = await import('../../app/ts/background/popupMessageHandlers/websiteAccess.js')
		const website = { websiteOrigin: 'revoked-before-injection.test' }
		const anotherWebsite = { websiteOrigin: 'disabled-in-same-edit.test' }
		await modules.updateWebsiteAccess(() => [{ website, access: true, interceptorDisabled: operation === 'remove' }, { website: anotherWebsite, access: true }])
		const entries = (await modules.getSettings()).websiteAccess
		const [entry, anotherEntry] = entries
		assert.ok(entry && anotherEntry)
		const socket = { tabId: 1, connectionName: 0n }
		const { port } = createPort(socket.tabId)
		const connections: WebsiteTabConnections = new Map([[socket.tabId, { connections: { [modules.websiteSocketToString(socket)]: { port, socket, websiteOrigin: website.websiteOrigin, approved: true, wantsToConnect: true } } }]])
		const error = new Error('Cannot read settings for content-script setup')
		const originalGet = browser.storage.local.get.bind(browser.storage.local)
		Object.defineProperty(browser.storage.local, 'get', { configurable: true, value: async (keys?: string | string[] | Record<string, unknown> | null) => {
			if (Array.isArray(keys) && keys.includes('openedPageV2')) throw error
			return await originalGet(keys)
		} })
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })
		const owner = createTestSimulationServicesOwner({ ethereum, tokenPriceService })
		try {
			const request = operation === 'bulk' ? modules.changeInterceptorAccess(owner, connections, { method: 'popup_changeInterceptorAccess', data: [
				{ oldEntry: entry, newEntry: entry, removed: true },
				{ oldEntry: anotherEntry, newEntry: { ...anotherEntry, interceptorDisabled: true }, removed: false },
			] }) : operation === 'disable'
				? handlers.disableInterceptor(owner, connections, { method: 'popup_disableInterceptor', data: { website, interceptorDisabled: true } })
				: handlers.removeWebsiteAccess(owner, connections, { method: 'popup_removeWebsiteAccess', data: { websiteOrigin: website.websiteOrigin } })
			await assert.rejects(request, caught => caught === error)
			assert.equal(Object.values(connections.get(1)?.connections ?? {})[0]?.approved, false)
			assert.equal(runtimeMessages.some(message => message.method === 'popup_websiteAccess_changed' || message.method === 'popup_interceptor_access_changed' || message.method === 'popup_setDisableInterceptorReply'), false)
		} finally { Object.defineProperty(browser.storage.local, 'get', { configurable: true, value: originalGet }) }
		const saved = (await modules.getSettings()).websiteAccess
		if (operation === 'disable') assert.equal(saved.find(entry => entry.website.websiteOrigin === website.websiteOrigin)?.interceptorDisabled, true)
		else assert.equal(saved.some(entry => entry.website.websiteOrigin === website.websiteOrigin), false, 'Revocation was committed before setup failed')
		if (operation === 'bulk') assert.equal(saved.find(entry => entry.website.websiteOrigin === anotherWebsite.websiteOrigin)?.interceptorDisabled, true)
	})

	test('address-book save reports permission reconciliation failures before acknowledgement', async () => {
		installBrowserMock()
		const modules = await loadModules()
		const { addOrModifyAddressBookEntry } = await import('../../app/ts/background/popupMessageHandlers.js')
		await modules.updateWebsiteAccess(() => [{ website: { websiteOrigin: 'https://blocked.invalid' }, access: true, declarativeNetRequestBlockMode: 'block-all' }])
		Object.defineProperty(browser.declarativeNetRequest, 'getDynamicRules', { configurable: true, value: async () => { throw new Error('Cannot reconcile request blocking rules') } })
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })
		const reply = await addOrModifyAddressBookEntry(createTestSimulationServicesOwner({ ethereum, tokenPriceService }), new Map(), {
			method: 'popup_addOrModifyAddressBookEntry', data: { type: 'contact', address: 42n, name: 'Saved account', entrySource: 'User', useAsActiveAddress: true },
		})
		assert.equal(reply.ok, false)
		assert.match('message' in reply ? reply.message : '', /Cannot reconcile request blocking rules/)
	})

	test.each([false, true])('access UI failure is awaited only by the synchronous API (deferred=%s)', async deferred => {
		installBrowserMock()
		const modules = await loadModules()
		const { reconcileWebsiteApprovalAccesses, scheduleWebsiteAccessUiUpdate, updateWebsiteApprovalAccesses } = await import('../../app/ts/background/accessManagement.js')
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })
		const owner = createTestSimulationServicesOwner({ ethereum, tokenPriceService })
		const settings = await modules.getSettings()
		let reconciliationCompleted = false
		const connections: WebsiteTabConnections = Object.assign(new Map(), {
			lifecycle: { accessReconciled: () => { reconciliationCompleted = true } },
		})
		const originalGet = browser.storage.local.get.bind(browser.storage.local)
		Object.defineProperty(browser.storage.local, 'get', { configurable: true, value: async (keys?: string | string[] | Record<string, unknown>) => {
			if (reconciliationCompleted && keys === undefined) throw new Error('Cannot read access icon targets')
			return await originalGet(keys)
		} })
		if (deferred) {
			const update = await reconcileWebsiteApprovalAccesses(connections, settings, true)
			scheduleWebsiteAccessUiUpdate(owner, connections, update, false)
			await waitForBackgroundTasks()
			assert.equal((await modules.getLatestUnexpectedError())?.data.message, 'Cannot read access icon targets')
		} else {
			await assert.rejects(updateWebsiteApprovalAccesses(owner, connections, settings, false, true), /Cannot read access icon targets/)
		}
	})

	test('reports follow-up failures after a local command has completed', async () => {
		installBrowserMock()
		const modules = await loadModules()
		const { backgroundTaskSupervisor } = await import('../../app/ts/background/backgroundTasks.js')
		const release = createDeferredSignal()
		const completion = backgroundTaskSupervisor.start({ source: 'test_deferred_ui', details: { address: 42n } }, async () => { await release.promise; throw new Error('Deferred UI work failed') })
		assert.equal(await modules.getLatestUnexpectedError(), undefined)
		assert.ok(backgroundTaskSupervisor.getPendingTasks().some(task => task.source === 'test_deferred_ui'))
		release.resolve()
		await waitForBackgroundTasks()
		assert.equal((await completion).status, 'failed')
		const reported = await modules.getLatestUnexpectedError()
		assert.equal(reported?.data.message, 'Deferred UI work failed')
		assert.equal(reported?.data.source, 'test_deferred_ui')
		assert.deepEqual(backgroundTaskSupervisor.getPendingTasks(), [])
	})

	test.each([false, true])('superseded visualization errors are reported or propagated (throw=%s)', async throwOnUnexpectedError => {
		installBrowserMock()
		const modules = await loadModules()
		const { captureSimulationSnapshot } = await import('../../app/ts/background/simulationUpdating.js')
		const { updatePopupVisualisationState, publishPendingPopupVisualisation } = await import('../../app/ts/background/popupVisualisationUpdater.js')
		await modules.changeSimulationMode({ simulationMode: true, activeSimulationAddress: signedTransaction.from, activeSigningAddress: signedTransaction.from })
		await modules.updateInterceptorTransactionStack(() => ({ operations: [{ type: 'Transaction', preSimulationTransaction: transaction }] }))
		const snapshot = await captureSimulationSnapshot()
		const started = createDeferredSignal()
		const release = createDeferredSignal()
		const error = new Error('Superseded visualization failed unexpectedly')
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })
		const refresh = updatePopupVisualisationState(ethereum, tokenPriceService, undefined, throwOnUnexpectedError, snapshot, {
			getUpdatedState: async () => ({ kind: 'simulated', value: { ...pendingTransaction.popupVisualisation.data.simulationState, rpcNetwork: ethereum.getRpcEntry(), simulationStateInput: snapshot.simulationStateInput } }),
			visualize: async () => { started.resolve(); await release.promise; throw error },
		}).then(() => undefined, caught => caught)
		try {
			await started.promise
			await publishPendingPopupVisualisation(true)
		} finally { release.resolve() }
		const outcome = await refresh
		if (throwOnUnexpectedError) assert.equal(outcome, error)
		else assert.equal((await modules.getLatestUnexpectedError())?.data.message, error.message)
		const stored = await modules.getPopupVisualisationState()
		assert.equal(stored.simulationResultState, 'invalid')
		assert.equal(stored.simulationUpdatingState, 'updating')
	})

	test('metadata refresh preserves gas edits made while visualization is pending', async () => {
		installBrowserMock()
		const { browserStorageLocalSet2 } = await import('../../app/ts/utils/storageUtils.js')
		const modules = await loadModules()
		const { setGasLimitForTransaction } = await import('../../app/ts/background/windows/confirmTransaction.js')
		const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')
		await browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingTransaction] })
		const started = createDeferredSignal()
		const release = createDeferredSignal()
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })
		ethereum.getBlockNumber = async () => 123n
		const refresh = refreshPopupConfirmTransactionMetadata(ethereum, tokenPriceService, undefined, {
			visualize: async () => {
				started.resolve()
				await release.promise
				return pendingTransaction.popupVisualisation.data
			},
			visualisation: { update: async () => undefined },
		})
		try {
			await started.promise
			await setGasLimitForTransaction(pendingTransaction.transactionIdentifier, 30_000n)
		} finally { release.resolve(); await refresh }
		const [edited] = await modules.getPendingTransactionsAndMessages()
		assert.ok(edited?.type === 'Transaction' && edited.originalRequestParameters.method === 'eth_sendTransaction')
		assert.equal(edited.originalRequestParameters.params[0].gas, 30_000n)
		assert.equal(isPendingTransactionGasLimitCurrent(edited), false)
	})

	test('gas edits invalidate approval until matching simulation results arrive', async () => {
		installBrowserMock()
		const { browserStorageLocalSet2 } = await import('../../app/ts/utils/storageUtils.js')
		const modules = await loadModules()
		const { setGasLimitForTransaction, resolvePendingTransactionOrMessage } = await import('../../app/ts/background/windows/confirmTransaction.js')
		await browserStorageLocalSet2({ pendingTransactionsAndMessages: [pendingTransaction] })
		assert.equal(isPendingTransactionGasLimitCurrent(pendingTransaction), true)
		await setGasLimitForTransaction(pendingTransaction.transactionIdentifier, 30_000n)
		const [edited] = await modules.getPendingTransactionsAndMessages()
		assert.ok(edited)
		assert.equal(isPendingTransactionGasLimitCurrent(edited), false)
		const { ethereum, tokenPriceService } = createEthereumWithGetBlockCounter({ count: 0 })
		assert.equal(await resolvePendingTransactionOrMessage(ethereum, tokenPriceService, new Map(), { method: 'popup_confirmDialog', data: { uniqueRequestIdentifier: pendingTransaction.uniqueRequestIdentifier, action: 'accept' } }), false)
		assert.equal((await modules.getPendingTransactionsAndMessages()).length, 1)
	})
})
