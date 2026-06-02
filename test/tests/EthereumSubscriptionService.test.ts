import * as assert from 'assert'
import { describe, test } from 'bun:test'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { createExecutionSimulationState, DEFAULT_BLOCK_MANIPULATION, mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { InterceptorMessageToInpage } from '../../app/ts/types/interceptor-messages.js'
import { JsonRpcResponse, type EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import type { EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import { PASSTHROUGH_STATE, toResolvedExecutionSimulationState } from '../../app/ts/types/visualizer-types.js'
import { dataStringWith0xStart } from '../../app/ts/utils/bigint.js'
import { Multicall3ABI } from '../../app/ts/utils/constants.js'
import { decodeFunctionDataStrict, encodeAbiValues, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { eth_getBlockByNumber_goerli_8443561_false, eth_getBlockByNumber_goerli_8443561_true, eth_simulateV1_dummy_call_result, eth_simulateV1_dummy_call_result_2calls, eth_simulateV1_get_eth_balance_multicall } from '../RPCResponses.js'

function parseRequest<T>(data: string): T {
	const jsonRpcResponse = JsonRpcResponse.parse(JSON.parse(data))
	if ('error' in jsonRpcResponse) throw Error(`Ethereum Client Error: ${jsonRpcResponse.error.message}`)
	return jsonRpcResponse.result as T
}

const ethSimulateSingleBlockResult = parseRequest<EthSimulateV1Result>(eth_simulateV1_dummy_call_result)
const ethSimulateSplitBlocksResult = parseRequest<EthSimulateV1Result>(eth_simulateV1_dummy_call_result_2calls)
const ethSimulateAggregate3Result = parseRequest<EthSimulateV1Result>(eth_simulateV1_get_eth_balance_multicall)

function buildAggregate3BalanceBlock(balanceQueryCount: number) {
	const aggregate3BalanceBlock = ethSimulateAggregate3Result[ethSimulateAggregate3Result.length - 1]
	const aggregate3Call = aggregate3BalanceBlock?.calls[0]
	if (aggregate3BalanceBlock === undefined) throw new Error('missing aggregate3 simulation fixture block')
	if (aggregate3Call === undefined) throw new Error('missing aggregate3 simulation fixture call')
	return {
		...aggregate3BalanceBlock,
		calls: [
			{
				...aggregate3Call,
				returnData: encodeFunctionReturn(Multicall3ABI, 'aggregate3', [
					Array.from({ length: balanceQueryCount }, (_, index) => ({
						success: true,
						returnData: encodeAbiValues(['uint256'], [BigInt(index + 1)]),
					})),
				]),
			},
		],
	}
}

function createMockEthSimulateV1Result(blockStateCallCount: number, aggregate3BalanceQueryCount: number | undefined) {
	const singleTransactionBlock = ethSimulateSingleBlockResult[0]
	const followupTransactionBlock = ethSimulateSplitBlocksResult[1]
	if (singleTransactionBlock === undefined) throw new Error('missing single transaction simulation fixture')
	if (followupTransactionBlock === undefined) throw new Error('missing followup simulation fixture block')

	const includesAggregate3BalanceCall = aggregate3BalanceQueryCount !== undefined
	const nonAggregateBlockCount = includesAggregate3BalanceCall ? Math.max(blockStateCallCount - 1, 0) : blockStateCallCount
	const nonAggregateBlocks = Array.from({ length: nonAggregateBlockCount }, (_, blockIndex) => (blockIndex === 0 ? singleTransactionBlock : followupTransactionBlock))
	if (!includesAggregate3BalanceCall) return nonAggregateBlocks
	return [...nonAggregateBlocks, buildAggregate3BalanceBlock(aggregate3BalanceQueryCount)]
}

function installBrowserMock() {
	const storageState: Record<string, unknown> = {}
	globalThis.browser = {
		runtime: {
			lastError: null,
		},
		storage: {
			local: {
				async get(keys?: string | string[] | Record<string, unknown> | null) {
					if (keys === undefined || keys === null) return { ...storageState }
					if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageState[key]]))
					if (typeof keys === 'string') return { [keys]: storageState[keys] }
					return Object.fromEntries(Object.entries(keys).map(([key, defaultValue]) => [key, key in storageState ? storageState[key] : defaultValue]))
				},
				async set(items: Record<string, unknown>) {
					Object.assign(storageState, items)
				},
				async remove(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState[key]
				},
			},
		},
	} as unknown as typeof globalThis.browser
	return storageState
}

async function loadModules() {
	return {
		...(await import('../../app/ts/simulation/services/EthereumSubscriptionService.js')),
		...(await import('../../app/ts/background/storageVariables.js')),
	}
}

const blockNumber = 8443561n
const rpcNetwork = {
	name: 'Goerli',
	chainId: 5n,
	httpsRpc: 'https://rpc.dark.florist/flipcardtrustone',
	currencyName: 'Goerli Testnet ETH',
	currencyTicker: 'GÖETH',
	primary: true,
	minimized: true,
	weth: 0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6n,
}

class MockEthereumJSONRpcRequestHandler {
	public rpcUrl = 'https://rpc.dark.florist/flipcardtrustone'

	public clearCache = () => undefined

	public getChainId = async () => 5n

	public readonly jsonRpcRequest = async (rpcRequest: EthereumJsonRpcRequest) => {
		switch (rpcRequest.method) {
			case 'eth_blockNumber':
				return `0x${blockNumber.toString(16)}`
			case 'eth_getBlockByNumber': {
				if (rpcRequest.params[0] !== blockNumber && rpcRequest.params[0] !== 'latest') throw new Error('Unsupported block number')
				if (rpcRequest.params[1] === true) return parseRequest(eth_getBlockByNumber_goerli_8443561_true)
				return parseRequest(eth_getBlockByNumber_goerli_8443561_false)
			}
			case 'eth_getLogs':
				return []
			case 'eth_simulateV1': {
				const lastCallInput = rpcRequest.params[0]?.blockStateCalls.at(-1)?.calls[0]?.input
				const aggregate3BalanceQueryCount =
					lastCallInput !== undefined && dataStringWith0xStart(lastCallInput).startsWith('0x82ad56cb')
						? (() => {
								const decoded = decodeFunctionDataStrict(Multicall3ABI, dataStringWith0xStart(lastCallInput))
								if (decoded.functionName !== 'aggregate3') throw new Error('expected aggregate3 call')
								return decoded.args[0].length
							})()
						: undefined
				return createMockEthSimulateV1Result(rpcRequest.params[0]?.blockStateCalls.length ?? 0, aggregate3BalanceQueryCount)
			}
			default:
				throw new Error(`unsupported method ${rpcRequest.method}`)
		}
	}
}

const exampleTransaction = {
	type: '1559',
	from: 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n,
	nonce: 0n,
	maxFeePerGas: 1n,
	maxPriorityFeePerGas: 1n,
	gas: 21000n,
	to: 0xda9dfa130df4de4673b89022ee50ff26f6ea73cfn,
	value: 10n,
	input: new Uint8Array(0),
	chainId: 1n,
} as const

const createEthereum = () =>
	new EthereumClientService(
		new MockEthereumJSONRpcRequestHandler(),
		async () => undefined,
		async () => undefined,
		rpcNetwork,
	)
const createSimulationInput = (gas: bigint, nonce: bigint, transactionIdentifier: bigint) =>
	[
		{
			stateOverrides: {},
			transactions: [
				{
					signedTransaction: mockSignTransaction({
						...exampleTransaction,
						gas,
						nonce,
					}),
					website: { websiteOrigin: 'test', icon: undefined, title: undefined },
					created: new Date(),
					originalRequestParameters: {
						method: 'eth_sendTransaction',
						params: [{}],
					},
					transactionIdentifier,
				},
			],
			signedMessages: [],
			blockTimeManipulation: {
				type: 'AddToTimestamp',
				deltaToAdd: 12n,
				deltaUnit: 'Seconds',
			},
			simulateWithZeroBaseFee: false,
		},
	] as const

describe('EthereumSubscriptionService', () => {
	test('removeEthereumSubscription only removes the matching socket subscription', async () => {
		installBrowserMock()
		const { getEthereumSubscriptionsAndFilters, removeEthereumSubscription, updateEthereumSubscriptionsAndFilters } = await loadModules()

		const socket = { tabId: 1, connectionName: 1n } as const
		const otherSocket = { tabId: 2, connectionName: 2n } as const
		await updateEthereumSubscriptionsAndFilters(() => [
			{
				type: 'newHeads',
				subscriptionOrFilterId: 'remove-me',
				params: { method: 'eth_subscribe', params: ['newHeads'] },
				subscriptionCreatorSocket: socket,
			},
			{
				type: 'newHeads',
				subscriptionOrFilterId: 'keep-same-socket',
				params: { method: 'eth_subscribe', params: ['newHeads'] },
				subscriptionCreatorSocket: socket,
			},
			{
				type: 'newHeads',
				subscriptionOrFilterId: 'keep-other-socket',
				params: { method: 'eth_subscribe', params: ['newHeads'] },
				subscriptionCreatorSocket: otherSocket,
			},
		])

		assert.equal(await removeEthereumSubscription(socket, 'remove-me'), true)
		assert.deepEqual(
			(await getEthereumSubscriptionsAndFilters()).map((entry) => entry.subscriptionOrFilterId),
			['keep-same-socket', 'keep-other-socket'],
		)
	})

	test('getEthFilterChanges applies the real filter payload and preserves the stored subscription list', async () => {
		installBrowserMock()
		const { getEthereumSubscriptionsAndFilters, getEthFilterChanges, updateEthereumSubscriptionsAndFilters } = await loadModules()
		const ethereum = createEthereum()

		const filterSocket = { tabId: 1, connectionName: 1n } as const
		const otherSocket = { tabId: 2, connectionName: 2n } as const

		const simulationInput = [
			{
				stateOverrides: {},
				transactions: [
					{
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
						website: {
							websiteOrigin: 'test',
							icon: undefined,
							title: undefined,
						},
						created: new Date(),
						originalRequestParameters: {
							method: 'eth_sendTransaction',
							params: [{}],
						},
						transactionIdentifier: 1n,
					},
				],
				signedMessages: [],
				blockTimeManipulation: DEFAULT_BLOCK_MANIPULATION,
				simulateWithZeroBaseFee: false,
			},
		] as const
		const simulationState = await createExecutionSimulationState(ethereum, undefined, simulationInput)
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')
		const matchingLog = simulationState.simulatedBlocks[0]?.simulatedTransactions[0]?.ethSimulateV1CallResult.status === 'success' ? simulationState.simulatedBlocks[0]?.simulatedTransactions[0]?.ethSimulateV1CallResult.logs[0] : undefined
		if (matchingLog === undefined) throw new Error('matching simulated log missing')

		await updateEthereumSubscriptionsAndFilters(() => [
			{
				type: 'eth_newFilter',
				subscriptionOrFilterId: 'filter-1',
				params: {
					method: 'eth_newFilter',
					params: [{ address: matchingLog.address, topics: [matchingLog.topics[0]] }],
				},
				subscriptionCreatorSocket: filterSocket,
				calledInlastBlock: 100n,
			},
			{
				type: 'newHeads',
				subscriptionOrFilterId: 'keep-me',
				params: { method: 'eth_subscribe', params: ['newHeads'] },
				subscriptionCreatorSocket: otherSocket,
			},
		])

		const firstChanges = await getEthFilterChanges('filter-1', ethereum, undefined, toResolvedExecutionSimulationState(simulationState))
		assert.equal(firstChanges?.length, 1)
		assert.equal(firstChanges?.[0]?.address, matchingLog.address)

		const secondChanges = await getEthFilterChanges('filter-1', ethereum, undefined, toResolvedExecutionSimulationState(simulationState))
		assert.deepEqual(secondChanges, [])

		const updated = await getEthereumSubscriptionsAndFilters()
		assert.equal(updated.length, 2)
		assert.equal(updated[0]?.type, 'eth_newFilter')
		if (updated[0]?.type !== 'eth_newFilter') throw new Error('Filter was not preserved')
		assert.equal(updated[0].calledInlastBlock, blockNumber + 1n)
		assert.equal(updated[1]?.subscriptionOrFilterId, 'keep-me')
	})

	test('eth_getFilterChanges only returns newly simulated logs once', async () => {
		installBrowserMock()
		const { createNewFilter, getEthFilterChanges, getEthereumSubscriptionsAndFilters } = await loadModules()
		const ethereum = createEthereum()
		const socket = { tabId: 1, connectionName: 1n } as const
		const filterId = await createNewFilter({ method: 'eth_newFilter', params: [{}] }, socket, ethereum, undefined, PASSTHROUGH_STATE)
		const simulationState = await createExecutionSimulationState(ethereum, undefined, createSimulationInput(21_000n, 0n, 1n))
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')

		const firstChanges = await getEthFilterChanges(filterId, ethereum, undefined, toResolvedExecutionSimulationState(simulationState))
		const secondChanges = await getEthFilterChanges(filterId, ethereum, undefined, toResolvedExecutionSimulationState(simulationState))
		const storedFilters = await getEthereumSubscriptionsAndFilters()
		const storedFilter = storedFilters.find((filter) => filter.type === 'eth_newFilter' && filter.subscriptionOrFilterId === filterId)
		if (storedFilter === undefined || storedFilter.type !== 'eth_newFilter') throw new Error('stored filter missing')

		assert.equal(firstChanges?.length, 1)
		assert.equal(firstChanges?.[0]?.blockNumber, blockNumber + 1n)
		assert.deepEqual(secondChanges, [])
		assert.equal(storedFilter.calledInlastBlock, blockNumber + 1n)
	})

	test('newHeads emits each simulated execution block after a gas split', async () => {
		installBrowserMock()
		const { createEthereumSubscription, sendSubscriptionMessagesForNewBlock } = await loadModules()
		const ethereum = createEthereum()
		const socket = { tabId: 1, connectionName: 1n } as const
		const postedMessages: InterceptorMessageToInpage[] = []
		const port = {
			postMessage(message: unknown) {
				postedMessages.push(InterceptorMessageToInpage.parse(message))
			},
		} as unknown as browser.runtime.Port
		const websiteTabConnections = new Map([
			[
				1,
				{
					connections: {
						'1-0x1': {
							port,
							socket,
							websiteOrigin: 'test',
							approved: true,
							wantsToConnect: false,
						},
					},
				},
			],
		])
		await createEthereumSubscription({ method: 'eth_subscribe', params: ['newHeads'] }, socket)
		const splitSimulationInput = [
			{
				stateOverrides: {},
				transactions: [
					{
						signedTransaction: mockSignTransaction({
							...exampleTransaction,
							nonce: 0n,
							gas: 20_000_000n,
						}),
						website: {
							websiteOrigin: 'test',
							icon: undefined,
							title: undefined,
						},
						created: new Date(),
						originalRequestParameters: {
							method: 'eth_sendTransaction',
							params: [{}],
						},
						transactionIdentifier: 2n,
					},
					{
						signedTransaction: mockSignTransaction({
							...exampleTransaction,
							nonce: 1n,
							gas: 20_000_000n,
						}),
						website: {
							websiteOrigin: 'test',
							icon: undefined,
							title: undefined,
						},
						created: new Date(),
						originalRequestParameters: {
							method: 'eth_sendTransaction',
							params: [{}],
						},
						transactionIdentifier: 3n,
					},
				],
				signedMessages: [],
				blockTimeManipulation: {
					type: 'AddToTimestamp',
					deltaToAdd: 12n,
					deltaUnit: 'Seconds',
				},
				simulateWithZeroBaseFee: false,
			},
		] as const
		const simulationState = await createExecutionSimulationState(ethereum, undefined, splitSimulationInput)
		if (simulationState.success === false) throw new Error('simulation unexpectedly failed')

		await sendSubscriptionMessagesForNewBlock(blockNumber, ethereum, true, websiteTabConnections, async () => toResolvedExecutionSimulationState(simulationState))

		const emittedBlockNumbers = postedMessages.flatMap((message) => {
			if (message.type !== 'result' || !('method' in message) || message.method !== 'newHeads') return []
			if (!('result' in message) || !('result' in message.result)) throw new Error('wrong subscription payload')
			if (message.result.result === null) throw new Error('missing simulated block payload')
			return [message.result.result.number]
		})
		assert.equal(emittedBlockNumbers.length, 3)
		assert.deepEqual(emittedBlockNumbers, [blockNumber, blockNumber + 1n, blockNumber + 2n])
	})

	test('newHeads skips stale subscriptions without suppressing later live subscribers', async () => {
		installBrowserMock()
		const { createEthereumSubscription, sendSubscriptionMessagesForNewBlock, updateEthereumSubscriptionsAndFilters } = await loadModules()
		const ethereum = createEthereum()
		const liveSocket = { tabId: 2, connectionName: 2n } as const
		const postedMessages: InterceptorMessageToInpage[] = []
		const port = {
			postMessage(message: unknown) {
				postedMessages.push(InterceptorMessageToInpage.parse(message))
			},
		} as unknown as browser.runtime.Port
		const websiteTabConnections = new Map([
			[
				2,
				{
					connections: {
						'2-0x2': {
							port,
							socket: liveSocket,
							websiteOrigin: 'test',
							approved: true,
							wantsToConnect: false,
						},
					},
				},
			],
		])

		await updateEthereumSubscriptionsAndFilters(() => [])
		await createEthereumSubscription({ method: 'eth_subscribe', params: ['newHeads'] }, { tabId: 1, connectionName: 1n })
		await createEthereumSubscription({ method: 'eth_subscribe', params: ['newHeads'] }, liveSocket)

		await sendSubscriptionMessagesForNewBlock(blockNumber, ethereum, false, websiteTabConnections, async () => PASSTHROUGH_STATE)

		const emittedBlockNumbers = postedMessages.flatMap((message) => {
			if (message.type !== 'result' || !('method' in message) || message.method !== 'newHeads') return []
			if (!('result' in message) || !('result' in message.result)) throw new Error('wrong subscription payload')
			if (message.result.result === null) throw new Error('missing block payload')
			return [message.result.result.number]
		})

		assert.deepEqual(emittedBlockNumbers, [blockNumber])
	})

	test('newHeads reuses one simulated state computation across multiple live subscribers', async () => {
		installBrowserMock()
		const { createEthereumSubscription, sendSubscriptionMessagesForNewBlock } = await loadModules()
		const ethereum = createEthereum()
		const sockets = [{ tabId: 1, connectionName: 1n } as const, { tabId: 2, connectionName: 2n } as const]
		const postedMessages: InterceptorMessageToInpage[] = []
		const websiteTabConnections = new Map(
			sockets.map((socket) => [
				socket.tabId,
				{
					connections: {
						[`${socket.tabId}-0x${socket.connectionName.toString(16)}`]: {
							port: {
								postMessage(message: unknown) {
									postedMessages.push(InterceptorMessageToInpage.parse(message))
								},
							} as unknown as browser.runtime.Port,
							socket,
							websiteOrigin: 'test',
							approved: true,
							wantsToConnect: false,
						},
					},
				},
			]),
		)
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
