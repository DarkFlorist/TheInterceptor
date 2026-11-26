// Shared Ethereum simulation RPC with configured Gnosis Safe state for wallet, co-signing and native-host scenarios.
import type { Hex } from '../../app/ts/utils/ethereumPrimitives.js'
import { MULTICALL3, Multicall3ABI } from '../../app/ts/utils/constants.js'
import { GNOSIS_SAFE_ABI } from '../../app/ts/gnosisSafe/gnosisSafeCore.js'
import { EthSimulateV1Result } from '../../app/ts/types/ethSimulate-types.js'
import { EthereumBlockHeader, EthereumQuantity, serialize } from '../../app/ts/types/wire-types.js'
import { decodeFunctionDataStrict, encodeFunctionCall, encodeFunctionReturn } from '../../app/ts/utils/abiRuntime.js'
import { addressString, bytes32String, dataStringWith0xStart, stringToUint8Array } from '../../app/ts/utils/bigint.js'
import { encodeStorageReaderCall, STORAGE_READER_ABI } from '../../app/ts/simulation/storageReader.js'

export type JsonRpcRequest = {
	readonly id: number
	readonly method: string
	readonly params?: readonly unknown[]
}

export function createBrowserSimulationRpc({ safeAddress, singletonAddress, ownerAddress, extraCallResults = [] }: { readonly safeAddress: bigint, readonly singletonAddress: bigint, readonly ownerAddress: bigint, readonly extraCallResults?: readonly (readonly [string, Hex])[] }) {
	const GET_CODE_CONTRACT = 0x1ce438391307f908756fefe0fe220c0f0d51508an
	const GET_CODE_ABI = [{
		type: 'function',
		name: 'at',
		stateMutability: 'view',
		inputs: [{ name: 'target', type: 'address' }],
		outputs: [{ name: 'code', type: 'bytes' }],
	}] as const
	const STORAGE_READER_CALL = dataStringWith0xStart(encodeStorageReaderCall(0n))
	const STORAGE_READER_RESULT = encodeFunctionReturn(STORAGE_READER_ABI, 'readSlot', [bytes32String(singletonAddress)])

	function makeFakeBlock() {
		return {
			author: 0n,
			difficulty: 0n,
			extraData: new Uint8Array(),
			gasLimit: 30_000_000n,
			gasUsed: 21_000n,
			hash: 0x1234n,
			logsBloom: 0n,
			miner: 0n,
			mixHash: 0n,
			nonce: 0n,
			number: 123n,
			parentHash: 0x1n,
			receiptsRoot: 0n,
			sha3Uncles: 0n,
			stateRoot: 0n,
			timestamp: new Date('2026-07-28T00:00:00.000Z'),
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

	function makeFakeEthSimulateResult(calls: readonly unknown[]) {
		const balanceResult = encodeFunctionReturn(Multicall3ABI, 'getEthBalance', [0n])
		const aggregate3Result = encodeFunctionReturn(Multicall3ABI, 'aggregate3', [[{ success: true, returnData: balanceResult }]])
		return {
			number: 123n,
			hash: 0x9876n,
			timestamp: 0x65920080n,
			gasLimit: 30_000_000n,
			gasUsed: 21_000n,
			baseFeePerGas: 1n,
			calls: calls.map((call) => {
				const input = isRecord(call) && typeof call.input === 'string' ? call.input : undefined
				const to = isRecord(call) && typeof call.to === 'string' ? call.to : undefined
				const safeResult = to !== undefined && BigInt(to) === GET_CODE_CONTRACT
					? encodeFunctionReturn(GET_CODE_ABI, 'at', ['0x01'])
					: input === STORAGE_READER_CALL && to !== undefined && BigInt(to) === safeAddress
					? STORAGE_READER_RESULT
					: input !== undefined && to !== undefined && BigInt(to) === safeAddress
					? safeCallResults.get(input)
					: undefined
				let metadataBatchResult: string | undefined
				if (input !== undefined && to !== undefined && BigInt(to) === MULTICALL3) {
					const decoded = decodeFunctionDataStrict(Multicall3ABI, stringToUint8Array(input))
					const metadataCalls = decoded.args[0]
					if (decoded.functionName === 'aggregate3' && Array.isArray(metadataCalls)) {
						const results = metadataCalls.map((entry: unknown) => {
							if (!isRecord(entry) || typeof entry.target !== 'string' || BigInt(entry.target) !== safeAddress || typeof entry.callData !== 'string') return undefined
							const returnData = safeCallResults.get(entry.callData)
							return returnData === undefined ? undefined : { success: true, returnData }
						})
						if (results.every((result) => result !== undefined)) metadataBatchResult = encodeFunctionReturn(Multicall3ABI, 'aggregate3', [results])
					}
				}
				return { status: 'success' as const, gasUsed: 21_000n, logs: [], returnData: stringToUint8Array(safeResult ?? metadataBatchResult ?? aggregate3Result) }
			}),
		}
	}

	const safeStateReadCalls = [
		encodeFunctionCall(GNOSIS_SAFE_ABI, 'VERSION', []),
		encodeFunctionCall(GNOSIS_SAFE_ABI, 'nonce', []),
		encodeFunctionCall(GNOSIS_SAFE_ABI, 'getOwners', []),
		encodeFunctionCall(GNOSIS_SAFE_ABI, 'getThreshold', []),
	] as const
	const safeCallResults = new Map<string, Hex>([
		[safeStateReadCalls[0], encodeFunctionReturn(GNOSIS_SAFE_ABI, 'VERSION', ['1.4.1'])],
		[safeStateReadCalls[1], encodeFunctionReturn(GNOSIS_SAFE_ABI, 'nonce', [7n])],
		[safeStateReadCalls[2], encodeFunctionReturn(GNOSIS_SAFE_ABI, 'getOwners', [[addressString(ownerAddress)]])],
		[safeStateReadCalls[3], encodeFunctionReturn(GNOSIS_SAFE_ABI, 'getThreshold', [2n])],
		...extraCallResults,
	])

	function isRecord(value: unknown): value is { readonly input?: unknown, readonly to?: unknown, readonly target?: unknown, readonly callData?: unknown, readonly data?: unknown, readonly blockStateCalls?: unknown, readonly calls?: unknown } {
		return typeof value === 'object' && value !== null && !Array.isArray(value)
	}

	async function handleRpcRequest(request: JsonRpcRequest) {
		switch (request.method) {
			case 'eth_chainId': return '0x1'
			case 'eth_estimateGas': return '0x5208'
			case 'eth_feeHistory': return { oldestBlock: '0x7b', baseFeePerGas: ['0x1', '0x1'], gasUsedRatio: [0.5], reward: [['0x1']] }
			case 'eth_blockNumber': return serialize(EthereumQuantity, 123n)
			case 'eth_getBlockByNumber': return EthereumBlockHeader.serialize(makeFakeBlock())
			case 'eth_getTransactionCount':
			case 'eth_getBalance':
			case 'eth_gasPrice':
			case 'eth_maxPriorityFeePerGas': return serialize(EthereumQuantity, 0n)
			case 'eth_getCode': {
				const [address] = request.params ?? []
				const hasTestCode = typeof address === 'string' && (BigInt(address) === safeAddress || BigInt(address) === singletonAddress || BigInt(address) === MULTICALL3)
				return hasTestCode ? '0x01' : '0x'
			}
			case 'eth_getStorageAt': {
				const [address, slot] = request.params ?? []
				if (typeof address !== 'string' || BigInt(address) !== safeAddress || typeof slot !== 'string' || BigInt(slot) !== 0n) throw new Error('Unexpected Gnosis Safe singleton storage request')
				return bytes32String(singletonAddress)
			}
			case 'eth_call': {
				const [call] = request.params ?? []
				if (!isRecord(call) || typeof call.data !== 'string') throw new Error('Malformed eth_call')
				return safeCallResults.get(call.data) ?? '0x'
			}
			case 'eth_getLogs': return []
			case 'eth_simulateV1': {
				const [payload] = request.params ?? []
				const blockStateCalls = isRecord(payload) && Array.isArray(payload.blockStateCalls) ? payload.blockStateCalls : []
				return EthSimulateV1Result.serialize(blockStateCalls.map((blockStateCall) =>
					makeFakeEthSimulateResult(isRecord(blockStateCall) && Array.isArray(blockStateCall.calls) ? blockStateCall.calls : [])
				))
			}
			default: throw new Error(`Unsupported test RPC method: ${ request.method }`)
		}
	}

		return { handleRpcRequest, safeStateReadCalls, safeCallResults }
}
