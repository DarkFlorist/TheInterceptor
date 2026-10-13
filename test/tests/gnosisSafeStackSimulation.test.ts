import * as assert from 'node:assert'
import { beforeEach, describe, test } from 'bun:test'
import type { IEthereumJSONRpcRequestHandler } from '../../app/ts/simulation/services/EthereumJSONRpcRequestHandler.js'
import type { SafeTx, VisualizedPersonalSignRequestSafeTx } from '../../app/ts/types/personal-message-definitions.js'
import type { RpcEntry } from '../../app/ts/types/rpc.js'
import type { InterceptorTransactionStack } from '../../app/ts/types/visualizer-types.js'
import { EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import { EthereumBlockHeader, EthereumQuantity } from '../../app/ts/types/wire-types.js'
import { addressString, stringifyJSONWithBigInts, stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { MULTICALL3, Multicall3ABI } from '../../app/ts/utils/constants.js'
import { encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { encodeAbiParameters } from '../../app/ts/utils/ethereumPrimitives.js'
import { createPerTestBrowserMockInstaller } from '../harness/perTest.js'

// Each test starts from empty extension storage.
const installBrowserMock = createPerTestBrowserMockInstaller()
beforeEach(() => { installBrowserMock() })

async function loadModules() {
	const simulationUpdating = await import('../../app/ts/background/simulationUpdating.js')
	const ethereumClientService = await import('../../app/ts/simulation/services/EthereumClientService.js')
	const simulationModeEthereumClientService = await import('../../app/ts/simulation/services/SimulationModeEthereumClientService.js')
	const priceEstimator = await import('../../app/ts/simulation/services/priceEstimator.js')
	const storageUtils = await import('../../app/ts/utils/storageUtils.js')
	const settings = await import('../../app/ts/background/settings.js')

	return {
		...simulationUpdating,
		EthereumClientService: ethereumClientService.EthereumClientService,
		TokenPriceService: priceEstimator.TokenPriceService,
		mockSignTransaction: simulationModeEthereumClientService.mockSignTransaction,
		browserStorageLocalSet: storageUtils.browserStorageLocalSet,
		defaultActiveAddresses: settings.defaultActiveAddresses,
	}
}

const modulesPromise = loadModules()
type TestModules = Awaited<ReturnType<typeof loadModules>>

function getDefaultTestAddresses(modules: TestModules) {
	const [activeAddress, stackRecipient] = modules.defaultActiveAddresses
	if (activeAddress === undefined || stackRecipient === undefined) throw new Error('missing default test addresses')
	return { activeAddress, stackRecipient }
}

const fakeRpcNetwork: RpcEntry = {
	name: 'Test Chain',
	chainId: 1337n,
	httpsRpc: 'https://example.invalid',
	currencyName: 'Ether',
	currencyTicker: 'ETH',
	currencyLogoUri: undefined,
	primary: true,
	minimized: true,
}

// The fake RPC inspects eth_simulateV1 payloads structurally, so it reads every request as a method name with untyped params.
type InspectedRpcRequest = { readonly method: string, readonly params?: readonly unknown[] }
const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value)

function createFakeRequestHandler(respond: (rpcRequest: InspectedRpcRequest) => Promise<unknown>): IEthereumJSONRpcRequestHandler {
	return {
		rpcUrl: fakeRpcNetwork.httpsRpc,
		clearCache() { return undefined },
		async getChainId() { return fakeRpcNetwork.chainId },
		jsonRpcRequest: respond,
	}
}

function makeFakeBlock(number: bigint) {
	return {
		author: 0n,
		difficulty: 0n,
		extraData: new Uint8Array(),
		gasLimit: 30_000_000n,
		gasUsed: 21_000n,
		hash: 0x1000n + number,
		logsBloom: 0n,
		miner: 0n,
		mixHash: 0n,
		nonce: 0n,
		number,
		parentHash: 0x1n,
		receiptsRoot: 0n,
		sha3Uncles: 0n,
		stateRoot: 0n,
		timestamp: new Date('2024-01-01T00:00:00.000Z'),
		size: 0n,
		totalDifficulty: 0n,
		uncles: [],
		baseFeePerGas: 1n,
		transactionsRoot: 0n,
		transactions: [],
		withdrawals: [],
		withdrawalsRoot: 0n,
	}
}

function makeEthSimulateBlocks(callCount: number, lastReturnData = new Uint8Array()) {
	return EthSimulateV1Result.serialize(Array.from({ length: callCount }, (_, index): EthSimulateV1Result[number] => ({
		number: 123n + BigInt(index),
		hash: 0x2000n + BigInt(index),
		timestamp: 0x65920080n + BigInt(index),
		gasLimit: 30_000_000n,
		gasUsed: 21_000n,
		baseFeePerGas: 1n,
		calls: [{
			status: 'success',
			returnData: index === callCount - 1 ? lastReturnData : new Uint8Array(),
			gasUsed: 21_000n,
			maxUsedGas: 21_000n,
			logs: [],
		}],
	})))
}

function createSafeMessage(fakeRpcNetwork: RpcEntry, activeAddress: TestModules['defaultActiveAddresses'][number], recipient: TestModules['defaultActiveAddresses'][number], operation: 0n | 1n = 0n) {
	const zeroAddressEntry = {
		address: 0n,
		name: '0x0 Address',
		type: 'contact',
		entrySource: 'Interceptor',
		chainId: fakeRpcNetwork.chainId,
	} as const

	const safeTxMessage: SafeTx = {
		types: {
			SafeTx: [
				{ name: 'to', type: 'address' },
				{ name: 'value', type: 'uint256' },
				{ name: 'data', type: 'bytes' },
				{ name: 'operation', type: 'uint8' },
				{ name: 'safeTxGas', type: 'uint256' },
				{ name: 'baseGas', type: 'uint256' },
				{ name: 'gasPrice', type: 'uint256' },
				{ name: 'gasToken', type: 'address' },
				{ name: 'refundReceiver', type: 'address' },
				{ name: 'nonce', type: 'uint256' },
			],
			EIP712Domain: [
				{ name: 'chainId', type: 'uint256' },
				{ name: 'verifyingContract', type: 'address' },
			],
		},
		primaryType: 'SafeTx',
		domain: {
			chainId: fakeRpcNetwork.chainId,
			verifyingContract: activeAddress.address,
		},
		message: {
			to: recipient.address,
			value: 0n,
			data: new Uint8Array(),
			operation,
			safeTxGas: 0n,
			baseGas: 0n,
			gasPrice: 0n,
			gasToken: 0n,
			refundReceiver: 0n,
			nonce: 0n,
		},
	}

	const safeMessage: VisualizedPersonalSignRequestSafeTx = {
		activeAddress,
		rpcNetwork: fakeRpcNetwork,
		simulationMode: true,
		signerName: 'NoSigner',
		quarantineReasons: [],
		quarantine: false,
		account: activeAddress,
		website: { websiteOrigin: 'https://safe.example', icon: undefined, title: undefined },
		created: new Date('2024-01-01T00:00:01.000Z'),
		rawMessage: stringifyJSONWithBigInts(safeTxMessage),
		stringifiedMessage: stringifyJSONWithBigInts(safeTxMessage),
		messageIdentifier: 2n,
		method: 'eth_signTypedData_v4',
		type: 'SafeTx',
		message: safeTxMessage,
		parsedMessageDataAddressBookEntries: [],
		parsedMessageData: { type: 'NonParsed', input: new Uint8Array() },
		gasToken: zeroAddressEntry,
		to: recipient,
		refundReceiver: zeroAddressEntry,
		verifyingContract: activeAddress,
		messageHash: '0x1',
		domainHash: '0x2',
		safeTxHash: '0x3',
	}

	return safeMessage
}

describe('Gnosis Safe stack simulation', () => {
	test('governance execution token balances are queried on top of stack plus execution transaction', async () => {
		const modules = await modulesPromise
		const { activeAddress, stackRecipient } = getDefaultTestAddresses(modules)

		const fakeBlock = makeFakeBlock(123n)
		let aggregate3BlockStateCallCount: number | undefined
		const fakeRequestHandler = createFakeRequestHandler(async (rpcRequest) => {
			switch (rpcRequest.method) {
				case 'eth_getBlockByNumber':
					return EthereumBlockHeader.serialize(fakeBlock)
				case 'eth_blockNumber':
					return EthereumQuantity.serialize(fakeBlock.number)
				case 'eth_simulateV1': {
					const firstParam = rpcRequest.params?.[0]
					if (typeof firstParam !== 'object' || firstParam === null || !('blockStateCalls' in firstParam) || !isUnknownArray(firstParam.blockStateCalls)) {
						throw new Error('Missing blockStateCalls in eth_simulateV1 request')
					}
					const callCount = firstParam.blockStateCalls.length
					const lastBlock = firstParam.blockStateCalls[callCount - 1]
					if (typeof lastBlock !== 'object' || lastBlock === null || !('calls' in lastBlock) || !isUnknownArray(lastBlock.calls)) {
						throw new Error('Missing calls in eth_simulateV1 block')
					}
					const lastCall = lastBlock.calls[lastBlock.calls.length - 1]
					const isAggregate3BalanceCall = typeof lastCall === 'object'
						&& lastCall !== null
						&& 'to' in lastCall
						&& lastCall.to === MULTICALL3
					if (!isAggregate3BalanceCall) throw new Error(`Unexpected eth_simulateV1 payload with ${ String(callCount) } blockStateCalls`)
					aggregate3BlockStateCallCount = callCount

					const aggregate3ReturnData = encodeFunctionReturn(Multicall3ABI, 'aggregate3', [[{
						success: true,
						returnData: encodeAbiParameters([{ type: 'uint256' }], [0n]),
					}]])
					return makeEthSimulateBlocks(callCount, stringToUint8Array(aggregate3ReturnData))
				}
				default:
					throw new Error(`Unexpected RPC method: ${ rpcRequest.method }`)
			}
		})

		const ethereum = new modules.EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
		const currentStackTransaction = modules.mockSignTransaction({
			type: '1559',
			from: activeAddress.address,
			chainId: fakeRpcNetwork.chainId,
			nonce: 0n,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
			gas: 21_000n,
			to: stackRecipient.address,
			value: 0n,
			input: new Uint8Array(),
			accessList: [],
		})

		await modules.browserStorageLocalSet({
			simulationMode: true,
			independentActiveSimulationAddress: activeAddress.address,
			activeRpcNetwork: fakeRpcNetwork,
			interceptorTransactionStack: {
				operations: [{
					type: 'Transaction',
					preSimulationTransaction: {
						signedTransaction: currentStackTransaction,
						website: { websiteOrigin: 'https://stack.example', icon: undefined, title: undefined },
						created: new Date('2024-01-01T00:00:00.000Z'),
						originalRequestParameters: { method: 'eth_sendTransaction', params: [{}] },
						transactionIdentifier: 1n,
					},
				}],
			},
		})

		const simulationInput = await modules.getCurrentSimulationInput()
		const executionTimestamp = new Date('2024-01-02T00:00:00.000Z')
		const executionStateOverrides = {
			'0x0000000000000000000000000000000000000001': { code: new Uint8Array([1, 2, 3]) },
		}
		const executionTransaction = {
			signedTransaction: modules.mockSignTransaction({
				type: '1559',
				from: activeAddress.address,
				chainId: fakeRpcNetwork.chainId,
				nonce: 1n,
				maxFeePerGas: 1n,
				maxPriorityFeePerGas: 1n,
				gas: 50_000n,
				to: stackRecipient.address,
				value: 0n,
				input: new Uint8Array(),
				accessList: [],
			}),
			website: { websiteOrigin: 'https://governance.example', icon: undefined, title: undefined },
			created: new Date('2024-01-01T00:00:01.000Z'),
			originalRequestParameters: { method: 'eth_sendTransaction', params: [{}] },
			transactionIdentifier: 2n,
		} as const

		const governanceExecutionSimulationInput = modules.getGovernanceExecutionSimulationInput(
			simulationInput,
			executionTransaction,
			executionTimestamp,
			executionStateOverrides,
		)

		const tokenBalancesAfter = await modules.getGovernanceExecutionTokenBalancesAfter(
			ethereum,
			simulationInput,
			executionTransaction,
			executionTimestamp,
			executionStateOverrides,
			{ status: 'success', returnData: new Uint8Array(), gasUsed: 21_000n, logs: [] },
		)

		assert.equal(governanceExecutionSimulationInput.length, 2)
		assert.deepStrictEqual(governanceExecutionSimulationInput[1]?.stateOverrides, executionStateOverrides)
		assert.deepStrictEqual(governanceExecutionSimulationInput[1]?.blockTimeManipulation, { type: 'SetTimetamp', timeToSet: 1704153600n })
		assert.equal(aggregate3BlockStateCallCount, 3)
		assert.equal(tokenBalancesAfter.length, 1)
		assert.equal(tokenBalancesAfter[0]?.owner, activeAddress.address)
	})

	const safeSimulationCases = [
		{ name: 'simulates a normal Safe call on top of the existing stack without temporary overrides', operation: 0n, seedStack: true },
		{ name: 'applies Safe delegatecall overrides during estimation and final simulation on top of the existing stack', operation: 1n, seedStack: true },
		{ name: 'applies Safe delegatecall overrides during estimation and final simulation with an empty stack', operation: 1n, seedStack: false },
	] as const

	for (const { name, operation, seedStack } of safeSimulationCases) test(name, async () => {
		const modules = await modulesPromise
		const { activeAddress, stackRecipient } = getDefaultTestAddresses(modules)

		const fakeBlock = makeFakeBlock(123n)
		let gasEstimationCount = 0
		let delegateCallSimulationCount = 0
		const fakeRequestHandler = createFakeRequestHandler(async (rpcRequest) => {
			switch (rpcRequest.method) {
				case 'eth_getBlockByNumber':
					return EthereumBlockHeader.serialize(fakeBlock)
				case 'eth_getTransactionCount':
					return EthereumQuantity.serialize(0n)
				case 'eth_getBalance':
					return EthereumQuantity.serialize(0n)
				case 'eth_getCode':
					return '0x6000'
				case 'eth_gasPrice':
					return EthereumQuantity.serialize(1n)
				case 'eth_blockNumber':
					return EthereumQuantity.serialize(fakeBlock.number)
				case 'eth_simulateV1': {
					const firstParam = rpcRequest.params?.[0]
					if (typeof firstParam !== 'object' || firstParam === null || !('blockStateCalls' in firstParam) || !isUnknownArray(firstParam.blockStateCalls)) {
						throw new Error('Missing blockStateCalls in eth_simulateV1 request')
					}
					const callCount = firstParam.blockStateCalls.length
					if (callCount !== 1 && callCount !== 2 && callCount !== 3) throw new Error(`Unexpected call count: ${ String(callCount) }`)
					const lastBlock = firstParam.blockStateCalls[callCount - 1]
					if (typeof lastBlock !== 'object' || lastBlock === null || !('calls' in lastBlock) || !isUnknownArray(lastBlock.calls)) {
						throw new Error('Missing calls in eth_simulateV1 block')
					}
					const lastCall = lastBlock.calls[lastBlock.calls.length - 1]
					const stateOverrides = 'stateOverrides' in lastBlock ? lastBlock.stateOverrides : undefined
					const hasSafeDelegateCallTarget = typeof lastCall === 'object'
						&& lastCall !== null
						&& 'to' in lastCall
						&& lastCall.to === activeAddress.address
					if (hasSafeDelegateCallTarget) {
						delegateCallSimulationCount += 1
						if (typeof stateOverrides !== 'object' || stateOverrides === null) throw new Error('Missing Safe state overrides during delegatecall simulation')
						const stateOverrideEntries: [string, unknown][] = Object.entries(stateOverrides)
						const safeOverride = stateOverrideEntries.find(([address]) => address === addressString(activeAddress.address))?.[1]
						if (typeof safeOverride !== 'object' || safeOverride === null || !('code' in safeOverride) || !(safeOverride.code instanceof Uint8Array) || safeOverride.code.length === 0) {
							throw new Error('Missing Safe wrapper code during delegatecall simulation')
						}
						const relocatedSafeOverride = stateOverrideEntries.find(([address]) => address === '0x0000000000000000000000000000000000920515')?.[1]
						if (typeof relocatedSafeOverride !== 'object' || relocatedSafeOverride === null || !('code' in relocatedSafeOverride) || !(relocatedSafeOverride.code instanceof Uint8Array) || relocatedSafeOverride.code.length === 0) {
							throw new Error('Missing relocated Safe code during delegatecall simulation')
						}
					}
					const blockOverrides = 'blockOverrides' in lastBlock ? lastBlock.blockOverrides : undefined
					const isGasEstimation = typeof lastCall === 'object'
						&& lastCall !== null
						&& 'to' in lastCall
						&& lastCall.to === (operation === 1n ? activeAddress.address : stackRecipient.address)
						&& typeof blockOverrides === 'object'
						&& blockOverrides !== null
						&& 'baseFeePerGas' in blockOverrides
						&& blockOverrides.baseFeePerGas === 0n
					if (isGasEstimation) {
						gasEstimationCount += 1
						if (operation === 0n && typeof stateOverrides === 'object' && stateOverrides !== null && Object.keys(stateOverrides).length !== 0) {
							throw new Error('Normal Safe call gas estimation received unexpected state overrides')
						}
					}
					const isGetCodeCall = typeof lastCall === 'object'
						&& lastCall !== null
						&& 'to' in lastCall
						&& lastCall.to === 0x1ce438391307f908756fefe0fe220c0f0d51508an
					if (isGetCodeCall) {
						return makeEthSimulateBlocks(callCount, stringToUint8Array(encodeAbiParameters([{ type: 'bytes' }], ['0x6000'])))
					}
					const isAggregate3BalanceCall = typeof lastCall === 'object'
						&& lastCall !== null
						&& 'to' in lastCall
						&& lastCall.to === MULTICALL3
					if (!isAggregate3BalanceCall) return makeEthSimulateBlocks(callCount)

					const aggregate3ReturnData = encodeFunctionReturn(Multicall3ABI, 'aggregate3', [[{
						success: true,
						returnData: encodeAbiParameters([{ type: 'uint256' }], [0n]),
					}]])
					return makeEthSimulateBlocks(callCount, stringToUint8Array(aggregate3ReturnData))
				}
				default:
					throw new Error(`Unexpected RPC method: ${ rpcRequest.method }`)
			}
		})

		const ethereum = new modules.EthereumClientService(fakeRequestHandler, async () => undefined, async () => undefined, fakeRpcNetwork)
		const tokenPriceService = new modules.TokenPriceService(ethereum, 0)

		const currentStackTransaction = modules.mockSignTransaction({
			type: '1559',
			from: activeAddress.address,
			chainId: fakeRpcNetwork.chainId,
			nonce: 0n,
			maxFeePerGas: 1n,
			maxPriorityFeePerGas: 1n,
			gas: 21_000n,
			to: stackRecipient.address,
			value: 0n,
			input: new Uint8Array(),
			accessList: [],
		})

		const stackOperations: InterceptorTransactionStack['operations'] = seedStack ? [{
			type: 'Transaction',
			preSimulationTransaction: {
				signedTransaction: currentStackTransaction,
				website: { websiteOrigin: 'https://stack.example', icon: undefined, title: undefined },
				created: new Date('2024-01-01T00:00:00.000Z'),
				originalRequestParameters: { method: 'eth_sendTransaction', params: [{}] },
				transactionIdentifier: 1n,
			},
		}] : []
		await modules.browserStorageLocalSet({
			simulationMode: true,
			independentActiveSimulationAddress: activeAddress.address,
			activeRpcNetwork: fakeRpcNetwork,
			interceptorTransactionStack: {
				operations: stackOperations,
			},
		})

		const safeMessage = createSafeMessage(fakeRpcNetwork, activeAddress, stackRecipient, operation)
		const simulationInput = await modules.getCurrentSimulationInput()
		assert.equal(simulationInput.length, seedStack ? 1 : 0)
		assert.equal(simulationInput[0]?.transactions.length, seedStack ? 1 : undefined)

		const reply = await modules.simulateGnosisSafeMetaTransaction(safeMessage, simulationInput, ethereum, tokenPriceService)
		assert.equal(reply.success, true)
		if (!reply.success) throw new Error(reply.errorMessage)

		assert.equal(reply.result.simulationState.rpcNetwork.chainId, fakeRpcNetwork.chainId)
		assert.equal(reply.result.simulationState.simulationStateInput.length, seedStack ? 2 : 1)
		assert.equal(reply.result.simulationState.simulationStateInput[0]?.transactions.length, 1)
		assert.equal(reply.result.simulationState.simulationStateInput[1]?.transactions.length, seedStack ? 1 : undefined)
		const safeSimulationBlock = reply.result.simulationState.simulationStateInput[seedStack ? 1 : 0]
		assert.equal(Object.keys(safeSimulationBlock?.stateOverrides ?? {}).length, operation === 1n ? 2 : 0)
		if (seedStack) assert.equal(Object.keys(reply.result.simulationState.simulationStateInput[0]?.stateOverrides ?? {}).length, 0)
		assert.equal(reply.result.visualizedSimulationState.success, true)
		if (!reply.result.visualizedSimulationState.success) throw new Error('unexpected Safe visualization failure')
		assert.equal(reply.result.visualizedSimulationState.visualizedBlocks.length, seedStack ? 2 : 1)
		assert.equal(reply.result.visualizedSimulationState.visualizedBlocks[0]?.simulatedAndVisualizedTransactions.length, 1)
		assert.equal(reply.result.visualizedSimulationState.visualizedBlocks[1]?.simulatedAndVisualizedTransactions.length, seedStack ? 1 : undefined)
		assert.equal(gasEstimationCount, 1)
		assert.equal(delegateCallSimulationCount, operation === 1n ? 2 : 0)
	})
})
