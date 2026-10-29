// The one metadata re-label of a stored simulation result, shared by the stack re-label (relabelPopupVisualisation) and the displayed confirmation re-label (relabelDisplayedConfirmationSimulation); see "Address-book re-labels" in docs/popup-simulation-refresh.md.
import type { RpcNetwork } from '../types/rpc.js'
import type { SimulationState } from '../types/visualizer-types.js'
import { isExpectedInfrastructureError, reportUnexpectedError } from '../utils/errors.js'
import { type StoredSimulationMetadata, visualizeStoredRunWithoutNode } from './storedRunVisualisation.js'

type SimulationMetadata = Omit<Awaited<ReturnType<typeof visualizeStoredRunWithoutNode>>, 'simulationState'>

// A stored simulation run whose metadata a re-label may replace.
export type SimulationRunToRelabel<Stored> = {
	// The stack's simulationId or the confirmation's confirmationRunId. Every new stack or confirmation simulation run stores a new id, so a run stored during the re-label's lookups has another id even on the same block within the same second.
	readonly runId: number
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
	// Aborted by newer work that replaces the stored result and stores its own. Undefined for a re-label that nothing cancels, which relies on the write guard alone.
	readonly abortController: AbortController | undefined
}

// Re-runs only the visualisation step (address-book names, ABI-parsed input, token metadata, and protector warnings such as send-to-non-contact) for a stored run, without any RPC request (see visualizeStoredRunWithoutNode), then writes the new metadata only onto that same run.
export async function relabelStoredSimulation<Stored>(rpcNetwork: RpcNetwork, { stored, getRunToRelabel, updateStored, abortController }: StoredSimulationRelabel<Stored>) {
	const runToRelabel = getRunToRelabel(stored)
	if (runToRelabel === undefined) return
	// A run stored by a version that did not record its protectors' chain reads or the entries its address lookups resolved could only be visualised again by simulating, so it keeps its names until it is simulated again.
	const recorded = runToRelabel.storedMetadata.recordedVisualisationLookups
	if (recorded === undefined) return
	// The re-visualised simulation state is dropped so the stored one, including its conducted timestamp, is kept.
	const { simulationState: _revisualizedSimulationState, ...metadata } = await visualizeStoredRunWithoutNode(runToRelabel.simulationState, runToRelabel.storedMetadata, recorded, rpcNetwork)
	// Newer work that aborted this re-label while it visualised stores its own result instead.
	if (abortController?.signal.aborted) return
	await updateStored((current) => {
		// The stale-write guard: a newer run stored meanwhile has another id, and a result stored under the same id that can no longer be re-labelled (a stack invalidation keeps the id of the run it raced with) is left alone.
		const currentRun = getRunToRelabel(current)
		if (currentRun === undefined || currentRun.runId !== runToRelabel.runId) return undefined
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
