import * as assert from 'node:assert'
import { describe, test } from 'bun:test'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import type { IEthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import { createExecutionSimulationState, mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../../app/ts/config/defaults.js'
import { InterceptorMessageToInpage } from '../../app/ts/types/interceptor-messages.js'
import { EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import { PASSTHROUGH_STATE, toResolvedExecutionSimulationState } from '../../app/ts/types/visualizer-types.js'
import { serialize } from '../../app/ts/types/wire-types.js'
import { METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER } from '../../app/ts/utils/constants.js'
import { JsonRpcResponseError } from '../../app/ts/utils/errors.js'
import { createMockPort } from '../harness/browserMock.js'
import { eth_getBlockByNumber_goerli_8443561_false, eth_getBlockByNumber_goerli_8443561_true } from '../RPCResponses.js'
import { createMockEthSimulateV1Result, getAggregate3BalanceQueryCount } from './ethSimulateV1MockResults.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'
import { readJsonRpcResult } from './rpcResponseParsing.js'
import { blockNumber, exampleTransaction, rpcNetwork } from './simulationModeEthereumClientServiceTestHelpers.js'

const installBrowserMock = createPerTestBrowserMockInstaller()

// A mock Goerli node at block 8443561 that answers the requests subscription and filter handling make, with wire JSON that EthereumClientService parses.
const createSubscriptionTestRequestHandler = (): IEthereumJSONRpcRequestHandler => ({
	rpcUrl: rpcNetwork.httpsRpc,
	clearCache: () => undefined,
	getChainId: async () => 5n,
	jsonRpcRequest: async (rpcRequest) => {
		switch (rpcRequest.method) {
			case 'eth_blockNumber': return `0x${ blockNumber.toString(16) }`
			case 'eth_getBlockByNumber': {
				if (rpcRequest.params[0] !== blockNumber && rpcRequest.params[0] !== 'latest') throw new Error('Unsupported block number')
				if (rpcRequest.params[1] === true) return readJsonRpcResult(eth_getBlockByNumber_goerli_8443561_true)
				return readJsonRpcResult(eth_getBlockByNumber_goerli_8443561_false)
			}
			case 'eth_getLogs': return []
			case 'eth_simulateV1': {
				const blockStateCalls = rpcRequest.params[0]?.blockStateCalls
				const aggregate3BalanceQueryCount = getAggregate3BalanceQueryCount(blockStateCalls?.at(-1)?.calls[0]?.input)
				return serialize(EthSimulateV1Result, createMockEthSimulateV1Result(blockStateCalls?.length ?? 0, aggregate3BalanceQueryCount))
			}
			default: throw new Error(`unsupported method ${ rpcRequest.method }`)
		}
	},
})

// A website port whose posted messages are parsed and collected like the inpage script would receive them.
const createCollectingWebsitePort = (postedMessages: InterceptorMessageToInpage[]) => createMockPort({
	onPostMessage: (message) => { postedMessages.push(InterceptorMessageToInpage.parse(message)) },
}).port

async function loadModules() {
	return {
		...await import('../../app/ts/simulation/services/EthereumSubscriptionService.js'),
		...await import('../../app/ts/background/storageVariables.js'),
	}
}

const createEthereum = () => new EthereumClientService(createSubscriptionTestRequestHandler(), async () => undefined, async () => undefined, rpcNetwork)
const createSimulationInput = (gas: bigint, nonce: bigint, transactionIdentifier: bigint) => [{
	stateOverrides: {},
	transactions: [{
		signedTransaction: mockSignTransaction({
			...exampleTransaction,
			gas,
			nonce,
		}),
		website: { websiteOrigin: 'test', icon: undefined, title: undefined },
		created: new Date(),
		originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
		transactionIdentifier,
	}],
	signedMessages: [],
	blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
	simulateWithZeroBaseFee: false,
}] as const

describe('EthereumSubscriptionService', () => {
	test('unsupported subscription types reject with a provider JSON-RPC error', async () => {
		installBrowserMock()
		const { createEthereumSubscription } = await loadModules()
		const socket = { tabId: 1, connectionName: 1n }

		for (const subscriptionType of ['logs', 'newPendingTransactions', 'syncing'] as const) {
			await assert.rejects(
				createEthereumSubscription({ method: 'eth_subscribe', params: [subscriptionType] }, socket),
				(error: unknown) => error instanceof JsonRpcResponseError
					&& error.code === METAMASK_ERROR_METHOD_NOT_SUPPORTED_BY_PROVIDER
					&& error.message.includes(subscriptionType),
			)
		}
	})

	test('removeEthereumSubscription only removes the matching socket subscription', async () => {
		installBrowserMock()
		const { getEthereumSubscriptionsAndFilters, removeEthereumSubscription, updateEthereumSubscriptionsAndFilters } = await loadModules()

		const socket = { tabId: 1, connectionName: 1n } as const
		const otherSocket = { tabId: 2, connectionName: 2n } as const
		await updateEthereumSubscriptionsAndFilters(() => ([
			{ type: 'newHeads', subscriptionOrFilterId: 'remove-me', params: { method: 'eth_subscribe', params: ['newHeads'] }, subscriptionCreatorSocket: socket },
			{ type: 'newHeads', subscriptionOrFilterId: 'keep-same-socket', params: { method: 'eth_subscribe', params: ['newHeads'] }, subscriptionCreatorSocket: socket },
			{ type: 'newHeads', subscriptionOrFilterId: 'keep-other-socket', params: { method: 'eth_subscribe', params: ['newHeads'] }, subscriptionCreatorSocket: otherSocket },
		]))

		assert.equal(await removeEthereumSubscription(socket, 'remove-me'), true)
		assert.deepEqual((await getEthereumSubscriptionsAndFilters()).map((entry) => entry.subscriptionOrFilterId), ['keep-same-socket', 'keep-other-socket'])
	})

	test('getEthFilterChanges applies the real filter payload and preserves the stored subscription list', async () => {
		installBrowserMock()
		const { getEthereumSubscriptionsAndFilters, getEthFilterChanges, updateEthereumSubscriptionsAndFilters } = await loadModules()
		const ethereum = createEthereum()

		const filterSocket = { tabId: 1, connectionName: 1n } as const
		const otherSocket = { tabId: 2, connectionName: 2n } as const

		const simulationInput = [{
			stateOverrides: {},
			transactions: [{
				signedTransaction: mockSignTransaction({
					type: '1559',
					from: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
					nonce: 0n,
					maxFeePerGas: 1n,
					maxPriorityFeePerGas: 1n,
					gas: 21000n,
					to: 0xda9dfa130df4de4673b89022ee50ff26f6ea73cfn,
					value: 10n,
					input: new Uint8Array(0),
					chainId: 5n,
				}),
				website: { websiteOrigin: 'test', icon: undefined, title: undefined },
				created: new Date(),
				originalRequestParameters: { method: 'eth_sendTransaction', params: [{}] },
				transactionIdentifier: 1n,
			}],
			signedMessages: [],
			blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION,
			simulateWithZeroBaseFee: false,
		}] as const
		const simulationState = await createExecutionSimulationState(ethereum, undefined, simulationInput)
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
		const matchingLog = simulationState.simulatedBlocks[0]?.simulatedTransactions[0]?.ethSimulateV1CallResult.status === 'success'
			? simulationState.simulatedBlocks[0]?.simulatedTransactions[0]?.ethSimulateV1CallResult.logs[0]
			: undefined
		if (matchingLog === undefined) throw new Error('matching simulated log missing')
		const [matchingTopic] = matchingLog.topics
		if (matchingTopic === undefined) throw new Error('matching simulated log topic missing')

		await updateEthereumSubscriptionsAndFilters(() => ([
			{
				type: 'eth_newFilter',
				subscriptionOrFilterId: 'filter-1',
				params: { method: 'eth_newFilter', params: [{ address: matchingLog.address, topics: [matchingTopic] }] },
				subscriptionCreatorSocket: filterSocket,
				calledInlastBlock: 100n,
			},
			{
				type: 'newHeads',
				subscriptionOrFilterId: 'keep-me',
				params: { method: 'eth_subscribe', params: ['newHeads'] },
				subscriptionCreatorSocket: otherSocket,
			},
		]))

		const firstChanges = await getEthFilterChanges(filterSocket, 'filter-1', ethereum, undefined, toResolvedExecutionSimulationState(simulationState))
		assert.equal(firstChanges?.length, 1)
		assert.equal(firstChanges?.[0]?.address, matchingLog.address)

		const secondChanges = await getEthFilterChanges(filterSocket, 'filter-1', ethereum, undefined, toResolvedExecutionSimulationState(simulationState))
		assert.deepEqual(secondChanges, [])

		const updated = await getEthereumSubscriptionsAndFilters()
		assert.equal(updated.length, 2)
		assert.equal(updated[0]?.type, 'eth_newFilter')
		if (updated[0]?.type !== 'eth_newFilter') throw new Error('Filter was not preserved')
		assert.equal(updated[0].calledInlastBlock, blockNumber + 1n)
		assert.equal(updated[1]?.subscriptionOrFilterId, 'keep-me')
	})

	test('eth_getFilterChanges treats a null address as unrestricted', async () => {
		installBrowserMock()
		const { createNewFilter, getEthFilterChanges, getEthereumSubscriptionsAndFilters } = await loadModules()
		const ethereum = createEthereum()
		const socket = { tabId: 1, connectionName: 1n } as const
		const filterId = await createNewFilter({ method: 'eth_newFilter', params: [{ address: null }] }, socket, ethereum, undefined, PASSTHROUGH_STATE)
		const simulationState = await createExecutionSimulationState(ethereum, undefined, createSimulationInput(21_000n, 0n, 1n))
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')

		const firstChanges = await getEthFilterChanges(socket, filterId, ethereum, undefined, toResolvedExecutionSimulationState(simulationState))
		const secondChanges = await getEthFilterChanges(socket, filterId, ethereum, undefined, toResolvedExecutionSimulationState(simulationState))
		const storedFilters = await getEthereumSubscriptionsAndFilters()
		const storedFilter = storedFilters.find((filter) => filter.type === 'eth_newFilter' && filter.subscriptionOrFilterId === filterId)
		if (storedFilter === undefined || storedFilter.type !== 'eth_newFilter') throw new Error('stored filter missing')

		assert.equal(firstChanges?.length, 1)
		assert.equal(firstChanges?.[0]?.blockNumber, blockNumber + 1n)
		assert.deepEqual(secondChanges, [])
		assert.equal(storedFilter.calledInlastBlock, blockNumber + 1n)
	})

	test('concurrent eth_getFilterChanges calls do not return the same logs twice', async () => {
		installBrowserMock()
		const { createNewFilter, getEthFilterChanges } = await loadModules()
		const ethereum = createEthereum()
		const socket = { tabId: 1, connectionName: 1n } as const
		const filterId = await createNewFilter({ method: 'eth_newFilter', params: [{}] }, socket, ethereum, undefined, PASSTHROUGH_STATE)
		const simulationState = await createExecutionSimulationState(ethereum, undefined, createSimulationInput(21_000n, 0n, 1n))
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
		const resolvedSimulationState = toResolvedExecutionSimulationState(simulationState)

		const concurrentChanges = await Promise.all([
			getEthFilterChanges(socket, filterId, ethereum, undefined, resolvedSimulationState),
			getEthFilterChanges(socket, filterId, ethereum, undefined, resolvedSimulationState),
		])

		assert.deepEqual(concurrentChanges.map((logs) => logs?.length).sort(), [0, 1])
	})

	test('filter reads are restricted to the socket that created the filter', async () => {
		installBrowserMock()
		const { createNewFilter, getEthFilterChanges, getEthFilterLogs } = await loadModules()
		const ethereum = createEthereum()
		const creatorSocket = { tabId: 1, connectionName: 1n } as const
		const otherSocketInSameTab = { tabId: 1, connectionName: 2n } as const
		const filterId = await createNewFilter({ method: 'eth_newFilter', params: [{}] }, creatorSocket, ethereum, undefined, PASSTHROUGH_STATE)

		assert.equal(await getEthFilterChanges(otherSocketInSameTab, filterId, ethereum, undefined, PASSTHROUGH_STATE), undefined)
		assert.equal(await getEthFilterLogs(otherSocketInSameTab, filterId, ethereum, undefined, PASSTHROUGH_STATE), undefined)
		assert.deepEqual(await getEthFilterChanges(creatorSocket, filterId, ethereum, undefined, PASSTHROUGH_STATE), [])
	})

	test('filter cursors do not rewind when the simulated head moves backwards', async () => {
		installBrowserMock()
		const { getEthFilterChanges, getEthereumSubscriptionsAndFilters, updateEthereumSubscriptionsAndFilters } = await loadModules()
		const ethereum = createEthereum()
		const socket = { tabId: 1, connectionName: 1n } as const
		const futureCursor = blockNumber + 5n
		await updateEthereumSubscriptionsAndFilters(() => ([{
			type: 'eth_newFilter',
			subscriptionOrFilterId: 'future-filter',
			params: { method: 'eth_newFilter', params: [{}] },
			subscriptionCreatorSocket: socket,
			calledInlastBlock: futureCursor,
		}]))

		assert.deepEqual(await getEthFilterChanges(socket, 'future-filter', ethereum, undefined, PASSTHROUGH_STATE), [])
		const [storedFilter] = await getEthereumSubscriptionsAndFilters()
		if (storedFilter?.type !== 'eth_newFilter') throw new Error('stored filter missing')
		assert.equal(storedFilter.calledInlastBlock, futureCursor)
	})

	test('newHeads emits each simulated execution block after a gas split', async () => {
		installBrowserMock()
		const { createEthereumSubscription, sendSubscriptionMessagesForNewBlock } = await loadModules()
		const ethereum = createEthereum()
		const socket = { tabId: 1, connectionName: 1n } as const
		const postedMessages: InterceptorMessageToInpage[] = []
		const port = createCollectingWebsitePort(postedMessages)
		const websiteTabConnections = new Map([
			[1, {
				connections: {
					'1-0x1': {
						port,
						socket,
						websiteOrigin: 'test',
						approved: true,
						wantsToConnect: false,
					},
				},
			}],
		])
		const subscriptionId = await createEthereumSubscription({ method: 'eth_subscribe', params: ['newHeads'] }, socket)
		const splitSimulationInput = [{
			stateOverrides: {},
			transactions: [
				{
					signedTransaction: mockSignTransaction({
						...exampleTransaction,
						nonce: 0n,
						gas: 20_000_000n,
					}),
					website: { websiteOrigin: 'test', icon: undefined, title: undefined },
					created: new Date(),
					originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
					transactionIdentifier: 2n,
				},
				{
					signedTransaction: mockSignTransaction({
						...exampleTransaction,
						nonce: 1n,
						gas: 20_000_000n,
					}),
					website: { websiteOrigin: 'test', icon: undefined, title: undefined },
					created: new Date(),
					originalRequestParameters: { method: 'eth_sendTransaction', params: [{}]},
					transactionIdentifier: 3n,
				},
			],
			signedMessages: [],
			blockTimeManipulation: { type: 'AddToTimestamp', deltaToAdd: 12n, deltaUnit: 'Seconds' },
			simulateWithZeroBaseFee: false,
		}] as const
		const simulationState = await createExecutionSimulationState(ethereum, undefined, splitSimulationInput)
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')

		await sendSubscriptionMessagesForNewBlock(blockNumber, ethereum, true, websiteTabConnections, async () => toResolvedExecutionSimulationState(simulationState))

		const emittedBlockNumbers = postedMessages.flatMap((message) => {
			if (message.type !== 'result' || !('method' in message) || message.method !== 'newHeads') return []
			if (!('result' in message) || !('result' in message.result)) throw new Error('wrong subscription payload')
			if (message.result.result === null) throw new Error('missing simulated block payload')
			assert.equal(message.subscription, subscriptionId)
			assert.equal(message.result.subscription, subscriptionId)
			return [message.result.result.number]
		})
		assert.equal(emittedBlockNumbers.length, 3)
		assert.deepEqual(emittedBlockNumbers, [blockNumber, blockNumber + 1n, blockNumber + 2n])
	})

	test('newHeads removes a stale socket while another socket in the same tab remains live', async () => {
		installBrowserMock()
		const { createEthereumSubscription, getEthereumSubscriptionsAndFilters, sendSubscriptionMessagesForNewBlock, updateEthereumSubscriptionsAndFilters } = await loadModules()
		const ethereum = createEthereum()
		const staleSocket = { tabId: 2, connectionName: 1n } as const
		const liveSocket = { tabId: 2, connectionName: 2n } as const
		const postedMessages: InterceptorMessageToInpage[] = []
		const port = createCollectingWebsitePort(postedMessages)
		const websiteTabConnections = new Map([
			[2, {
				connections: {
					'2-0x2': {
						port,
						socket: liveSocket,
						websiteOrigin: 'test',
						approved: true,
						wantsToConnect: false,
					},
				},
			}],
		])

		await updateEthereumSubscriptionsAndFilters(() => [])
		const staleSubscriptionId = await createEthereumSubscription({ method: 'eth_subscribe', params: ['newHeads'] }, staleSocket)
		const liveSubscriptionId = await createEthereumSubscription({ method: 'eth_subscribe', params: ['newHeads'] }, liveSocket)

		await sendSubscriptionMessagesForNewBlock(blockNumber, ethereum, false, websiteTabConnections, async () => PASSTHROUGH_STATE)

		const emittedBlockNumbers = postedMessages.flatMap((message) => {
			if (message.type !== 'result' || !('method' in message) || message.method !== 'newHeads') return []
			if (!('result' in message) || !('result' in message.result)) throw new Error('wrong subscription payload')
			if (message.result.result === null) throw new Error('missing block payload')
			return [message.result.result.number]
		})

		assert.deepEqual(emittedBlockNumbers, [blockNumber])
		assert.deepEqual((await getEthereumSubscriptionsAndFilters()).map((subscription) => subscription.subscriptionOrFilterId), [liveSubscriptionId])
		assert.notEqual(staleSubscriptionId, liveSubscriptionId)
	})

	test('newHeads reuses one simulated state computation across multiple live subscribers', async () => {
		installBrowserMock()
		const { createEthereumSubscription, sendSubscriptionMessagesForNewBlock } = await loadModules()
		const ethereum = createEthereum()
		const sockets = [
			{ tabId: 1, connectionName: 1n } as const,
			{ tabId: 2, connectionName: 2n } as const,
		]
		const postedMessages: InterceptorMessageToInpage[] = []
		const websiteTabConnections = new Map(sockets.map((socket) => [socket.tabId, {
			connections: {
				[`${ socket.tabId }-0x${ socket.connectionName.toString(16) }`]: {
					port: createCollectingWebsitePort(postedMessages),
					socket,
					websiteOrigin: 'test',
					approved: true,
					wantsToConnect: false,
				},
			},
		}]))
		for (const socket of sockets) {
			await createEthereumSubscription({ method: 'eth_subscribe', params: ['newHeads'] }, socket)
		}
		const simulationState = await createExecutionSimulationState(ethereum, undefined, createSimulationInput(21_000n, 0n, 1n))
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
		let simulationStateRequests = 0

		await sendSubscriptionMessagesForNewBlock(blockNumber, ethereum, true, websiteTabConnections, async () => {
			simulationStateRequests++
			return toResolvedExecutionSimulationState(simulationState)
		})

		assert.equal(simulationStateRequests, 1)
		const emittedMessages = postedMessages.filter((message) => message.type === 'result' && 'method' in message && message.method === 'newHeads')
		assert.equal(emittedMessages.length, 4)
	})
})
