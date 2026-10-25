import * as assert from 'node:assert'
import { beforeEach, test } from 'bun:test'
import { createDeferredSignal } from './backgroundEthAccountsTestHarness.js'
import { createBrowserMock, fakeRequestHandler, fakeRpcNetwork, modules, pendingTransaction, resetConfirmTransactionTestState } from './confirmTransactionTestHarness.js'
import { isPendingTransactionGasLimitCurrent } from '../../app/ts/utils/pendingTransactionSimulation.js'

let browserMock: ReturnType<typeof createBrowserMock>
beforeEach(async () => {
	browserMock = createBrowserMock()
	await resetConfirmTransactionTestState()
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
