import * as assert from 'assert'
import { setSystemTime, test } from 'bun:test'
import { activeAddress, addressString, browserMock, created, fakeRequestHandler, fakeRpcNetwork, fakeSafeContract, modules, popupVisualisation, recipientAddress, signedTransaction, simulator, uniqueRequestIdentifier } from './confirmTransactionTestHarness.js'
import { createDeferredValue } from './backgroundEthAccountsTestHarness.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'

async function getStoredTransactionPreview() {
	const pending = (await modules.getPendingTransactionsAndMessages()).find((entry) => entry.type === 'Transaction')
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus === 'Crafting') throw new Error('Missing simulated pending transaction')
	return [pending.transactionOrMessageCreationStatus, pending.popupVisualisation.statusCode]
}

test('a metadata refresh of an older transaction simulation does not replace a newer simulation started in the same second', async () => {
	// Stored simulation timestamps keep only whole seconds, so with a stopped clock both simulations are stored with the same start time.
	setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
	try {
		// Signing mode keeps the simulation stack out of the metadata refresh, so only the transaction's own preview is re-visualized.
		await modules.browserStorageLocalSet({ simulationMode: false, activeRpcNetwork: fakeRpcNetwork })
		await modules.updatePendingTransactionOrMessage(uniqueRequestIdentifier, async (pending) => ({ ...pending, simulationMode: false }))
		const { refreshPopupConfirmTransactionMetadata, refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')
		await refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
		assert.deepEqual(await getStoredTransactionPreview(), ['Simulated', 'success'])
		let newerSimulation: Promise<void> | undefined
		// The metadata refresh reads the settings while it re-visualizes its snapshot of the transaction, so a simulation run there is stored between the snapshot and the metadata write.
		browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
			if (newerSimulation === undefined && Array.isArray(keys) && keys.includes('simulationMode')) {
				fakeSafeContract.getEthSimulateFailure = () => new JsonRpcResponseError({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'execution reverted' } })
				newerSimulation = refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
				await newerSimulation
			}
			return readStoredItems()
		})

		await refreshPopupConfirmTransactionMetadata(simulator.ethereum, simulator.tokenPriceService)
		browserMock.setStorageGetHandler(undefined)

		assert.ok(newerSimulation !== undefined)
		assert.deepEqual(await getStoredTransactionPreview(), ['Simulated', 'failed'])
	} finally {
		setSystemTime()
	}
})

test('a stored simulation run is only replaced by a newer run, ordered by confirmationRunId when both runs have one', async () => {
	const { shouldReplacePopupVisualisation } = await import('../../app/ts/background/confirmationPreviews.js')
	const sameSecond = new Date('2026-01-01T00:00:00.000Z')
	const run = (statusCode: 'success' | 'failed', simulationStartedTimestamp: Date, confirmationRunId?: number) => ({ statusCode, data: { ...popupVisualisation.data, simulationStartedTimestamp, ...(confirmationRunId === undefined ? {} : { confirmationRunId }) } })

	assert.equal(shouldReplacePopupVisualisation(undefined, run('failed', sameSecond, 1)), true)
	// Within one stored second, only the ids tell the runs apart, whether the older run succeeded or failed.
	assert.equal(shouldReplacePopupVisualisation(run('success', sameSecond, 2), run('failed', sameSecond, 1)), false)
	assert.equal(shouldReplacePopupVisualisation(run('failed', sameSecond, 2), run('success', sameSecond, 1)), false)
	assert.equal(shouldReplacePopupVisualisation(run('failed', sameSecond, 1), run('success', sameSecond, 2)), true)
	// A run stored by an older version has no id, so runs are ordered by start time.
	const nextSecond = new Date('2026-01-01T00:00:01.000Z')
	assert.equal(shouldReplacePopupVisualisation(run('success', nextSecond), run('failed', sameSecond, 1)), false)
	assert.equal(shouldReplacePopupVisualisation(run('success', sameSecond), run('failed', nextSecond, 1)), true)
})

test('an older transaction refresh that finishes preparing after a newer refresh stored its preview does not replace it', async () => {
	await modules.browserStorageLocalSet({ simulationMode: true, activeRpcNetwork: fakeRpcNetwork, useSignersAddressAsActiveAddress: false, independentActiveSimulationAddress: activeAddress })
	const stackTransaction = { signedTransaction, website: popupVisualisation.data.transactionToSimulate.website, created, originalRequestParameters: popupVisualisation.data.transactionToSimulate.originalRequestParameters, transactionIdentifier: 99n }
	await modules.updateInterceptorTransactionStack(() => ({ operations: [{ type: 'Transaction', preSimulationTransaction: stackTransaction }] }))
	const { refreshPopupConfirmTransactionSimulation } = await import('../../app/ts/background/popupMessageHandlers.js')
	const getPreparedNonce = async () => {
		const pending = (await modules.getPendingTransactionsAndMessages()).find((entry) => entry.type === 'Transaction')
		return pending?.type === 'Transaction' && pending.transactionOrMessageCreationStatus !== 'Crafting' && pending.transactionToSimulate.success ? pending.transactionToSimulate.transaction.nonce : undefined
	}
	await refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	// The pending transaction is first prepared after the stack transaction of the same account.
	assert.equal(await getPreparedNonce(), 1n)
	const olderRefreshPaused = createDeferredValue<void>()
	const olderRefreshReleased = createDeferredValue<void>()
	let olderRefreshHeld = false
	// The older refresh reads the simulation stack and then pauses at its first RPC request while preparing the transaction.
	const olderEthereum = new modules.EthereumClientService({
		...fakeRequestHandler,
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
			if (!olderRefreshHeld) {
				olderRefreshHeld = true
				olderRefreshPaused.resolve()
				await olderRefreshReleased.promise
			}
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, fakeRpcNetwork)
	const olderRefresh = refreshPopupConfirmTransactionSimulation(olderEthereum, new modules.TokenPriceService(olderEthereum, 60_000))
	await olderRefreshPaused.promise

	await modules.updateInterceptorTransactionStack(() => ({ operations: [] }))
	await refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	olderRefreshReleased.resolve()
	await olderRefresh

	assert.equal(await getPreparedNonce(), 0n)
})

test('confirmation runs of different requests overlap without aborting each other, while a newer run of the same request aborts the older one', async () => {
	const { getInFlightConfirmationRunAbortController, runConfirmationSimulation, simulateConfirmationRun } = await import('../../app/ts/background/confirmationSimulationRun.js')
	const { getCurrentSimulationInput } = await import('../../app/ts/background/simulationUpdating.js')
	// Each run waits before it reads its simulation input until the test releases it, so runs started one after another are in flight together.
	const startHeldRun = async (request: typeof uniqueRequestIdentifier) => {
		const inFlight = createDeferredValue<void>()
		const released = createDeferredValue<void>()
		const record = runConfirmationSimulation(request, async (confirmationRun) => await simulateConfirmationRun({
			ethereum: simulator.ethereum,
			tokenPriceService: simulator.tokenPriceService,
			confirmationRun,
			activeAddress,
			simulationMode: true,
			calledContracts: [],
			getSimulationInput: async () => {
				inFlight.resolve()
				await released.promise
				return await getCurrentSimulationInput()
			},
		}))
		await inFlight.promise
		return { record, abortController: getInFlightConfirmationRunAbortController(request), release: () => released.resolve() }
	}
	const otherRequest = { requestId: 2, requestSocket: uniqueRequestIdentifier.requestSocket }

	const transactionRun = await startHeldRun(uniqueRequestIdentifier)
	const otherRequestRun = await startHeldRun(otherRequest)
	assert.ok(transactionRun.abortController !== undefined && otherRequestRun.abortController !== undefined)
	assert.notEqual(transactionRun.abortController, otherRequestRun.abortController)
	assert.equal(transactionRun.abortController.signal.aborted, false)
	transactionRun.release()
	otherRequestRun.release()
	assert.equal((await transactionRun.record)?.statusCode, 'success')
	assert.equal((await otherRequestRun.record)?.statusCode, 'success')
	assert.equal(otherRequestRun.abortController.signal.aborted, false)
	// A finished run is no longer in flight.
	assert.equal(getInFlightConfirmationRunAbortController(uniqueRequestIdentifier), undefined)

	const olderRun = await startHeldRun(uniqueRequestIdentifier)
	const newerRun = await startHeldRun(uniqueRequestIdentifier)
	assert.equal(olderRun.abortController?.signal.aborted, true)
	assert.equal(newerRun.abortController?.signal.aborted, false)
	olderRun.release()
	newerRun.release()
	await olderRun.record
	assert.equal((await newerRun.record)?.statusCode, 'success')
	assert.equal(getInFlightConfirmationRunAbortController(uniqueRequestIdentifier), undefined)
})

test('the metadata refresh of the shown confirmation is cancelled with that confirmation\'s simulation run in flight', async () => {
	const { getInFlightConfirmationRunAbortController, runConfirmationSimulation, simulateConfirmationRun } = await import('../../app/ts/background/confirmationSimulationRun.js')
	const { getCurrentSimulationInput } = await import('../../app/ts/background/simulationUpdating.js')
	const { refreshPopupConfirmTransactionMetadata } = await import('../../app/ts/background/popupMessageHandlers.js')
	const shownRequest = (await modules.getPendingTransactionsAndMessages())[0]?.uniqueRequestIdentifier
	if (shownRequest === undefined) throw new Error('Expected a queued confirmation')
	const runInFlight = createDeferredValue<void>()
	const releaseRun = createDeferredValue<void>()
	const run = runConfirmationSimulation(shownRequest, async (confirmationRun) => await simulateConfirmationRun({
		ethereum: simulator.ethereum,
		tokenPriceService: simulator.tokenPriceService,
		confirmationRun,
		activeAddress,
		simulationMode: true,
		calledContracts: [],
		getSimulationInput: async () => {
			runInFlight.resolve()
			await releaseRun.promise
			return await getCurrentSimulationInput()
		},
	}))
	await runInFlight.promise
	const runAbortController = getInFlightConfirmationRunAbortController(shownRequest)
	if (runAbortController === undefined) throw new Error('Expected the run to be in flight')
	const refreshAbortControllers: unknown[] = []
	const recordingEthereum = new modules.EthereumClientService({
		...fakeRequestHandler,
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }, requestAbortController?: AbortController) {
			if (rpcRequest.method === 'eth_blockNumber') refreshAbortControllers.push(requestAbortController)
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}, async () => undefined, async () => undefined, fakeRpcNetwork)

	await refreshPopupConfirmTransactionMetadata(recordingEthereum, simulator.tokenPriceService)
	releaseRun.resolve()
	await run

	assert.deepEqual(refreshAbortControllers, [runAbortController], 'the refresh uses the abort controller of the shown confirmation\'s run in flight')
})

test('an eth_sendRawTransaction confirmation is prepared, simulated and stored', async () => {
	const { Transaction } = await import('micro-eth-signer')
	const { SendRawTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const { sendTransaction } = await import('../../app/ts/background/simulationModeHandlers.js')
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.browserStorageLocalSet({ simulationMode: true, activeRpcNetwork: fakeRpcNetwork, useSignersAddressAsActiveAddress: false, independentActiveSimulationAddress: activeAddress })
	const rawTransaction = Transaction.prepare({ type: 'eip1559', chainId: fakeRpcNetwork.chainId, nonce: 0n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gasLimit: 21_000n, to: addressString(recipientAddress), value: 1n, data: '0x', accessList: [] }, false)
		.signBy('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
		.toHex()
	const parameters = SendRawTransactionParams.parse({ method: 'eth_sendRawTransaction', params: [rawTransaction] })
	const rawRequestIdentifier = { requestId: 42, requestSocket: uniqueRequestIdentifier.requestSocket }
	const reply = await sendTransaction(simulator.ethereum, simulator.tokenPriceService, activeAddress, { kind: 'transaction', parameters }, { ...parameters, interceptorRequest: true, usingInterceptorWithoutSigner: false, uniqueRequestIdentifier: rawRequestIdentifier }, popupVisualisation.data.transactionToSimulate.website, new Map())

	assert.deepEqual(reply, { type: 'doNotReply' })
	const pending = (await modules.getPendingTransactionsAndMessages()).find((entry) => entry.uniqueRequestIdentifier.requestId === rawRequestIdentifier.requestId)
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus === 'Crafting') throw new Error('Missing the raw transaction confirmation')
	assert.equal(pending.originalRequestParameters.method, 'eth_sendRawTransaction')
	assert.equal(pending.transactionOrMessageCreationStatus, 'Simulated')
	assert.equal(pending.popupVisualisation.statusCode, 'success')
	// A refresh simulates the stored raw transaction again with a newer run.
	const storedRunId = pending.popupVisualisation.data.confirmationRunId
	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	const refreshed = (await modules.getPendingTransactionsAndMessages()).find((entry) => entry.uniqueRequestIdentifier.requestId === rawRequestIdentifier.requestId)
	if (refreshed?.type !== 'Transaction' || refreshed.transactionOrMessageCreationStatus === 'Crafting') throw new Error('Missing the refreshed raw transaction confirmation')
	assert.equal(refreshed.popupVisualisation.statusCode, 'success')
	assert.ok(storedRunId !== undefined && (refreshed.popupVisualisation.data.confirmationRunId ?? 0) > storedRunId)
})
