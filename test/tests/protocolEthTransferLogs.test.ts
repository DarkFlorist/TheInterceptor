import { describe, test } from 'bun:test'
import * as assert from 'assert'
import { JsonRpcResponse, type EthereumJsonRpcRequest } from '../../app/ts/types/JsonRpc-types.js'
import type { BlockCalls, EthSimulateV1CallResult, StateOverrides } from '../../app/ts/types/ethSimulate-types.js'
import { EthereumClientService } from '../../app/ts/simulation/services/EthereumClientService.js'
import { createSimulationState, mockSignTransaction } from '../../app/ts/simulation/services/SimulationModeEthereumClientService.js'
import { prepareSafeDelegateStateOverrides } from '../../app/ts/safe/safeSimulation.js'
import { decodeFunctionDataStrict, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { addressString, dataStringWith0xStart } from '../../app/ts/utils/bigint.js'
import { EIP7708_SYSTEM_ADDRESS, ETHEREUM_LOGS_LOGGER_ADDRESS, Multicall3ABI, TRANSFER_LOG } from '../../app/ts/utils/constants.js'
import { getCompoundGovernanceTimeLockMulticall } from '../../app/ts/utils/ethereumByteCodes.js'
import { eth_getBlockByNumber_goerli_8443561_true } from '../RPCResponses.js'

const SENDER = 0xd8da6bf26964af9d7eed9e03e53415d37aa96045n
const RECEIVER = 0xdeadn
const CONTRACT = 0x2222222222222222222222222222222222222222n
const GET_ETH_BALANCE_SELECTOR = '0x4d2301cc'
const SENDER_BALANCE_AFTER = 7n

const word = (value: bigint) => `0x${ value.toString(16).padStart(64, '0') }`
const parentBlock = (() => {
	const response = JsonRpcResponse.parse(JSON.parse(eth_getBlockByNumber_goerli_8443561_true))
	if ('error' in response) throw new Error('fixture block is an error response')
	return response.result
})()

// The log a Sepolia node returned for a 1 attoeth transfer, reduced to the fields the types read. Captured in eth_simulateV1 with traceTransfers enabled.
const createRpcLog = (overrides: { address?: bigint, topics?: readonly string[], data?: string } = {}) => ({
	address: addressString(overrides.address ?? EIP7708_SYSTEM_ADDRESS),
	topics: overrides.topics ?? [TRANSFER_LOG, word(SENDER), word(RECEIVER)],
	data: overrides.data ?? word(1n),
	blockHash: word(0xa3n),
	blockNumber: '0xb84397',
	logIndex: '0x0',
})
type RpcLog = ReturnType<typeof createRpcLog>

const createRpcBlock = (calls: readonly unknown[]) => ({
	number: '0xb84397',
	hash: word(0xa3n),
	timestamp: '0x6aeda970',
	gasLimit: '0x1c9c380',
	gasUsed: '0x5208',
	baseFeePerGas: '0x1',
	calls,
})
const createRpcCall = (logs: readonly RpcLog[]) => ({ status: '0x1', returnData: '0x', gasUsed: '0x5208', logs })

const createStubNode = (transactionLogs: readonly RpcLog[], systemAddressCode = '0x', tokenBalanceReturnData = '0x') => {
	const getCodeRequests: (readonly unknown[])[] = []
	const balanceTargets: bigint[] = []
	const handler = {
		rpcUrl: 'https://stub.invalid',
		clearCache: () => undefined,
		getChainId: async () => 11155111n,
		jsonRpcRequest: async (request: EthereumJsonRpcRequest) => {
			switch (request.method) {
				case 'eth_getBlockByNumber': return parentBlock
				case 'eth_getCode':
					getCodeRequests.push(request.params)
					return systemAddressCode
				case 'eth_simulateV1': {
					const calls = request.params[0].blockStateCalls.flatMap((block) => block.calls)
					const input = calls.at(-1)?.input
					if (input === undefined || !dataStringWith0xStart(input).startsWith('0x82ad56cb')) return [createRpcBlock(calls.map(() => createRpcCall(transactionLogs)))]
					const decoded = decodeFunctionDataStrict(Multicall3ABI, dataStringWith0xStart(input))
					if (decoded.functionName !== 'aggregate3') throw new Error('expected aggregate3')
					// Multicall3 answers getEthBalance itself. Any other query reaches the contract that wrote the log, which decides the reply.
					const replies = decoded.args[0].map((query) => {
						const isEthBalance = query.callData.startsWith(GET_ETH_BALANCE_SELECTOR)
						if (!isEthBalance) balanceTargets.push(BigInt(query.target))
						return { success: true, returnData: isEthBalance ? word(SENDER_BALANCE_AFTER) : tokenBalanceReturnData }
					})
					return [createRpcBlock([{ ...createRpcCall([]), returnData: encodeFunctionReturn(Multicall3ABI, 'aggregate3', [replies]) }])]
				}
				default: throw new Error(`Unexpected RPC method ${ request.method }`)
			}
		},
	}
	return { ethereum: new EthereumClientService(handler, async () => undefined, async () => undefined, { name: 'Sepolia', chainId: 11155111n, httpsRpc: handler.rpcUrl, currencyName: 'Sepolia ETH', currencyTicker: 'SEETH', primary: true, minimized: true }), getCodeRequests, balanceTargets }
}

const createInputBlock = (stateOverrides: StateOverrides = {}) => ({
	stateOverrides,
	transactions: [{
		signedTransaction: mockSignTransaction({ type: '1559', from: SENDER, nonce: 0n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gas: 21000n, to: RECEIVER, value: 1n, input: new Uint8Array(0), chainId: 11155111n }),
		website: { websiteOrigin: 'test', icon: undefined, title: undefined },
		created: new Date(),
		originalRequestParameters: { method: 'eth_sendTransaction' as const, params: [{}] as const },
		transactionIdentifier: 100n,
	}],
	signedMessages: [],
	blockTimeManipulation: { type: 'AddToTimestamp' as const, deltaToAdd: 12n, deltaUnit: 'Seconds' as const },
	simulateWithZeroBaseFee: false,
})

const getLogAddresses = (call: EthSimulateV1CallResult | undefined) => {
	if (call?.status !== 'success') throw new Error('expected a successful call')
	return call.logs.map((log) => log.address)
}
const simulateLogAddresses = async (node: ReturnType<typeof createStubNode>, stateOverrides: StateOverrides = {}) => {
	const { result } = await node.ethereum.simulatePrepared([createInputBlock(stateOverrides)], 8443561n, undefined)
	return getLogAddresses(result[0]?.calls[0])
}
const directSimulationCalls: readonly BlockCalls[] = [{ calls: [{ from: SENDER, to: RECEIVER, value: 1n }] }]

describe('protocol ETH transfer logs', () => {
	test('reads the EIP-7708 log as an ETH transfer and queries the ETH balance, not a token balance', async () => {
		const node = createStubNode([createRpcLog()])
		const state = await createSimulationState(node.ethereum, undefined, [createInputBlock()])
		if (state.success !== true) throw new Error('simulation failed')
		const transaction = state.simulatedBlocks[0]?.simulatedTransactions[0]
		assert.deepEqual(getLogAddresses(transaction?.ethSimulateV1CallResult), [ETHEREUM_LOGS_LOGGER_ADDRESS])
		assert.deepEqual(node.balanceTargets, [])
		assert.equal(transaction?.tokenBalancesAfter.find((balance) => balance.token === ETHEREUM_LOGS_LOGGER_ADDRESS && balance.owner === SENDER)?.balance, SENDER_BALANCE_AFTER)
	})

	const unusableBalanceReplies = [
		['an address without code', '0x'],
		['a contract returning more than one word', `${ word(1n) }00`],
	] as const
	for (const [name, tokenBalanceReturnData] of unusableBalanceReplies) {
		test(`${ name } has no balance instead of stopping the simulation`, async () => {
			const node = createStubNode([createRpcLog({ address: CONTRACT })], '0x', tokenBalanceReturnData)
			const state = await createSimulationState(node.ethereum, undefined, [createInputBlock()])
			if (state.success !== true) throw new Error('simulation failed')
			const balances = state.simulatedBlocks[0]?.simulatedTransactions[0]?.tokenBalancesAfter.filter((balance) => balance.token === CONTRACT)
			assert.equal(balances?.length, 2)
			assert.equal(balances?.every((balance) => balance.balance === undefined), true)
		})
	}

	test('a one word balance reply is still read', async () => {
		const node = createStubNode([createRpcLog({ address: CONTRACT })], '0x', word(5n))
		const state = await createSimulationState(node.ethereum, undefined, [createInputBlock()])
		if (state.success !== true) throw new Error('simulation failed')
		assert.equal(state.simulatedBlocks[0]?.simulatedTransactions[0]?.tokenBalancesAfter.find((balance) => balance.token === CONTRACT)?.balance, 5n)
	})

	test('reads the code at the block the simulation started from', async () => {
		const node = createStubNode([createRpcLog()])
		await simulateLogAddresses(node)
		assert.deepEqual(node.getCodeRequests, [[EIP7708_SYSTEM_ADDRESS, 8443561n]])
	})

	test('does not read code for a simulation without a candidate log', async () => {
		const node = createStubNode([createRpcLog({ address: CONTRACT })])
		assert.deepEqual(await simulateLogAddresses(node), [CONTRACT])
		assert.equal(node.getCodeRequests.length, 0)
	})

	describe('forgery', () => {
		test('a contract logging the same event from its own address is not an ETH transfer', async () => {
			assert.deepEqual(await simulateLogAddresses(createStubNode([createRpcLog({ address: CONTRACT })])), [CONTRACT])
		})

		test('a Safe delegate simulation of a website chosen verifyingContract places code there, so logs from it are not ETH transfers', async () => {
			const overrides = prepareSafeDelegateStateOverrides(EIP7708_SYSTEM_ADDRESS, new Uint8Array([0x60]))
			assert.deepEqual(await simulateLogAddresses(createStubNode([createRpcLog()]), overrides), [EIP7708_SYSTEM_ADDRESS])
		})

		test('a Compound timelock override does not let logs through the direct simulation path', async () => {
			const { ethereum } = createStubNode([createRpcLog()])
			const stateOverrides = { [addressString(EIP7708_SYSTEM_ADDRESS)]: { code: getCompoundGovernanceTimeLockMulticall() } }
			const result = await ethereum.ethSimulateV1([{ calls: [{ from: SENDER, to: EIP7708_SYSTEM_ADDRESS }], stateOverrides }], 8443561n, undefined)
			assert.deepEqual(getLogAddresses(result[0]?.calls[0]), [EIP7708_SYSTEM_ADDRESS])
		})

		test('an override in another block of the request taints every block, because code persists across simulated blocks', async () => {
			const node = createStubNode([createRpcLog()])
			const codeOverride = { [addressString(EIP7708_SYSTEM_ADDRESS)]: { code: new Uint8Array([0x60]) } }
			const { result } = await node.ethereum.simulatePrepared([createInputBlock(), createInputBlock(codeOverride)], 8443561n, undefined)
			assert.deepEqual(getLogAddresses(result[0]?.calls[0]), [EIP7708_SYSTEM_ADDRESS])
		})

		test('an override key in checksum casing is still the system address', async () => {
			const checksumCasedKey = '0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfE'
			assert.deepEqual(await simulateLogAddresses(createStubNode([createRpcLog()]), { [checksumCasedKey]: { code: new Uint8Array([0x60]) } }), [EIP7708_SYSTEM_ADDRESS])
		})

		test('code at the address on chain means a contract may have written the log', async () => {
			assert.deepEqual(await simulateLogAddresses(createStubNode([createRpcLog()], '0x60')), [EIP7708_SYSTEM_ADDRESS])
		})

		test('an override that gives the address no code leaves the node as the only author', async () => {
			const noCode = { [addressString(EIP7708_SYSTEM_ADDRESS)]: { balance: 1n, code: new Uint8Array() } }
			assert.deepEqual(await simulateLogAddresses(createStubNode([createRpcLog()]), noCode), [ETHEREUM_LOGS_LOGGER_ADDRESS])
		})
	})

	describe('log shape', () => {
		const addressTopics = [word(SENDER), word(RECEIVER)]
		const notTransfers = [
			['a different event signature', createRpcLog({ topics: [word(1n), ...addressTopics] })],
			['no recipient topic', createRpcLog({ topics: [TRANSFER_LOG, word(SENDER)] })],
			['an extra topic', createRpcLog({ topics: [TRANSFER_LOG, ...addressTopics, word(1n)] })],
			['no topics', createRpcLog({ topics: [] })],
			['an amount wider than one word', createRpcLog({ data: `${ word(1n) }${ word(1n).slice(2) }` })],
			['no amount', createRpcLog({ data: '0x' })],
		] as const
		for (const [name, log] of notTransfers) {
			test(`leaves a log with ${ name } alone`, async () => {
				assert.deepEqual(await simulateLogAddresses(createStubNode([log])), [EIP7708_SYSTEM_ADDRESS])
			})
		}

		test('keeps the logs around a transfer in order', async () => {
			const logs = [createRpcLog(), createRpcLog({ address: CONTRACT }), createRpcLog()]
			assert.deepEqual(await simulateLogAddresses(createStubNode(logs)), [ETHEREUM_LOGS_LOGGER_ADDRESS, CONTRACT, ETHEREUM_LOGS_LOGGER_ADDRESS])
		})
	})

	describe('entry points', () => {
		test('ethSimulateV1 recognises transfers for the direct governance path', async () => {
			const { ethereum } = createStubNode([createRpcLog()])
			const result = await ethereum.ethSimulateV1(directSimulationCalls, 8443561n, undefined)
			assert.deepEqual(getLogAddresses(result[0]?.calls[0]), [ETHEREUM_LOGS_LOGGER_ADDRESS])
		})

		test('simulate recognises transfers', async () => {
			const { ethereum } = createStubNode([createRpcLog()])
			const result = await ethereum.simulate([createInputBlock()], 8443561n, undefined)
			assert.deepEqual(getLogAddresses(result[0]?.calls[0]), [ETHEREUM_LOGS_LOGGER_ADDRESS])
		})

		test('a website asking for eth_simulateV1 gets the node reply unchanged', async () => {
			const node = createStubNode([createRpcLog()])
			const result = await node.ethereum.ethSimulateV1Request({ method: 'eth_simulateV1', params: [{ blockStateCalls: directSimulationCalls, traceTransfers: true }, 'latest'] }, undefined)
			assert.deepEqual(getLogAddresses(result[0]?.calls[0]), [EIP7708_SYSTEM_ADDRESS])
			assert.equal(node.getCodeRequests.length, 0)
		})
	})
})
