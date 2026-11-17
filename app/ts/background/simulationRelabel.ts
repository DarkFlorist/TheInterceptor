import type { ConfirmationRunId } from '../types/accessRequest.js'
import { isSameConfirmationRun } from '../utils/confirmationRunId.js'
import { isMissingRecordedProtectorReadError } from '../simulation/protectorChainReads.js'
// The one metadata re-label of a stored simulation result, shared by the stack re-label (relabelPopupVisualisation) and the confirmation re-labels (confirmationRelabel.ts); see "Address-book re-labels" in docs/popup-simulation-refresh.md.
import type { RpcNetwork } from '../types/rpc.js'
import type { SimulationState } from '../types/visualizer-types.js'
import { isExpectedInfrastructureError, reportUnexpectedError } from '../utils/errors.js'
import { type StoredSimulationMetadata, visualizeStoredRunWithoutNode } from './storedRunVisualisation.js'

type SimulationMetadata = Omit<Awaited<ReturnType<typeof visualizeStoredRunWithoutNode>>, 'simulationState'>

// Stack ids are numbers; confirmation ids survive background restarts and storage decoding.
const isSameSimulationRun = (first: number | ConfirmationRunId, second: number | ConfirmationRunId) => typeof first === 'number' || typeof second === 'number' ? first === second : isSameConfirmationRun(first, second)

// Every metadata-only relabel uses this run identity and replacement contract.
export type StoredRunToRelabel<Stored, Metadata> = {
	readonly runId: number | ConfirmationRunId
	readonly withMetadata: (metadata: Metadata) => Stored
}

export type SimulationRunToRelabel<Stored> = StoredRunToRelabel<Stored, SimulationMetadata> & {
	readonly simulationState: SimulationState
	readonly storedMetadata: StoredSimulationMetadata
}

// Metadata reads may race a newer run or an invalidation. Only this shared guard decides whether their result may still be stored.
export async function relabelStoredRunMetadata<Stored, Metadata, Run extends StoredRunToRelabel<Stored, Metadata>>({ stored, getRunToRelabel, readMetadata, updateStored }: {
	readonly stored: Stored
	readonly getRunToRelabel: (stored: Stored) => Run | undefined
	readonly readMetadata: (run: Run) => Promise<Metadata | undefined>
	readonly updateStored: (relabel: (current: Stored) => Stored | undefined) => Promise<unknown>
}) {
	const run = getRunToRelabel(stored)
	if (run === undefined) return
	const metadata = await readMetadata(run)
	if (metadata === undefined) return
	await updateStored((current) => {
		const currentRun = getRunToRelabel(current)
		if (currentRun === undefined || !isSameSimulationRun(currentRun.runId, run.runId)) return undefined
		return currentRun.withMetadata(metadata)
	})
}

type StoredSimulationRelabel<Stored> = {
	// Read by the caller under whatever serialization it needs against other writers of the stored result.
	readonly stored: Stored
	// Returns the run when the stored result can be re-labelled (a finished simulation on the services' chain), otherwise undefined. Checked on the stored result before the lookups and again on the current result at the write.
	readonly getRunToRelabel: (stored: Stored) => SimulationRunToRelabel<Stored> | undefined
	// Atomically replaces the stored result with relabel(current), or keeps it when relabel returns undefined.
	readonly updateStored: (relabel: (current: Stored) => Stored | undefined) => Promise<unknown>
}

// Re-runs only the visualisation step (address-book names, ABI-parsed input, token metadata, and protector warnings such as send-to-non-contact) for a stored run, without any RPC request (see visualizeStoredRunWithoutNode), then writes the new metadata only onto that same run.
export async function relabelStoredSimulation<Stored>(rpcNetwork: RpcNetwork, { stored, getRunToRelabel, updateStored }: StoredSimulationRelabel<Stored>) {
	await relabelStoredRunMetadata<Stored, SimulationMetadata, SimulationRunToRelabel<Stored>>({
		stored, getRunToRelabel, updateStored,
		readMetadata: async (run) => {
			// Legacy runs may lack all or part of the recorded reads today's protectors need. Keep them unchanged until a fresh simulation records those reads.
			const recorded = run.storedMetadata.recordedVisualisationLookups
			if (recorded === undefined) return undefined
			try {
				const { simulationState: _revisualizedSimulationState, ...metadata } = await visualizeStoredRunWithoutNode(run.simulationState, run.storedMetadata, recorded, rpcNetwork)
				return metadata
			} catch (error: unknown) {
				if (isMissingRecordedProtectorReadError(error)) return undefined
				throw error
			}
		},
	})
}

// A re-label only replaces names on a result that is already stored, so its failure is reported without failing the address-book change or the confirmation run that requested it.
export async function relabelReportingUnexpectedErrors(relabel: Promise<void>) {
	try {
		await relabel
	} catch (error: unknown) {
		if (!isExpectedInfrastructureError(error)) await reportUnexpectedError(error)
	}
}
