import * as assert from 'node:assert'
import { afterEach, describe, test } from 'bun:test'
import type { WebsiteTabConnections } from '../../app/ts/types/user-interface-types.js'
import type { PreSimulationTransaction } from '../../app/ts/types/visualizer-types.js'
import { createTestSimulationServicesOwner, createDeferredSignal, createEthereumWithGetBlockCounter, createPort, installBrowserMock, loadModules } from './backgroundEthAccountsTestHarness.js'
import { waitForBackgroundTasks } from '../../app/ts/background/backgroundTasks.js'
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
		installBrowserMock()
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

	test('reports follow-up failures after a local command has completed', async () => {
		installBrowserMock()
		const modules = await loadModules()
		const { startBackgroundTask } = await import('../../app/ts/background/backgroundTasks.js')
		const release = createDeferredSignal()
		startBackgroundTask(async () => { await release.promise; throw new Error('Deferred UI work failed') })
		assert.equal(await modules.getLatestUnexpectedError(), undefined)
		release.resolve()
		await waitForBackgroundTasks()
		assert.equal((await modules.getLatestUnexpectedError())?.data.message, 'Deferred UI work failed')
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
		const refresh = updatePopupVisualisationState(ethereum, tokenPriceService, undefined, throwOnUnexpectedError, snapshot, undefined, {
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
