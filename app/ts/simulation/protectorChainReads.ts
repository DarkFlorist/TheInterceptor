import { createInterceptorInternalError, getInterceptorInternalErrorCode } from '../utils/caughtErrors.js'
import type { EthereumAddress } from '../types/wire-types.js'
import { type RecordedProtectorChainReads, type SimulationState, toResolvedSimulationState } from '../types/visualizer-types.js'
import type { EthereumClientService } from './services/EthereumClientService.js'
import { getSimulatedCode } from './services/SimulationModeEthereumClientService.js'

import type { ProtectorChainReads } from './protectorTypes.js'

type AddressCode = RecordedProtectorChainReads['addressCode'][number]['code']

type ProtectorChainReadsWithRecord = {
	readonly chainReads: ProtectorChainReads
	// The reads made so far, to store with the run.
	readonly getRecord: () => RecordedProtectorChainReads
}

// A simulation run reads from the transaction's simulated state and the node, and records every read with the run.
export function readAndRecordProtectorChainReads(ethereum: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState): ProtectorChainReadsWithRecord {
	const addressCode: { address: EthereumAddress, code: AddressCode }[] = []
	let gasPrice: bigint | undefined
	const live = createLiveProtectorChainReads(ethereum, requestAbortController, simulationState)
	return {
		chainReads: {
			readCode: async (address) => {
				const code = await live.readCode(address)
				addressCode.push({ address, code })
				return code
			},
			readGasPrice: async () => {
				const nodeGasPrice = await live.readGasPrice()
				gasPrice = nodeGasPrice
				return nodeGasPrice
			},
		},
		getRecord: () => ({ addressCode: [...addressCode], ...(gasPrice === undefined ? {} : { gasPrice }) }),
	}
}

// Stored runs survive updates that may add protector reads. Missing replay data is an expected compatibility condition; the shared re-label skips the run without changing its stored result.
export const createMissingRecordedProtectorReadError = (message: string) => createInterceptorInternalError(message, 'missing_recorded_protector_read', 'handled')
export const isMissingRecordedProtectorReadError = (error: unknown) => getInterceptorInternalErrorCode(error) === 'missing_recorded_protector_read'

// An address-book re-label answers from the reads recorded with the stored run, so it never simulates again. A missing read means the run cannot be re-labelled without fresh chain data, for example after an extension update.
export function replayRecordedProtectorChainReads(record: RecordedProtectorChainReads): ProtectorChainReads {
	return {
		readCode: async (address) => {
			// Protectors reading the same address within a run send identical requests, which the RPC request cache answers once, so the first recorded read stands for every read of that address.
			const recordedRead = record.addressCode.find((read) => read.address === address)
			if (recordedRead === undefined) throw createMissingRecordedProtectorReadError('The stored simulation run has no recorded code read for this address')
			return recordedRead.code
		},
		readGasPrice: async () => {
			if (record.gasPrice === undefined) throw createMissingRecordedProtectorReadError('The stored simulation run has no recorded gas price')
			return record.gasPrice
		},
	}
}

export const createLiveProtectorChainReads = (ethereum: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState): ProtectorChainReads => ({
	readCode: async (address) => {
		const code = await getSimulatedCode(ethereum, requestAbortController, toResolvedSimulationState(simulationState), address)
		return code.statusCode === 'failure' ? 'unverified' : code.getCodeReturn.length > 0 ? 'present' : 'absent'
	},
	readGasPrice: async () => await ethereum.getGasPrice(requestAbortController),
})
