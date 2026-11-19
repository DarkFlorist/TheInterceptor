import type { EthereumClientService } from './services/EthereumClientService.js'
import type { BlockCalls, BlockOverrides } from '../types/ethSimulate-types.js'
import { EthereumData, type EthereumBlockHeader } from '../types/wire-types.js'
import { addressString, stringToUint8Array } from '../utils/bigint.js'
import { decodeFunctionOutput, encodeFunctionCall } from '../utils/abiRuntime.js'
import type { Abi } from '../utils/ethereumPrimitives.js'
import { getCodeByteCode } from '../utils/ethereumByteCodes.js'
import { MOCK_ADDRESS } from '../utils/constants.js'
import { JsonRpcResponseError } from '../utils/errors.js'
import { getNextBlockTimeStampOverride } from './services/EthereumClientService.js'
import { getSimulatedBlockBaseFeePerGas } from './services/simulationBlockParameters.js'
import { DEFAULT_BLOCK_MANIPULATION } from '../config/defaults.js'

export type SimulatedCodeResult = { readonly statusCode: 'success', readonly getCodeReturn: Uint8Array } | { readonly statusCode: 'failure', readonly getCodeReturn?: undefined }
const GET_CODE_CONTRACT = 0x1ce438391307f908756fefe0fe220c0f0d51508an
const getCodeAbi = [{ type: 'function', name: 'at', stateMutability: 'view', inputs: [{ name: 'target', type: 'address' }], outputs: [{ name: 'code', type: 'bytes' }] }] as const satisfies Abi

// This module can submit already-prepared RPC blocks, but has no nonce-calculation or simulated-call capability. Its synthetic sender nonce is seeded only in the appended probe block.
export const probeSimulatedCode = async (client: Pick<EthereumClientService, 'ethSimulateV1' | 'getChainId'>, requestAbortController: AbortController | undefined, prefix: readonly BlockCalls[], parentBlock: NonNullable<EthereumBlockHeader>, previousBlockOverride: BlockOverrides | undefined, address: bigint): Promise<SimulatedCodeResult> => {
	const probeBlock: BlockCalls = {
		calls: [{ type: '1559', from: MOCK_ADDRESS, nonce: 0n, chainId: client.getChainId(), maxPriorityFeePerGas: 0n, to: GET_CODE_CONTRACT, value: 0n, input: stringToUint8Array(encodeFunctionCall(getCodeAbi, 'at', [addressString(address)])), accessList: [] }],
		blockOverrides: { ...(previousBlockOverride ?? { feeRecipient: parentBlock.miner }), baseFeePerGas: getSimulatedBlockBaseFeePerGas(parentBlock), time: getNextBlockTimeStampOverride(previousBlockOverride?.time ?? parentBlock.timestamp, DEFAULT_BLOCK_MANIPULATION) },
		stateOverrides: { [addressString(GET_CODE_CONTRACT)]: { code: getCodeByteCode() }, [addressString(MOCK_ADDRESS)]: { nonce: 0n } },
	}
	try {
		const blocks = await client.ethSimulateV1([...prefix, probeBlock], parentBlock.number, requestAbortController)
		const result = blocks[blocks.length - 1]?.calls[0]
		if (result === undefined) throw new Error('Missing simulated code probe result')
		if (result.status === 'failure') return { statusCode: 'failure' }
		return { statusCode: 'success', getCodeReturn: EthereumData.parse(decodeFunctionOutput(getCodeAbi, 'at', result.returnData)) }
	} catch (error: unknown) {
		if (error instanceof JsonRpcResponseError) return { statusCode: 'failure' }
		throw error
	}
}
