import * as assert from 'node:assert'
import { spyOn, test } from 'bun:test'
import * as ts from 'typescript'
import { recordProtectorChainReads, replayRecordedProtectorChainReads, isMissingRecordedProtectorReadError } from '../../app/ts/simulation/protectorChainReads.js'
import { createDeferredSignal } from './backgroundEthAccountsTestHarness.js'
import { activeAddress, recipientAddress, simulator, modules, fakeRpcNetwork, fakeSafeContract, created } from './confirmTransactionTestHarness.js'

const { getPopupVisualisationForDisplay, getStoredPopupVisualisationState, setStoredPopupVisualisationState } = await import('../../app/ts/background/storageVariables.js')
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
	const delegationLookup = spyOn(simulator.ethereum, 'getDelegation').mockResolvedValue(recipientAddress)
	try {
		await updatePopupVisualisationState(simulator.ethereum, simulator.tokenPriceService, undefined, true)
	} finally {
		delegationLookup.mockRestore()
	}
	const current = await getStoredPopupVisualisationState()
	if (current.simulationState.kind !== 'simulated' || current.recordedVisualisationLookups === undefined) throw new Error('Expected a recorded simulation')
	assert.deepEqual(current.recordedVisualisationLookups.senderDelegations, [{ sender: activeAddress, delegationAddress: recipientAddress }])
	assert.equal('recordedVisualisationLookups' in await getPopupVisualisationForDisplay(), false)
	await setStoredPopupVisualisationState(current)
	assert.deepEqual(await getStoredPopupVisualisationState(), current)
	// Make the previous result old enough that only the busy semaphore can suppress a throttled refresh.
	const stored = { ...current, recordedVisualisationLookups: current.recordedVisualisationLookups, simulationState: { kind: 'simulated' as const, value: { ...current.simulationState.value, simulationConductedTimestamp: new Date(0) } } }
	await setStoredPopupVisualisationState(stored)
	await modules.updateUserAddressBookEntries((entries) => [...entries.filter((entry) => entry.address !== recipientAddress), { type: 'contact', name: 'Edited replay recipient', address: recipientAddress, entrySource: 'User', chainId: fakeRpcNetwork.chainId }])
	fakeSafeContract.requestedRpcMethods.length = 0
	const storedMetadata = { tokenPriceEstimates: stored.tokenPriceEstimates }
	const { senderDelegations: _senderDelegations, ...legacyLookups } = stored.recordedVisualisationLookups
	assert.equal(await visualizeStoredRunWithoutNode(stored.simulationState.value, storedMetadata, legacyLookups, fakeRpcNetwork), undefined)
	const replayed = await visualizeStoredRunWithoutNode(stored.simulationState.value, storedMetadata, stored.recordedVisualisationLookups, fakeRpcNetwork)
	assert.ok(replayed)
	assert.equal(replayed.visualizedSimulationState.visualizedBlocks[0]?.simulatedAndVisualizedTransactions[0]?.transaction.delegationAddress?.name, 'Edited replay recipient')
	assert.deepEqual(fakeSafeContract.requestedRpcMethods, [])
	assert.equal(replayed.visualizedSimulationState.visualizedBlocks[0]?.simulatedAndVisualizedTransactions[0]?.transaction.to?.name, 'Edited replay recipient')
	assert.deepEqual(replayed.recordedVisualisationLookups, stored.recordedVisualisationLookups)
	const { relabelPopupVisualisation, updatePopupVisualisationIfNeeded } = await import('../../app/ts/background/popupVisualisationUpdater.js')
	const publicationStarted = createDeferredSignal()
	const releasePublication = createDeferredSignal()
	const sendMessage = browser.runtime.sendMessage
	let visibilityProbes = 0
	browser.runtime.sendMessage = async (message) => {
		if (message.method === 'popup_isSimulationVisualizerOpen') visibilityProbes += 1
		if (message.method === 'popup_simulation_state_changed') {
			publicationStarted.resolve()
			assert.equal('recordedVisualisationLookups' in message.data.visualizedSimulatorState, false)
			await releasePublication.promise
		}
		return await sendMessage(message)
	}
	const relabel = relabelPopupVisualisation(fakeRpcNetwork)
	try {
		await publicationStarted.promise
		await updatePopupVisualisationIfNeeded(simulator.ethereum, simulator.tokenPriceService, { onlyIfNotAlreadyUpdating: true })
		assert.equal(visibilityProbes, 0, 'a throttled refresh does not enter while relabeling holds the lock')
	} finally {
		releasePublication.resolve()
		try { await relabel } finally { browser.runtime.sendMessage = sendMessage }
	}
	const relabelled = await getPopupVisualisationForDisplay()
	assert.equal(relabelled.simulationId, stored.simulationId)
	assert.equal(relabelled.metadataRevision, 1)
	assert.deepEqual((await getStoredPopupVisualisationState()).recordedVisualisationLookups, stored.recordedVisualisationLookups)
	assert.deepEqual(relabelled.simulationState, stored.simulationState)
	assert.equal(relabelled.visualizedSimulationState.visualizedBlocks[0]?.simulatedAndVisualizedTransactions[0]?.transaction.to?.name, 'Edited replay recipient')
	assert.deepEqual(fakeSafeContract.requestedRpcMethods, [])
})

test('display messages and stored writes require different visualisation types', async () => {
	const repositoryRoot = new URL('../../', import.meta.url).pathname
	const fixturePath = `${ repositoryRoot }test/fixtures/storedVisualisation/projection.ts`
	const configFile = ts.readConfigFile(`${ repositoryRoot }tsconfig.json`, ts.sys.readFile)
	const { options } = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repositoryRoot)
	const program = ts.createProgram([fixturePath], { ...options, noEmit: true, rootDir: repositoryRoot })
	const fixture = program.getSourceFile(fixturePath)
	if (fixture === undefined) throw new Error('Missing stored visualisation fixture')
	const errorLines = ts.getPreEmitDiagnostics(program, fixture).flatMap((diagnostic) => diagnostic.start === undefined ? [] : [fixture.getLineAndCharacterOfPosition(diagnostic.start).line + 1])
	const expectedLines = (await Bun.file(fixturePath).text()).split('\n').flatMap((line, index) => line.includes('// expect-type-error') ? [index + 1] : [])
	assert.equal(expectedLines.length, 3)
	assert.deepEqual([...new Set(errorLines)].sort((first, second) => first - second), expectedLines)
})

test('paired protector adapters record and replay each chain read', async () => {
	const { chainReads, getRecord } = recordProtectorChainReads({
		readCode: async () => 'unverified',
		readGasPrice: async () => 0n,
	})
	assert.equal(await chainReads.readCode(1n), 'unverified')
	assert.equal(await chainReads.readGasPrice(), 0n)
	const record = getRecord()
	assert.deepEqual(record, { addressCode: [{ address: 1n, code: 'unverified' }], gasPrice: 0n })
	const replay = replayRecordedProtectorChainReads(record)
	assert.equal(await replay.readCode(1n), 'unverified')
	assert.equal(await replay.readGasPrice(), 0n)
})

test('protector replay uses recorded values and identifies missing compatibility data', async () => {
	const chainReads = replayRecordedProtectorChainReads({ addressCode: [{ address: 1n, code: 'present' }], gasPrice: 42n })
	assert.equal(await chainReads.readCode(1n), 'present')
	assert.equal(await chainReads.readGasPrice(), 42n)
	await assert.rejects(chainReads.readCode(2n), isMissingRecordedProtectorReadError)
	await assert.rejects(replayRecordedProtectorChainReads({ addressCode: [] }).readGasPrice(), isMissingRecordedProtectorReadError)
})

test('an empty stack is left unchanged by a metadata re-label', async () => {
	const { relabelPopupVisualisation } = await import('../../app/ts/background/popupVisualisationUpdater.js')
	const { getPopupVisualisationForDisplay, setStoredPopupVisualisationState } = await import('../../app/ts/background/storageVariables.js')
	// This fixture has no chain operations, so it must be left unchanged by a re-label.
	const { createPassthroughCompleteVisualizedSimulation } = await import('../../app/ts/types/visualizer-types.js')
	await setStoredPopupVisualisationState({ ...createPassthroughCompleteVisualizedSimulation((await getPopupVisualisationForDisplay()).simulationId + 1), recordedVisualisationLookups: undefined })
	const before = await getPopupVisualisationForDisplay()
	fakeSafeContract.requestedRpcMethods.length = 0
	await relabelPopupVisualisation(fakeRpcNetwork)
	assert.deepEqual(await getPopupVisualisationForDisplay(), before)
	assert.deepEqual(fakeSafeContract.requestedRpcMethods, [])
})
