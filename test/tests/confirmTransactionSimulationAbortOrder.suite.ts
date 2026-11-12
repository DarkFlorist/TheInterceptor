import * as assert from 'assert'
import { test } from 'bun:test'
import { activeAddress, browserMock, fakeRequestHandler, fakeRpcNetwork, modules, pendingTransaction, simulator } from './confirmTransactionTestHarness.js'
import { createDeferredSignal } from './backgroundEthAccountsTestHarness.js'
import { getConfirmTransactionAbortController, refreshConfirmTransactionSimulation } from '../../app/ts/background/confirmTransactionSimulation.js'
import { readNetworkSnapshotForServices } from '../../app/ts/background/networkTransitionLock.js'
import { requireSimulationSnapshot } from '../../app/ts/background/simulationUpdating.js'
import type { SimulationServices } from '../../app/ts/simulation/serviceLifecycle.js'

// Confirmations simulate on a snapshot read with the services they run on; both runs' clients serve the active network, so each read pairs them with the stack.
const readSimulationSnapshot = async (services: SimulationServices) => requireSimulationSnapshot((await readNetworkSnapshotForServices(services)).simulation)

test('an older confirmation simulation whose tab state loads late does not abort a newer simulation', async () => {
	const olderRunTabId = 1
	const newerRunTabId = 2
	const olderRunTabStateReadStarted = createDeferredSignal()
	const releaseOlderRunTabStateRead = createDeferredSignal()
	browserMock.setStorageGetHandler(async (keys, readStoredItems) => {
		if (keys === `tabState_${ olderRunTabId }`) {
			olderRunTabStateReadStarted.resolve()
			await releaseOlderRunTabStateRead.promise
		}
		return readStoredItems()
	})

	const newerRunRpcStarted = createDeferredSignal()
	const releaseNewerRunRpc = createDeferredSignal()
	const suspendedRequestHandler = {
		rpcUrl: fakeRpcNetwork.httpsRpc,
		clearCache() { return undefined },
		async jsonRpcRequest(rpcRequest: { method: string, params?: readonly unknown[] }) {
			newerRunRpcStarted.resolve()
			await releaseNewerRunRpc.promise
			return await fakeRequestHandler.jsonRpcRequest(rpcRequest)
		},
	}
	const newerRunEthereum = new modules.EthereumClientService(suspendedRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
	const newerRunTokenPriceService = new modules.TokenPriceService(newerRunEthereum, 60_000)

	const olderRunSimulation = await readSimulationSnapshot({ ethereum: simulator.ethereum, tokenPriceService: simulator.tokenPriceService })
	const newerRunSimulation = await readSimulationSnapshot({ ethereum: newerRunEthereum, tokenPriceService: newerRunTokenPriceService })

	const olderRun = refreshConfirmTransactionSimulation(
		olderRunSimulation,
		activeAddress,
		true,
		{ requestId: 1, requestSocket: { tabId: olderRunTabId, connectionName: 0n } },
		pendingTransaction.transactionToSimulate,
	)
	await olderRunTabStateReadStarted.promise

	const newerRun = refreshConfirmTransactionSimulation(
		newerRunSimulation,
		activeAddress,
		true,
		{ requestId: 2, requestSocket: { tabId: newerRunTabId, connectionName: 0n } },
		pendingTransaction.transactionToSimulate,
	)
	await newerRunRpcStarted.promise
	const newerRunAbortSignal = getConfirmTransactionAbortController().signal

	releaseOlderRunTabStateRead.resolve()
	await olderRun
	assert.equal(newerRunAbortSignal.aborted, false, 'the older run must not abort the newer run\'s in-flight simulation')

	releaseNewerRunRpc.resolve()
	const newerRunVisualisation = await newerRun
	if (newerRunVisualisation?.statusCode !== 'success') throw new Error('The newer confirmation simulation did not produce a preview')
	assert.equal(newerRunVisualisation.data.uniqueRequestIdentifier.requestSocket.tabId, newerRunTabId)
})
