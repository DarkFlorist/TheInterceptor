import type { EthereumClientService } from '../simulation/services/EthereumClientService.js'
import { simulatedCallFromInput } from '../simulation/services/SimulationModeEthereumClientService.js'
import { getGnosisSafeContractStateAtBlock, createGnosisSafeContractValidationFailure, type GnosisSafeContractState } from './gnosisSafeCore.js'
import { toResolvedSimulationInput, type SimulationStateInput } from '../types/visualizer-types.js'
import { addressString, dataStringWith0xStart, stringToUint8Array, stringifyJSONWithBigInts } from '../utils/bigint.js'
import { decodeFunctionOutput, encodeFunctionCall } from '../utils/abiRuntime.js'
import { MULTICALL3, Multicall3ABI } from '../utils/constants.js'

type PrepareSimulationInput = (input: SimulationStateInput, ethereum: EthereumClientService) => Promise<SimulationStateInput>

// Batch the metadata getters into one call on the prepared prefix. Independent simulated reads repeat execution preparation and the stored Gnosis Safe operations.
async function readGnosisSafeAppsSimulationContractState(ethereum: EthereumClientService, safeAddress: bigint, rawInput: SimulationStateInput, prepareInput: PrepareSimulationInput) {
	const input = toResolvedSimulationInput(await prepareInput(rawInput, ethereum))
	const parentBlock = await ethereum.getBlockNumber(undefined)
	const read = async (to: bigint, calldata: `0x${ string }`): Promise<Uint8Array> => {
		const response = await simulatedCallFromInput(ethereum, undefined, input, { to, input: stringToUint8Array(calldata), maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, value: 0n }, 'latest', parentBlock)
		// The simulation helper returns either bytes or an RPC error; keep the failure branch explicit at this domain boundary.
		if (response.error !== undefined) throw createGnosisSafeContractValidationFailure(response.error.message)
		return response.result
	}
	const multicallDeployed = (await ethereum.getCode(MULTICALL3, parentBlock, undefined)).length > 0
	return await getGnosisSafeContractStateAtBlock(ethereum, safeAddress, parentBlock, async (calldata) => {
		// Custom networks without Multicall3 keep the original direct-read path; failed/malformed batch calls never become fallback data.
		if (!multicallDeployed) return await Promise.all(calldata.map((data) => read(safeAddress, data)))
		const aggregate = encodeFunctionCall(Multicall3ABI, 'aggregate3', [calldata.map((callData) => ({ target: addressString(safeAddress), allowFailure: true, callData }))])
		const results = decodeFunctionOutput(Multicall3ABI, 'aggregate3', dataStringWith0xStart(await read(MULTICALL3, aggregate)))
		if (results.some((result) => !result.success)) throw createGnosisSafeContractValidationFailure('A Gnosis Safe metadata read reverted.')
		return results.map((result) => stringToUint8Array(result.returnData))
	})
}


type MetadataSnapshot = { readonly key: string, readonly prepareInput: PrepareSimulationInput, readonly result: Promise<GnosisSafeContractState> }

// Each installed service snapshot owns this reader and its cache. Explicit input includes execution options and the preparation policy participates in cache identity; permission admission still runs on every SDK request and signing validation never uses these discovery snapshots.
export function createGnosisSafeAppsSimulationMetadataReader(ethereum: EthereumClientService) {
	let cached: MetadataSnapshot | undefined
	return {
		getContractState: async (safeAddress: bigint, input: SimulationStateInput, prepareInput: PrepareSimulationInput) => {
			const parent = await ethereum.getBlock(undefined)
			if (parent === null) throw new Error('The latest block is unavailable for Gnosis Safe discovery.')
			const key = stringifyJSONWithBigInts([safeAddress, parent.hash, input])
			if (cached?.key === key && cached.prepareInput === prepareInput) return await cached.result
			const snapshot: MetadataSnapshot = { key, prepareInput, result: readGnosisSafeAppsSimulationContractState(ethereum, safeAddress, input, prepareInput).then(async (state) => {
				// Preparation may cross a real block boundary. Do not retain that result under the earlier block's key.
				const latest = await ethereum.getBlock(undefined)
				if (latest?.hash !== parent.hash && cached === snapshot) cached = undefined
				return state
			}).catch((error: unknown) => {
				if (cached === snapshot) cached = undefined
				throw error
			}) }
			cached = snapshot
			return await snapshot.result
		},
	}
}

export type GnosisSafeAppsSimulationMetadataReader = ReturnType<typeof createGnosisSafeAppsSimulationMetadataReader>
