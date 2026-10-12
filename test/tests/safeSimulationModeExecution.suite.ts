import * as assert from 'assert'
import { test } from 'bun:test'
import { activeAddress, addressString, createFeeValidatingSimulator, createSafeAddressBookEntry, createWebsitePort, fakeRpcNetwork, isRecord, modules, recipientAddress, TOO_LITTLE_ETH_FOR_FEES, uniqueRequestIdentifier, withSilencedConsole } from './confirmTransactionTestHarness.js'

const SAFE_EXECUTION_SIMULATION_OPTIONS = { requiredChainId: fakeRpcNetwork.chainId, simulateWithZeroBaseFee: true }

async function getSimulatedPendingTransaction() {
	const [pending] = await modules.getPendingTransactionsAndMessages()
	if (pending?.type !== 'Transaction' || pending.transactionOrMessageCreationStatus !== 'Simulated') throw new Error(`Expected a simulated transaction, got ${ pending?.transactionOrMessageCreationStatus }`)
	return pending
}

test('simulates a configured Gnosis Safe transaction with executor-paid fees in simulation mode', async () => {
	await modules.browserStorageLocalSet2({ pendingTransactionsAndMessages: [] })
	await modules.updateUserAddressBookEntries(() => [createSafeAddressBookEntry({ safeSimulationSignerAddress: recipientAddress, safeVersion: '1.4.1' })])
	await (await import('../../app/ts/background/settings.js')).changeSimulationMode({ simulationMode: true, rpcNetwork: fakeRpcNetwork, activeSimulationAddress: activeAddress })
	const simulator = createFeeValidatingSimulator(TOO_LITTLE_ETH_FOR_FEES)
	const { SendTransactionParams } = await import('../../app/ts/types/JsonRpc-types.js')
	const transactionParams = SendTransactionParams.parse({
		method: 'eth_sendTransaction',
		params: [{ from: addressString(activeAddress), to: addressString(recipientAddress), value: '0x0', data: '0x' }],
	})
	const postedMessages: unknown[] = []
	const websiteTabConnections = new Map([[uniqueRequestIdentifier.requestSocket.tabId, {
		connections: {
			[modules.websiteSocketToString(uniqueRequestIdentifier.requestSocket)]: {
				port: createWebsitePort(uniqueRequestIdentifier.requestSocket, 0, postedMessages),
				socket: uniqueRequestIdentifier.requestSocket,
				websiteOrigin: 'https://example.com',
				approved: true,
				wantsToConnect: true,
			},
		},
	}]])

	assert.deepEqual(await withSilencedConsole(async () => await modules.openConfirmTransactionDialogForTransaction(
		simulator.ethereum,
		simulator.tokenPriceService,
		{
			interceptorRequest: true,
			usingInterceptorWithoutSigner: false,
			uniqueRequestIdentifier,
			method: transactionParams.method,
			params: transactionParams.params,
		},
		{ kind: 'transaction', parameters: transactionParams },
		true,
		activeAddress,
		{ websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		websiteTabConnections,
	)), { type: 'doNotReply' })

	const pending = await getSimulatedPendingTransaction()
	assert.equal(pending.safeTransaction, undefined, 'simulation mode stacks the transaction instead of proposing it to the Safe')
	assert.equal(pending.transactionToSimulate.transaction.from, activeAddress)
	assert.equal(pending.transactionToSimulate.transaction.maxFeePerGas, 0n)
	assert.deepEqual(pending.transactionToSimulate.simulationOptions, SAFE_EXECUTION_SIMULATION_OPTIONS)
	if (pending.popupVisualisation.statusCode !== 'success') throw new Error(`Safe transaction simulation failed: ${ pending.popupVisualisation.data.error.message }`)
	assert.equal(pending.popupVisualisation.data.visualizedSimulationState.success, true)
	assert.equal(pending.popupVisualisation.data.simulationState.simulationStateInput.at(-1)?.simulateWithZeroBaseFee, true)

	await modules.refreshPopupConfirmTransactionSimulation(simulator.ethereum, simulator.tokenPriceService)
	const refreshedPending = await getSimulatedPendingTransaction()
	assert.deepEqual(refreshedPending.transactionToSimulate.simulationOptions, SAFE_EXECUTION_SIMULATION_OPTIONS, 'refreshing the confirmation keeps the Safe execution fee model')

	await modules.resolvePendingTransactionOrMessage(simulator.ethereum, simulator.tokenPriceService, websiteTabConnections, {
		method: 'popup_confirmDialog',
		data: { action: 'accept', uniqueRequestIdentifier },
	})
	const [stackedOperation] = (await modules.getInterceptorTransactionStack()).operations
	if (stackedOperation?.type !== 'Transaction') throw new Error('Expected the Safe transaction on the simulation stack')
	assert.deepEqual(stackedOperation.preSimulationTransaction.simulationOptions, SAFE_EXECUTION_SIMULATION_OPTIONS)
	const { getCurrentSimulationInput } = await import('../../app/ts/background/simulationUpdating.js')
	assert.equal((await getCurrentSimulationInput()).at(-1)?.simulateWithZeroBaseFee, true)
	assert.equal(postedMessages.some((message) => isRecord(message) && message.type === 'forwardToSigner'), false)
})
