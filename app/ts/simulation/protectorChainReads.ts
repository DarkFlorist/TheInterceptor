import { createInterceptorInternalError, getInterceptorInternalErrorCode } from '../utils/caughtErrors.js'
import { type RecordedProtectorChainReads, type SimulationState, toResolvedSimulationState } from '../types/visualizer-types.js'
import type { EthereumClientService } from './services/EthereumClientService.js'
import { getSimulatedCode } from './services/SimulationModeEthereumClientService.js'

import type { ProtectorChainReads } from './protectorTypes.js'

type ProtectorChainReadsWithRecord = {
	readonly chainReads: ProtectorChainReads
	readonly getRecord: () => RecordedProtectorChainReads
}

type CodeReadArguments = Parameters<ProtectorChainReads['readCode']>

type RecordedReadMode =
	| { readonly kind: 'record', readonly live: ProtectorChainReads }
	| { readonly kind: 'replay', readonly record: RecordedProtectorChainReads }

const recordedReadMarker = Symbol('recordedProtectorRead')
type RecordedProtectorReads = {
	readonly [Method in keyof ProtectorChainReads]: ProtectorChainReads[Method] & { readonly [recordedReadMarker]: true }
}

// Legacy runs can lack reads added in a later version. The relabel caller detects that case and keeps the stored result.
export const createMissingRecordedProtectorReadError = (message: string) => createInterceptorInternalError(message, 'missing_recorded_protector_read', 'handled')
export const isMissingRecordedProtectorReadError = (error: unknown) => getInterceptorInternalErrorCode(error) === 'missing_recorded_protector_read'

function createRecordedProtectorChainReads(mode: RecordedReadMode): ProtectorChainReadsWithRecord {
	let record: RecordedProtectorChainReads = mode.kind === 'replay' ? mode.record : { addressCode: [] }

	// Every method must use this binder, which pairs the live read with its storage and replay accessors.
	const bindRead = <Args extends readonly unknown[], Value>(
		readLive: (live: ProtectorChainReads, ...args: Args) => Promise<Value>,
		readRecorded: (current: RecordedProtectorChainReads, ...args: Args) => Value | undefined,
		saveRecorded: (current: RecordedProtectorChainReads, value: Value, ...args: Args) => RecordedProtectorChainReads,
		missingRecordMessage: string,
	) => Object.assign(async (...args: Args): Promise<Value> => {
		if (mode.kind === 'record') {
			const value = await readLive(mode.live, ...args)
			record = saveRecorded(record, value, ...args)
			return value
		}
		const value = readRecorded(record, ...args)
		if (value === undefined) throw createMissingRecordedProtectorReadError(missingRecordMessage)
		return value
	}, { [recordedReadMarker]: true as const })

	const chainReads: RecordedProtectorReads = {
		readCode: bindRead<CodeReadArguments, RecordedProtectorChainReads['addressCode'][number]['code']>(
			(live, address) => live.readCode(address),
			// Repeated reads of the same address in a run use the same RPC cache entry.
			(current, address) => current.addressCode.find((read) => read.address === address)?.code,
			(current, code, address) => ({ ...current, addressCode: [...current.addressCode, { address, code }] }),
			'The stored simulation run has no recorded code read for this address',
		),
		readGasPrice: bindRead(
			(live) => live.readGasPrice(),
			(current) => current.gasPrice,
			(current, gasPrice) => ({ ...current, gasPrice }),
			'The stored simulation run has no recorded gas price',
		),
	}
	return { chainReads, getRecord: () => record }
}

export function recordProtectorChainReads(live: ProtectorChainReads): ProtectorChainReadsWithRecord {
	return createRecordedProtectorChainReads({ kind: 'record', live })
}

export function replayRecordedProtectorChainReads(record: RecordedProtectorChainReads): ProtectorChainReads {
	return createRecordedProtectorChainReads({ kind: 'replay', record }).chainReads
}

export const createLiveProtectorChainReads = (ethereum: EthereumClientService, requestAbortController: AbortController | undefined, simulationState: SimulationState): ProtectorChainReads => ({
	readCode: async (address) => {
		const code = await getSimulatedCode(ethereum, requestAbortController, toResolvedSimulationState(simulationState), address)
		return code.statusCode === 'failure' ? 'unverified' : code.getCodeReturn.length > 0 ? 'present' : 'absent'
	},
	readGasPrice: async () => await ethereum.getGasPrice(requestAbortController),
})
