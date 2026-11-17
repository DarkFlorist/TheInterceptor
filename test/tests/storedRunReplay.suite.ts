import * as assert from 'node:assert'
import { test } from 'bun:test'
import { replayRecordedProtectorChainReads, isMissingRecordedProtectorReadError } from '../../app/ts/simulation/protectorChainReads.js'
import { activeAddress, recipientAddress, simulator, modules, fakeRpcNetwork, fakeSafeContract, created } from './confirmTransactionTestHarness.js'

const { getPopupVisualisationState } = await import('../../app/ts/background/storageVariables.js')
const { updatePopupVisualisationState } = await import('../../app/ts/background/popupVisualisationUpdater.js')
const { visualizeStoredRunWithoutNode } = await import('../../app/ts/background/storedRunVisualisation.js')

test('stored visualization replay uses edited local names and recorded chain reads without RPC requests', async () => {
	if (activeAddress === undefined || recipientAddress === undefined) throw new Error('Missing test addresses')
	await modules.browserStorageLocalSet({ simulationMode: true, activeRpcNetwork: fakeRpcNetwork, makeCurrentAddressRich: false })
	await modules.updateUserAddressBookEntries(() => modules.defaultActiveAddresses)
	const transaction = { type: '1559' as const, from: activeAddress, to: recipientAddress, chainId: fakeRpcNetwork.chainId, nonce: 0n, gas: 21_000n, value: 1n, input: new Uint8Array(), maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, accessList: [] }
	await modules.updateInterceptorTransactionStack(() => ({ operations: [{ type: 'Transaction', preSimulationTransaction: {
		signedTransaction: modules.mockSignTransaction(transaction), created, transactionIdentifier: 1n,
		website: { websiteOrigin: 'https://example.com', icon: undefined, title: undefined },
		originalRequestParameters: { method: 'eth_sendTransaction', params: [{ from: activeAddress, to: recipientAddress, value: 1n }] },
	} }] }))
	await updatePopupVisualisationState(simulator.ethereum, simulator.tokenPriceService, undefined, true)
	const stored = await getPopupVisualisationState()
	if (stored.simulationState.kind !== 'simulated' || stored.recordedVisualisationLookups === undefined) throw new Error('Expected a recorded simulation')
	await modules.updateUserAddressBookEntries((entries) => [...entries.filter((entry) => entry.address !== recipientAddress), { type: 'contact', name: 'Edited replay recipient', address: recipientAddress, entrySource: 'User', chainId: fakeRpcNetwork.chainId }])
	fakeSafeContract.requestedRpcMethods.length = 0
	const replayed = await visualizeStoredRunWithoutNode(stored.simulationState.value, stored, stored.recordedVisualisationLookups, fakeRpcNetwork)
	assert.deepEqual(fakeSafeContract.requestedRpcMethods, [])
	assert.equal(replayed.visualizedSimulationState.visualizedBlocks[0]?.simulatedAndVisualizedTransactions[0]?.transaction.to?.name, 'Edited replay recipient')
	assert.deepEqual(replayed.recordedVisualisationLookups, stored.recordedVisualisationLookups)
	const { relabelPopupVisualisation } = await import('../../app/ts/background/popupVisualisationUpdater.js')
	await relabelPopupVisualisation(fakeRpcNetwork)
	const relabelled = await getPopupVisualisationState()
	assert.equal(relabelled.simulationId, stored.simulationId)
	assert.equal(relabelled.metadataRevision, 1)
	assert.deepEqual(relabelled.simulationState, stored.simulationState)
	assert.equal(relabelled.visualizedSimulationState.visualizedBlocks[0]?.simulatedAndVisualizedTransactions[0]?.transaction.to?.name, 'Edited replay recipient')
	assert.deepEqual(fakeSafeContract.requestedRpcMethods, [])
})

test('protector replay uses recorded values and identifies missing compatibility data', async () => {
	const { chainReads } = replayRecordedProtectorChainReads({ addressCode: [{ address: 1n, code: 'present' }], gasPrice: 42n })
	assert.equal(await chainReads.readCode(1n), 'present')
	assert.equal(await chainReads.readGasPrice(), 42n)
	await assert.rejects(chainReads.readCode(2n), isMissingRecordedProtectorReadError)
	await assert.rejects(replayRecordedProtectorChainReads({ addressCode: [] }).chainReads.readGasPrice(), isMissingRecordedProtectorReadError)
})

test('an empty stack is left unchanged by a metadata re-label', async () => {
	const { relabelPopupVisualisation } = await import('../../app/ts/background/popupVisualisationUpdater.js')
	const { getPopupVisualisationState, setPopupVisualisationState } = await import('../../app/ts/background/storageVariables.js')
	// This fixture has no chain operations, so it must be left unchanged by a re-label.
	const { createPassthroughCompleteVisualizedSimulation } = await import('../../app/ts/types/visualizer-types.js')
	await setPopupVisualisationState(createPassthroughCompleteVisualizedSimulation((await getPopupVisualisationState()).simulationId + 1))
	const before = await getPopupVisualisationState()
	fakeSafeContract.requestedRpcMethods.length = 0
	await relabelPopupVisualisation(fakeRpcNetwork)
	assert.deepEqual(await getPopupVisualisationState(), before)
	assert.deepEqual(fakeSafeContract.requestedRpcMethods, [])
})
