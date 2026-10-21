import type { EthereumAddress } from '../types/wire-types.js'
import { type RecordedProtectorChainReads, type SimulationState, toResolvedSimulationState } from '../types/visualizer-types.js'
import type { EthereumClientService } from './services/EthereumClientService.js'
import { getSimulatedCode } from './services/SimulationModeEthereumClientService.js'

type AddressCode = RecordedProtectorChainReads['addressCode'][number]['code']

// The chain state protectors read about a transaction besides its simulation result. Every chain read a protector makes must go through this object, so it is recorded with the run and replayed by the address-book re-label, which makes no RPC request.
export type ProtectorChainReads = {
	// Whether the address has code where the transaction runs, after the transactions simulated before it.
	readonly readCode: (address: EthereumAddress) => Promise<AddressCode>
	readonly readGasPrice: () => Promise<bigint>
}

type ProtectorChainReadsWithRecord = {
	readonly chainReads: ProtectorChainReads
	// The reads made so far, to store with the run.
	readonly getRecord: () => RecordedProtectorChainReads
}

// A simulation run reads from the transaction's simulated state and the node, and records every read with the run.
export function readAndRecordProtectorChainReads(ethereum: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState): ProtectorChainReadsWithRecord {
	const addressCode: { address: EthereumAddress, code: AddressCode }[] = []
	let gasPrice: bigint | undefined
	return {
		chainReads: {
			readCode: async (address) => {
				const simulatedCode = await getSimulatedCode(ethereum, requestAbortController, toResolvedSimulationState(simulationState), address)
				const code = simulatedCode.statusCode === 'failure' ? 'unverified' : simulatedCode.getCodeReturn.length > 0 ? 'present' : 'absent'
				addressCode.push({ address, code })
				return code
			},
			readGasPrice: async () => {
				const nodeGasPrice = await ethereum.getGasPrice(requestAbortController)
				gasPrice = nodeGasPrice
				return nodeGasPrice
			},
		},
		getRecord: () => ({ addressCode: [...addressCode], ...(gasPrice === undefined ? {} : { gasPrice }) }),
	}
}

// An address-book re-label answers from the reads recorded with the stored run, so it never simulates again. The protectors make the same reads for the same transaction, so a read missing from the record can only come from a record of another version.
export function replayRecordedProtectorChainReads(record: RecordedProtectorChainReads): ProtectorChainReadsWithRecord {
	return {
		chainReads: {
			readCode: async (address) => {
				// Protectors reading the same address within a run send identical requests, which the RPC request cache answers once, so the first recorded read stands for every read of that address.
				const recordedRead = record.addressCode.find((read) => read.address === address)
				if (recordedRead === undefined) throw new Error('The stored simulation run has no recorded code read for this address')
				return recordedRead.code
			},
			readGasPrice: async () => {
				if (record.gasPrice === undefined) throw new Error('The stored simulation run has no recorded gas price')
				return record.gasPrice
			},
		},
		getRecord: () => record,
	}
}
