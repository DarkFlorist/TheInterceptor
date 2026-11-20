import * as assert from 'node:assert'
import { beforeEach, test } from 'bun:test'
import { createDeferredSignal, installBrowserMock } from './backgroundEthAccountsTestHarness.js'
import { browserMock, fakeRequestHandler, fakeRpcNetwork, modules, pendingTransaction, resetConfirmTransactionTestState } from './confirmTransactionTestHarness.js'
import { isPendingTransactionGasLimitCurrent } from '../../app/ts/utils/pendingTransactionSimulation.js'
import { UpdateConfirmTransactionDialogPendingTransactions } from '../../app/ts/types/interceptor-messages.js'
import { waitForBackgroundTasks } from './backgroundTasksTestHarness.js'

beforeEach(async () => {
	await resetConfirmTransactionTestState()
})

test('confirmation reset restores its browser after another test installs a different mock', async () => {
	installBrowserMock()
	await resetConfirmTransactionTestState()
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	assert.equal((await modules.getPendingTransactionsAndMessages()).length, 0)
	assert.deepEqual(browserMock.storageState.pendingTransactionsAndMessages, [])
})

test('gas edits broadcast a JSON-transportable pending request that disables stale approval', async () => {
	const { forceSetGasLimitForTransaction } = await import('../../app/ts/background/popupMessageHandlers.js')
	const ethereum = new modules.EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
	const tokenPriceService = new modules.TokenPriceService(ethereum, 60_000)
	try {
		await forceSetGasLimitForTransaction(ethereum, tokenPriceService, {
			method: 'popup_forceSetGasLimitForTransaction',
			data: { transactionIdentifier: pendingTransaction.transactionIdentifier, gasLimit: 30_000n },
		})
		const notification = browserMock.sentMessages.find(message => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions')
		assert.ok(notification, 'The open confirmation must receive the edited request before resimulation')
		// Chrome runtime messages cross a JSON boundary; structured-clone mocks would miss raw bigint/byte payloads.
		const received = UpdateConfirmTransactionDialogPendingTransactions.parse(JSON.parse(JSON.stringify(notification)))
		const [edited] = received.data.pendingTransactionAndSignableMessages
		assert.ok(edited?.type === 'Transaction' && edited.originalRequestParameters.method === 'eth_sendTransaction')
		assert.equal(edited.transactionIdentifier, pendingTransaction.transactionIdentifier)
		assert.equal(edited.originalRequestParameters.params[0].gas, 30_000n)
		assert.equal(isPendingTransactionGasLimitCurrent(edited), false, 'The popup must reject results for the previous gas limit')
	} finally { await waitForBackgroundTasks() }
})

test.each(['dialog view update', 'metadata refresh', 'gas edit'] as const)('%s sends the pending requests with their companion dialog update', async path => {
	const { forceSetGasLimitForTransaction, refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')
	const { updateConfirmTransactionView } = await import('../../app/ts/background/windows/confirmTransaction.js')
	const { UpdateConfirmTransactionDialog } = await import('../../app/ts/types/interceptor-messages.js')
	const ethereum = new modules.EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
	const tokenPriceService = new modules.TokenPriceService(ethereum, 60_000)
	try {
		if (path === 'dialog view update') await updateConfirmTransactionView(ethereum, tokenPriceService)
		else if (path === 'metadata refresh') await refreshPopupConfirmTransactionMetadata(ethereum, tokenPriceService, undefined)
		else await forceSetGasLimitForTransaction(ethereum, tokenPriceService, { method: 'popup_forceSetGasLimitForTransaction', data: { transactionIdentifier: pendingTransaction.transactionIdentifier, gasLimit: 30_000n } })
		const pendingUpdates = browserMock.sentMessages.filter(message => message.method === 'popup_update_confirm_transaction_dialog_pending_transactions')
		const dialogUpdates = browserMock.sentMessages.filter(message => message.method === 'popup_update_confirm_transaction_dialog')
		assert.equal(pendingUpdates.length, 1)
		assert.equal(dialogUpdates.length, 1)
		const pending = UpdateConfirmTransactionDialogPendingTransactions.parse(JSON.parse(JSON.stringify(pendingUpdates[0])))
		const dialog = UpdateConfirmTransactionDialog.parse(JSON.parse(JSON.stringify(dialogUpdates[0])))
		assert.deepEqual(Object.keys(pending.data).sort(), ['currentBlockNumber', 'pendingTransactionAndSignableMessages', 'rpcConnectionStatus'])
		assert.deepEqual(Object.keys(dialog.data).sort(), ['currentBlockNumber', 'rpcConnectionStatus', 'visualizedSimulatorState'])
		assert.equal(pending.data.currentBlockNumber, dialog.data.currentBlockNumber)
		assert.deepEqual(pending.data.rpcConnectionStatus, dialog.data.rpcConnectionStatus)
		assert.deepEqual(pending.data.pendingTransactionAndSignableMessages.map(request => request.uniqueRequestIdentifier.requestId), [pendingTransaction.uniqueRequestIdentifier.requestId])
		// Only the gas edit uses the cached head; the other paths ask the node, as on main.
		assert.equal(dialog.data.currentBlockNumber, path === 'gas edit' ? ethereum.getCachedBlock()?.number ?? 0n : await ethereum.getBlockNumber(undefined))
	} finally { await waitForBackgroundTasks() }
})

test('the dialog state builder owns the passthrough rule and the block number source', async () => {
	const { buildConfirmTransactionDialogState } = await import('../../app/ts/background/windows/confirmTransaction.js')
	const { createPassthroughCompleteVisualizedSimulation } = await import('../../app/ts/types/visualizer-types.js')
	const { getRpcConnectionStatus } = await import('../../app/ts/background/storageVariables.js')
	const ethereum = new modules.EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
	const visualisation = { ...createPassthroughCompleteVisualizedSimulation(9, 'done'), numberOfAddressesMadeRich: 3 }
	let visualisationReads = 0
	const getVisualisation = async () => { visualisationReads++; return visualisation }
	const signing = await buildConfirmTransactionDialogState(ethereum, { simulationMode: false, getVisualisation, blockNumberSource: { kind: 'cached' } })
	assert.deepEqual(signing.visualizedSimulatorState, createPassthroughCompleteVisualizedSimulation())
	assert.equal(visualisationReads, 0, 'signing mode never reads the simulation visualisation')
	assert.equal(signing.currentBlockNumber, ethereum.getCachedBlock()?.number ?? 0n)
	const simulating = await buildConfirmTransactionDialogState(ethereum, { simulationMode: true, getVisualisation, blockNumberSource: { kind: 'fetch', abortController: undefined } })
	assert.deepEqual(simulating.visualizedSimulatorState, visualisation)
	assert.equal(simulating.currentBlockNumber, await ethereum.getBlockNumber(undefined))
	assert.deepEqual(simulating.rpcConnectionStatus, await getRpcConnectionStatus())
	await modules.changeSimulationMode({ simulationMode: false })
	const fromSettings = await buildConfirmTransactionDialogState(ethereum, { simulationMode: 'activeSettings', getVisualisation, blockNumberSource: { kind: 'cached' } })
	assert.deepEqual(fromSettings.visualizedSimulatorState, createPassthroughCompleteVisualizedSimulation())
	assert.equal(visualisationReads, 1)
})

test.each(['pending-state read', 'transaction construction', 'tab-state read'] as const)('a refresh delayed during %s cannot cancel a newer gas simulation', async pauseAt => {
	const { getConfirmTransactionAbortController } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	const { refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')
	const { setGasLimitForTransaction } = await import('../../app/ts/background/windows/confirmTransaction.js')
	const olderPaused = createDeferredSignal()
	const releaseOlder = createDeferredSignal()
	const newerVisualizing = createDeferredSignal()
	const releaseVisualization = createDeferredSignal()
	let heldOlder = false
	const holdOlder = async () => {
		heldOlder = true
		olderPaused.resolve()
		await releaseOlder.promise
	}
	const ethereum = new modules.EthereumClientService({
		...fakeRequestHandler,
		async jsonRpcRequest(request, abortController) {
			if (pauseAt === 'transaction construction' && !heldOlder && request.method === 'eth_getTransactionCount') await holdOlder()
			if (request.method === 'eth_getCode' && abortController !== undefined) {
				newerVisualizing.resolve()
				await releaseVisualization.promise
				abortController.signal.throwIfAborted()
			}
			return await fakeRequestHandler.jsonRpcRequest(request)
		},
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	const tokenPriceService = new modules.TokenPriceService(ethereum, 60_000)
	await setGasLimitForTransaction(pendingTransaction.transactionIdentifier, 30_000n)
	if (pauseAt === 'tab-state read' || pauseAt === 'pending-state read') {
		browserMock.setStorageGetHandler(async (keys, read) => {
			const captured = read()
			const requestedKey = pauseAt === 'tab-state read' ? 'tabState_1' : 'pendingTransactionsAndMessages'
			if (!heldOlder && (keys === requestedKey || Array.isArray(keys) && keys.includes(requestedKey))) await holdOlder()
			return captured
		})
	}
	const older = refreshPopupConfirmTransactionSimulation(ethereum, tokenPriceService)
	let newer: Promise<void> | undefined
	try {
		await olderPaused.promise
		await setGasLimitForTransaction(pendingTransaction.transactionIdentifier, 40_000n)
		newer = refreshPopupConfirmTransactionSimulation(ethereum, tokenPriceService)
		await newerVisualizing.promise
		const newerController = getConfirmTransactionAbortController()
		const newerAborted = createDeferredSignal()
		newerController.signal.addEventListener('abort', () => newerAborted.resolve(), { once: true })
		releaseOlder.resolve()
		await Promise.race([older, newerAborted.promise])
		assert.equal(newerController.signal.aborted, false, 'Obsolete refresh must not cancel the current visualization')
		releaseVisualization.resolve()
		await newer
		const [saved] = await modules.getPendingTransactionsAndMessages()
		assert.ok(saved?.type === 'Transaction' && saved.transactionOrMessageCreationStatus === 'Simulated' && saved.originalRequestParameters.method === 'eth_sendTransaction')
		assert.equal(saved.originalRequestParameters.params[0].gas, 40_000n)
		assert.equal(isPendingTransactionGasLimitCurrent(saved), true, 'The newest gas edit must become approvable')
	} finally {
		releaseOlder.resolve()
		releaseVisualization.resolve()
		await Promise.all([older, newer])
		browserMock.setStorageGetHandler(undefined)
	}
})

test.each(['Crafting', 'Simulating'] as const)('a no-op refresh leaves an initial %s simulation current', async status => {
	const { refreshConfirmTransactionSimulation } = await import('../../app/ts/background/confirmTransactionSimulation.js')
	const { refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')
	const started = createDeferredSignal()
	const release = createDeferredSignal()
	const ethereum = new modules.EthereumClientService({
		...fakeRequestHandler,
		async jsonRpcRequest(request, abortController) {
			if (request.method === 'eth_getCode' && abortController !== undefined) {
				started.resolve()
				await release.promise
				abortController.signal.throwIfAborted()
			}
			return await fakeRequestHandler.jsonRpcRequest(request)
		},
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	const tokenPriceService = new modules.TokenPriceService(ethereum, 60_000)
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [{ ...pendingTransaction, transactionOrMessageCreationStatus: status }] })
	const initial = refreshConfirmTransactionSimulation(ethereum, tokenPriceService, pendingTransaction.activeAddress, pendingTransaction.simulationMode, pendingTransaction.uniqueRequestIdentifier, pendingTransaction.transactionToSimulate)
	try {
		await started.promise
		await refreshPopupConfirmTransactionSimulation(ethereum, tokenPriceService)
	} finally { release.resolve() }
	assert.notEqual(await initial, undefined, 'The initial simulation must still produce its result after an ineligible refresh')
})
