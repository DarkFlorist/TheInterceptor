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

// A stored simulation run whose metadata a re-label may replace.
export type SimulationRunToRelabel<Stored> = {
	// The stack's numeric simulationId or the confirmation's lifetime/sequence identity. Every new stack or confirmation simulation run stores a new id, so a run stored during the re-label's lookups has another id even on the same block within the same second.
	readonly runId: number | ConfirmationRunId
	readonly simulationState: SimulationState
	// The metadata stored with the run: the names, prices and delegations the re-label starts from, the chain reads its protectors recorded and the entries its address lookups resolved.
	readonly storedMetadata: StoredSimulationMetadata
	// The stored result with only its metadata replaced, keeping the simulation, its id, its timestamps and any approval status.
	readonly withMetadata: (metadata: SimulationMetadata) => Stored
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
	const runToRelabel = getRunToRelabel(stored)
	if (runToRelabel === undefined) return
	// A run stored by a version that did not record its protectors' chain reads or the entries its address lookups resolved could only be visualised again by simulating, so it keeps its names until it is simulated again.
	const recorded = runToRelabel.storedMetadata.recordedVisualisationLookups
	if (recorded === undefined) return
	let visualisation: Awaited<ReturnType<typeof visualizeStoredRunWithoutNode>>
	try {
		visualisation = await visualizeStoredRunWithoutNode(runToRelabel.simulationState, runToRelabel.storedMetadata, recorded, rpcNetwork)
	} catch (error: unknown) {
		// An earlier extension version may have recorded only part of the reads the current protectors need. Keep that run unchanged until a fresh simulation records the missing data.
		if (isMissingRecordedProtectorReadError(error)) return
		throw error
	}
	// The re-visualised simulation state is dropped so the stored one, including its conducted timestamp, is kept.
	const { simulationState: _revisualizedSimulationState, ...metadata } = visualisation
	// Nothing cancels a re-label: newer work may store no fresh names, so the write guard below alone keeps it from replacing a result stored meanwhile.
	await updateStored((current) => {
		// The stale-write guard: a newer run stored meanwhile has another id, and a result stored under the same id that can no longer be re-labelled (a stack invalidation keeps the id of the run it raced with) is left alone.
		const currentRun = getRunToRelabel(current)
		if (currentRun === undefined || !isSameSimulationRun(currentRun.runId, runToRelabel.runId)) return undefined
		return currentRun.withMetadata(metadata)
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
